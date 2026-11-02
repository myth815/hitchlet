import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  open,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import {
  tartAllocationOwnerTuple,
  tartAllocationIdentitySchema,
  tartGuestBootstrapReceiptSchema,
  tartGuestBootstrapRequestSchema,
  tartLocalTemplateRefSchema,
  tartReconcileRequestSchema,
  tartResourceSpecSchema,
  type TartAllocationIdentity,
  type TartGuestBootstrapReceipt,
  type TartGuestBootstrapRequest,
  type TartInspection,
  type TartLocalTemplateRef,
  type TartReconcileRequest,
  type TartResourceSpec,
} from "@hitchlet/contracts/internal";

const execFileAsync = promisify(execFile);
const SHORT_COMMAND_MS = 15_000;
const CLONE_COMMAND_MS = 120_000;
const IP_DEADLINE_MS = 90_000;
const IP_POLL_MS = 1_000;
const RUN_EXIT_MS = 5_000;
const MAX_OUTPUT = 1024 * 1024;

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
  .object({ ...manifestBase, phase: z.literal("released") })
  .strict();
const manifestSchema = z.union([ownedManifestSchema, releasedTombstoneSchema]);

type Manifest = z.infer<typeof ownedManifestSchema>;
type ReleasedTombstone = z.infer<typeof releasedTombstoneSchema>;
type StoredManifest = Manifest | ReleasedTombstone;
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
type RunningChild = { child: ChildProcess; exit: Promise<void> };

export type TartDriverOptions = Readonly<{
  /** Dedicated Tart home; never point this at a user's regular Tart home. */
  tartHome: string;
  /** Durable, private directory for this driver's ownership manifests. */
  manifestDirectory: string;
  /** Absolute executable path. Production callers fix this to their installed Tart binary. */
  executable: string;
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
  private readonly executable: string;
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
    this.executable = options.executable;
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

  recordBootstrapReceipt(
    rawIdentity: unknown,
    rawRequest: unknown,
    rawReceipt: unknown,
  ): Promise<TartInspection> {
    const identity = tartAllocationIdentitySchema.parse(rawIdentity);
    const request = tartGuestBootstrapRequestSchema.parse(rawRequest);
    const receipt = tartGuestBootstrapReceiptSchema.parse(rawReceipt);
    return this.exclusive(ownerKey(identity), () =>
      this.recordBootstrapReceiptOwned(identity, request, receipt),
    );
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
    await this.prepareDirectories();
    const { identity } = request;
    const vmName = this.vmName(identity);
    const manifestPath = this.manifestPath(identity);
    let manifest = await this.readManifest(manifestPath);
    const freshIntent = manifest === undefined;

    if (manifest && !sameOwner(manifest.identity, identity))
      return unknown(identity, "manifest_owner_mismatch");
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
    if (!row.Running) await this.startRun(vmName);
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
        };
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
    return {
      presence: "present",
      identity: manifest.identity,
      vmName: manifest.vmName,
      state: normalizeVmState(row),
      resources: observed.resources,
      bootstrapStatus: !manifest.bootstrapRequest
        ? "not_requested"
        : (manifest.bootstrapReceipt?.status ?? "pending"),
      ...(ipAddress ? { ipAddress } : {}),
      ...(manifest.bootstrapReceipt
        ? { bootstrapReceipt: manifest.bootstrapReceipt }
        : {}),
    };
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
    if (row.Running) await this.runShort(["stop", "--timeout", "5", vmName]);
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
    const [homeStat, manifestStat] = await Promise.all([
      stat(this.home),
      stat(this.manifestRoot),
    ]);
    if ((homeStat.mode & 0o077) !== 0 || (manifestStat.mode & 0o077) !== 0)
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

  private async matchesHome(manifest: StoredManifest): Promise<boolean> {
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
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error("tart_command_deadline_expired");
    try {
      return await execFileAsync(this.executable, [...args], {
        cwd: this.home,
        env: this.env,
        shell: false,
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
      });
    } catch {
      throw new Error("tart_cli_command_failed");
    }
  }

  private async startRun(vmName: string): Promise<void> {
    if (this.children.has(vmName)) return;
    const child = spawn(this.executable, ["run", "--no-graphics", vmName], {
      cwd: this.home,
      env: this.env,
      shell: false,
      stdio: "ignore",
    });
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    child.once("error", () => resolveExit());
    child.once("exit", () => resolveExit());
    this.children.set(vmName, { child, exit });
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("tart_run_start_timeout")),
        5_000,
      );
      child.once("spawn", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("tart_run_start_failed"));
      });
    }).catch((error: unknown) => {
      this.children.delete(vmName);
      throw error;
    });
    void exit.then(() => {
      if (this.children.get(vmName)?.child === child)
        this.children.delete(vmName);
    });
  }

  private async discoverIp(vmName: string): Promise<string | undefined> {
    const deadline = Date.now() + IP_DEADLINE_MS;
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

function commandBudget(deadlineMs?: number): number {
  return Math.floor(
    Math.min(
      SHORT_COMMAND_MS,
      deadlineMs === undefined ? SHORT_COMMAND_MS : deadlineMs - Date.now(),
    ),
  );
}
