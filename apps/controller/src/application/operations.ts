import { randomUUID } from "node:crypto";
import {
  AcceptedAcquireRequestSchema,
  type AcceptedAcquireRequest,
  type ResourceContract,
} from "@hitchlet/contracts";
import { StorageError, type Storage } from "../storage/index.js";
import type {
  ExecutionPort,
  ProvisionPlan,
  OwnedResource,
  ReadyReceipt,
  NetworkDestination,
  NetworkDenyRule,
  StorageProtocol,
  ResourceJournal,
} from "../providers/port.js";
import { createHash } from "node:crypto";
import { SQLiteOperationStore } from "../storage/operation-store.js";

type Row = Record<string, string | number | bigint | null>;

/** Persistent operation executor and restart reconciler for the explicit Simulator mode. */
export class OperationWorker {
  private readonly store: SQLiteOperationStore;
  constructor(
    private readonly options: {
      storage: Storage;
      execution: ExecutionPort;
      installationId: string;
      controllerEpoch?: number;
      now?: () => number;
      id?: () => string;
    },
  ) {
    this.store = new SQLiteOperationStore(options.storage);
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  async reconcile(): Promise<number> {
    const rows = await this.store.dueOperations(
      this.options.installationId,
      this.options.controllerEpoch ?? 1,
      this.now(),
    );
    let worked = 0;
    for (const row of rows)
      if (typeof row.id === "string" && (await this.run(row.id))) worked++;
    return worked;
  }
  /** Run before scheduling on startup and periodically; deadlines are strict (equality is expired). */
  async reconcileBeforeScheduling(): Promise<number> {
    await this.expireDue();
    return this.reconcile();
  }
  async expireDue(): Promise<number> {
    const now = this.now();
    const rows = await this.store.expiredTickets(now);
    let expired = 0;
    for (const row of rows) {
      if (typeof row.id !== "string") continue;
      const reason =
        row.phase === "queued"
          ? "queue_timeout"
          : row.phase === "ready" && row.claimed_at_ms === null
            ? "unclaimed_timeout"
            : row.phase === "ready"
              ? "lease_expired"
              : "provision_timeout";
      const version = Number(row.version);
      if (row.phase === "queued") {
        await this.store.releaseExpiredQueued(row.id, version, now, reason);
        expired++;
        continue;
      }
      const cleanupId = (this.options.id ?? randomUUID)();
      try {
        await this.store.terminateExpired({
          id: row.id,
          phase: val(row, "phase") as string,
          version,
          reason,
          cleanupId,
          requestHash: createHash("sha256")
            .update(`${row.id}:${reason}`)
            .digest("hex"),
          now,
        });
        expired++;
      } catch (error) {
        if (
          !(error instanceof StorageError) ||
          error.code !== "STORAGE_CAS_FAILED"
        )
          throw error;
        // A concurrent termination wins; the next scan observes its durable intent.
      }
    }
    return expired;
  }
  async run(operationId: string): Promise<boolean> {
    const now = this.now();
    const token = (this.options.id ?? randomUUID)();
    const op = await this.store.claimOperation({
      operationId,
      installationId: this.options.installationId,
      epoch: this.options.controllerEpoch ?? 1,
      token,
      now,
    });
    if (
      !op ||
      typeof op.allocation_id !== "string" ||
      typeof op.ticket_id !== "string" ||
      typeof op.node_id !== "string"
    )
      return false;
    try {
      if (op.kind === "allocation.provision" && Number(op.attempt_count) >= 5)
        await this.inspectExhaustedProvision(op, token);
      else if (op.kind === "allocation.provision")
        await this.provision(op, await this.plan(op, operationId), token);
      else await this.cleanup(op, token);
    } catch {
      await this.defer(op, token, "execution_error");
    }
    return true;
  }
  /** Explicit operator retry. The reason is persisted in both Operation and Ticket event history. */
  retryFailedOperation(operationId: string, reason: string): Promise<void> {
    return this.store.retryFailedOperation(operationId, reason, this.now());
  }
  private async inspectExhaustedProvision(
    op: Row,
    token: string,
  ): Promise<void> {
    const plan = await this.plan(op, stringField(val(op, "id")));
    const inspection = await this.options.execution.inspect(plan);
    if (inspection.presence === "present")
      await this.recordObjects(op, inspection.evidence.objects);
    await this.defer(
      op,
      token,
      inspection.presence === "unknown"
        ? `exhausted_inspection_${inspection.reason}`
        : inspection.presence === "present"
          ? "exhausted_inspection_found_resources"
          : "exhausted_inspection_absent",
    );
  }
  private async provision(
    op: Row,
    plan: ProvisionPlan,
    token: string,
  ): Promise<void> {
    const now = this.now();
    await this.store.markProvisioning(stringField(val(op, "ticket_id")), now);
    if (op.desired_state !== "present" || Number(op.deadline_ms) <= now)
      return this.defer(op, token);
    let inspection = await this.options.execution.inspect(plan);
    if (inspection.presence === "unknown") return this.defer(op, token);
    const expectedObjects = 3 + plan.resolved.mounts.length;
    if (
      inspection.presence === "absent" ||
      (inspection.presence === "present" &&
        inspection.evidence.objects.length < expectedObjects)
    ) {
      await this.options.execution.create(plan, {
        recordCreated: (resource) => this.recordResource(op, resource),
      });
      inspection = await this.options.execution.inspect(plan);
    }
    if (
      inspection.presence !== "present" ||
      inspection.evidence.objects.length !== expectedObjects
    )
      return this.defer(op, token);
    await this.recordObjects(op, inspection.evidence.objects);
    const receipt = await this.options.execution.ready(
      plan,
      inspection.evidence,
    );
    if (!validReceipt(plan, inspection.evidence.objects, receipt))
      return this.defer(op, token, "simulator_ready_evidence_mismatch");
    const ticket = await this.store.ticketForReady(
      stringField(val(op, "ticket_id")),
    );
    if (
      !ticket ||
      ticket.phase !== "provisioning" ||
      Number(op.deadline_ms) <= this.now()
    )
      return this.defer(op, token);
    const accepted = parseObject(ticket.request_json);
    const lease = objectValue(accepted.lease);
    const starts = this.now();
    const claimBy = starts + 600_000;
    const expires = starts + Number(lease.requestedSeconds) * 1000;
    const renewUntil = starts + Number(lease.maximumLifetimeSeconds) * 1000;
    if (
      ![starts, claimBy, expires, renewUntil].every(Number.isSafeInteger) ||
      expires <= starts ||
      renewUntil < expires ||
      starts >= Number(op.deadline_ms)
    )
      return this.defer(op, token);
    await this.store.completeReady({
      receipt,
      starts,
      claimBy,
      expires,
      renewUntil,
      operationId: stringField(val(op, "id")),
      token,
      operationVersion: Number(op.version),
      allocationId: stringField(val(op, "allocation_id")),
      generation: Number(op.generation),
      controlVersion: Number(op.control_version),
      ticketId: stringField(val(op, "ticket_id")),
      contractId: plan.resolved.id,
      objects: inspection.evidence.objects,
    });
  }
  private async recordObjects(
    op: Row,
    objects: readonly OwnedResource[],
  ): Promise<void> {
    for (const item of objects) await this.recordResource(op, item);
  }
  private async recordResource(op: Row, item: OwnedResource): Promise<void> {
    const result = await this.store.recordResource({
      id: item.id,
      allocationId: stringField(val(op, "allocation_id")),
      nodeId: stringField(val(op, "node_id")),
      generation: Number(op.generation),
      kind: item.kind === "storage_reference" ? "volume" : item.kind,
      ownership: item.ownership,
      ownershipJson: JSON.stringify({
        ...item.identity,
        referenceKey: item.referenceKey ?? null,
      }),
      detailsJson: JSON.stringify({
        simulator: true,
        detachedOnly: item.ownership === "reference",
      }),
    });
    if (result.changes !== 1n)
      throw new Error("Simulator resource ownership journal CAS failed");
  }
  private async plan(op: Row, operationId: string): Promise<ProvisionPlan> {
    const row = await this.store.provisionInputs(
      stringField(val(op, "allocation_id")),
    );
    if (
      !row ||
      typeof row.request_json !== "string" ||
      typeof row.accepted_contract_json !== "string" ||
      typeof row.node_id !== "string" ||
      typeof row.runtime_identity_id !== "string" ||
      typeof row.artifact_ref !== "string" ||
      typeof row.content_digest !== "string"
    )
      throw new Error("Persisted provision inputs are incomplete");
    const accepted = AcceptedAcquireRequestSchema.parse(
      JSON.parse(row.request_json),
    ) as unknown as AcceptedAcquireRequest;
    const frozen = parseObject(row.accepted_contract_json);
    const network = objectValue(frozen.network);
    const storage = Array.isArray(frozen.storage)
      ? frozen.storage.map(objectValue)
      : [];
    const resources: ResourceContract = accepted.resources;
    const selectionHash = stringField(frozen.selectionHash);
    const mounts = storage.map((entry) => ({
      grantId: stringField(entry.grantId),
      grantRevision: grantRevision(entry.grantRevision),
      revisionId: stringField(entry.storageProfileRevisionId),
      protocol: storageProtocol(entry.protocol),
      authorizedSubpath: stringField(entry.authorizedSubpath),
      approvedSourceRef: stringField(entry.approvedSourceRef),
      resolvedSourceRef: stringField(entry.approvedSourceRef),
      sourceValidationEvidenceId: `simulator:${stringField(entry.grantId)}`,
      target: stringField(entry.mountPath),
      mode: storageMode(entry.mode),
      secretVersionRef:
        typeof entry.secretVersionRef === "string"
          ? entry.secretVersionRef
          : null,
    }));
    const networkContract = {
      grantId: stringField(network.grantId),
      revisionId: stringField(network.networkProfileRevisionId),
      frozenPlatformDenyRevisionId: stringField(network.platformDenyRevisionId),
      platformDenyRevisionId: stringField(network.platformDenyRevisionId),
      mode: networkMode(network.mode),
      ipv6: ipv6Mode(network.ipv6),
      allowedEgress: parseEgress(network.allowedEgress),
      allowedIngressSourceCidrs: stringList(network.allowedIngressSourceCidrs),
      managementDenyRules: parseDenyRules(network.managementDenyRules),
      enforcement: enforcement(network.enforcement),
      verificationRequired: requiredTrue(network.verificationRequired),
    };
    const contractPayload = {
      selectionHash,
      nodeId: row.node_id,
      artifact: {
        id: val(op, "image_artifact_id"),
        ref: row.artifact_ref,
        digest: row.content_digest,
      },
      resources,
      network: networkContract,
      mounts,
    };
    const contractHash = createHash("sha256")
      .update(JSON.stringify(contractPayload))
      .digest("hex");
    const binding = stringField(val(op, "connection_revision_id"));
    const deterministicContractId = `d04-${createHash("sha256")
      .update(stringField(val(op, "allocation_id")))
      .digest("hex")
      .slice(0, 32)}`;
    const plan: ProvisionPlan = {
      identity: {
        installationId: this.options.installationId,
        allocationId: stringField(val(op, "allocation_id")),
        generation: Number(op.generation),
        operationId,
        purpose: "tenant",
        controlVersion: Number(op.control_version),
        runtimeIdentityId: row.runtime_identity_id,
        connectionRevisionId: binding,
      },
      artifact: {
        id: stringField(val(op, "image_artifact_id")),
        ref: row.artifact_ref,
        digest: row.content_digest,
      },
      resources,
      resolved: {
        id:
          typeof row.resolved_provision_contract_id === "string"
            ? row.resolved_provision_contract_id
            : deterministicContractId,
        contractHash,
        selectionHash,
        network: networkContract,
        mounts,
      },
      accessProtocol: accepted.access.protocol,
    };
    const boundId = row.resolved_provision_contract_id;
    if (typeof boundId === "string") {
      const bound = await this.store.resolvedContract(boundId);
      if (
        !bound ||
        bound.contract_hash !== contractHash ||
        bound.selection_hash !== selectionHash ||
        bound.node_id !== row.node_id
      )
        throw new Error("Resolved contract identity mismatch");
      return plan;
    }
    const contractId = deterministicContractId;
    const now = this.now();
    await this.store.bindResolvedContract({
      contractId,
      selectionHash,
      now,
      networkRevisionId: networkContract.revisionId,
      denyRevisionId: stringField(network.platformDenyRevisionId),
      contractHash,
      storageJson: JSON.stringify(storage),
      networkJson: JSON.stringify(network),
      allocationId: stringField(val(op, "allocation_id")),
      generation: Number(op.generation),
      controlVersion: Number(op.control_version),
    });
    return plan;
  }
  private async cleanup(op: Row, token: string): Promise<void> {
    const createOperation = await this.store.createOperation(
      stringField(val(op, "allocation_id")),
    );
    if (!createOperation) return this.defer(op, token, "missing_create_intent");
    if (
      createOperation.state === "running" &&
      Number(createOperation.locked_until_ms) > this.now()
    )
      return this.defer(op, token, "create_worker_lease_active");
    const noExternalCreate =
      (createOperation.state === "cancelled" &&
        Number(createOperation.attempt_count) === 0) ||
      (typeof op.resolved_provision_contract_id !== "string" &&
        createOperation.state !== "succeeded");
    if (!noExternalCreate) {
      const createPlan = await this.plan(op, stringField(createOperation.id));
      let createInspection = await this.options.execution.inspect(createPlan);
      if (
        createInspection.presence === "unknown" &&
        createInspection.reason === "runtime_identity_mismatch"
      )
        return this.defer(op, token, "create_runtime_unknown");
      if (createInspection.presence === "unknown") {
        await this.options.execution.revokeStop(createPlan);
        createInspection = await this.options.execution.inspect(createPlan);
      }
      if (createInspection.presence === "unknown")
        return this.defer(op, token, "create_inventory_unknown");
      if (createInspection.presence === "present")
        await this.recordObjects(op, createInspection.evidence.objects);
      await this.options.execution.revokeStop(createPlan);
      if (createInspection.presence === "present") {
        for (const item of createInspection.evidence.objects)
          await this.options.execution.destroy(createPlan, item);
      }
      const after = await this.options.execution.inspect(createPlan);
      if (after.presence !== "absent") return this.defer(op, token);
    }
    const now = this.now();
    await this.store.finishCleanup({
      operationId: stringField(val(op, "id")),
      allocationId: stringField(val(op, "allocation_id")),
      ticketId: stringField(val(op, "ticket_id")),
      token,
      operationVersion: Number(op.version),
      controlVersion: Number(op.control_version),
      now,
    });
  }
  private async defer(
    op: Row,
    token: string,
    diagnostic = "operation_not_ready",
  ): Promise<void> {
    const now = this.now();
    const attempt = Number(op.attempt_count);
    await this.store.deferOperation({
      operationId: stringField(val(op, "id")),
      allocationId: stringField(val(op, "allocation_id")),
      ticketId: stringField(val(op, "ticket_id")),
      controlVersion: Number(op.control_version),
      token,
      operationVersion: Number(op.version),
      attempt,
      now,
      diagnostic,
    });
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Invalid persisted contract");
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Invalid persisted contract");
  return parsed as Record<string, unknown>;
}
function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid persisted object (${typeof value})`);
  return value as Record<string, unknown>;
}
function val(row: Row, field: string): string | number | bigint | null {
  return row[field] ?? null;
}
function stringField(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Persisted string field is missing");
  return value;
}
function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("Persisted string list is invalid");
  return value as string[];
}
function parseEgress(value: unknown): NetworkDestination[] {
  if (!Array.isArray(value))
    throw new Error("Persisted egress rules are invalid");
  return value.map((item) => {
    const rule = objectValue(item);
    if (
      typeof rule.cidr !== "string" ||
      !rule.cidr ||
      (rule.protocol !== "tcp" && rule.protocol !== "udp") ||
      !Array.isArray(rule.ports) ||
      rule.ports.length === 0 ||
      rule.ports.some(
        (port) =>
          typeof port !== "number" ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535,
      )
    )
      throw new Error("Persisted egress rule is invalid");
    return {
      cidr: rule.cidr,
      protocol: rule.protocol,
      ports: rule.ports as number[],
    };
  });
}
function parseDenyRules(value: unknown): NetworkDenyRule[] {
  if (!Array.isArray(value))
    throw new Error("Persisted deny rules are invalid");
  return value.map((item) => {
    const rule = objectValue(item);
    if (typeof rule.cidr !== "string" || rule.cidr.length === 0)
      throw new Error("Persisted deny CIDR is invalid");
    if (rule.protocol === "any" && rule.ports === "any")
      return { cidr: rule.cidr, protocol: "any", ports: "any" };
    if (
      (rule.protocol !== "tcp" && rule.protocol !== "udp") ||
      (rule.ports !== "any" &&
        (!Array.isArray(rule.ports) ||
          rule.ports.some(
            (port) =>
              typeof port !== "number" ||
              !Number.isInteger(port) ||
              port < 1 ||
              port > 65535,
          )))
    )
      throw new Error("Persisted deny rule is invalid");
    return {
      cidr: rule.cidr,
      protocol: rule.protocol,
      ports: rule.ports as "any" | number[],
    };
  });
}
function storageProtocol(value: unknown): StorageProtocol {
  if (value !== "nfs" && value !== "smb" && value !== "local")
    throw new Error("Persisted storage protocol is invalid");
  return value;
}
function storageMode(value: unknown): "read_only" | "read_write" {
  if (value !== "read_only" && value !== "read_write")
    throw new Error("Persisted storage mode is invalid");
  return value;
}
function enforcement(value: unknown): "docker_iptables" {
  if (value !== "docker_iptables")
    throw new Error("Persisted network enforcement is invalid");
  return value;
}
function grantRevision(value: unknown): 1 {
  if (value !== 1) throw new Error("Persisted grant revision is invalid");
  return 1;
}
function networkMode(value: unknown): "isolated_bridge" {
  if (value !== "isolated_bridge")
    throw new Error("Persisted network mode is invalid");
  return value;
}
function requiredTrue(value: unknown): true {
  if (value !== true)
    throw new Error("Persisted verification requirement is missing");
  return true;
}
function ipv6Mode(value: unknown): "disabled" | "verified_equivalent" {
  if (value !== "disabled" && value !== "verified_equivalent")
    throw new Error("Persisted IPv6 mode is invalid");
  return value;
}
function validReceipt(
  plan: ProvisionPlan,
  objects: readonly OwnedResource[],
  receipt: ReadyReceipt,
): boolean {
  const identity = plan.identity;
  const ids = objects.map((item) => item.id).sort();
  return (
    receipt.bootstrapComplete === true &&
    receipt.offlineLeaseEnforcement === "unsupported" &&
    receipt.identity.installationId === identity.installationId &&
    receipt.identity.allocationId === identity.allocationId &&
    receipt.identity.generation === identity.generation &&
    receipt.identity.operationId === identity.operationId &&
    receipt.identity.controlVersion === identity.controlVersion &&
    receipt.identity.runtimeIdentityId === identity.runtimeIdentityId &&
    receipt.identity.connectionRevisionId === identity.connectionRevisionId &&
    receipt.artifactDigest === plan.artifact.digest &&
    receipt.contractHash === plan.resolved.contractHash &&
    receipt.networkRevisionId === plan.resolved.network.revisionId &&
    receipt.networkContractHash === hash(plan.resolved.network) &&
    receipt.mountContractHash === hash(plan.resolved.mounts) &&
    receipt.accessProtocol === plan.accessProtocol &&
    receipt.effectiveResources.limits.cpuMillis ===
      plan.resources.limit.cpuMillis &&
    receipt.effectiveResources.limits.memoryMiB ===
      plan.resources.limit.memoryMiB &&
    receipt.effectiveResources.limits.scratchMiB ===
      plan.resources.limit.scratchMiB &&
    receipt.effectiveResources.cpuEnforcement === "hard" &&
    receipt.effectiveResources.memoryEnforcement === "hard" &&
    receipt.effectiveResources.scratchEnforcement ===
      (plan.resources.scratchEnforcement === "required"
        ? "hard"
        : "best_effort") &&
    receipt.effectiveResources.acceleratorAssignments.length ===
      plan.resources.accelerators.length &&
    receipt.objectIds.length === ids.length &&
    receipt.objectIds.every((id, index) => id === ids[index])
  );
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
