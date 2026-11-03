import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  open,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cpus, homedir, totalmem } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import {
  tartAllocationOwnerTuple,
  tartAllocationIdentitySchema,
  canonicalTartNetworkPlan,
  tartGuestBootstrapReceiptSchema,
  tartGuestBootstrapRequestSchema,
  tartLocalTemplateRefSchema,
  tartReconcileRequestSchema,
  tartResourceSpecSchema,
  tartNetworkPlanSchema,
  tartNetworkCleanupReceiptSchema,
  tartRuntimeFactsSchema,
  type TartAllocationIdentity,
  type TartGuestBootstrapReceipt,
  type TartGuestBootstrapRequest,
  type TartInspection,
  type TartLocalTemplateRef,
  type TartReconcileRequest,
  type TartResourceSpec,
  type TartRuntimeFacts,
  type TartRuntimeTemplateProof,
  type TartNetworkPlan,
  type TartNetworkObservation,
  type TartNetworkCleanupReceipt,
} from "@hitchlet/contracts/internal";
import { canonical } from "../canonical.js";
import { currentCommandDeadlineMs } from "../command-exec.js";
import {
  compileTartNetworkPolicy,
  hashSoftnetPolicy,
  sameSoftnetPolicy,
  type TartNetworkAdapter,
  type TartNetworkSession,
} from "./tart-network.js";

const execFileAsync = promisify(execFile);
const SHORT_COMMAND_MS = 15_000;
const CLONE_COMMAND_MS = 120_000;
const IP_DEADLINE_MS = 90_000;
const IP_POLL_MS = 1_000;
const RUN_EXIT_MS = 5_000;
const MAX_OUTPUT = 1024 * 1024;
const GUEST_BOOTSTRAP_TIMEOUT_MS = 120_000;
const MAX_GUEST_BOOTSTRAP_OUTPUT = 256 * 1024;
const TEMPLATE_BUNDLE_FILES = ["config.json", "disk.img", "nvram.bin"] as const;

const manifestBase = {
  version: z.literal(2),
  identity: tartAllocationIdentitySchema,
  highestControlVersion: z.number().int().positive(),
  vmName: z.string(),
  home: z
    .object({ path: z.string(), device: z.string(), inode: z.string() })
    .strict(),
};
const ownedManifestSchema = z
  .object({
    ...manifestBase,
    phase: z.enum(["clone_intent", "owned", "deleting"]),
    resources: tartResourceSpecSchema,
    templateRef: tartLocalTemplateRefSchema,
    networkPlan: tartNetworkPlanSchema,
    networkLaunchIntent: z.boolean().optional(),
    networkProcess: z
      .object({
        pid: z.number().int().positive().safe(),
        startedAt: z.string().datetime({ offset: true }),
        policyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    networkCleanupReceipt: tartNetworkCleanupReceiptSchema.optional(),
    templateIdentity: z
      .object({
        device: z.string(),
        inode: z.string(),
        macAddress: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
      })
      .strict()
      .optional(),
    instance: z
      .object({
        device: z.string(),
        inode: z.string(),
        macAddress: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
        guestOS: z.enum(["darwin", "linux"]),
        arch: z.literal("arm64"),
      })
      .strict()
      .optional(),
    bootstrapRequest: tartGuestBootstrapRequestSchema.optional(),
    bootstrapReceipt: tartGuestBootstrapReceiptSchema.optional(),
  })
  .strict();
const releasedTombstoneSchema = z
  .object({
    ...manifestBase,
    phase: z.literal("released"),
    networkPlan: tartNetworkPlanSchema.optional(),
    networkLaunchIntent: z.boolean().optional(),
    networkProcess: z
      .object({
        pid: z.number().int().positive().safe(),
        startedAt: z.string().datetime({ offset: true }),
        policyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    networkCleanupReceipt: tartNetworkCleanupReceiptSchema.optional(),
  })
  .strict();
const manifestSchema = z.union([ownedManifestSchema, releasedTombstoneSchema]);
const templateFileProofSchema = z
  .object({
    name: z.enum(TEMPLATE_BUNDLE_FILES),
    device: z.string(),
    inode: z.string(),
    size: z.string(),
    mtimeNs: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const templateRegistrySchema = z
  .object({
    version: z.literal(1),
    templateRef: tartLocalTemplateRefSchema,
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    proofKind: z.literal("sealed_local_bundle_v1"),
    sealedAt: z.string().datetime({ offset: true }),
    home: z
      .object({ path: z.string(), device: z.string(), inode: z.string() })
      .strict(),
    files: z
      .array(templateFileProofSchema)
      .length(TEMPLATE_BUNDLE_FILES.length)
      .superRefine((files, context) => {
        if (
          TEMPLATE_BUNDLE_FILES.some(
            (name) => files.filter((file) => file.name === name).length !== 1,
          )
        )
          context.addIssue({
            code: "custom",
            message: "invalid_bundle_file_set",
          });
      }),
  })
  .strict();

type Manifest = z.infer<typeof ownedManifestSchema>;
type ReleasedTombstone = z.infer<typeof releasedTombstoneSchema>;
type StoredManifest = Manifest | ReleasedTombstone;
type TemplateRegistryRecord = z.infer<typeof templateRegistrySchema>;
type HomeBound = Readonly<{
  home: Readonly<{ path: string; device: string; inode: string }>;
}>;
type InventoryRow = {
  Source: string;
  Name: string;
  Running: boolean;
  State: string;
};
type TartInstanceIdentity = {
  device: string;
  inode: string;
  macAddress: string;
  guestOS: "darwin" | "linux";
  arch: "arm64";
};
type TemplateFacts = {
  ref: TartLocalTemplateRef;
  identity: { device: string; inode: string; macAddress: string };
};
type RunningChild = TartNetworkSession & {
  policy: ReturnType<typeof compileTartNetworkPolicy>;
  instance: TartInstanceIdentity;
};

export type TartDriverOptions = Readonly<{
  /** Dedicated Tart home; never point this at a user's regular Tart home. */
  tartHome: string;
  /** Durable, private directory for this driver's ownership manifests. */
  manifestDirectory: string;
  /** Absolute executable path. Production callers fix this to their installed Tart binary. */
  executable: string;
  /** Optional strong-isolation backend. Trusted NAT runs do not require Softnet. */
  networkAdapter?: TartNetworkAdapter;
  templateRegistryDirectory?: string;
}>;

/**
 * Finite, local Tart CLI adapter for macOS arm64. This is not a controller
 * ProvisionPlan implementation and does not qualify guest networking or boot.
 * Every command uses fixed argv with shell:false and a private TART_HOME.
 */
export class TartLocalDriver {
  private readonly home: string;
  private readonly vmRoot: string;
  private readonly manifestRoot: string;
  private readonly registryRoot: string;
  private readonly executable: string;
  private readonly networkAdapter: TartNetworkAdapter | undefined;
  private readonly natChildren = new Map<
    string,
    { child: ChildProcess; exit: Promise<unknown> }
  >();
  private readonly env: NodeJS.ProcessEnv;
  private readonly children = new Map<string, RunningChild>();
  private readonly ownedRunningVMs = new Set<string>();
  private readonly operations = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: TartDriverOptions) {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error("tart_host_unsupported");
    if (!options.tartHome || !options.manifestDirectory || !options.executable)
      throw new Error("tart_driver_paths_required");
    if (!options.executable.startsWith("/"))
      throw new Error("tart_executable_must_be_absolute");
    this.home = resolve(options.tartHome);
    this.vmRoot = join(this.home, "vms");
    if (
      this.home === resolve(homedir()) ||
      this.home === resolve(homedir(), ".tart") ||
      this.home.startsWith(`${resolve(homedir(), ".tart")}/`) ||
      this.home === "/"
    )
      throw new Error("tart_home_must_be_dedicated");
    this.manifestRoot = resolve(options.manifestDirectory);
    if (
      this.manifestRoot === this.home ||
      this.manifestRoot.startsWith(`${this.home}/`)
    )
      throw new Error("tart_manifest_must_be_outside_home");
    this.registryRoot = resolve(
      options.templateRegistryDirectory ??
        join(this.manifestRoot, "template-registry"),
    );
    if (
      this.registryRoot === this.home ||
      this.registryRoot.startsWith(`${this.home}/`)
    )
      throw new Error("tart_template_registry_must_be_outside_home");
    this.executable = options.executable;
    this.networkAdapter = options.networkAdapter;
    this.env = {
      ...process.env,
      TART_HOME: this.home,
      TART_NO_AUTO_PRUNE: "1",
      LC_ALL: "C",
      LANG: "C",
    };
  }

  inspect(rawIdentity: unknown): Promise<TartInspection> {
    const identity = tartAllocationIdentitySchema.parse(rawIdentity);
    return this.exclusive(ownerKey(identity), () =>
      this.inspectOwned(identity),
    );
  }

  reconcile(rawRequest: unknown): Promise<TartInspection> {
    const request = tartReconcileRequestSchema.parse(rawRequest);
    return this.exclusive(ownerKey(request.identity), () =>
      this.reconcileOwned(request),
    );
  }

  destroy(rawIdentity: unknown): Promise<TartInspection> {
    const identity = tartAllocationIdentitySchema.parse(rawIdentity);
    return this.exclusive(ownerKey(identity), () =>
      this.destroyOwned(identity),
    );
  }

  revokeNetwork(
    rawIdentity: unknown,
    rawNetwork: unknown,
  ): Promise<TartInspection> {
    const identity = tartAllocationIdentitySchema.parse(rawIdentity);
    const network = tartNetworkPlanSchema.parse(rawNetwork);
    return this.exclusive(ownerKey(identity), () =>
      this.revokeNetworkOwned(identity, network),
    );
  }

  bootstrapApply(
    rawIdentity: unknown,
    rawRequest: unknown,
  ): Promise<TartInspection> {
    const identity = tartAllocationIdentitySchema.parse(rawIdentity);
    const request = tartGuestBootstrapRequestSchema.parse(rawRequest);
    return this.exclusive(ownerKey(identity), () =>
      this.bootstrapApplyOwned(identity, request),
    );
  }

  async facts(nativeRuntimeNamespaceId: string): Promise<TartRuntimeFacts> {
    await this.prepareDirectories();
    const namespaceId = z.string().uuid().parse(nativeRuntimeNamespaceId);
    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      throw new Error("tart_inventory_incomplete");
    const templates: TartRuntimeTemplateProof[] = [];
    const registryEntries = await readdir(this.registryRoot, {
      withFileTypes: true,
    });
    for (const entry of registryEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.readTemplateRegistryByPath(
        join(this.registryRoot, entry.name),
      );
      if (!record) continue;
      const expected = record.templateRef;
      if (
        entry.name !==
        `${createHash("sha256").update(expected.name).digest("hex")}.json`
      )
        continue;
      const row = inventory.rows.find((item) => item.Name === expected.name);
      if (
        !row ||
        row.Source !== "local" ||
        row.Running ||
        row.State !== "stopped"
      )
        continue;
      const actual = await this.readTemplateFacts(expected.name);
      if (!actual || !sameTemplateRef(actual.ref, expected)) continue;
      if (
        record.artifactDigest !==
          templateArtifactDigest(record.templateRef, record.files) ||
        !(await this.matchesHome(record)) ||
        !(await this.templateFilesUnchanged(record))
      )
        continue;
      templates.push(templateProof(record));
    }
    const versionResult = await this.runShort(["--version"]);
    const tartVersion = (versionResult.stdout || versionResult.stderr).trim();
    return tartRuntimeFactsSchema.parse({
      nativeRuntimeNamespaceId: namespaceId,
      tartVersion,
      hostOS: "macos",
      hostArch: "arm64",
      hostCpuCount: cpus().length,
      hostMemoryBytes: totalmem(),
      templates,
    });
  }

  sealTemplate(rawName: unknown): Promise<TartRuntimeTemplateProof> {
    const name = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .parse(rawName);
    return this.exclusive(`template:${name}`, () =>
      this.sealTemplateOwned(name),
    );
  }

  private async sealTemplateOwned(
    name: string,
  ): Promise<TartRuntimeTemplateProof> {
    await this.prepareDirectories();
    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      throw new Error("tart_inventory_incomplete");
    const row = inventory.rows.find((item) => item.Name === name);
    if (
      !row ||
      row.Source !== "local" ||
      row.Running ||
      row.State !== "stopped"
    )
      throw new Error("tart_template_not_stopped");
    const initial = await this.readTemplateFacts(name);
    if (!initial) throw new Error("tart_template_configuration_unavailable");
    const files: z.infer<typeof templateFileProofSchema>[] = [];
    for (const fileName of TEMPLATE_BUNDLE_FILES)
      files.push(
        await hashTemplateFile(join(this.vmRoot, name, fileName), fileName),
      );
    const final = await this.readTemplateFacts(name);
    if (
      !final ||
      !sameTemplateRef(initial.ref, final.ref) ||
      !sameTemplateFacts(initial.ref, initial.identity, final)
    )
      throw new Error("tart_template_changed_while_sealing");
    const record: TemplateRegistryRecord = templateRegistrySchema.parse({
      version: 1,
      templateRef: initial.ref,
      artifactDigest: templateArtifactDigest(initial.ref, files),
      proofKind: "sealed_local_bundle_v1",
      sealedAt: new Date().toISOString(),
      home: await this.homeIdentity(),
      files,
    });
    await this.writeTemplateRegistry(name, record);
    return templateProof(record);
  }

  /** Stop accepting work and wait for in-flight CLI state transitions. Running
   * VMs are left intact; close never treats a run-child exit as VM absence. */
  async close(): Promise<
    Readonly<{ lastObservedOwnedRunningVMs: readonly string[] }>
  > {
    this.closed = true;
    await Promise.all([...this.operations.values()]);
    return { lastObservedOwnedRunningVMs: [...this.ownedRunningVMs] };
  }

  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("tart_driver_closed");
    const previous = this.operations.get(key) ?? Promise.resolve();
    let finish!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      finish = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.operations.set(key, tail);
    await previous;
    try {
      if (this.closed) throw new Error("tart_driver_closed");
      return await work();
    } finally {
      finish();
      if (this.operations.get(key) === tail) this.operations.delete(key);
    }
  }

  private async reconcileOwned(
    request: TartReconcileRequest,
  ): Promise<TartInspection> {
    const { identity } = request;
    const trustedNat = request.network.mode === "trusted_nat";
    if (trustedNat) {
      const { contractHash, ...unhashed } = request.network;
      const expected =
        "sha256:" +
        createHash("sha256")
          .update(canonicalTartNetworkPlan(unhashed))
          .digest("hex");
      if (contractHash !== expected)
        return unknown(identity, "tart_network_contract_hash_mismatch");
    }
    if (!trustedNat && !this.networkAdapter)
      return unknown(identity, "tart_network_adapter_unavailable");
    let compiledPolicy: ReturnType<typeof compileTartNetworkPolicy>;
    try {
      compiledPolicy = trustedNat
        ? { allow: [], block: [], policyHash: request.network.contractHash }
        : compileTartNetworkPolicy(request.network);
    } catch (error) {
      return unknown(
        identity,
        error instanceof Error ? error.message : "tart_network_plan_invalid",
      );
    }
    await this.prepareDirectories();
    const vmName = this.vmName(identity);
    const manifestPath = this.manifestPath(identity);
    let manifest = await this.readManifest(manifestPath);
    const freshIntent = manifest === undefined;

    if (manifest && !sameOwner(manifest.identity, identity))
      return unknown(identity, "manifest_owner_mismatch");
    if (
      manifest?.phase !== "released" &&
      manifest &&
      (!manifest.networkPlan ||
        canonicalTartNetworkPlan(manifest.networkPlan) !==
          canonicalTartNetworkPlan(request.network))
    )
      return unknown(identity, "network_contract_changed");
    if (manifest && !(await this.matchesHome(manifest)))
      return unknown(identity, "tart_home_identity_changed");
    if (manifest?.phase === "released") return this.inspectOwned(identity);
    if (manifest?.phase === "deleting")
      return unknown(identity, "deletion_in_progress");
    if (manifest && !acceptsFence(manifest, identity))
      return unknown(identity, "stale_control_fence");

    if (!manifest) {
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return unknown(identity, "inventory_incomplete");
      if (inventory.names.has(vmName))
        return unknown(identity, "unmanifested_vm_name_collision");
      if (!inventory.names.has(request.template.name))
        return unknown(identity, "local_template_not_found");
      const templateRow = inventory.rows.find(
        (item) => item.Name === request.template.name,
      );
      if (
        !templateRow ||
        templateRow.Source !== "local" ||
        templateRow.Running ||
        templateRow.State !== "stopped"
      )
        return unknown(identity, "template_not_stopped");
      const template = await this.readTemplateFacts(request.template.name);
      if (!template || !sameTemplateRef(template.ref, request.template))
        return unknown(identity, "local_template_proof_mismatch");
      manifest = {
        version: 2,
        identity,
        highestControlVersion: identity.controlVersion,
        vmName,
        phase: "clone_intent",
        resources: request.resources,
        networkPlan: request.network,
        home: await this.homeIdentity(),
        templateRef: template.ref,
        templateIdentity: template.identity,
      };
      await this.writeManifest(manifestPath, manifest);
    }

    if (manifest.phase === "clone_intent") {
      if (!freshIntent)
        return unknown(identity, "interrupted_clone_identity_not_recorded");
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return unknown(identity, "inventory_incomplete");
      if (inventory.names.has(vmName))
        return unknown(identity, "clone_identity_not_recorded");
      const templateRow = inventory.rows.find(
        (item) => item.Name === request.template.name,
      );
      if (
        !templateRow ||
        templateRow.Source !== "local" ||
        templateRow.Running ||
        templateRow.State !== "stopped"
      )
        return unknown(identity, "template_not_stopped");
      const template = await this.readTemplateFacts(request.template.name);
      if (
        !template ||
        !sameTemplateRef(manifest.templateRef, request.template) ||
        !sameTemplateFacts(
          manifest.templateRef,
          manifest.templateIdentity,
          template,
        )
      )
        return unknown(identity, "template_identity_changed");

      await this.runShort(
        ["clone", request.template.name, vmName],
        CLONE_COMMAND_MS,
      );
      // Persist immutable instance facts before any mutable configuration command.
      const instance = await this.readInstanceIdentity(vmName);
      if (!instance) return unknown(identity, "cloned_vm_identity_unavailable");
      const templateIdentity = manifest.templateIdentity;
      if (!templateIdentity)
        return unknown(identity, "template_identity_missing");
      manifest = { ...manifest, phase: "owned", instance };
      await this.writeManifest(manifestPath, manifest);
      if (instance.macAddress === templateIdentity.macAddress)
        return unknown(identity, "clone_mac_not_regenerated");
    }

    const ownedInstance = manifest.instance;
    if (!ownedInstance)
      return unknown(identity, "manifest_instance_identity_missing");
    const currentTemplate = await this.readTemplateFacts(request.template.name);
    if (
      !currentTemplate ||
      !sameTemplateRef(manifest.templateRef, request.template) ||
      !sameTemplateFacts(
        manifest.templateRef,
        manifest.templateIdentity,
        currentTemplate,
      )
    )
      return unknown(identity, "template_identity_changed");
    if ((await this.verifyOwned(manifest)) !== "present")
      return unknown(identity, "owned_vm_identity_or_inventory_mismatch");
    if (
      !manifest.templateIdentity ||
      ownedInstance.macAddress === manifest.templateIdentity.macAddress
    )
      return unknown(identity, "clone_mac_not_regenerated");

    if (manifest.identity.controlVersion < identity.controlVersion) {
      manifest = {
        ...manifest,
        identity,
        highestControlVersion: identity.controlVersion,
        resources: request.resources,
        networkPlan: request.network,
      };
      await this.writeManifest(manifestPath, manifest);
    } else {
      if (!sameActionIdentity(manifest.identity, identity))
        return unknown(identity, "operation_fence_mismatch");
      if (!sameResources(manifest.resources, request.resources))
        return unknown(identity, "operation_resource_mismatch");
    }

    if (request.bootstrap) {
      if (!sameActionIdentity(request.bootstrap.identity, identity))
        return unknown(identity, "bootstrap_action_identity_mismatch");
      if (!validBootstrapPublicKeyFingerprints(request.bootstrap))
        return unknown(identity, "bootstrap_public_key_fingerprint_mismatch");
      if (
        manifest.bootstrapRequest &&
        JSON.stringify(manifest.bootstrapRequest) !==
          JSON.stringify(request.bootstrap)
      )
        return unknown(identity, "bootstrap_request_changed");
      if (!manifest.bootstrapRequest) {
        manifest = { ...manifest, bootstrapRequest: request.bootstrap };
        await this.writeManifest(manifestPath, manifest);
      }
    }

    let observed = await this.readVmConfiguration(vmName);
    if (!observed)
      return unknown(identity, "owned_vm_configuration_unavailable");
    if (!sameResources(observed.resources, request.resources)) {
      await this.runShort([
        "set",
        vmName,
        "--cpu",
        String(request.resources.cpus),
        "--memory",
        String(request.resources.memoryMiB),
      ]);
      observed = await this.readVmConfiguration(vmName);
      const afterSet = await this.readInstanceIdentity(vmName);
      if (
        !observed ||
        !afterSet ||
        !sameInstanceIdentity(ownedInstance, afterSet) ||
        !sameResources(observed.resources, request.resources)
      )
        return unknown(identity, "vm_resource_configuration_unverified");
    }

    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete");
    const row = inventory.rows.find((item) => item.Name === vmName);
    if (!row || row.Source !== "local")
      return unknown(identity, "owned_vm_missing_from_cli_inventory");
    if (trustedNat) {
      if (!row.Running) {
        if (manifest.networkLaunchIntent)
          return unknown(identity, "nat_launch_outcome_unknown");
        await this.startNatRun(vmName, manifestPath, manifest);
      }
    } else if (row.Running) {
      const running = this.children.get(vmName);
      if (!running || running.policy.policyHash !== compiledPolicy.policyHash)
        return unknown(identity, "network_process_untracked");
    } else {
      if (manifest.networkLaunchIntent && !this.children.has(vmName))
        return unknown(identity, "network_launch_outcome_unknown");
      try {
        await this.startRun(
          vmName,
          identity,
          request.network,
          compiledPolicy,
          manifestPath,
          manifest,
          ownedInstance,
        );
      } catch (error) {
        return unknown(
          identity,
          error instanceof Error ? error.message : "tart_network_start_unknown",
        );
      }
    }
    const ipAddress = await this.discoverIp(vmName);
    if (ipAddress) this.ownedRunningVMs.add(vmName);
    return this.inspectOwned(identity);
  }

  private async recordBootstrapReceiptOwned(
    identity: TartAllocationIdentity,
    request: TartGuestBootstrapRequest,
    receipt: TartGuestBootstrapReceipt,
  ): Promise<TartInspection> {
    await this.prepareDirectories();
    const manifestPath = this.manifestPath(identity);
    let manifest = await this.readManifest(manifestPath);
    if (!manifest || !sameOwner(manifest.identity, identity))
      return unknown(identity, "bootstrap_manifest_missing");
    if (!(await this.matchesHome(manifest)))
      return unknown(identity, "tart_home_identity_changed");
    if (
      manifest.phase !== "owned" ||
      !manifest.instance ||
      manifest.highestControlVersion !== identity.controlVersion ||
      !sameActionIdentity(manifest.identity, identity)
    )
      return unknown(identity, "bootstrap_receipt_fence_closed");
    if (
      !manifest.bootstrapRequest ||
      JSON.stringify(manifest.bootstrapRequest) !== JSON.stringify(request) ||
      !sameActionIdentity(request.identity, identity) ||
      !sameActionIdentity(receipt.identity, identity) ||
      receipt.nonce !== request.nonce
    )
      return unknown(identity, "bootstrap_request_receipt_mismatch");
    if (!validBootstrapPublicKeyFingerprints(request))
      return unknown(identity, "bootstrap_client_key_fingerprint_mismatch");
    if (receipt.status === "applied") {
      const evidence = request.networkEvidence;
      if (
        receipt.account !== request.account ||
        receipt.clientPublicKeyFingerprint !==
          request.clientPublicKeyFingerprint ||
        receipt.networkEvidenceReference !== evidence.reference ||
        receipt.networkEvidenceExpiresAt !== evidence.expiresAt ||
        Date.parse(receipt.observedAt) > Date.parse(evidence.expiresAt) ||
        sshPublicKeyFingerprint(receipt.hostPublicKey) !==
          receipt.hostKeyFingerprint.replace(/=+$/, "")
      )
        return unknown(identity, "bootstrap_receipt_evidence_mismatch");
    }
    if (manifest.bootstrapReceipt) {
      if (JSON.stringify(manifest.bootstrapReceipt) === JSON.stringify(receipt))
        return this.inspectOwned(identity);
      if (
        manifest.bootstrapReceipt.status !== "unknown" ||
        receipt.status !== "applied"
      )
        return unknown(identity, "bootstrap_receipt_conflict");
    }
    if ((await this.verifyOwned(manifest)) !== "present")
      return unknown(identity, "owned_vm_identity_or_inventory_mismatch");
    manifest = { ...manifest, bootstrapReceipt: receipt };
    await this.writeManifest(manifestPath, manifest);
    return this.inspectOwned(identity);
  }

  private async bootstrapApplyOwned(
    identity: TartAllocationIdentity,
    request: TartGuestBootstrapRequest,
  ): Promise<TartInspection> {
    await this.prepareDirectories();
    const manifestPath = this.manifestPath(identity);
    const manifest = await this.readManifest(manifestPath);
    if (!manifest || !sameOwner(manifest.identity, identity))
      return unknown(identity, "bootstrap_manifest_missing");
    if (!(await this.matchesHome(manifest)))
      return unknown(identity, "tart_home_identity_changed");
    if (
      manifest.phase !== "owned" ||
      !manifest.instance ||
      manifest.highestControlVersion !== identity.controlVersion ||
      !sameActionIdentity(manifest.identity, identity)
    )
      return unknown(identity, "bootstrap_receipt_fence_closed");
    if (
      !manifest.bootstrapRequest ||
      JSON.stringify(manifest.bootstrapRequest) !== JSON.stringify(request) ||
      !sameActionIdentity(request.identity, identity)
    )
      return unknown(identity, "bootstrap_request_receipt_mismatch");
    if (Date.parse(request.networkEvidence.expiresAt) <= Date.now())
      return unknown(identity, "bootstrap_network_evidence_expired");
    if (!validBootstrapPublicKeyFingerprints(request))
      return unknown(identity, "bootstrap_client_key_fingerprint_mismatch");
    if (manifest.bootstrapReceipt?.status === "applied")
      return this.inspectOwned(identity);
    if ((await this.verifyOwned(manifest)) !== "present")
      return unknown(identity, "owned_vm_identity_or_inventory_mismatch");
    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete");
    const row = inventory.rows.find((item) => item.Name === manifest.vmName);
    if (!row || row.Source !== "local")
      return unknown(identity, "owned_vm_missing_from_cli_inventory");
    if (!row.Running) return unknown(identity, "bootstrap_vm_not_running");

    let receipt: TartGuestBootstrapReceipt;
    try {
      receipt = await this.invokeGuestBootstrap(manifest.vmName, request);
    } catch (error) {
      const reason =
        error instanceof Error && error.message === "guest_ssh_port_22_in_use"
          ? error.message
          : "guest_bootstrap_execution_unknown";
      receipt = {
        status: "unknown",
        identity,
        nonce: request.nonce,
        reason,
        observedAt: new Date().toISOString(),
      };
    }
    return this.recordBootstrapReceiptOwned(identity, request, receipt);
  }

  private async invokeGuestBootstrap(
    vmName: string,
    request: TartGuestBootstrapRequest,
  ): Promise<TartGuestBootstrapReceipt> {
    const helperSource = await readFile(
      new URL("./tart-guest-bootstrap.cjs", import.meta.url),
      "utf8",
    );
    const script = tartGuestBootstrapProgram(helperSource);
    const result = await this.runInteractive(
      [
        "exec",
        "-i",
        vmName,
        "/usr/bin/sudo",
        "-n",
        "/opt/homebrew/bin/node",
        "-e",
        script,
      ],
      `${JSON.stringify(request)}\n`,
    );
    const output = result.stdout.trim();
    const parsed = tartGuestBootstrapReceiptSchema.parse(JSON.parse(output));
    if (
      parsed.status !== "applied" ||
      !sameActionIdentity(parsed.identity, request.identity) ||
      parsed.nonce !== request.nonce
    )
      throw new Error("tart_guest_bootstrap_receipt_mismatch");
    return parsed;
  }

  private async runInteractive(
    args: readonly string[],
    input: string,
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.closed) throw new Error("tart_driver_closed");
    const timeout = commandBudget(undefined, GUEST_BOOTSTRAP_TIMEOUT_MS);
    if (timeout <= 0) throw new Error("tart_command_deadline_expired");
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.executable, [...args], {
        cwd: this.home,
        env: this.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputSize = 0;
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, timeout);
      const append = (target: Buffer[], chunk: Buffer) => {
        outputSize += chunk.byteLength;
        if (outputSize > MAX_GUEST_BOOTSTRAP_OUTPUT) {
          failed = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0) {
          const errorText = Buffer.concat(stderr).toString("utf8").trim();
          reject(
            new Error(
              errorText === "guest_ssh_port_22_in_use"
                ? errorText
                : "tart_guest_bootstrap_command_failed",
            ),
          );
          return;
        }
        resolvePromise({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
      child.stdin.once("error", () => {
        failed = true;
      });
      child.stdin.end(input);
    });
  }

  private async inspectOwned(
    identity: TartAllocationIdentity,
  ): Promise<TartInspection> {
    await this.prepareDirectories();
    const manifest = await this.readManifest(this.manifestPath(identity));
    const vmName = this.vmName(identity);
    if (!manifest) {
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return unknown(identity, "inventory_incomplete");
      if (inventory.names.has(vmName))
        return unknown(identity, "unmanifested_vm_name_collision");
      return {
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
      };
    }
    if (!sameOwner(manifest.identity, identity))
      return unknown(identity, "manifest_owner_mismatch");
    if (!(await this.matchesHome(manifest)))
      return unknown(identity, "tart_home_identity_changed");
    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete");
    if (!inventory.names.has(manifest.vmName)) {
      if (manifest.phase === "released")
        return {
          presence: "absent",
          identity: manifest.identity,
          inventoryCompleteness: "complete",
          ...(manifest.networkCleanupReceipt
            ? { networkCleanupReceipt: manifest.networkCleanupReceipt }
            : {}),
        };
      if (
        manifest.networkPlan?.mode !== "trusted_nat" &&
        manifest.networkLaunchIntent &&
        manifest.networkCleanupReceipt?.status !== "removed" &&
        manifest.networkCleanupReceipt?.status !== "process_exited" &&
        manifest.networkCleanupReceipt?.status !== "not_started"
      )
        return unknown(identity, "network_process_absence_unverified");
      if (manifest.phase === "clone_intent" || !manifest.instance)
        return unknown(identity, "clone_identity_not_recorded");
      await this.writeManifest(
        this.manifestPath(identity),
        toTombstone(manifest),
      );
      this.ownedRunningVMs.delete(manifest.vmName);
      return {
        presence: "absent",
        identity: manifest.identity,
        inventoryCompleteness: "complete",
        ...(manifest.networkCleanupReceipt
          ? { networkCleanupReceipt: manifest.networkCleanupReceipt }
          : {}),
      };
    }
    if (manifest.phase === "released")
      return unknown(identity, "released_vm_still_present");
    if (manifest.phase === "clone_intent" || !manifest.instance)
      return unknown(identity, "clone_identity_not_recorded");
    if ((await this.verifyOwned(manifest)) !== "present")
      return unknown(identity, "owned_vm_identity_or_inventory_mismatch");
    const row = inventory.rows.find((item) => item.Name === manifest.vmName);
    if (!row || row.Source !== "local")
      return unknown(identity, "owned_vm_missing_from_cli_inventory");
    const observed = await this.readVmConfiguration(manifest.vmName);
    if (!observed)
      return unknown(identity, "owned_vm_configuration_unavailable");
    let ipAddress: string | undefined;
    if (row.Running) {
      try {
        const { stdout } = await this.runShort([
          "ip",
          "--wait",
          "0",
          manifest.vmName,
        ]);
        if (isIPv4(stdout.trim())) ipAddress = stdout.trim();
      } catch {
        /* An IP observation is optional, never readiness. */
      }
      this.ownedRunningVMs.add(manifest.vmName);
    }
    const network = await this.networkObservation(identity, manifest);
    return {
      presence: "present",
      identity: manifest.identity,
      vmName: manifest.vmName,
      state: normalizeVmState(row),
      resources: observed.resources,
      bootstrapStatus: !manifest.bootstrapRequest
        ? "not_requested"
        : (manifest.bootstrapReceipt?.status ?? "pending"),
      network,
      ...(ipAddress ? { ipAddress } : {}),
      ...(manifest.bootstrapReceipt
        ? { bootstrapReceipt: manifest.bootstrapReceipt }
        : {}),
      ...(manifest.networkCleanupReceipt
        ? { networkCleanupReceipt: manifest.networkCleanupReceipt }
        : {}),
    };
  }

  private async networkObservation(
    identity: TartAllocationIdentity,
    manifest: Manifest,
  ): Promise<TartNetworkObservation> {
    const plan = manifest.networkPlan;
    if (!plan) return networkUnknown(identity, "network_plan_missing");
    if (!sameActionIdentity(manifest.identity, identity))
      return networkUnknown(identity, "network_operation_fence_mismatch", plan);
    if (plan.mode === "trusted_nat") {
      if (!manifest.instance)
        return networkUnknown(identity, "network_vm_identity_missing", plan);
      return {
        backend: "nat",
        status: "not_enforced",
        identity,
        revisionId: plan.revisionId,
        contractHash: plan.contractHash,
        vm: {
          vmName: manifest.vmName,
          device: manifest.instance.device,
          inode: manifest.instance.inode,
          macAddress: manifest.instance.macAddress,
        },
        observedAt: new Date().toISOString(),
      };
    }
    if (manifest.networkCleanupReceipt)
      return networkUnknown(identity, "network_policy_revoked", plan);
    if (!manifest.networkLaunchIntent)
      return networkUnknown(identity, "network_not_started", plan);
    const running = this.children.get(manifest.vmName);
    if (!running || !manifest.networkProcess)
      return networkUnknown(identity, "network_process_untracked", plan);
    if (
      running.child.exitCode !== null ||
      running.child.pid !== manifest.networkProcess.pid ||
      running.startedAt !== manifest.networkProcess.startedAt ||
      running.policy.policyHash !== manifest.networkProcess.policyHash
    )
      return networkUnknown(
        identity,
        "network_process_identity_mismatch",
        plan,
      );
    let readback;
    try {
      readback = await running.getPolicy();
    } catch {
      return networkUnknown(identity, "network_control_unavailable", plan);
    }
    if (!sameSoftnetPolicy(readback, running.policy))
      return networkUnknown(identity, "network_policy_readback_mismatch", plan);
    const instance = manifest.instance;
    if (!instance)
      return networkUnknown(identity, "network_vm_identity_missing", plan);
    if (!sameInstanceIdentity(running.instance, instance))
      return networkUnknown(identity, "network_vm_instance_mismatch", plan);
    return {
      backend: "softnet",
      status: "policy_match",
      identity,
      revisionId: plan.revisionId,
      contractHash: plan.contractHash,
      policyHash: running.policy.policyHash,
      vm: {
        vmName: manifest.vmName,
        device: instance.device,
        inode: instance.inode,
        macAddress: instance.macAddress,
      },
      process: {
        pid: running.child.pid!,
        startedAt: running.startedAt,
      },
      control: { transport: "unix_stream_fd", connected: true },
      readback,
      observedAt: new Date().toISOString(),
    };
  }

  private async revokeNetworkOwned(
    identity: TartAllocationIdentity,
    network: TartNetworkPlan,
  ): Promise<TartInspection> {
    if (network.mode === "trusted_nat")
      return this.stopNatOwned(identity, network);
    let expected: ReturnType<typeof compileTartNetworkPolicy>;
    try {
      expected = compileTartNetworkPolicy(network);
    } catch (error) {
      return unknown(
        identity,
        error instanceof Error ? error.message : "tart_network_plan_invalid",
      );
    }
    await this.prepareDirectories();
    const manifestPath = this.manifestPath(identity);
    let manifest = await this.readManifest(manifestPath);
    const vmName = this.vmName(identity);
    if (!manifest) {
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return unknown(identity, "inventory_incomplete");
      if (inventory.names.has(vmName))
        return unknown(identity, "unmanifested_vm_name_collision");
      const receipt = notStartedReceipt(identity, network, vmName);
      await this.writeManifest(manifestPath, {
        version: 2,
        identity,
        highestControlVersion: identity.controlVersion,
        vmName,
        home: await this.homeIdentity(),
        phase: "released",
        networkPlan: network,
        networkLaunchIntent: false,
        networkCleanupReceipt: receipt,
      });
      return {
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
        networkCleanupReceipt: receipt,
      };
    }
    if (!sameOwner(manifest.identity, identity))
      return unknown(identity, "manifest_owner_mismatch");
    if (!(await this.matchesHome(manifest)))
      return unknown(identity, "tart_home_identity_changed");
    if (!acceptsFence(manifest, identity))
      return unknown(identity, "stale_control_fence");
    if (
      !manifest.networkPlan ||
      canonicalTartNetworkPlan(manifest.networkPlan) !==
        canonicalTartNetworkPlan(network)
    )
      return unknown(identity, "network_contract_changed");

    const savedReceipt = manifest.networkCleanupReceipt;
    if (
      manifest.phase !== "released" &&
      (savedReceipt?.status === "removed" ||
        savedReceipt?.status === "process_exited") &&
      sameActionIdentity(manifest.identity, identity) &&
      sameActionIdentity(savedReceipt.identity, identity) &&
      savedReceipt.revisionId === network.revisionId &&
      savedReceipt.contractHash === network.contractHash
    ) {
      const denyPolicy = compileDenyAllNetworkPolicy();
      if (
        !manifest.instance ||
        savedReceipt.vm.vmName !== vmName ||
        savedReceipt.vm.device !== manifest.instance.device ||
        savedReceipt.vm.inode !== manifest.instance.inode ||
        savedReceipt.vm.macAddress !== manifest.instance.macAddress ||
        !manifest.networkProcess ||
        savedReceipt.process.pid !== manifest.networkProcess.pid ||
        savedReceipt.process.startedAt !== manifest.networkProcess.startedAt ||
        (savedReceipt.status === "removed" &&
          (savedReceipt.policyHash !== denyPolicy.policyHash ||
            !sameSoftnetPolicy(savedReceipt.readback, denyPolicy))) ||
        (savedReceipt.status === "process_exited" &&
          savedReceipt.vmStopped !== true)
      )
        return unknown(identity, "network_release_receipt_mismatch");
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return unknown(identity, "inventory_incomplete");
      const row = inventory.rows.find((item) => item.Name === vmName);
      if (
        !row ||
        row.Source !== "local" ||
        row.Running ||
        row.State !== "stopped" ||
        (await this.verifyOwned(manifest)) !== "present"
      )
        return unknown(identity, "network_release_vm_stop_not_verified");
      return this.inspectOwned(identity);
    }

    if (manifest.phase === "released") {
      const receipt = manifest.networkCleanupReceipt;
      if (!receipt || receipt.status === "unknown")
        return unknown(identity, "network_release_receipt_missing");
      if (identity.controlVersion > manifest.highestControlVersion) {
        const reboundReceipt = { ...receipt, identity };
        manifest = {
          ...manifest,
          identity,
          highestControlVersion: identity.controlVersion,
          networkCleanupReceipt: reboundReceipt,
        };
        await this.writeManifest(manifestPath, manifest);
      }
      return this.inspectOwned(identity);
    }

    if (identity.controlVersion > manifest.highestControlVersion) {
      manifest = {
        ...manifest,
        identity,
        highestControlVersion: identity.controlVersion,
      };
      await this.writeManifest(manifestPath, manifest);
    } else if (!sameActionIdentity(manifest.identity, identity)) {
      return unknown(identity, "operation_fence_mismatch");
    }

    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete");
    const row = inventory.rows.find((item) => item.Name === vmName);
    if (!row) {
      if (manifest.networkLaunchIntent)
        return unknown(identity, "network_process_absence_unverified");
      const receipt = notStartedReceipt(identity, network, vmName);
      const released = {
        ...toTombstone(manifest),
        identity,
        highestControlVersion: identity.controlVersion,
        networkPlan: network,
        networkLaunchIntent: false,
        networkCleanupReceipt: receipt,
      };
      await this.writeManifest(manifestPath, released);
      return {
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
        networkCleanupReceipt: receipt,
      };
    }
    if (
      row.Source !== "local" ||
      (await this.verifyOwned(manifest)) !== "present"
    )
      return unknown(identity, "owned_vm_identity_or_inventory_mismatch");
    if (!manifest.networkLaunchIntent) {
      if (row.Running)
        return unknown(identity, "network_vm_running_without_owned_process");
      const receipt = notStartedReceipt(identity, network, vmName);
      manifest = { ...manifest, networkCleanupReceipt: receipt };
      await this.writeManifest(manifestPath, manifest);
      return this.inspectOwned(identity);
    }
    const running = this.children.get(vmName);
    const nativeProcess = manifest.networkProcess;
    if (!running || !nativeProcess)
      return unknown(identity, "network_process_untracked");
    if (
      !row.Running ||
      running.child.exitCode !== null ||
      running.child.pid !== nativeProcess.pid ||
      running.startedAt !== nativeProcess.startedAt ||
      nativeProcess.policyHash !== expected.policyHash ||
      running.policy.policyHash !== expected.policyHash
    )
      return unknown(identity, "network_process_identity_mismatch");
    const instance = manifest.instance;
    if (!instance || !sameInstanceIdentity(running.instance, instance))
      return unknown(identity, "network_vm_identity_mismatch");

    const denyPolicy = compileDenyAllNetworkPolicy();
    let readback;
    try {
      readback = await running.getPolicy();
      if (sameSoftnetPolicy(readback, expected)) {
        await running.setPolicy(denyPolicy.allow, denyPolicy.block);
        readback = await running.getPolicy();
      }
    } catch {
      return this.stopAfterNetworkControlFailure(
        identity,
        network,
        vmName,
        manifestPath,
        manifest,
        running,
        nativeProcess,
        instance,
      );
    }
    if (!sameSoftnetPolicy(readback, denyPolicy))
      return unknown(identity, "network_deny_policy_not_verified");

    try {
      await this.runShort(["stop", "--timeout", "5", vmName]);
    } catch (error) {
      return unknown(
        identity,
        error instanceof Error ? error.message : "tart_graceful_stop_unknown",
      );
    }
    const exitTimeout = commandBudget(undefined, RUN_EXIT_MS);
    if (exitTimeout <= 0 || !(await settlesWithin(running.exit, exitTimeout)))
      return unknown(identity, "network_process_exit_unverified");
    const exit = await running.exit;
    if (exit.code !== 0 || exit.signal !== null)
      return unknown(identity, "network_process_not_gracefully_stopped");
    const afterStop = await this.inventory();
    if (afterStop.status !== "complete")
      return unknown(identity, "inventory_incomplete_after_network_stop");
    const stopped = afterStop.rows.find((item) => item.Name === vmName);
    if (!stopped || stopped.Source !== "local" || stopped.Running)
      return unknown(identity, "vm_stop_not_verified");

    const receipt: TartNetworkCleanupReceipt = {
      backend: "softnet",
      status: "removed",
      identity,
      revisionId: network.revisionId,
      contractHash: network.contractHash,
      policyHash: denyPolicy.policyHash,
      vm: {
        vmName,
        device: instance.device,
        inode: instance.inode,
        macAddress: instance.macAddress,
      },
      process: { pid: nativeProcess.pid, startedAt: nativeProcess.startedAt },
      processExitObserved: true,
      readback,
      observedAt: new Date().toISOString(),
    };
    manifest = { ...manifest, networkCleanupReceipt: receipt };
    await this.writeManifest(manifestPath, manifest);
    return this.inspectOwned(identity);
  }

  private async stopAfterNetworkControlFailure(
    identity: TartAllocationIdentity,
    network: TartNetworkPlan,
    vmName: string,
    manifestPath: string,
    manifest: Manifest,
    running: RunningChild,
    nativeProcess: NonNullable<Manifest["networkProcess"]>,
    instance: NonNullable<Manifest["instance"]>,
  ): Promise<TartInspection> {
    try {
      await this.runShort(["stop", "--timeout", "5", vmName]);
    } catch {
      return unknown(identity, "network_control_unavailable");
    }
    const exitTimeout = commandBudget(undefined, RUN_EXIT_MS);
    if (exitTimeout <= 0 || !(await settlesWithin(running.exit, exitTimeout)))
      return unknown(identity, "network_process_exit_unverified");
    const exit = await running.exit;
    if (exit.code !== 0 || exit.signal !== null)
      return unknown(identity, "network_process_not_gracefully_stopped");
    const afterStop = await this.inventory();
    if (afterStop.status !== "complete")
      return unknown(identity, "inventory_incomplete_after_network_stop");
    const stopped = afterStop.rows.find((item) => item.Name === vmName);
    if (
      !stopped ||
      stopped.Source !== "local" ||
      stopped.Running ||
      stopped.State !== "stopped"
    )
      return unknown(identity, "vm_stop_not_verified");
    const observedInstance = await this.readInstanceIdentity(vmName);
    if (!observedInstance || !sameInstanceIdentity(instance, observedInstance))
      return unknown(identity, "network_vm_identity_mismatch_after_stop");

    const receipt: TartNetworkCleanupReceipt = {
      backend: "softnet",
      status: "process_exited",
      identity,
      revisionId: network.revisionId,
      contractHash: network.contractHash,
      vm: {
        vmName,
        device: instance.device,
        inode: instance.inode,
        macAddress: instance.macAddress,
      },
      process: { pid: nativeProcess.pid, startedAt: nativeProcess.startedAt },
      processExitObserved: true,
      vmStopped: true,
      observedAt: new Date().toISOString(),
    };
    await this.writeManifest(manifestPath, {
      ...manifest,
      networkCleanupReceipt: receipt,
    });
    return this.inspectOwned(identity);
  }

  private async destroyOwned(
    identity: TartAllocationIdentity,
  ): Promise<TartInspection> {
    await this.prepareDirectories();
    let manifest = await this.readManifest(this.manifestPath(identity));
    const vmName = this.vmName(identity);
    if (!manifest) {
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return unknown(identity, "inventory_incomplete");
      if (inventory.names.has(vmName))
        return unknown(identity, "unmanifested_vm_name_collision");
      await this.writeManifest(this.manifestPath(identity), {
        version: 2,
        identity,
        highestControlVersion: identity.controlVersion,
        vmName,
        home: await this.homeIdentity(),
        phase: "released",
      });
      return {
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
      };
    }
    if (!sameOwner(manifest.identity, identity))
      return unknown(identity, "manifest_owner_mismatch");
    if (!(await this.matchesHome(manifest)))
      return unknown(identity, "tart_home_identity_changed");
    if (!acceptsFence(manifest, identity))
      return unknown(identity, "stale_control_fence");
    if (
      manifest.networkPlan &&
      manifest.networkPlan.mode !== "trusted_nat" &&
      manifest.networkCleanupReceipt?.status !== "removed" &&
      manifest.networkCleanupReceipt?.status !== "process_exited" &&
      manifest.networkCleanupReceipt?.status !== "not_started"
    )
      return unknown(identity, "network_cleanup_not_verified");
    if (manifest.phase === "released") {
      if (identity.controlVersion > manifest.highestControlVersion) {
        manifest = {
          ...manifest,
          identity,
          highestControlVersion: identity.controlVersion,
        };
        await this.writeManifest(this.manifestPath(identity), manifest);
      }
      return this.inspectOwned(identity);
    }
    if (manifest.phase === "clone_intent" || !manifest.instance)
      return unknown(identity, "clone_identity_not_recorded");

    manifest = {
      ...manifest,
      identity,
      highestControlVersion: identity.controlVersion,
      phase: "deleting",
    };
    await this.writeManifest(this.manifestPath(identity), manifest);
    let inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete");
    if (!inventory.names.has(vmName)) {
      manifest = toTombstone(manifest);
      await this.writeManifest(this.manifestPath(identity), manifest);
      this.ownedRunningVMs.delete(vmName);
      return {
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
      };
    }
    if ((await this.verifyOwned(manifest)) !== "present")
      return unknown(identity, "owned_vm_identity_or_inventory_mismatch");
    const row = inventory.rows.find((item) => item.Name === vmName);
    if (!row || row.Source !== "local")
      return unknown(identity, "owned_vm_missing_from_cli_inventory");
    if (row.Running)
      return unknown(identity, "vm_running_after_network_revoke");
    if (!(await this.stopRunChild(vmName)))
      return unknown(identity, "run_process_exit_not_observed");
    inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete_after_stop");
    const stoppedRow = inventory.rows.find((item) => item.Name === vmName);
    if (
      !stoppedRow ||
      stoppedRow.Source !== "local" ||
      stoppedRow.Running ||
      stoppedRow.State !== "stopped"
    )
      return unknown(identity, "vm_stop_not_verified");
    if ((await this.verifyOwned(manifest)) !== "present")
      return unknown(identity, "owned_vm_identity_changed_before_delete");
    await this.runShort(["delete", vmName]);
    inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete_after_delete");
    if (inventory.names.has(vmName))
      return unknown(identity, "deletion_absence_not_verified");
    manifest = toTombstone(manifest);
    await this.writeManifest(this.manifestPath(identity), manifest);
    this.ownedRunningVMs.delete(vmName);
    return { presence: "absent", identity, inventoryCompleteness: "complete" };
  }

  private async prepareDirectories(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(this.manifestRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.vmRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.registryRoot, { recursive: true, mode: 0o700 });
    const [homeStat, manifestStat, registryStat] = await Promise.all([
      stat(this.home),
      stat(this.manifestRoot),
      stat(this.registryRoot),
    ]);
    if (
      (homeStat.mode & 0o077) !== 0 ||
      (manifestStat.mode & 0o077) !== 0 ||
      (registryStat.mode & 0o077) !== 0
    )
      throw new Error("tart_private_directory_permissions_required");
  }

  private async homeIdentity(): Promise<{
    path: string;
    device: string;
    inode: string;
  }> {
    const directory = await stat(this.home);
    return {
      path: this.home,
      device: String(directory.dev),
      inode: String(directory.ino),
    };
  }

  private async matchesHome(manifest: HomeBound): Promise<boolean> {
    const current = await this.homeIdentity();
    return (
      current.path === manifest.home.path &&
      current.device === manifest.home.device &&
      current.inode === manifest.home.inode
    );
  }

  private vmName(identity: TartAllocationIdentity): string {
    const key = createHash("sha256")
      .update(ownerKey(identity))
      .digest("hex")
      .slice(0, 32);
    return `hitchlet-${key}`;
  }

  private manifestPath(identity: TartAllocationIdentity): string {
    const key = createHash("sha256").update(ownerKey(identity)).digest("hex");
    return join(this.manifestRoot, `${key}.json`);
  }

  private async readManifest(
    path: string,
  ): Promise<StoredManifest | undefined> {
    try {
      return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new Error("tart_manifest_unreadable");
    }
  }

  private async writeManifest(
    path: string,
    manifest: StoredManifest,
  ): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(tmp, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  private templateRegistryPath(name: string): string {
    const filename = createHash("sha256").update(name).digest("hex");
    return join(this.registryRoot, `${filename}.json`);
  }

  private async readTemplateRegistry(
    name: string,
  ): Promise<TemplateRegistryRecord | undefined> {
    const record = await this.readTemplateRegistryByPath(
      this.templateRegistryPath(name),
    );
    return record?.templateRef.name === name ? record : undefined;
  }

  private async readTemplateRegistryByPath(
    path: string,
  ): Promise<TemplateRegistryRecord | undefined> {
    try {
      const parsed = templateRegistrySchema.safeParse(
        JSON.parse(await readFile(path, "utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      return undefined;
    }
  }

  private async writeTemplateRegistry(
    name: string,
    record: TemplateRegistryRecord,
  ): Promise<void> {
    const path = this.templateRegistryPath(name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async templateFilesUnchanged(
    record: TemplateRegistryRecord,
  ): Promise<boolean> {
    if (record.files.length !== TEMPLATE_BUNDLE_FILES.length) return false;
    for (const proof of record.files) {
      try {
        const filePath = join(this.vmRoot, record.templateRef.name, proof.name);
        const link = await lstat(filePath, { bigint: true });
        if (!link.isFile() || link.isSymbolicLink()) return false;
        const current = await stat(filePath, { bigint: true });
        if (
          String(current.dev) !== proof.device ||
          String(current.ino) !== proof.inode ||
          String(current.size) !== proof.size ||
          String(current.mtimeNs) !== proof.mtimeNs
        )
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async inventory(
    deadlineMs?: number,
  ): Promise<
    | { status: "complete"; names: Set<string>; rows: InventoryRow[] }
    | { status: "unknown" }
  > {
    try {
      const { stdout } = await this.runShort(
        ["list", "--source", "local", "--format", "json"],
        commandBudget(deadlineMs),
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return { status: "unknown" };
      const rows = parsed.map((row) => {
        if (
          typeof row !== "object" ||
          row === null ||
          typeof (row as Record<string, unknown>).Name !== "string" ||
          typeof (row as Record<string, unknown>).Source !== "string" ||
          typeof (row as Record<string, unknown>).Running !== "boolean" ||
          typeof (row as Record<string, unknown>).State !== "string"
        )
          throw new Error("inventory_shape");
        return row as InventoryRow;
      });
      if (
        rows.some((row) => row.Source !== "local") ||
        new Set(rows.map((row) => row.Name)).size !== rows.length
      )
        return { status: "unknown" };
      const diskNames = await readdir(this.vmRoot, { withFileTypes: true });
      const names = diskNames
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const cliNames = rows.map((row) => row.Name).sort();
      if (JSON.stringify(names) !== JSON.stringify(cliNames))
        return { status: "unknown" };
      return { status: "complete", names: new Set(names), rows };
    } catch {
      return { status: "unknown" };
    }
  }

  private async readInstanceIdentity(
    vmName: string,
  ): Promise<TartInstanceIdentity | undefined> {
    try {
      const directory = join(this.vmRoot, vmName);
      const [directoryStat, configText] = await Promise.all([
        stat(directory),
        readFile(join(directory, "config.json"), "utf8"),
      ]);
      const parsed: unknown = JSON.parse(configText);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const config = parsed as Record<string, unknown>;
      if (
        typeof config.macAddress !== "string" ||
        !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(config.macAddress) ||
        (config.os !== "darwin" && config.os !== "linux") ||
        config.arch !== "arm64"
      )
        return undefined;
      return {
        device: String(directoryStat.dev),
        inode: String(directoryStat.ino),
        macAddress: config.macAddress.toLowerCase(),
        guestOS: config.os,
        arch: "arm64",
      };
    } catch {
      return undefined;
    }
  }

  private async readVmConfiguration(
    vmName: string,
  ): Promise<{ resources: TartResourceSpec } | undefined> {
    try {
      const config: unknown = JSON.parse(
        await readFile(join(this.vmRoot, vmName, "config.json"), "utf8"),
      );
      if (typeof config !== "object" || config === null) return undefined;
      const value = config as Record<string, unknown>;
      const parsed = tartResourceSpecSchema.safeParse({
        cpus: value.cpuCount,
        memoryMiB:
          typeof value.memorySize === "number"
            ? value.memorySize / (1024 * 1024)
            : undefined,
      });
      return parsed.success ? { resources: parsed.data } : undefined;
    } catch {
      return undefined;
    }
  }

  private async readTemplateFacts(
    templateName: string,
  ): Promise<TemplateFacts | undefined> {
    try {
      const path = join(this.vmRoot, templateName);
      const [directoryStat, configText] = await Promise.all([
        stat(path),
        readFile(join(path, "config.json"), "utf8"),
      ]);
      const parsed: unknown = JSON.parse(configText);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const config = parsed as Record<string, unknown>;
      if (
        (config.os !== "darwin" && config.os !== "linux") ||
        config.arch !== "arm64" ||
        typeof config.macAddress !== "string" ||
        !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(config.macAddress)
      )
        return undefined;
      return {
        ref: {
          source: "local",
          name: templateName,
          guestOS: config.os,
          guestArch: "arm64",
          configSha256: createHash("sha256").update(configText).digest("hex"),
        },
        identity: {
          device: String(directoryStat.dev),
          inode: String(directoryStat.ino),
          macAddress: config.macAddress.toLowerCase(),
        },
      };
    } catch {
      return undefined;
    }
  }

  private async verifyOwned(
    manifest: Manifest,
  ): Promise<"present" | "absent" | "unknown"> {
    const inventory = await this.inventory();
    if (inventory.status !== "complete") return "unknown";
    if (!inventory.names.has(manifest.vmName)) return "absent";
    if (!manifest.instance) return "unknown";
    const instance = await this.readInstanceIdentity(manifest.vmName);
    if (!instance || !sameInstanceIdentity(manifest.instance, instance))
      return "unknown";
    return "present";
  }

  private async runShort(
    args: readonly string[],
    timeout = SHORT_COMMAND_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    const boundedTimeout = Math.floor(
      Math.min(
        timeout,
        (currentCommandDeadlineMs() ?? Number.POSITIVE_INFINITY) - Date.now(),
      ),
    );
    if (!Number.isFinite(boundedTimeout) || boundedTimeout <= 0)
      throw new Error("tart_command_deadline_expired");
    try {
      return await execFileAsync(this.executable, [...args], {
        cwd: this.home,
        env: this.env,
        shell: false,
        timeout: boundedTimeout,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
      });
    } catch {
      throw new Error("tart_cli_command_failed");
    }
  }

  private async startNatRun(
    vmName: string,
    manifestPath: string,
    manifest: Manifest,
  ): Promise<void> {
    if (this.closed) throw new Error("tart_driver_closed");
    if (this.natChildren.has(vmName))
      throw new Error("nat_run_already_in_flight");
    await this.writeManifest(manifestPath, {
      ...manifest,
      networkLaunchIntent: true,
    });
    const child = spawn(this.executable, ["run", "--no-graphics", vmName], {
      cwd: this.home,
      env: this.env,
      shell: false,
      stdio: "ignore",
    });
    const exit = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    this.natChildren.set(vmName, { child, exit });
    void exit.then(() => {
      if (this.natChildren.get(vmName)?.child === child)
        this.natChildren.delete(vmName);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  }

  /** Stop only the exact manifested VM; no firewall/control-FD receipt exists for NAT. */
  private async stopNatOwned(
    identity: TartAllocationIdentity,
    network: TartNetworkPlan,
  ): Promise<TartInspection> {
    await this.prepareDirectories();
    const manifestPath = this.manifestPath(identity);
    let manifest = await this.readManifest(manifestPath);
    if (!manifest) return this.inspectOwned(identity);
    if (!sameOwner(manifest.identity, identity))
      return unknown(identity, "manifest_owner_mismatch");
    if (!(await this.matchesHome(manifest)))
      return unknown(identity, "tart_home_identity_changed");
    if (!acceptsFence(manifest, identity))
      return unknown(identity, "stale_control_fence");
    if (
      !manifest.networkPlan ||
      canonicalTartNetworkPlan(manifest.networkPlan) !==
        canonicalTartNetworkPlan(network)
    )
      return unknown(identity, "network_contract_changed");
    if (manifest.phase === "released") {
      if (identity.controlVersion > manifest.highestControlVersion)
        await this.writeManifest(manifestPath, {
          ...manifest,
          identity,
          highestControlVersion: identity.controlVersion,
        });
      return this.inspectOwned(identity);
    }
    if (!manifest.instance)
      return unknown(identity, "clone_identity_not_recorded");
    if (
      identity.controlVersion === manifest.highestControlVersion &&
      !sameActionIdentity(manifest.identity, identity)
    )
      return unknown(identity, "operation_fence_mismatch");
    manifest = {
      ...manifest,
      identity,
      highestControlVersion: identity.controlVersion,
    };
    await this.writeManifest(manifestPath, manifest);
    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      return unknown(identity, "inventory_incomplete");
    const row = inventory.rows.find((item) => item.Name === manifest.vmName);
    if (!row) return this.inspectOwned(identity);
    if (
      row.Source !== "local" ||
      (await this.verifyOwned(manifest)) !== "present"
    )
      return unknown(identity, "owned_vm_identity_or_inventory_mismatch");
    if (row.Running) await this.runShort(["stop", manifest.vmName]);
    if (!(await this.stopRunChild(manifest.vmName)))
      return unknown(identity, "run_process_exit_not_observed");
    const stopped = await this.inventory();
    if (stopped.status !== "complete")
      return unknown(identity, "inventory_incomplete_after_stop");
    const current = stopped.rows.find((item) => item.Name === manifest.vmName);
    if (
      !current ||
      current.Source !== "local" ||
      current.Running ||
      current.State !== "stopped" ||
      (await this.verifyOwned(manifest)) !== "present"
    )
      return unknown(identity, "vm_stop_not_verified");
    return this.inspectOwned(identity);
  }

  private async startRun(
    vmName: string,
    identity: TartAllocationIdentity,
    networkPlan: TartNetworkPlan,
    policy: ReturnType<typeof compileTartNetworkPolicy>,
    manifestPath: string,
    manifest: Manifest,
    instance: TartInstanceIdentity,
  ): Promise<RunningChild> {
    if (this.closed) throw new Error("tart_driver_closed");
    const existing = this.children.get(vmName);
    if (existing) {
      if (
        existing.policy.policyHash !== policy.policyHash ||
        !sameInstanceIdentity(existing.instance, instance)
      )
        throw new Error("network_process_binding_mismatch");
      const readback = await existing.getPolicy();
      if (!sameSoftnetPolicy(readback, policy))
        throw new Error("network_policy_readback_mismatch");
      return existing;
    }
    if ((currentCommandDeadlineMs() ?? Number.POSITIVE_INFINITY) <= Date.now())
      throw new Error("tart_command_deadline_expired");
    if (!this.networkAdapter)
      throw new Error("tart_network_adapter_unavailable");
    if (manifest.networkLaunchIntent)
      throw new Error("network_launch_outcome_unknown");

    const launching = { ...manifest, networkLaunchIntent: true };
    await this.writeManifest(manifestPath, launching);
    const session = await this.networkAdapter.launch({
      executable: this.executable,
      home: this.home,
      env: this.env,
      vmName,
      policy,
    });
    if (!session.child.pid) {
      session.child.kill("SIGINT");
      throw new Error("tart_network_process_identity_unavailable");
    }
    const running: RunningChild = { ...session, policy, instance };
    this.children.set(vmName, running);
    void session.exit.then(() => {
      if (this.children.get(vmName)?.child === session.child)
        this.children.delete(vmName);
    });
    const processManifest = {
      ...launching,
      networkProcess: {
        pid: session.child.pid,
        startedAt: session.startedAt,
        policyHash: policy.policyHash,
      },
    };
    await this.writeManifest(manifestPath, processManifest);
    const readback = await session.getPolicy();
    if (!sameSoftnetPolicy(readback, policy)) {
      await this.stopRunChild(vmName);
      throw new Error("network_policy_readback_mismatch");
    }
    if (
      !sameOwner(identity, manifest.identity) ||
      canonicalTartNetworkPlan(processManifest.networkPlan) !==
        canonicalTartNetworkPlan(networkPlan)
    )
      throw new Error("network_manifest_binding_mismatch");
    return running;
  }

  private async discoverIp(vmName: string): Promise<string | undefined> {
    const deadline = Math.min(
      Date.now() + IP_DEADLINE_MS,
      currentCommandDeadlineMs() ?? Number.POSITIVE_INFINITY,
    );
    while (Date.now() < deadline) {
      const current = await this.inventory(deadline);
      if (current.status !== "complete" || !current.names.has(vmName))
        return undefined;
      const row = current.rows.find((item) => item.Name === vmName);
      if (row?.Running) {
        try {
          const { stdout } = await this.runShort(
            ["ip", "--wait", "0", vmName],
            commandBudget(deadline),
          );
          const address = stdout.trim();
          if (
            /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) &&
            address.split(".").every((part) => Number(part) <= 255)
          )
            return address;
        } catch {
          // IP discovery is read-only and retried within the fixed deadline.
        }
      }
      if (Date.now() < deadline)
        await new Promise((resolvePromise) =>
          setTimeout(
            resolvePromise,
            Math.min(IP_POLL_MS, deadline - Date.now()),
          ),
        );
    }
    return undefined;
  }

  private async stopRunChild(vmName: string): Promise<boolean> {
    const nat = this.natChildren.get(vmName);
    if (nat) {
      nat.child.kill("SIGINT");
      if (!(await settlesWithin(nat.exit, RUN_EXIT_MS))) return false;
      this.natChildren.delete(vmName);
    }
    const running = this.children.get(vmName);
    if (!running) return true;
    running.child.kill("SIGINT");
    if (await settlesWithin(running.exit, RUN_EXIT_MS)) {
      this.children.delete(vmName);
      return true;
    }
    running.child.kill("SIGKILL");
    if (await settlesWithin(running.exit, RUN_EXIT_MS)) {
      this.children.delete(vmName);
      return true;
    }
    return false;
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function ownerKey(identity: TartAllocationIdentity): string {
  return JSON.stringify(tartAllocationOwnerTuple(identity));
}

function toTombstone(manifest: Manifest): ReleasedTombstone {
  return {
    version: 2,
    identity: manifest.identity,
    highestControlVersion: manifest.highestControlVersion,
    vmName: manifest.vmName,
    home: manifest.home,
    phase: "released",
    networkPlan: manifest.networkPlan,
    ...(manifest.networkLaunchIntent !== undefined
      ? { networkLaunchIntent: manifest.networkLaunchIntent }
      : {}),
    ...(manifest.networkProcess
      ? { networkProcess: manifest.networkProcess }
      : {}),
    ...(manifest.networkCleanupReceipt
      ? { networkCleanupReceipt: manifest.networkCleanupReceipt }
      : {}),
  };
}

function sameOwner(
  left: TartAllocationIdentity,
  right: TartAllocationIdentity,
): boolean {
  return ownerKey(left) === ownerKey(right);
}

function acceptsFence(
  manifest: StoredManifest,
  identity: TartAllocationIdentity,
): boolean {
  return (
    identity.controlVersion > manifest.highestControlVersion ||
    (identity.controlVersion === manifest.highestControlVersion &&
      identity.operationId === manifest.identity.operationId)
  );
}

function sameActionIdentity(
  left: TartAllocationIdentity,
  right: TartAllocationIdentity,
): boolean {
  return (
    sameOwner(left, right) &&
    left.operationId === right.operationId &&
    left.controlVersion === right.controlVersion
  );
}

function sameResources(
  left: TartResourceSpec,
  right: TartResourceSpec,
): boolean {
  return left.cpus === right.cpus && left.memoryMiB === right.memoryMiB;
}

function sameInstanceIdentity(
  left: TartInstanceIdentity,
  right: TartInstanceIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.macAddress === right.macAddress &&
    left.guestOS === right.guestOS &&
    left.arch === right.arch
  );
}

function sameTemplateRef(
  left: TartLocalTemplateRef,
  right: TartLocalTemplateRef,
): boolean {
  return (
    left.source === right.source &&
    left.name === right.name &&
    left.guestOS === right.guestOS &&
    left.guestArch === right.guestArch &&
    left.configSha256 === right.configSha256
  );
}

function sameTemplateFacts(
  ref: TartLocalTemplateRef,
  identity: Manifest["templateIdentity"],
  actual: TemplateFacts,
): boolean {
  return (
    identity !== undefined &&
    sameTemplateRef(ref, actual.ref) &&
    identity.device === actual.identity.device &&
    identity.inode === actual.identity.inode &&
    identity.macAddress === actual.identity.macAddress
  );
}

function normalizeVmState(
  row: InventoryRow,
): "running" | "stopped" | "suspended" {
  if (row.Running) return "running";
  return row.State === "suspended" ? "suspended" : "stopped";
}

function unknown(
  identity: TartAllocationIdentity,
  reason: string,
): TartInspection {
  return { presence: "unknown", identity, reason };
}

function networkUnknown(
  identity: TartAllocationIdentity,
  reason: string,
  plan?: TartNetworkPlan,
): TartNetworkObservation {
  return {
    backend: "softnet",
    status: "unknown",
    identity,
    ...(plan
      ? { revisionId: plan.revisionId, contractHash: plan.contractHash }
      : {}),
    reason,
    observedAt: new Date().toISOString(),
  };
}

function notStartedReceipt(
  identity: TartAllocationIdentity,
  network: TartNetworkPlan,
  vmName: string,
): TartNetworkCleanupReceipt {
  return {
    backend: "softnet",
    status: "not_started",
    identity,
    revisionId: network.revisionId,
    contractHash: network.contractHash,
    vmName,
    observedAt: new Date().toISOString(),
  };
}

function compileDenyAllNetworkPolicy(): ReturnType<
  typeof compileTartNetworkPolicy
> {
  const allow: string[] = [];
  const block = ["in 0.0.0.0/0", "out 0.0.0.0/0"];
  return { allow, block, policyHash: hashSoftnetPolicy(allow, block) };
}

async function hashTemplateFile(
  path: string,
  name: (typeof TEMPLATE_BUNDLE_FILES)[number],
): Promise<z.infer<typeof templateFileProofSchema>> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("tart_template_bundle_file_invalid");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  )
    throw new Error("tart_template_bundle_file_changed_while_sealing");
  return templateFileProofSchema.parse({
    name,
    device: String(after.dev),
    inode: String(after.ino),
    size: String(after.size),
    mtimeNs: String(after.mtimeNs),
    sha256: digest.digest("hex"),
  });
}

function templateProof(
  record: TemplateRegistryRecord,
): TartRuntimeTemplateProof {
  return {
    templateRef: record.templateRef,
    artifactDigest: record.artifactDigest,
    proofKind: record.proofKind,
    sealedAt: record.sealedAt,
  };
}

function templateArtifactDigest(
  templateRef: TartLocalTemplateRef,
  files: readonly z.infer<typeof templateFileProofSchema>[],
): string {
  const bundleManifest = {
    format: "hitchlet_tart_local_bundle_v1",
    templateRef,
    files: files
      .map(({ name, size, sha256 }) => ({ name, size, sha256 }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  return `sha256:${createHash("sha256").update(canonical(bundleManifest)).digest("hex")}`;
}

function isIPv4(value: string): boolean {
  return (
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split(".").every((part) => Number(part) <= 255)
  );
}

function validBootstrapPublicKeyFingerprints(
  request: TartGuestBootstrapRequest,
): boolean {
  const actual = sshPublicKeyFingerprint(request.clientPublicKey);
  return (
    actual !== undefined &&
    actual === request.clientPublicKeyFingerprint.replace(/=+$/, "")
  );
}

function sshPublicKeyFingerprint(publicKey: string): string | undefined {
  const [algorithm, encoded] = publicKey.split(" ");
  if (!algorithm || !encoded) return undefined;
  const blob = Buffer.from(encoded, "base64");
  if (blob.length < 8) return undefined;
  const algorithmLength = blob.readUInt32BE(0);
  if (algorithmLength < 1 || algorithmLength > blob.length - 4)
    return undefined;
  const wireAlgorithm = blob.subarray(4, 4 + algorithmLength).toString("ascii");
  if (wireAlgorithm !== algorithm) return undefined;
  const digest = createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/, "");
  return `SHA256:${digest}`;
}

function commandBudget(
  deadlineMs?: number,
  nativeBudgetMs = SHORT_COMMAND_MS,
): number {
  const actionDeadline = currentCommandDeadlineMs();
  return Math.floor(
    Math.min(
      nativeBudgetMs,
      deadlineMs === undefined
        ? Number.POSITIVE_INFINITY
        : deadlineMs - Date.now(),
      actionDeadline === undefined
        ? Number.POSITIVE_INFINITY
        : actionDeadline - Date.now(),
    ),
  );
}

/** Capture the lexical helper in node -e; its ambient module export changes after stdin resumes. */
export function tartGuestBootstrapProgram(helperSource: string): string {
  return `${helperSource}\n;let __input="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>__input+=c);process.stdin.on("end",()=>{try{const __result=runGuestBootstrap(JSON.parse(__input));process.stdout.write(JSON.stringify(__result)+"\\n")}catch(__error){const __code=__error&&__error.code==="guest_ssh_port_22_in_use"?__error.code:"guest_bootstrap_failed";process.stderr.write(__code+"\\n");process.exitCode=1}});`;
}
