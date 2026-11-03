import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import ssh2 from "ssh2";
import {
  hyperVInspectionSchema,
  hyperVGuestBootstrapRequestSchema,
  hyperVGuestBootstrapReceiptSchema,
  type HyperVInspection,
  type HyperVRequest,
  type HyperVGuestBootstrapRequest,
  type VmAllocationIdentity,
} from "@hitchlet/contracts/internal";
import type { SQLiteAccessMaterialStore } from "../storage/access-material-store.js";
import { resourceManifest } from "../domain/resource-manifest.js";
import { ExecutionProviderDispatcher } from "./execution-dispatcher.js";
import type {
  ExecutionMode,
  ExecutionSelection,
} from "./execution-registry.js";
import type {
  ExecutionPort,
  ProvisionPlan,
  ResourceJournal,
  OwnedResource,
  InventoryEvidence,
  ReadyReceipt,
  CleanupReceipt,
  Inspection,
} from "./port.js";

export type HyperVRuntimePort = Readonly<{
  inspect(identity: VmAllocationIdentity): Promise<HyperVInspection>;
  reconcile(request: HyperVRequest): Promise<HyperVInspection>;
  bootstrapApply(
    request: HyperVGuestBootstrapRequest,
  ): Promise<HyperVInspection>;
  stop(identity: VmAllocationIdentity): Promise<HyperVInspection>;
  destroy(identity: VmAllocationIdentity): Promise<HyperVInspection>;
}>;
type Binding = {
  runtimeIdentityId: string;
  connectionRevisionId: string;
  artifactDigest: string;
};
export type ResolvedHyperVRuntime = Binding &
  Readonly<{
    template: HyperVRequest["template"];
    switchName: string;
    runtime: HyperVRuntimePort;
  }>;
export type ResolvedHyperVCleanupRuntime = Binding &
  Readonly<{
    runtime: Pick<HyperVRuntimePort, "inspect" | "stop" | "destroy">;
  }>;
export type HyperVSshEvidence = Readonly<{
  authenticated: true;
  username: string;
  hostKeyFingerprint: string;
  clientPublicKeyFingerprint: string;
  guestOs: "windows" | "linux";
  architecture: "amd64";
  scratchWritable: true;
}>;
export type HyperVExecutionProviderOptions = Readonly<{
  resolveRuntime(plan: ProvisionPlan): Promise<ResolvedHyperVRuntime>;
  /** Caller verifies the exact durable cleanup Operation and effective credentials; no template/publish qualification needed. */
  resolveCleanupRuntime(
    plan: ProvisionPlan,
    authorization: NonNullable<ProvisionPlan["cleanupAuthorization"]>,
  ): Promise<ResolvedHyperVCleanupRuntime>;
  accessMaterials: Pick<
    SQLiteAccessMaterialStore,
    "getOrCreate" | "readExisting"
  >;
  ssh: {
    verify(
      input: Readonly<{
        host: string;
        port: 22;
        username: string;
        privateKey: string;
        hostPublicKey: string;
        hostKeyFingerprint: string;
        clientPublicKeyFingerprint: string;
        guestOs: "windows" | "linux";
        architecture: "amd64";
        deadlineMs: number;
      }>,
    ): Promise<HyperVSshEvidence>;
  };
  now?: () => number;
}>;
/** Existing ExecutionPort adapter; native execution and guest initialization remain explicit ports. */
export class HyperVExecutionProvider implements ExecutionPort {
  private readonly now: () => number;
  constructor(private readonly options: HyperVExecutionProviderOptions) {
    this.now = options.now ?? Date.now;
  }
  async resolveMounts(plan: ProvisionPlan) {
    assertPlan(plan);
    return [];
  }
  async create(
    plan: ProvisionPlan,
    journal: ResourceJournal,
  ): Promise<readonly OwnedResource[]> {
    assertNewWork(plan);
    assertPlan(plan);
    if (!journal.beforeCreate || !journal.assertActive)
      throw Error("Hyper-V requires a durable resource journal");
    const resolved = await this.runtime(plan);
    let observed = await inspect(resolved.runtime, plan);
    if (observed.presence === "unknown")
      throw Error("Hyper-V creation inventory is unknown");
    if (observed.presence === "absent")
      await journal.beforeCreate({
        kind: "vm",
        name: "hyperv-" + hash(owner(plan.identity)),
        requestHash: hash({
          identity: plan.identity,
          template: resolved.template,
          switchName: resolved.switchName,
          resources: plan.resources,
        }),
      });
    else await journal.recordCreated(this.resource(plan, observed));
    await journal.assertActive();
    observed = hyperVInspectionSchema.parse(
      await resolved.runtime.reconcile({
        identity: plan.identity,
        template: resolved.template,
        switchName: resolved.switchName,
        resources: {
          cpus: plan.resources.limit.cpuMillis / 1000,
          memoryMiB: plan.resources.limit.memoryMiB,
        },
      }),
    );
    assertIdentity(observed.identity, plan.identity);
    assertVm(observed, plan);
    const resource = this.resource(plan, observed);
    await journal.recordCreated(resource);
    return [resource];
  }
  async inspect(plan: ProvisionPlan): Promise<Inspection> {
    try {
      const resolved =
        plan.executionPhase === "cleanup"
          ? await this.cleanupRuntime(plan)
          : await this.runtime(plan);
      const got = await inspect(resolved.runtime, plan);
      if (got.presence === "unknown")
        return { presence: "unknown", reason: "inventory_incomplete" };
      if (got.presence === "absent")
        return {
          presence: "absent",
          evidence: {
            completeness: "complete",
            identity: plan.identity,
            runtime: binding(plan),
          },
        };
      if (plan.executionPhase === "observe" && got.vm?.state !== "running")
        return {
          presence: "present",
          evidence: {
            completeness: "complete",
            identity: plan.identity,
            runtime: binding(plan),
            objects: [this.resource(plan, got)],
          },
          integrity: { state: "lost", reason: "native_vm_not_running" },
        };
      if (plan.executionPhase !== "cleanup") assertVm(got, plan);
      if (plan.executionPhase === "observe") {
        const receipt = got.bootstrapReceipt;
        const material = await this.options.accessMaterials.readExisting(
          plan.identity.allocationId,
        );
        if (
          got.bootstrapStatus !== "applied" ||
          !receipt ||
          !material ||
          !got.vm
        )
          return {
            presence: "present",
            evidence: {
              completeness: "complete",
              identity: plan.identity,
              runtime: binding(plan),
              objects: [this.resource(plan, got)],
            },
            integrity: {
              state: "lost",
              reason: "guest_bootstrap_or_access_material_missing",
            },
          };
        assertIdentity(receipt.identity, plan.identity);
        const host = got.vm.ipv4.find(isIPv4);
        if (
          !host ||
          receipt.vmId !== got.vm.id ||
          receipt.account !== plan.access.account ||
          receipt.guestOs !== plan.artifact.guestOS ||
          receipt.architecture !== "amd64" ||
          fingerprint(receipt.hostPublicKey) !== receipt.hostKeyFingerprint ||
          fingerprint(material.publicKey) !==
            receipt.clientPublicKeyFingerprint ||
          receipt.clientPublicKeyFingerprint !== material.fingerprint ||
          this.now() >= plan.deadlineMs
        )
          throw Error("Hyper-V observed access facts changed");
        const probe = await this.options.ssh.verify({
          host,
          port: 22,
          username: receipt.account,
          privateKey: material.privateKey,
          hostPublicKey: receipt.hostPublicKey,
          hostKeyFingerprint: receipt.hostKeyFingerprint,
          clientPublicKeyFingerprint: material.fingerprint,
          guestOs: receipt.guestOs,
          architecture: "amd64",
          deadlineMs: plan.deadlineMs,
        });
        if (
          probe.authenticated !== true ||
          probe.username !== receipt.account ||
          probe.guestOs !== receipt.guestOs ||
          probe.architecture !== "amd64" ||
          probe.scratchWritable !== true ||
          probe.hostKeyFingerprint !== receipt.hostKeyFingerprint ||
          probe.clientPublicKeyFingerprint !== material.fingerprint ||
          this.now() >= plan.deadlineMs
        )
          throw Error("Hyper-V observed SSH evidence mismatch");
        const final = await inspect(resolved.runtime, plan);
        assertVm(final, plan);
        if (
          final.vm.id !== got.vm.id ||
          !final.vm.ipv4.includes(host) ||
          !equal(final.bootstrapReceipt, receipt)
        )
          throw Error("Hyper-V observed native identity changed");
        return {
          presence: "present",
          evidence: {
            completeness: "complete",
            identity: plan.identity,
            runtime: binding(plan),
            objects: [this.resource(plan, final)],
          },
          integrity: { state: "healthy" },
          accessEndpointUpdate: { host },
        };
      }
      return {
        presence: "present",
        evidence: {
          completeness: "complete",
          identity: plan.identity,
          runtime: binding(plan),
          objects: [this.resource(plan, got)],
        },
      };
    } catch {
      return { presence: "unknown", reason: "inventory_incomplete" };
    }
  }
  async ready(
    plan: ProvisionPlan,
    inventory: InventoryEvidence,
  ): Promise<ReadyReceipt> {
    assertNewWork(plan);
    assertPlan(plan);
    const resolved = await this.runtime(plan);
    assertIdentity(inventory.identity, plan.identity);
    if (
      inventory.completeness !== "complete" ||
      inventory.runtime.runtimeIdentityId !== plan.identity.runtimeIdentityId ||
      inventory.runtime.connectionRevisionId !==
        plan.identity.connectionRevisionId
    )
      throw Error("Hyper-V ready inventory is incomplete");
    let got = await inspect(resolved.runtime, plan);
    assertVm(got, plan);
    const vmId = got.vm.id;
    const objects = inventory.objects.filter(
      (o) => o.kind === "vm" && o.ownership === "owned",
    );
    if (
      objects.length !== 1 ||
      objects[0]!.id !== vmId ||
      objects[0]!.contractHash !== plan.resolved.contractHash ||
      !sameOwner(objects[0]!.identity, plan.identity) ||
      !equal(objects[0]!.evidence, this.resource(plan, got).evidence)
    )
      throw Error("Hyper-V ready inventory changed");
    assertIdentity(objects[0]!.identity, plan.identity);
    const access = await this.options.accessMaterials.getOrCreate(
      plan.identity.allocationId,
    );
    if (fingerprint(access.publicKey) !== access.fingerprint)
      throw Error("Hyper-V client key fingerprint mismatch");
    const request = hyperVGuestBootstrapRequestSchema.parse({
      identity: plan.identity,
      vmId,
      nonce: hash({
        identity: plan.identity,
        contract: plan.resolved.contractHash,
      }),
      account: plan.access.account,
      guestOs: plan.artifact.guestOS,
      architecture: plan.artifact.architecture,
      clientPublicKey: access.publicKey,
      clientPublicKeyFingerprint: access.fingerprint,
    });
    got = hyperVInspectionSchema.parse(
      await resolved.runtime.bootstrapApply(request),
    );
    assertIdentity(got.identity, plan.identity);
    assertVm(got, plan);
    const receipt = hyperVGuestBootstrapReceiptSchema.parse(
      got.bootstrapReceipt,
    );
    if (
      got.bootstrapStatus !== "applied" ||
      receipt.vmId !== vmId ||
      receipt.nonce !== request.nonce ||
      receipt.account !== request.account ||
      receipt.guestOs !== request.guestOs ||
      receipt.architecture !== request.architecture ||
      receipt.clientPublicKeyFingerprint !==
        request.clientPublicKeyFingerprint ||
      fingerprint(receipt.hostPublicKey) !== receipt.hostKeyFingerprint
    )
      throw Error("Hyper-V bootstrap receipt mismatch");
    assertIdentity(receipt.identity, plan.identity);
    const readback = await inspect(resolved.runtime, plan);
    assertVm(readback, plan);
    if (readback.vm.id !== vmId || !equal(readback.bootstrapReceipt, receipt))
      throw Error("Hyper-V bootstrap readback changed");
    const host = readback.vm.ipv4.find(isIPv4);
    if (!host || this.now() >= plan.deadlineMs)
      throw Error("Hyper-V SSH endpoint is unavailable");
    const ssh = await this.options.ssh.verify({
      host,
      port: 22,
      username: plan.access.account,
      privateKey: access.privateKey,
      hostPublicKey: receipt.hostPublicKey,
      hostKeyFingerprint: receipt.hostKeyFingerprint,
      clientPublicKeyFingerprint: access.fingerprint,
      guestOs: request.guestOs,
      architecture: "amd64",
      deadlineMs: plan.deadlineMs,
    });
    if (
      this.now() >= plan.deadlineMs ||
      ssh.authenticated !== true ||
      ssh.username !== plan.access.account ||
      ssh.hostKeyFingerprint !== receipt.hostKeyFingerprint ||
      ssh.clientPublicKeyFingerprint !== access.fingerprint ||
      ssh.guestOs !== request.guestOs ||
      ssh.architecture !== "amd64" ||
      ssh.scratchWritable !== true
    )
      throw Error("Hyper-V authenticated guest facts mismatch");
    const final = await inspect(resolved.runtime, plan);
    assertVm(final, plan);
    if (
      final.vm.id !== vmId ||
      !final.vm.ipv4.includes(host) ||
      !equal(final.bootstrapReceipt, receipt)
    )
      throw Error("Hyper-V endpoint changed during readiness");
    const resource = this.resource(plan, final);
    return {
      identity: plan.identity,
      artifactDigest: plan.artifact.digest,
      contractHash: plan.resolved.contractHash,
      ...resourceManifest(plan, [resource]),
      objectIds: [vmId],
      effectiveResources: {
        limits: {
          cpuMillis: final.vm.cpus * 1000,
          memoryMiB: final.vm.memoryMiB,
          scratchMiB: plan.resources.limit.scratchMiB,
        },
        cpuEnforcement: "hard",
        memoryEnforcement: "hard",
        scratchEnforcement: "best_effort",
        acceleratorAssignments: [],
      },
      networkRevisionId: plan.resolved.network.revisionId,
      networkContractHash: hash(plan.resolved.network),
      mountContractHash: hash(plan.resolved.mounts),
      accessProtocol: "ssh",
      bootstrapComplete: true,
      offlineLeaseEnforcement: "unsupported",
      access: {
        host,
        port: 22,
        username: plan.access.account,
        hostKeyFingerprint: receipt.hostKeyFingerprint,
        clientPublicKeyFingerprint: access.fingerprint,
      },
    };
  }
  async revokeStop(plan: ProvisionPlan): Promise<void> {
    const resolved = await this.cleanupRuntime(plan);
    const got = hyperVInspectionSchema.parse(
      await resolved.runtime.stop(plan.identity),
    );
    assertIdentity(got.identity, plan.identity);
    const readback = await inspect(resolved.runtime, plan);
    if (
      [got, readback].some(
        (o) =>
          o.presence === "unknown" ||
          (o.presence === "present" && o.vm?.state !== "stopped"),
      )
    )
      throw Error("Hyper-V stop is not confirmed");
  }
  async destroy(
    plan: ProvisionPlan,
    resource: OwnedResource,
  ): Promise<CleanupReceipt> {
    if (
      resource.kind !== "vm" ||
      resource.ownership !== "owned" ||
      !sameOwner(resource.identity, plan.identity) ||
      resource.contractHash !== plan.resolved.contractHash ||
      resource.identity.operationId !==
        plan.cleanupAuthorization?.createOperationId ||
      resource.identity.controlVersion > plan.identity.controlVersion
    )
      throw Error("Hyper-V cleanup resource owner mismatch");
    const resolved = await this.cleanupRuntime(plan);
    const before = await inspect(resolved.runtime, plan);
    if (before.presence === "present" && before.vm?.id !== resource.id)
      throw Error("Hyper-V cleanup native identity unknown");
    const got = hyperVInspectionSchema.parse(
      await resolved.runtime.destroy(plan.identity),
    );
    assertIdentity(got.identity, plan.identity);
    const after = await inspect(resolved.runtime, plan);
    if (got.presence !== "absent" || after.presence !== "absent")
      throw Error("Hyper-V cleanup absence not confirmed");
    return {
      resourceId: resource.id,
      kind: "vm",
      runtime: binding(plan),
      identity: plan.identity,
      presence: "absent",
      networkRules: "not_applicable",
      verifiedAtMs: this.now(),
    };
  }
  private async runtime(plan: ProvisionPlan) {
    assertPlan(plan);
    const r = await this.options.resolveRuntime(plan);
    assertBinding(r, plan);
    if (
      r.template.guestOs !== plan.artifact.guestOS ||
      r.template.architecture !== plan.artifact.architecture
    )
      throw Error("Hyper-V template environment mismatch");
    return r;
  }
  private async cleanupRuntime(plan: ProvisionPlan) {
    if (
      plan.executionPhase !== "cleanup" ||
      !plan.cleanupAuthorization ||
      plan.cleanupAuthorization.createOperationId !==
        plan.identity.operationId ||
      !plan.cleanupAuthorization.cleanupOperationId ||
      !plan.cleanupAuthorization.ownerToken ||
      !Number.isSafeInteger(plan.cleanupAuthorization.operationVersion) ||
      plan.cleanupAuthorization.operationVersion < 1
    )
      throw Error("Hyper-V cleanup requires its durable operation");
    const r = await this.options.resolveCleanupRuntime(
      plan,
      plan.cleanupAuthorization,
    );
    assertBinding(r, plan);
    return r;
  }
  private resource(plan: ProvisionPlan, got: HyperVInspection): OwnedResource {
    if (got.presence !== "present" || !got.vm)
      throw Error("Hyper-V resource is not present");
    return {
      id: got.vm.id,
      kind: "vm",
      ownership: "owned",
      identity: plan.identity,
      contractHash: plan.resolved.contractHash,
      evidence: {
        artifactDigest: plan.artifact.digest,
        resourcesHash: hash(plan.resources),
        networkHash: hash(plan.resolved.network),
        mountsHash: hash(plan.resolved.mounts),
        accessProtocol: "ssh",
      },
      details: {
        nativeVmId: got.vm.id,
        state: got.vm.state,
        ipv4: got.vm.ipv4,
        ...(got.bootstrapReceipt
          ? { bootstrapReceipt: got.bootstrapReceipt }
          : {}),
      },
    };
  }
}
/** Explicit local composition, not automatic registration of an unqualified node. */
export function registerHyperVExecutionProvider(
  options: HyperVExecutionProviderOptions,
  other: Partial<Record<ExecutionMode, ExecutionPort>> = {},
  selection: ExecutionSelection = ["hyperv"],
) {
  const execution = new HyperVExecutionProvider(options);
  return {
    execution,
    dispatcher: new ExecutionProviderDispatcher(
      { ...other, hyperv: execution },
      selection,
    ),
  };
}
function assertPlan(p: ProvisionPlan) {
  if (
    !["windows", "linux"].includes(p.artifact.guestOS ?? "") ||
    p.artifact.architecture !== "amd64" ||
    p.resources.isolation !== "virtual_machine" ||
    p.resources.scratchEnforcement !== "best_effort" ||
    p.resources.accelerators.length ||
    p.resources.limit.cpuMillis % 1000 ||
    p.resources.limit.cpuMillis !== p.resources.request.cpuMillis ||
    p.resources.limit.memoryMiB !== p.resources.request.memoryMiB ||
    p.resources.limit.scratchMiB !== p.resources.request.scratchMiB ||
    p.resolved.mounts.length ||
    p.resolved.network.mode !== "trusted_nat" ||
    p.resolved.network.enforcement !== "hyperv_nat" ||
    p.resolved.network.verificationRequired ||
    p.resolved.network.ipv6 !== "not_enforced" ||
    p.accessProtocol !== "ssh" ||
    p.bootstrap.mechanism !== "hyperv-guest-bootstrap-v1" ||
    p.bootstrap.contractVersion !== "1" ||
    p.access.account.length === 0 ||
    !equal(p.access.ports, [22]) ||
    !equal(p.access.accessProtocols, ["ssh"])
  )
    throw Error(
      "Hyper-V supports whole-CPU amd64 SSH VMs on an existing trusted network without platform mounts",
    );
}
function assertNewWork(p: ProvisionPlan) {
  if (
    p.executionPhase === "cleanup" ||
    p.executionPhase === "observe" ||
    p.cleanupAuthorization
  )
    throw Error("Only provision plans can create or bootstrap Hyper-V");
}
function assertBinding(r: Binding, p: ProvisionPlan) {
  if (
    r.runtimeIdentityId !== p.identity.runtimeIdentityId ||
    r.connectionRevisionId !== p.identity.connectionRevisionId ||
    r.artifactDigest !== p.artifact.digest
  )
    throw Error("Hyper-V runtime binding mismatch");
}
async function inspect(
  r: Pick<HyperVRuntimePort, "inspect">,
  p: ProvisionPlan,
) {
  const o = hyperVInspectionSchema.parse(await r.inspect(p.identity));
  assertIdentity(o.identity, p.identity);
  return o;
}
function assertVm(
  o: HyperVInspection,
  p: ProvisionPlan,
): asserts o is HyperVInspection & { vm: NonNullable<HyperVInspection["vm"]> } {
  if (
    o.presence !== "present" ||
    !o.inventoryComplete ||
    !o.vm ||
    o.vm.state !== "running" ||
    o.vm.dynamicMemory ||
    o.vm.cpus * 1000 !== p.resources.limit.cpuMillis ||
    o.vm.memoryMiB !== p.resources.limit.memoryMiB ||
    o.requestedEnvironment?.guestOs !== p.artifact.guestOS ||
    o.requestedEnvironment?.architecture !== p.artifact.architecture
  )
    throw Error("Hyper-V native resources/environment are not verified");
}
function owner(i: VmAllocationIdentity) {
  const { operationId: _, controlVersion: __, ...value } = i;
  return value;
}
function sameOwner(a: VmAllocationIdentity, b: VmAllocationIdentity) {
  return equal(owner(a), owner(b));
}
function assertIdentity(a: VmAllocationIdentity, b: VmAllocationIdentity) {
  if (!equal(a, b)) throw Error("Hyper-V action identity mismatch");
}
function binding(p: ProvisionPlan) {
  return {
    runtimeIdentityId: p.identity.runtimeIdentityId,
    connectionRevisionId: p.identity.connectionRevisionId,
  };
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
function equal(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function hash(v: unknown) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}
function fingerprint(key: string) {
  const parsed = ssh2.utils.parseKey(key);
  if (parsed instanceof Error || parsed.isPrivateKey())
    throw Error("Hyper-V public key invalid");
  return (
    "SHA256:" +
    createHash("sha256")
      .update(parsed.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "")
  );
}
