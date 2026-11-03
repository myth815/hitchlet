import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import ssh2 from "ssh2";
import {
  canonicalTartNetworkPlan,
  tartGuestBootstrapReceiptSchema,
  tartGuestBootstrapRequestSchema,
  tartInspectionSchema,
  tartLocalTemplateRefSchema,
  tartNetworkCleanupReceiptSchema,
  tartNetworkObservationSchema,
  tartNetworkPlanSchema,
  tartAllocationOwnerTuple,
  tartAllocationIdentitySchema,
  type EffectiveResources,
  type TartAllocationIdentity,
  type TartGuestBootstrapReceipt,
  type TartGuestBootstrapRequest,
  type TartInspection,
  type TartLocalTemplateRef,
  type TartNetworkCleanupReceipt,
  type TartNetworkPlan,
  type TartReconcileRequest,
} from "@hitchlet/contracts/internal";
import { resourceManifest } from "../domain/resource-manifest.js";
import type { SQLiteAccessMaterialStore } from "../storage/access-material-store.js";
import type {
  CleanupReceipt,
  CreateEffect,
  ExecutionPort,
  Inspection,
  InventoryEvidence,
  OwnedResource,
  ProvisionPlan,
  ReadyReceipt,
  ResourceJournal,
} from "./port.js";

const { utils: sshUtils } = ssh2;
const EVIDENCE_MAX_AGE_MS = 30_000;

export type TartRuntimePort = Readonly<{
  inspect(identity: TartAllocationIdentity): Promise<TartInspection>;
  reconcile(request: TartReconcileRequest): Promise<TartInspection>;
  bootstrapApply(
    identity: TartAllocationIdentity,
    request: TartGuestBootstrapRequest,
  ): Promise<TartInspection>;
  revokeNetwork(
    identity: TartAllocationIdentity,
    network: TartNetworkPlan,
  ): Promise<TartInspection>;
  destroy(identity: TartAllocationIdentity): Promise<TartInspection>;
}>;

export type ResolvedTartRuntime = Readonly<{
  runtimeIdentityId: string;
  connectionRevisionId: string;
  artifactDigest: string;
  template: TartLocalTemplateRef;
  runtime: TartRuntimePort;
}>;

export type TartCleanupRuntimePort = Pick<
  TartRuntimePort,
  "inspect" | "revokeNetwork" | "destroy"
>;

export type ResolvedTartCleanupRuntime = Readonly<{
  runtimeIdentityId: string;
  connectionRevisionId: string;
  artifactDigest: string;
  runtime: TartCleanupRuntimePort;
}>;

type TartResolvedIdentity = Pick<
  ResolvedTartRuntime,
  "runtimeIdentityId" | "connectionRevisionId" | "artifactDigest"
>;

export type TartNetworkEvidence = Readonly<{
  runtimeIdentityId: string;
  allocationId: string;
  generation: number;
  revisionId: string;
  contractHash: string;
  reference: string;
  verifiedAt: string;
  expiresAt: string;
}>;

export type TartSshProbeEvidence = Readonly<{
  authenticated: true;
  username: string;
  hostKeyFingerprint: string;
  clientPublicKeyFingerprint: string;
  guestOS: "linux" | "macos";
  architecture: "arm64";
  scratchWritable: true;
  /** Optional authenticated guest observation; scratch remains best-effort. */
  observedScratchMiB?: number;
}>;

export type TartExecutionProviderOptions = Readonly<{
  resolveRuntime(plan: ProvisionPlan): Promise<ResolvedTartRuntime>;
  resolveCleanupRuntime(
    plan: ProvisionPlan,
    authorization: NonNullable<ProvisionPlan["cleanupAuthorization"]>,
  ): Promise<ResolvedTartCleanupRuntime>;
  accessMaterials: Pick<SQLiteAccessMaterialStore, "getOrCreate">;
  ssh: Readonly<{
    /** Resolves only after host-key confirmation and public-key authentication. */
    verify(
      input: Readonly<{
        host: string;
        port: number;
        username: string;
        privateKey: string;
        hostPublicKey: string;
        hostKeyFingerprint: string;
        clientPublicKeyFingerprint: string;
        guestOS: "linux" | "macos";
        architecture: "arm64";
        deadlineMs: number;
      }>,
    ): Promise<TartSshProbeEvidence>;
  }>;
  now?: () => number;
}>;

/** Controller-side Tart adapter. It makes no platform calls except through injected ports. */
export class TartExecutionProvider implements ExecutionPort {
  private readonly now: () => number;

  constructor(private readonly options: TartExecutionProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  async create(
    plan: ProvisionPlan,
    journal: ResourceJournal,
  ): Promise<readonly OwnedResource[]> {
    assertProvisionPhase(plan);
    assertSupportedPlan(plan);
    const resolved = await this.runtime(plan);
    const identity = tartIdentity(plan);
    const networkPlan = tartNetworkPlanFor(plan);
    let observed = tartInspectionSchema.parse(
      await resolved.runtime.inspect(identity),
    );
    assertInspectionOwner(observed, identity);
    if (observed.presence === "unknown")
      throw new Error("Tart VM ownership is unknown");

    const effect: CreateEffect = {
      kind: "vm",
      name: tartVmName(identity),
      requestHash: sha256({
        identity,
        artifactDigest: plan.artifact.digest,
        template: resolved.template,
        resources: tartResources(plan),
        network: networkPlan,
      }),
    };
    requireJournal(journal);
    if (observed.presence === "absent") await journal.beforeCreate(effect);
    else {
      assertOwnedVmShape(observed, plan);
      await journal.recordCreated(this.ownedVm(plan, resolved, observed));
    }
    await journal.assertActive();

    // Reconcile checks an existing manifest before any clone and repairs only that owned VM.
    const reconciled = tartInspectionSchema.parse(
      await resolved.runtime.reconcile({
        identity,
        template: resolved.template,
        resources: tartResources(plan),
        network: networkPlan,
      }),
    );
    assertInspectionOwner(reconciled, identity);
    observed =
      reconciled.presence === "present"
        ? reconciled
        : tartInspectionSchema.parse(await resolved.runtime.inspect(identity));
    assertInspectionOwner(observed, identity);
    if (observed.presence !== "present")
      throw new Error("Tart VM creation outcome is not verified");
    assertOwnedVmShape(observed, plan);
    await journal.recordCreated(this.ownedVm(plan, resolved, observed));
    assertVmObservation(observed, plan, resolved);

    const network = await this.networkEvidence(plan, observed);
    const access = await this.options.accessMaterials.getOrCreate(
      identity.allocationId,
    );
    const request = makeBootstrapRequest(
      plan,
      identity,
      network,
      access.publicKey,
      access.fingerprint,
    );

    await journal.assertActive();
    const desired = tartInspectionSchema.parse(
      await resolved.runtime.reconcile({
        identity,
        template: resolved.template,
        resources: tartResources(plan),
        network: networkPlan,
        bootstrap: request,
      }),
    );
    assertInspectionOwner(desired, identity);
    // A persisted desired bootstrap may be unknown until its guest receipt is applied.
    observed =
      desired.presence === "present"
        ? desired
        : tartInspectionSchema.parse(await resolved.runtime.inspect(identity));
    assertInspectionOwner(observed, identity);
    if (observed.presence !== "present")
      throw new Error("Tart VM disappeared during bootstrap preparation");
    assertOwnedVmShape(observed, plan);
    const resource = this.ownedVm(plan, resolved, observed, {
      bootstrapRequest: request,
      networkEvidence: network,
    });
    await journal.recordCreated(resource);
    return [resource];
  }

  async inspect(plan: ProvisionPlan): Promise<Inspection> {
    let resolved: ResolvedTartRuntime | ResolvedTartCleanupRuntime;
    try {
      assertSupportedPlan(plan);
      resolved =
        plan.executionPhase === "cleanup"
          ? await this.cleanupRuntime(plan)
          : await this.runtime(plan);
    } catch {
      return { presence: "unknown", reason: "runtime_identity_mismatch" };
    }
    const identity = tartIdentity(plan);
    let observed: TartInspection;
    try {
      observed = tartInspectionSchema.parse(
        await resolved.runtime.inspect(identity),
      );
    } catch {
      return { presence: "unknown", reason: "inventory_incomplete" };
    }
    if (!inspectionOwnerMatches(observed, identity))
      return { presence: "unknown", reason: "inventory_incomplete" };
    if (observed.presence === "unknown")
      return { presence: "unknown", reason: "inventory_incomplete" };
    if (observed.presence === "absent")
      return {
        presence: "absent",
        evidence: {
          completeness: "complete",
          runtime: runtimeBinding(plan),
          identity: plan.identity,
        },
      };
    if (plan.executionPhase === "observe") {
      if (!sameProvisionIdentity(observed.identity, identity))
        return { presence: "unknown", reason: "inventory_incomplete" };
      if (!isResolvedTartRuntime(resolved))
        return { presence: "unknown", reason: "runtime_identity_mismatch" };
      return this.inspectIntegrity(plan, resolved, observed);
    }
    if (!this.vmObservationMatches(observed, plan, resolved))
      return { presence: "unknown", reason: "inventory_incomplete" };
    const object = this.ownedVm(plan, resolved, observed);
    return {
      presence: "present",
      evidence: {
        completeness: "complete",
        runtime: runtimeBinding(plan),
        identity: plan.identity,
        objects: [object],
      },
    };
  }

  async ready(
    plan: ProvisionPlan,
    inventory: InventoryEvidence,
  ): Promise<ReadyReceipt> {
    assertProvisionPhase(plan);
    assertSupportedPlan(plan);
    const resolved = await this.runtime(plan);
    const identity = tartIdentity(plan);
    assertInventory(plan, inventory, resolved);

    let observed = tartInspectionSchema.parse(
      await resolved.runtime.inspect(identity),
    );
    assertInspectionOwner(observed, identity);
    if (observed.presence !== "present")
      throw new Error("Tart VM is not completely present");
    assertVmObservation(observed, plan, resolved);
    assertInventoryVmMatches(inventory, this.ownedVm(plan, resolved, observed));

    const network = await this.networkEvidence(plan, observed);
    const materials = await this.options.accessMaterials.getOrCreate(
      identity.allocationId,
    );
    const request = makeBootstrapRequest(
      plan,
      identity,
      network,
      materials.publicKey,
      materials.fingerprint,
    );
    const bootstrapResult = tartInspectionSchema.parse(
      await resolved.runtime.bootstrapApply(identity, request),
    );
    assertInspectionOwner(bootstrapResult, identity);
    if (
      bootstrapResult.presence !== "present" ||
      bootstrapResult.bootstrapStatus !== "applied" ||
      !bootstrapResult.bootstrapReceipt
    )
      throw new Error("Tart guest bootstrap did not return an applied receipt");
    const receipt = tartGuestBootstrapReceiptSchema.parse(
      bootstrapResult.bootstrapReceipt,
    );
    assertBootstrapReceipt(receipt, request, plan, this.now());

    const persisted = tartInspectionSchema.parse(
      await resolved.runtime.inspect(identity),
    );
    assertInspectionOwner(persisted, identity);
    if (
      persisted.presence !== "present" ||
      persisted.bootstrapStatus !== "applied" ||
      !persisted.bootstrapReceipt ||
      !sameJson(persisted.bootstrapReceipt, receipt)
    )
      throw new Error("Tart bootstrap receipt readback is not verified");
    assertVmObservation(persisted, plan, resolved);

    const ssh = await this.options.ssh.verify({
      host: persisted.ipAddress!,
      port: 22,
      username: plan.access.account,
      privateKey: materials.privateKey,
      hostPublicKey: receipt.hostPublicKey,
      hostKeyFingerprint: receipt.hostKeyFingerprint,
      clientPublicKeyFingerprint: materials.fingerprint,
      guestOS: plan.artifact.guestOS!,
      architecture: "arm64",
      deadlineMs: plan.deadlineMs,
    });
    if (
      this.now() >= plan.deadlineMs ||
      Date.parse(network.expiresAt) <= this.now() ||
      ssh.authenticated !== true ||
      ssh.username !== plan.access.account ||
      ssh.hostKeyFingerprint !== receipt.hostKeyFingerprint ||
      ssh.clientPublicKeyFingerprint !== materials.fingerprint ||
      ssh.guestOS !== plan.artifact.guestOS ||
      ssh.architecture !== plan.artifact.architecture ||
      ssh.scratchWritable !== true ||
      (ssh.observedScratchMiB !== undefined &&
        (!Number.isSafeInteger(ssh.observedScratchMiB) ||
          ssh.observedScratchMiB < 0))
    )
      throw new Error("Tart SSH readiness evidence does not match the request");

    const finalInspection = tartInspectionSchema.parse(
      await resolved.runtime.inspect(identity),
    );
    assertInspectionOwner(finalInspection, identity);
    if (finalInspection.presence !== "present")
      throw new Error("Tart VM changed during SSH readiness verification");
    assertVmObservation(finalInspection, plan, resolved);
    if (
      finalInspection.vmName !== persisted.vmName ||
      finalInspection.ipAddress !== persisted.ipAddress ||
      !sameJson(finalInspection.bootstrapReceipt, receipt)
    )
      throw new Error(
        "Tart VM readiness facts changed during SSH verification",
      );

    const scratchMiB =
      ssh.observedScratchMiB === undefined
        ? plan.resources.limit.scratchMiB
        : Math.min(plan.resources.limit.scratchMiB, ssh.observedScratchMiB);
    const objects = [this.ownedVm(plan, resolved, finalInspection)];
    const hashes = provisionHashes(plan);
    const effectiveResources: EffectiveResources = {
      limits: {
        cpuMillis: finalInspection.resources.cpus * 1000,
        memoryMiB: finalInspection.resources.memoryMiB,
        scratchMiB,
      },
      cpuEnforcement: "hard",
      memoryEnforcement: "hard",
      scratchEnforcement: "best_effort",
      acceleratorAssignments: [],
    };
    return {
      identity: plan.identity,
      artifactDigest: plan.artifact.digest,
      contractHash: plan.resolved.contractHash,
      ...resourceManifest(plan, objects),
      objectIds: objects.map((item) => item.id).sort(),
      effectiveResources,
      networkRevisionId: plan.resolved.network.revisionId,
      networkContractHash: hashes.networkHash,
      mountContractHash: hashes.mountsHash,
      accessProtocol: "ssh",
      bootstrapComplete: true,
      offlineLeaseEnforcement: "unsupported",
      access: {
        host: finalInspection.ipAddress!,
        port: 22,
        username: plan.access.account,
        hostKeyFingerprint: receipt.hostKeyFingerprint,
        clientPublicKeyFingerprint: materials.fingerprint,
      },
    };
  }

  async revokeStop(plan: ProvisionPlan): Promise<void> {
    const resolved = await this.cleanupRuntime(plan);
    const identity = tartIdentity(plan);
    const network = tartNetworkPlanFor(plan);
    const result = tartInspectionSchema.parse(
      await resolved.runtime.revokeNetwork(identity, network),
    );
    assertInspectionOwner(result, identity);
    const resultRules = assertNetworkCleanupReceipt(
      plan,
      network,
      "networkCleanupReceipt" in result
        ? result.networkCleanupReceipt
        : undefined,
    );
    const confirmed = tartInspectionSchema.parse(
      await resolved.runtime.inspect(identity),
    );
    assertInspectionOwner(confirmed, identity);
    const confirmedRules = assertNetworkCleanupReceipt(
      plan,
      network,
      "networkCleanupReceipt" in confirmed
        ? confirmed.networkCleanupReceipt
        : undefined,
    );
    if (resultRules !== confirmedRules)
      throw new Error("Tart network cleanup receipt changed on readback");
  }

  async destroy(
    plan: ProvisionPlan,
    resource: OwnedResource,
  ): Promise<CleanupReceipt> {
    const resolved = await this.cleanupRuntime(plan);
    if (resource.kind !== "vm" || resource.ownership !== "owned")
      throw new Error("Tart destroy requires an owned VM resource");
    const identity = tartIdentity(plan);
    if (
      resource.id !== tartVmName(identity) ||
      !sameProvisionIdentity(resource.identity, plan.identity) ||
      resource.contractHash !== plan.resolved.contractHash
    )
      throw new Error("Tart destroy resource ownership does not match plan");
    const result = tartInspectionSchema.parse(
      await resolved.runtime.destroy(identity),
    );
    assertInspectionOwner(result, identity);
    if (result.presence === "unknown")
      throw new Error("Tart VM deletion outcome is unknown");
    if (result.presence !== "absent")
      throw new Error("Tart VM remains after deletion request");
    const confirmed = tartInspectionSchema.parse(
      await resolved.runtime.inspect(identity),
    );
    assertInspectionOwner(confirmed, identity);
    if (confirmed.presence !== "absent")
      throw new Error("Tart VM absence is not verified");
    const network = tartNetworkPlanFor(plan);
    const resultRules = assertNetworkCleanupReceipt(
      plan,
      network,
      result.networkCleanupReceipt,
    );
    const confirmedRules = assertNetworkCleanupReceipt(
      plan,
      network,
      confirmed.networkCleanupReceipt,
    );
    if (
      resultRules !== confirmedRules ||
      !sameJson(result.networkCleanupReceipt, confirmed.networkCleanupReceipt)
    )
      throw new Error("Tart network cleanup receipt changed on readback");
    return {
      resourceId: resource.id,
      kind: "vm",
      runtime: runtimeBinding(plan),
      identity: plan.identity,
      presence: "absent",
      networkRules: resultRules,
      verifiedAtMs: this.now(),
    };
  }

  private async runtime(plan: ProvisionPlan): Promise<ResolvedTartRuntime> {
    assertProvisionPhase(plan);
    const resolved = await this.options.resolveRuntime(plan);
    tartLocalTemplateRefSchema.parse(resolved.template);
    if (
      resolved.runtimeIdentityId !== plan.identity.runtimeIdentityId ||
      resolved.connectionRevisionId !== plan.identity.connectionRevisionId ||
      resolved.artifactDigest !== plan.artifact.digest ||
      resolved.template.name !== plan.artifact.ref ||
      resolved.template.source !== "local" ||
      resolved.template.guestArch !== plan.artifact.architecture ||
      resolved.template.guestArch !== "arm64" ||
      resolved.template.guestOS !==
        (plan.artifact.guestOS === "macos" ? "darwin" : "linux")
    )
      throw new Error("Resolved Tart runtime differs from the frozen plan");
    return resolved;
  }

  private async cleanupRuntime(
    plan: ProvisionPlan,
  ): Promise<ResolvedTartCleanupRuntime> {
    assertSupportedPlan(plan);
    const authorization = plan.cleanupAuthorization;
    if (plan.executionPhase !== "cleanup" || !authorization)
      throw new Error("Tart cleanup requires a claimed cleanup operation");
    if (
      authorization.createOperationId !== plan.identity.operationId ||
      !authorization.cleanupOperationId ||
      !authorization.ownerToken ||
      !Number.isSafeInteger(authorization.operationVersion) ||
      authorization.operationVersion < 1
    )
      throw new Error("Tart cleanup authorization does not match the plan");
    const resolved = await this.options.resolveCleanupRuntime(
      plan,
      authorization,
    );
    if (
      resolved.runtimeIdentityId !== plan.identity.runtimeIdentityId ||
      resolved.connectionRevisionId !== plan.identity.connectionRevisionId ||
      resolved.artifactDigest !== plan.artifact.digest
    )
      throw new Error("Tart cleanup runtime differs from the frozen owner");
    return resolved;
  }

  private async inspectIntegrity(
    plan: ProvisionPlan,
    resolved: ResolvedTartRuntime,
    observed: Extract<TartInspection, { presence: "present" }>,
  ): Promise<Inspection> {
    const evidence: InventoryEvidence = {
      completeness: "complete",
      runtime: runtimeBinding(plan),
      identity: plan.identity,
      objects: [this.ownedVm(plan, resolved, observed)],
    };
    const unknown = (): Inspection => ({
      presence: "unknown",
      reason: "inventory_incomplete",
    });
    const lost = (reason: string): Inspection => ({
      presence: "present",
      evidence,
      integrity: { state: "lost", reason },
    });
    if (resolved.artifactDigest !== plan.artifact.digest) return unknown();
    if (observed.vmName !== tartVmName(tartIdentity(plan)))
      return lost("TART_VM_IDENTITY_MISMATCH");
    if (observed.state !== "running") return lost("TART_VM_NOT_RUNNING");
    if (
      observed.resources.cpus !== tartResources(plan).cpus ||
      observed.resources.memoryMiB !== tartResources(plan).memoryMiB
    )
      return lost("TART_VM_RESOURCE_MISMATCH");
    if (observed.networkCleanupReceipt) {
      const receipt = observed.networkCleanupReceipt;
      if (!sameProvisionIdentity(receipt.identity, plan.identity))
        return unknown();
      if (receipt.status === "removed" || receipt.status === "process_exited")
        return lost("TART_NETWORK_REVOKED");
    }
    if (
      observed.bootstrapStatus === "unknown" ||
      observed.bootstrapStatus === "pending"
    )
      return unknown();
    if (observed.bootstrapStatus !== "applied" || !observed.bootstrapReceipt)
      return lost("TART_BOOTSTRAP_NOT_APPLIED");
    const bootstrap = tartGuestBootstrapReceiptSchema.parse(
      observed.bootstrapReceipt,
    );
    if (bootstrap.status !== "applied") return unknown();
    if (!sameProvisionIdentity(bootstrap.identity, plan.identity))
      return unknown();

    const saved = readyReceiptSnapshot(plan.integritySnapshot);
    if (!saved) return unknown();
    const savedIdentity = recordValue(saved.identity);
    const savedAccess = recordValue(saved.access);
    let parsedSavedIdentity: TartAllocationIdentity;
    try {
      parsedSavedIdentity = tartAllocationIdentitySchema.parse(savedIdentity);
    } catch {
      return unknown();
    }
    if (
      !savedIdentity ||
      !savedAccess ||
      !sameProvisionIdentity(parsedSavedIdentity, plan.identity) ||
      saved.artifactDigest !== plan.artifact.digest ||
      saved.contractHash !== plan.resolved.contractHash ||
      saved.networkRevisionId !== plan.resolved.network.revisionId ||
      saved.networkContractHash !== sha256(plan.resolved.network)
    )
      return unknown();
    const username = savedAccess.username;
    const hostFingerprint = savedAccess.hostKeyFingerprint;
    const clientFingerprint = savedAccess.clientPublicKeyFingerprint;
    if (
      typeof username !== "string" ||
      typeof hostFingerprint !== "string" ||
      typeof clientFingerprint !== "string"
    )
      return unknown();
    if (
      bootstrap.nonce !== expectedBootstrapNonce(plan) ||
      bootstrap.account !== plan.access.account ||
      username !== plan.access.account ||
      bootstrap.clientPublicKeyFingerprint !== clientFingerprint ||
      bootstrap.hostKeyFingerprint !== hostFingerprint
    )
      return lost("TART_BOOTSTRAP_RECEIPT_MISMATCH");
    const receiptObservedAt = Date.parse(bootstrap.observedAt);
    const receiptEvidenceExpiry = Date.parse(
      bootstrap.networkEvidenceExpiresAt,
    );
    if (
      !Number.isFinite(receiptObservedAt) ||
      !Number.isFinite(receiptEvidenceExpiry) ||
      receiptObservedAt > this.now() ||
      receiptEvidenceExpiry <= receiptObservedAt
    )
      return unknown();

    if (observed.network.status === "unknown") {
      if (
        observed.network.reason === "network_policy_revoked" ||
        observed.network.reason === "network_policy_readback_mismatch"
      )
        return lost("TART_NETWORK_POLICY_MISMATCH");
      return unknown();
    }
    const expectedNetwork = tartNetworkPlanFor(plan);
    if (!sameProvisionIdentity(observed.network.identity, plan.identity))
      return unknown();
    if (
      observed.network.revisionId !== expectedNetwork.revisionId ||
      observed.network.contractHash !== expectedNetwork.contractHash ||
      observed.network.vm.vmName !== observed.vmName
    )
      return lost("TART_NETWORK_POLICY_MISMATCH");
    let currentNetwork: TartNetworkEvidence;
    try {
      currentNetwork = await this.networkEvidence(
        {
          ...plan,
          deadlineMs: Math.min(
            plan.deadlineMs,
            this.now() + EVIDENCE_MAX_AGE_MS,
          ),
        },
        observed,
      );
    } catch {
      return unknown();
    }
    if (bootstrap.networkEvidenceReference !== currentNetwork.reference)
      return lost("TART_BOOTSTRAP_NETWORK_MISMATCH");
    return { presence: "present", evidence, integrity: { state: "healthy" } };
  }

  private async networkEvidence(
    plan: ProvisionPlan,
    observed: Extract<TartInspection, { presence: "present" }>,
  ): Promise<TartNetworkEvidence> {
    const networkPlan = tartNetworkPlanFor(plan);
    const evidence = tartNetworkObservationSchema.parse(observed.network);
    const now = this.now();
    const verifiedAt = Date.parse(evidence.observedAt);
    const expiresAtMs = plan.deadlineMs;
    if (
      evidence.status !== "policy_match" ||
      evidence.backend !== "softnet" ||
      !sameProvisionIdentity(evidence.identity, plan.identity) ||
      evidence.revisionId !== networkPlan.revisionId ||
      evidence.contractHash !== networkPlan.contractHash ||
      evidence.policyHash !== hashSoftnetReadback(evidence.readback) ||
      evidence.vm.vmName !== tartVmName(tartIdentity(plan)) ||
      evidence.vm.vmName !== observed.vmName ||
      !evidence.vm.device ||
      !evidence.vm.inode ||
      !evidence.vm.macAddress ||
      !Number.isSafeInteger(evidence.process.pid) ||
      !Number.isFinite(Date.parse(evidence.process.startedAt)) ||
      evidence.control.transport !== "unix_stream_fd" ||
      evidence.control.connected !== true ||
      !Number.isSafeInteger(evidence.readback.ruleCount) ||
      evidence.readback.ruleCount < 0 ||
      evidence.readback.ruleCount > 8192 ||
      !Number.isFinite(verifiedAt) ||
      verifiedAt > now ||
      now - verifiedAt > EVIDENCE_MAX_AGE_MS ||
      expiresAtMs <= now
    )
      throw new Error("Tart network verification is stale or mismatched");
    return {
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      allocationId: plan.identity.allocationId,
      generation: plan.identity.generation,
      revisionId: plan.resolved.network.revisionId,
      // Keep the ledger's existing network hash distinct from the Tart policy-plan hash.
      contractHash: sha256(plan.resolved.network),
      reference: evidence.policyHash,
      verifiedAt: evidence.observedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  private ownedVm(
    plan: ProvisionPlan,
    resolved: TartResolvedIdentity,
    observed: Extract<TartInspection, { presence: "present" }>,
    extraDetails: Readonly<Record<string, unknown>> = {},
  ): OwnedResource {
    const hashes = provisionHashes(plan);
    return {
      id: tartVmName(tartIdentity(plan)),
      kind: "vm",
      ownership: "owned",
      identity: plan.identity,
      contractHash: plan.resolved.contractHash,
      evidence: {
        artifactDigest: resolved.artifactDigest,
        resourcesHash: hashes.resourcesHash,
        networkHash: hashes.networkHash,
        mountsHash: hashes.mountsHash,
        accessProtocol: "ssh",
      },
      details: {
        nativeName: tartVmName(tartIdentity(plan)),
        vmName: observed.vmName,
        state: observed.state,
        ipAddress: observed.ipAddress ?? null,
        resources: observed.resources,
        ...(observed.bootstrapReceipt
          ? { bootstrapReceipt: observed.bootstrapReceipt }
          : {}),
        ...extraDetails,
      },
    };
  }

  private vmObservationMatches(
    observed: Extract<TartInspection, { presence: "present" }>,
    plan: ProvisionPlan,
    resolved: TartResolvedIdentity,
  ): boolean {
    return (
      sameOwner(observed.identity, tartIdentity(plan)) &&
      observed.vmName === tartVmName(tartIdentity(plan)) &&
      resolved.artifactDigest === plan.artifact.digest
    );
  }
}

function assertSupportedPlan(plan: ProvisionPlan): void {
  if (
    !["linux", "macos"].includes(plan.artifact.guestOS ?? "") ||
    plan.artifact.architecture !== "arm64" ||
    plan.resources.isolation !== "virtual_machine" ||
    plan.resolved.network.mode !== "isolated_vm" ||
    plan.resolved.network.enforcement !== "tart_agent" ||
    plan.resolved.network.verificationRequired !== true ||
    plan.resolved.network.ipv6 !== "disabled" ||
    plan.bootstrap.mechanism !== "tart-guest-bootstrap-v1" ||
    plan.bootstrap.contractVersion !== "1" ||
    plan.bootstrap.identityReset !== true ||
    plan.access.discovery !== "guest_ipv4" ||
    plan.access.readiness !== "authenticated_ssh" ||
    plan.accessProtocol !== "ssh" ||
    plan.access.accessProtocols.length !== 1 ||
    plan.access.accessProtocols[0] !== "ssh" ||
    plan.access.ports.length !== 1 ||
    plan.access.ports[0] !== 22 ||
    plan.resolved.mounts.length > 0 ||
    plan.resources.scratchEnforcement === "required" ||
    plan.resources.accelerators.length > 0
  )
    throw new Error("Tart supports only local isolated SSH virtual machines");
  if (
    plan.resources.request.cpuMillis !== plan.resources.limit.cpuMillis ||
    plan.resources.request.memoryMiB !== plan.resources.limit.memoryMiB ||
    plan.resources.request.scratchMiB !== plan.resources.limit.scratchMiB ||
    plan.resources.limit.cpuMillis % 1000 !== 0
  )
    throw new Error("Tart requires whole-CPU frozen resource limits");
}

function assertProvisionPhase(plan: ProvisionPlan): void {
  if (plan.executionPhase === "cleanup" || plan.cleanupAuthorization)
    throw new Error("Tart cleanup plans cannot create or bootstrap VMs");
}

export function tartNetworkPlanFor(plan: ProvisionPlan): TartNetworkPlan {
  const network = plan.resolved.network;
  const unhashed = {
    grantId: network.grantId,
    revisionId: network.revisionId,
    frozenPlatformDenyRevisionId: network.frozenPlatformDenyRevisionId,
    platformDenyRevisionId: network.platformDenyRevisionId,
    mode: network.mode,
    enforcement: network.enforcement,
    ipv6: network.ipv6,
    allowedEgress: network.allowedEgress.map((rule) => ({
      cidr: rule.cidr,
      protocol: rule.protocol,
      ports: [...rule.ports],
    })),
    allowedIngressSourceCidrs: [...network.allowedIngressSourceCidrs],
    accessSourceCidrs: [...plan.access.allowedSourceCidrs],
    accessPorts: [...plan.access.ports],
    managementDenyRules: network.managementDenyRules.map((rule) => ({
      cidr: rule.cidr,
      protocol: rule.protocol,
      ports: rule.ports === "any" ? "any" : [...rule.ports],
    })),
  };
  const contractHash = `sha256:${createHash("sha256")
    .update(canonicalTartNetworkPlan(unhashed))
    .digest("hex")}`;
  return tartNetworkPlanSchema.parse({ ...unhashed, contractHash });
}

function assertNetworkCleanupReceipt(
  plan: ProvisionPlan,
  network: TartNetworkPlan,
  rawReceipt: TartNetworkCleanupReceipt | undefined,
): "removed" | "never_installed" {
  if (!rawReceipt) throw new Error("Tart network removal outcome is unknown");
  const receipt = tartNetworkCleanupReceiptSchema.parse(rawReceipt);
  const identityMatches = sameProvisionIdentity(
    receipt.identity,
    plan.identity,
  );
  if (
    receipt.backend !== "softnet" ||
    !identityMatches ||
    receipt.revisionId !== network.revisionId ||
    receipt.contractHash !== network.contractHash
  )
    throw new Error("Tart network cleanup receipt does not match the plan");
  if (receipt.status === "not_started") {
    if (receipt.vmName !== tartVmName(tartIdentity(plan)))
      throw new Error("Tart network never-started receipt is not owned");
    return "never_installed";
  }
  if (receipt.status === "process_exited") {
    if (
      receipt.vm.vmName !== tartVmName(tartIdentity(plan)) ||
      receipt.processExitObserved !== true ||
      receipt.vmStopped !== true
    )
      throw new Error("Tart stopped-process receipt is not owned");
    return "removed";
  }
  if (
    receipt.status !== "removed" ||
    receipt.vm.vmName !== tartVmName(tartIdentity(plan)) ||
    receipt.processExitObserved !== true ||
    !receipt.readback ||
    receipt.readback.allow.length !== 0 ||
    !receipt.readback.block.includes("in 0.0.0.0/0") ||
    !receipt.readback.block.includes("out 0.0.0.0/0") ||
    !Number.isSafeInteger(receipt.readback.ruleCount) ||
    receipt.readback.ruleCount < 0 ||
    receipt.readback.ruleCount > 8192
  )
    throw new Error("Tart network removal is not verified");
  return "removed";
}

function tartResources(plan: ProvisionPlan) {
  return {
    cpus: plan.resources.limit.cpuMillis / 1000,
    memoryMiB: plan.resources.limit.memoryMiB,
  };
}

function tartIdentity(plan: ProvisionPlan): TartAllocationIdentity {
  const identity = plan.identity;
  return {
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    connectionRevisionId: identity.connectionRevisionId,
    allocationId: identity.allocationId,
    generation: identity.generation,
    operationId: identity.operationId,
    controlVersion: identity.controlVersion,
    purpose: identity.purpose,
  };
}

function runtimeBinding(plan: ProvisionPlan) {
  return {
    runtimeIdentityId: plan.identity.runtimeIdentityId,
    connectionRevisionId: plan.identity.connectionRevisionId,
  };
}

function sameOwner(
  observed: TartAllocationIdentity,
  expected: TartAllocationIdentity,
): boolean {
  return (
    observed.installationId === expected.installationId &&
    observed.runtimeIdentityId === expected.runtimeIdentityId &&
    observed.connectionRevisionId === expected.connectionRevisionId &&
    observed.allocationId === expected.allocationId &&
    observed.generation === expected.generation &&
    observed.purpose === expected.purpose
  );
}

function sameProvisionIdentity(
  left: TartAllocationIdentity,
  right: TartAllocationIdentity,
): boolean {
  return (
    sameOwner(left, right) &&
    left.operationId === right.operationId &&
    left.controlVersion === right.controlVersion
  );
}

function inspectionOwnerMatches(
  inspection: TartInspection,
  expected: TartAllocationIdentity,
): boolean {
  return (
    sameOwner(inspection.identity, expected) &&
    inspection.identity.controlVersion <= expected.controlVersion &&
    (inspection.identity.controlVersion < expected.controlVersion ||
      inspection.identity.operationId === expected.operationId)
  );
}

function assertInspectionOwner(
  inspection: TartInspection,
  expected: TartAllocationIdentity,
): void {
  if (!inspectionOwnerMatches(inspection, expected))
    throw new Error("Tart runtime identity differs from the provision plan");
}

function assertOwnedVmShape(
  observed: Extract<TartInspection, { presence: "present" }>,
  plan: ProvisionPlan,
): void {
  if (
    !sameOwner(observed.identity, tartIdentity(plan)) ||
    observed.vmName !== tartVmName(tartIdentity(plan))
  )
    throw new Error("Tart VM ownership does not match the frozen plan");
}

function assertVmObservation(
  observed: Extract<TartInspection, { presence: "present" }>,
  plan: ProvisionPlan,
  resolved: TartResolvedIdentity,
): void {
  if (
    !sameOwner(observed.identity, tartIdentity(plan)) ||
    observed.identity.controlVersion > plan.identity.controlVersion ||
    (observed.identity.controlVersion === plan.identity.controlVersion &&
      observed.identity.operationId !== plan.identity.operationId) ||
    observed.vmName !== tartVmName(tartIdentity(plan)) ||
    observed.resources.cpus !== tartResources(plan).cpus ||
    observed.resources.memoryMiB !== tartResources(plan).memoryMiB ||
    observed.state !== "running" ||
    !observed.ipAddress ||
    !isIPv4(observed.ipAddress) ||
    resolved.artifactDigest !== plan.artifact.digest
  )
    throw new Error("Tart VM readback differs from the frozen plan");
}

function assertInventory(
  plan: ProvisionPlan,
  inventory: InventoryEvidence,
  resolved: ResolvedTartRuntime,
): void {
  if (
    inventory.completeness !== "complete" ||
    !sameProvisionIdentity(inventory.identity, tartIdentity(plan)) ||
    inventory.runtime.runtimeIdentityId !== resolved.runtimeIdentityId ||
    inventory.runtime.connectionRevisionId !== resolved.connectionRevisionId ||
    inventory.objects.length !== 1
  )
    throw new Error("Tart inventory does not match the frozen plan");
}

function assertInventoryVmMatches(
  inventory: InventoryEvidence,
  current: OwnedResource,
): void {
  const prior = inventory.objects[0];
  if (
    !prior ||
    prior.kind !== "vm" ||
    prior.ownership !== "owned" ||
    prior.id !== current.id ||
    prior.contractHash !== current.contractHash ||
    !sameProvisionIdentity(prior.identity, current.identity) ||
    !sameJson(prior.evidence, current.evidence)
  )
    throw new Error("Tart VM inventory changed before readiness verification");
}

function makeBootstrapRequest(
  plan: ProvisionPlan,
  identity: TartAllocationIdentity,
  network: TartNetworkEvidence,
  clientPublicKey: string,
  clientPublicKeyFingerprint: string,
): TartGuestBootstrapRequest {
  if (fingerprint(clientPublicKey) !== clientPublicKeyFingerprint)
    throw new Error("Tart client key material does not match its fingerprint");
  const nonce = expectedBootstrapNonce(plan);
  return tartGuestBootstrapRequestSchema.parse({
    identity,
    nonce,
    account: plan.access.account,
    clientPublicKey,
    clientPublicKeyFingerprint,
    networkEvidence: {
      reference: network.reference,
      revisionId: network.revisionId,
      expiresAt: network.expiresAt,
    },
  });
}

function assertBootstrapReceipt(
  receipt: TartGuestBootstrapReceipt,
  request: TartGuestBootstrapRequest,
  plan: ProvisionPlan,
  now: number,
): asserts receipt is Extract<
  TartGuestBootstrapReceipt,
  { status: "applied" }
> {
  if (
    receipt.status !== "applied" ||
    !sameProvisionIdentity(receipt.identity, request.identity) ||
    receipt.nonce !== request.nonce ||
    receipt.account !== request.account ||
    receipt.clientPublicKeyFingerprint !== request.clientPublicKeyFingerprint ||
    receipt.networkEvidenceReference !== request.networkEvidence.reference ||
    receipt.networkEvidenceExpiresAt !== request.networkEvidence.expiresAt ||
    Date.parse(receipt.observedAt) > now ||
    Date.parse(receipt.observedAt) > plan.deadlineMs ||
    Date.parse(receipt.networkEvidenceExpiresAt) <= now ||
    Date.parse(receipt.networkEvidenceExpiresAt) > plan.deadlineMs ||
    fingerprint(receipt.hostPublicKey) !== receipt.hostKeyFingerprint
  )
    throw new Error("Tart guest bootstrap receipt does not match the request");
}

function fingerprint(publicKey: string): string {
  const parsed = sshUtils.parseKey(publicKey);
  if (parsed instanceof Error || parsed.isPrivateKey())
    throw new Error("Tart SSH public key is invalid");
  return `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

function tartVmName(identity: TartAllocationIdentity): string {
  const ownerKey = JSON.stringify(tartAllocationOwnerTuple(identity));
  return `hitchlet-${createHash("sha256").update(ownerKey).digest("hex").slice(0, 32)}`;
}

function provisionHashes(plan: ProvisionPlan) {
  return {
    resourcesHash: sha256(plan.resources),
    networkHash: sha256(plan.resolved.network),
    mountsHash: sha256(plan.resolved.mounts),
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashSoftnetReadback(readback: {
  allow: readonly string[];
  block: readonly string[];
}): string {
  return `sha256:${sha256({
    allow: [...readback.allow].sort(),
    block: [...readback.block].sort(),
  })}`;
}

function readyReceiptSnapshot(
  value: unknown,
): Record<string, unknown> | undefined {
  const snapshot =
    typeof value === "string"
      ? (() => {
          try {
            return recordValue(JSON.parse(value));
          } catch {
            return undefined;
          }
        })()
      : recordValue(value);
  return snapshot ? recordValue(snapshot.receipt) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isResolvedTartRuntime(
  value: ResolvedTartRuntime | ResolvedTartCleanupRuntime,
): value is ResolvedTartRuntime {
  return (
    "template" in value &&
    tartLocalTemplateRefSchema.safeParse(value.template).success
  );
}

function expectedBootstrapNonce(plan: ProvisionPlan): string {
  const identity = tartIdentity(plan);
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.installationId,
        identity.runtimeIdentityId,
        identity.connectionRevisionId,
        identity.allocationId,
        identity.generation,
        identity.purpose,
        plan.resolved.contractHash,
      ]),
    )
    .digest("base64url");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireJournal(
  journal: ResourceJournal,
): asserts journal is Required<ResourceJournal> {
  if (!journal.beforeCreate || !journal.assertActive || !journal.recordCreated)
    throw new Error("Tart create requires a durable VM resource journal");
}
