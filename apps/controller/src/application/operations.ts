import { resolvedStorageMountSchema } from "@hitchlet/contracts/internal";
import { admissionOpen } from "./maintenance.js";
import { resourceManifest } from "../domain/resource-manifest.js";
import { randomUUID } from "node:crypto";
import {
  AcceptedAcquireRequestSchema,
  type AcceptedAcquireRequest,
  type ResourceContract,
} from "@hitchlet/contracts";
import { StorageError, type Storage } from "../storage/index.js";
import type {
  ExecutionPort,
  Inspection,
  ProvisionPlan,
  OwnedResource,
  ReadyReceipt,
  NetworkDestination,
  NetworkDenyRule,
  StorageProtocol,
} from "../providers/port.js";
import { createHash } from "node:crypto";
import { ImageValidationService } from "./image-validation.js";
import { ResourceContractSchema } from "@hitchlet/contracts/schemas";
import { SQLiteValidationStore } from "../storage/validation-store.js";
import { SQLiteOperationStore } from "../storage/operation-store.js";

type Row = Record<string, string | number | bigint | null>;
/** A controller owns this guard only for calls still executing in its own process.
 * It is not persisted and is never evidence that a remote request has completed. */
export class AllocationCreateCalls {
  private readonly active = new Set<string>();
  has(allocationId: string): boolean {
    return this.active.has(allocationId);
  }
  enter(allocationId: string): void {
    this.active.add(allocationId);
  }
  leave(allocationId: string): void {
    this.active.delete(allocationId);
  }
}

/** Shared durable executor for tenant and internal validation allocations. */
export class OperationWorker {
  private readonly store: SQLiteOperationStore;
  private readonly validations: SQLiteValidationStore;
  private readonly createCalls: AllocationCreateCalls;
  constructor(
    private readonly options: {
      storage: Storage;
      execution: ExecutionPort;
      installationId: string;
      controllerEpoch?: number;
      now?: () => number;
      id?: () => string;
      createCalls?: AllocationCreateCalls;
    },
  ) {
    this.store = new SQLiteOperationStore(options.storage);
    this.createCalls = options.createCalls ?? new AllocationCreateCalls();
    this.validations = new SQLiteValidationStore(options.storage, () =>
      this.now(),
    );
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
    worked += await this.reconcileIntegrityAudits();
    return worked;
  }
  /** Read-only Portainer integrity audits use the provision operation as their
   * durable cursor. They never transition it out of succeeded or call create. */
  private async reconcileIntegrityAudits(): Promise<number> {
    const epoch = this.options.controllerEpoch ?? 1;
    const due = await this.store.dueIntegrityAudits(this.now());
    let worked = 0;
    for (const candidate of due) {
      if (typeof candidate.id !== "string") continue;
      const token = (this.options.id ?? randomUUID)();
      const op = await this.store.claimIntegrityAudit({
        operationId: candidate.id,
        operationVersion: Number(candidate.version),
        token,
        epoch,
        now: this.now(),
        intervalMs: 30_000,
      });
      if (!op) continue;
      worked++;
      const now = this.now();
      const allocationId = stringField(val(op, "allocation_id"));
      const ticketId = stringField(val(op, "ticket_id"));
      const controlVersion = Number(op.control_version);
      try {
        const base = await this.plan(op, stringField(val(op, "id")));
        const observationPlan: ProvisionPlan = {
          ...base,
          deadlineMs: now + 15_000,
          executionPhase: "observe",
        };
        const inspection = await this.inspect(observationPlan);
        let loss: string | undefined;
        if (inspection.presence === "absent") loss = "RESOURCE_MISSING";
        else if (inspection.presence === "present") {
          if (inspection.integrity?.state === "lost")
            loss = inspection.integrity.reason ?? "RESOURCE_INTEGRITY_LOST";
          else if (inspection.integrity?.state !== "healthy")
            await this.recordAuditUnknown(
              op,
              token,
              allocationId,
              ticketId,
              controlVersion,
              "integrity_evidence_incomplete",
            );
          else {
            const expected = expectedManifest(op.actual_resources_json);
            const journalRows = await this.store.integrityManifest(
              allocationId,
              Number(op.generation),
            );
            const journal = journalRows
              .filter(
                (item) =>
                  item.ownership === "owned" &&
                  item.observed_state === "present",
              )
              .map((item) => `${item.kind}:${item.id}`)
              .sort();
            if (
              !expected ||
              journalRows.some((item) => item.observed_state !== "present") ||
              JSON.stringify(expected) !== JSON.stringify(journal)
            ) {
              await this.recordAuditUnknown(
                op,
                token,
                allocationId,
                ticketId,
                controlVersion,
                "persisted_resource_manifest_incomplete",
              );
              continue;
            }
            const actual = inspection.evidence.objects
              .filter((item) => item.ownership === "owned")
              .map((item) => `${item.kind}:${item.id}`)
              .sort();
            if (JSON.stringify(expected) !== JSON.stringify(actual)) {
              const expectedSet = new Set(expected);
              const ownedOrphans = actual.filter(
                (item) => !expectedSet.has(item),
              );
              loss = ownedOrphans.length
                ? `RESOURCE_MANIFEST_DRIFT; ownedOrphans=${ownedOrphans.join(",")}`
                : "RESOURCE_MANIFEST_DRIFT";
            } else
              await this.store.recordIntegrityAudit({
                operationId: stringField(val(op, "id")),
                allocationId,
                ticketId,
                token,
                operationVersion: Number(op.version),
                controlVersion,
                epoch,
                now: this.now(),
                state: "healthy",
              });
          }
        } else {
          await this.recordAuditUnknown(
            op,
            token,
            allocationId,
            ticketId,
            controlVersion,
            inspection.reason,
          );
        }
        if (loss) {
          await this.store.terminateExpired({
            id: ticketId,
            phase: "ready",
            version: Number(op.ticket_version),
            reason: "resource_lost",
            detail: loss,
            cleanupId: (this.options.id ?? randomUUID)(),
            requestHash: createHash("sha256")
              .update(`${ticketId}:resource_lost:${loss}:${controlVersion}`)
              .digest("hex"),
            now: this.now(),
            expectedControlVersion: controlVersion,
            expectedEpoch: epoch,
            auditOperationId: stringField(val(op, "id")),
            auditToken: token,
            auditOperationVersion: Number(op.version),
          });
        }
      } catch {
        await this.recordAuditUnknown(
          op,
          token,
          allocationId,
          ticketId,
          controlVersion,
          "integrity_observation_failed",
        );
      }
    }
    return worked;
  }
  private async recordAuditUnknown(
    op: Row,
    token: string,
    allocationId: string,
    ticketId: string,
    controlVersion: number,
    reason: string,
  ): Promise<void> {
    await this.store.recordIntegrityAudit({
      operationId: stringField(val(op, "id")),
      allocationId,
      ticketId,
      token,
      operationVersion: Number(op.version),
      controlVersion,
      epoch: this.options.controllerEpoch ?? 1,
      now: this.now(),
      state: "unknown",
      reason,
    });
  }
  /** Run before scheduling on startup and periodically; deadlines are strict (equality is expired). */
  async reconcileBeforeScheduling(): Promise<number> {
    await this.validations.expireDue(this.now());
    await this.expireDue();
    await new ImageValidationService(this.validations, () =>
      this.now(),
    ).retryBlocked();
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
      typeof op.node_id !== "string"
    )
      return false;
    const flightKey = `${this.options.installationId}:${op.allocation_id}`;
    if (this.createCalls.has(flightKey)) {
      await this.defer(op, token, "create_call_in_flight");
      return true;
    }
    const trackFlight =
      parseObject(op.intent_json).executionMode === "portainer";
    if (op.kind === "allocation.provision" && trackFlight)
      this.createCalls.enter(flightKey);
    try {
      if (op.kind === "allocation.provision" && op.desired_state !== "present")
        await this.defer(op, token, "allocation_terminated");
      else if (
        op.kind === "allocation.provision" &&
        trackFlight &&
        parseObject(op.result_json).createJournalVersion !== 1
      )
        await this.defer(op, token, "untracked_create_outcome_unknown");
      else if (op.kind === "allocation.provision") {
        const execute = async () => {
          if (Number(op.attempt_count) >= 5)
            await this.inspectExhaustedProvision(op, token);
          else
            await this.provision(op, await this.plan(op, operationId), token);
        };
        if (trackFlight) await this.withProvisionLease(op, token, execute);
        else await execute();
      } else await this.cleanup(op, token);
    } catch (error) {
      await this.defer(op, token, "execution_error");
    } finally {
      if (op.kind === "allocation.provision" && trackFlight)
        this.createCalls.leave(flightKey);
    }
    return true;
  }
  /** Explicit operator retry. The reason is persisted in both Operation and Ticket event history. */
  retryFailedOperation(operationId: string, reason: string): Promise<void> {
    return this.store.retryFailedOperation(operationId, reason, this.now());
  }
  private async inspect(plan: ProvisionPlan): Promise<Inspection> {
    const result = await this.options.execution.inspect(plan);
    if (result.presence === "unknown") return result;
    const evidence = result.evidence;
    const expected = plan.identity;
    const identityMatches = (identity: ProvisionPlan["identity"]) =>
      identity.installationId === expected.installationId &&
      identity.allocationId === expected.allocationId &&
      identity.generation === expected.generation &&
      identity.operationId === expected.operationId &&
      identity.purpose === expected.purpose &&
      identity.runtimeIdentityId === expected.runtimeIdentityId &&
      identity.connectionRevisionId === expected.connectionRevisionId;
    if (
      evidence.completeness !== "complete" ||
      !identityMatches(evidence.identity) ||
      evidence.identity.controlVersion !== expected.controlVersion ||
      evidence.runtime.runtimeIdentityId !== expected.runtimeIdentityId ||
      evidence.runtime.connectionRevisionId !== expected.connectionRevisionId
    )
      return { presence: "unknown", reason: "inventory_incomplete" };
    if (
      result.presence === "present" &&
      result.evidence.objects.some(
        (item) =>
          !identityMatches(item.identity) ||
          item.contractHash !== plan.resolved.contractHash,
      )
    )
      return { presence: "unknown", reason: "inventory_incomplete" };
    return result;
  }

  /** Keep this controller's bounded lease alive during slow external readiness checks.
   * Renewal cannot extend the original provision deadline or revive an expired owner. */
  private async withProvisionLease(
    op: Row,
    token: string,
    execute: () => Promise<void>,
  ): Promise<void> {
    const renew = () =>
      this.store.assertProvisionActive(
        String(op.id),
        token,
        Number(op.version),
        this.now(),
      );
    await renew();
    let pending: Promise<void> | undefined;
    let failed: unknown;
    const timer = setInterval(() => {
      if (pending || failed) return;
      pending = renew()
        .catch((error: unknown) => {
          failed = error;
        })
        .finally(() => {
          pending = undefined;
        });
    }, 10_000);
    timer.unref();
    try {
      await execute();
    } finally {
      clearInterval(timer);
      await pending;
    }
  }

  private async inspectExhaustedProvision(
    op: Row,
    token: string,
  ): Promise<void> {
    const plan = await this.plan(op, stringField(val(op, "id")));
    const inspection = await this.inspect(plan);
    if (inspection.presence === "present") {
      await this.recordObjects(op, inspection.evidence.objects);
      if (!(await this.store.unknownCreateEffects(String(op.allocation_id)))) {
        // Exhaustion forbids another create call, but verified existing resources may still become ready.
        await this.provision(op, plan, token, false);
        return;
      }
    }
    const subject = operationSubject(op);
    if (subject.kind === "validation") {
      await this.validations.terminate(
        subject.validationId,
        "execution_failed",
        this.now(),
      );
      await this.defer(op, token, "validation_execution_failed");
      return;
    }
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
    allowCreate = true,
  ): Promise<void> {
    const now = this.now();
    const subject = operationSubject(op);
    if (subject.kind === "tenant")
      await this.store.markProvisioning(subject.ticketId, now);
    else await this.validations.markRunning(subject.validationId, now);
    if (
      op.desired_state !== "present" ||
      Number(op.control_version) !== Number(op.allocation_control_version) ||
      Number(op.deadline_ms) <= now
    )
      return this.defer(op, token);
    let inspection = await this.inspect(plan);
    if (inspection.presence === "unknown") return this.defer(op, token);
    if (
      allowCreate &&
      (await admissionOpen(
        this.options.storage,
        String(op.node_id),
        this.now(),
      )) &&
      (inspection.presence === "absent" || inspection.presence === "present")
    ) {
      await this.options.execution.create(plan, {
        beforeCreate: (effect) =>
          this.store.beforeCreate({
            operationId: String(op.id),
            token,
            operationVersion: Number(op.version),
            effect,
            now: this.now(),
          }),
        assertActive: () =>
          this.store.assertProvisionActive(
            String(op.id),
            token,
            Number(op.version),
            this.now(),
          ),
        recordCreated: (resource) => this.recordResource(op, resource),
      });
      inspection = await this.inspect(plan);
    }
    if (
      inspection.presence !== "present" ||
      inspection.evidence.completeness !== "complete"
    )
      return this.defer(op, token);
    await this.recordObjects(op, inspection.evidence.objects);
    if (await this.store.unknownCreateEffects(String(op.allocation_id)))
      return this.defer(op, token, "create_effect_outcome_unknown");
    if (parseObject(op.intent_json).executionMode === "portainer")
      await this.store.assertProvisionActive(
        String(op.id),
        token,
        Number(op.version),
        this.now(),
      );
    const receipt = await this.options.execution.ready(
      plan,
      inspection.evidence,
    );
    if (parseObject(op.intent_json).executionMode === "portainer")
      await this.store.assertProvisionActive(
        String(op.id),
        token,
        Number(op.version),
        this.now(),
      );
    if (!validReceipt(plan, inspection.evidence.objects, receipt))
      return this.defer(op, token, "ready_evidence_mismatch");
    if (subject.kind === "validation") {
      await this.validations.completeTest({
        validationId: subject.validationId,
        op,
        token,
        receipt,
        objects: inspection.evidence.objects,
        now: this.now(),
      });
      return;
    }
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
      executionMode: String(parseObject(op.intent_json).executionMode),
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
      observedAtMs: this.now(),
      detailsJson: JSON.stringify({
        ...item.details,
        contractHash: item.contractHash,
        ...(item.details
          ? {}
          : { simulator: true, detachedOnly: item.ownership === "reference" }),
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
    const subject = operationSubject(op);
    const frozen = parseObject(row.accepted_contract_json);
    const accepted =
      subject.kind === "tenant"
        ? (AcceptedAcquireRequestSchema.parse(
            JSON.parse(row.request_json),
          ) as unknown as AcceptedAcquireRequest)
        : {
            resources: ResourceContractSchema.parse(
              frozen.resources,
            ) as ResourceContract,
            access: { protocol: "ssh" as const },
          };
    const network = objectValue(frozen.network);
    const storage = Array.isArray(frozen.storage)
      ? frozen.storage.map(objectValue)
      : [];
    const resources: ResourceContract = accepted.resources;
    const requirementsRow = parseObject(
      stringField(val(row, "requirements_json")),
    );
    const requirements = objectValue(
      requirementsRow.bootstrap ?? {
        mechanism: "simulator",
        contractVersion: "1",
        identityReset: true,
      },
    );
    const accessRecipe = objectValue(
      parseObject(stringField(val(row, "access_recipe_json"))),
    );
    const selectionHash = stringField(frozen.selectionHash);
    let mounts: ProvisionPlan["resolved"]["mounts"] = storage.map((entry) => ({
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
    if (typeof row.resolved_provision_contract_id !== "string")
      mounts = mounts.map((m) => resolvedStorageMountSchema.parse(m));
    if (
      typeof row.resolved_provision_contract_id === "string" &&
      mounts.length
    ) {
      const bound = await this.store.resolvedContract(
        row.resolved_provision_contract_id,
      );
      const persisted = JSON.parse(String(bound?.storage_bindings_json));
      if (!Array.isArray(persisted))
        throw new Error("Bound mount facts missing");
      if (persisted.every((m) => typeof m.resolvedSourceRef === "string"))
        mounts = persisted.map((m) => resolvedStorageMountSchema.parse(m));
      else if (
        parseObject(row.frozen_config_json).executionMode === "portainer"
      )
        throw new Error("Real runtime mount evidence missing");
      // Pre-D23 Simulator contracts stored frozen selections rather than host
      // facts. Their explicit simulated references retain the original hash.
    }
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
    let contractHash = createHash("sha256")
      .update(JSON.stringify(contractPayload))
      .digest("hex");
    const binding = stringField(val(op, "connection_revision_id"));
    const deterministicContractId = `d04-${createHash("sha256")
      .update(stringField(val(op, "allocation_id")))
      .digest("hex")
      .slice(0, 32)}`;
    let plan: ProvisionPlan = {
      deadlineMs: Number(op.deadline_ms),
      ...(typeof row.frozen_config_json === "string"
        ? { runtimeConfig: parseObject(row.frozen_config_json) }
        : {}),
      identity: {
        installationId: this.options.installationId,
        allocationId: stringField(val(op, "allocation_id")),
        generation: Number(op.generation),
        operationId,
        purpose: subject.kind,
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
      bootstrap: {
        mechanism: stringField(requirements.mechanism),
        contractVersion: stringField(requirements.contractVersion),
        identityReset: requiredTrue(requirements.identityReset),
      },
      access: {
        accessProtocols: stringList(
          accessRecipe.accessProtocols ?? [accepted.access.protocol],
        ) as ("ssh" | "rdp")[],
        ports: numberList(
          accessRecipe.ports ?? [
            accepted.access.protocol === "ssh" ? 22 : 3389,
          ],
        ),
        account:
          typeof accessRecipe.account === "string"
            ? accessRecipe.account
            : "simulator",
        allowedSourceCidrs: stringList(accessRecipe.allowedSourceCidrs ?? []),
        discovery:
          typeof accessRecipe.discovery === "string"
            ? accessRecipe.discovery
            : "simulator",
        readiness:
          typeof accessRecipe.readiness === "string"
            ? accessRecipe.readiness
            : "simulator",
      },
    };
    if (
      typeof row.resolved_provision_contract_id !== "string" &&
      mounts.length &&
      parseObject(row.frozen_config_json).executionMode === "portainer"
    ) {
      if (!this.options.execution.resolveMounts)
        throw new Error("Runtime storage facts unavailable");
      mounts = (await this.options.execution.resolveMounts(plan)).map((m) =>
        resolvedStorageMountSchema.parse(m),
      );
      contractHash = createHash("sha256")
        .update(JSON.stringify({ ...contractPayload, mounts }))
        .digest("hex");
      plan = { ...plan, resolved: { ...plan.resolved, mounts, contractHash } };
    }
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
      storageJson: JSON.stringify(mounts.length ? mounts : storage),
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
    let cleanupEvidence: Record<string, unknown> = {
      verifiedAbsentAtMs: this.now(),
      noExternalCreate: true,
    };
    const noExternalCreate =
      (createOperation.state === "cancelled" &&
        Number(createOperation.attempt_count) === 0) ||
      (typeof op.resolved_provision_contract_id !== "string" &&
        createOperation.state !== "succeeded");
    if (!noExternalCreate) {
      const baseCreatePlan = await this.plan(
        op,
        stringField(createOperation.id),
      );
      const journaled = await this.store.cleanupResources(
        stringField(val(op, "allocation_id")),
        Number(op.generation),
      );
      const journaledObjects = journaled.map((row) =>
        journaledOwnedResource(baseCreatePlan, row),
      );
      const createPlan: ProvisionPlan = {
        ...baseCreatePlan,
        deadlineMs: this.now() + 30_000,
        executionPhase: "cleanup" as const,
        cleanupResources: journaledObjects,
      };
      let createInspection = await this.inspect(createPlan);
      if (
        createInspection.presence === "unknown" &&
        createInspection.reason === "runtime_identity_mismatch"
      )
        return this.defer(op, token, "create_runtime_unknown");
      if (createInspection.presence === "unknown") {
        await this.options.execution.revokeStop(createPlan);
        createInspection = await this.inspect(createPlan);
      }
      if (createInspection.presence === "unknown")
        return this.defer(op, token, "create_inventory_unknown");
      if (createInspection.presence === "present")
        await this.recordObjects(op, createInspection.evidence.objects);
      if (await this.store.unknownCreateEffects(String(op.allocation_id)))
        return this.defer(op, token, "create_effect_outcome_unknown");
      const knownObjects =
        createInspection.presence === "present"
          ? [...createInspection.evidence.objects]
          : [];
      for (const row of journaled) {
        const resource = journaledOwnedResource(createPlan, row);
        const index = knownObjects.findIndex(
          (item) => item.id === resource.id && item.kind === resource.kind,
        );
        if (index < 0) knownObjects.push(resource);
        else
          knownObjects[index] = {
            ...knownObjects[index]!,
            details: { ...knownObjects[index]!.details, ...resource.details },
          };
      }
      const cleanupPlan: ProvisionPlan = {
        ...createPlan,
        cleanupResources: knownObjects,
      };
      await this.options.execution.revokeStop(cleanupPlan);
      const rank = (item: OwnedResource) =>
        item.kind === "container" ? 0 : item.kind === "network_policy" ? 2 : 1;
      knownObjects.sort((a, b) => rank(a) - rank(b));
      const destructionReceipts = [];
      for (const item of knownObjects) {
        const receipt = await this.options.execution.destroy(cleanupPlan, item);
        if (receipt) destructionReceipts.push(receipt);
      }
      const after = await this.inspect(cleanupPlan);
      if (after.presence !== "absent") return this.defer(op, token);
      cleanupEvidence = {
        verifiedAbsentAtMs: this.now(),
        inventory: after.evidence,
        resources: knownObjects.map((item) => ({
          id: item.id,
          kind: item.kind,
          ownership: item.ownership,
        })),
        destructionReceipts,
      };
    }
    if (await this.store.unknownCreateEffects(String(op.allocation_id)))
      return this.defer(op, token, "create_effect_outcome_unknown");
    const now = this.now();
    await this.store.finishCleanup({
      cleanupEvidence,
      operationId: stringField(val(op, "id")),
      allocationId: stringField(val(op, "allocation_id")),
      ticketId: typeof op.ticket_id === "string" ? op.ticket_id : null,
      ...(typeof op.image_validation_id === "string"
        ? { validationId: op.image_validation_id }
        : {}),
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
      ticketId: typeof op.ticket_id === "string" ? op.ticket_id : null,
      ...(typeof op.image_validation_id === "string"
        ? { validationId: op.image_validation_id }
        : {}),
      controlVersion: Number(op.control_version),
      token,
      operationVersion: Number(op.version),
      attempt,
      now,
      diagnostic,
    });
  }
}

type OperationSubject =
  | { kind: "tenant"; ticketId: string }
  | { kind: "validation"; validationId: string };
function operationSubject(op: Row): OperationSubject {
  if (op.purpose === "tenant" && typeof op.ticket_id === "string")
    return { kind: "tenant", ticketId: op.ticket_id };
  if (op.purpose === "validation" && typeof op.image_validation_id === "string")
    return { kind: "validation", validationId: op.image_validation_id };
  throw new Error("Operation allocation subject is invalid");
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
function numberList(value: unknown): number[] {
  return Array.isArray(value) && value.every(Number.isSafeInteger)
    ? (value as number[])
    : [];
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
function expectedManifest(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    const objects = (parsed as Record<string, unknown>).objects;
    if (!Array.isArray(objects)) return undefined;
    const result: string[] = [];
    for (const item of objects) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        return undefined;
      const resource = item as Record<string, unknown>;
      if (resource.ownership !== "owned") continue;
      if (typeof resource.id !== "string" || typeof resource.kind !== "string")
        return undefined;
      result.push(`${resource.kind}:${resource.id}`);
    }
    return result.sort();
  } catch {
    return undefined;
  }
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
    receipt.identity.purpose === identity.purpose &&
    receipt.manifestId === resourceManifest(plan, objects).manifestId &&
    receipt.manifestHash === resourceManifest(plan, objects).manifestHash &&
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
    (receipt.effectiveResources.scratchEnforcement === "best_effort"
      ? receipt.effectiveResources.limits.scratchMiB <=
        plan.resources.limit.scratchMiB
      : receipt.effectiveResources.limits.scratchMiB ===
        plan.resources.limit.scratchMiB) &&
    receipt.effectiveResources.cpuEnforcement === "hard" &&
    receipt.effectiveResources.memoryEnforcement === "hard" &&
    receipt.effectiveResources.scratchEnforcement ===
      (plan.resources.scratchEnforcement === "required"
        ? "hard"
        : "best_effort") &&
    receipt.effectiveResources.acceleratorAssignments.length ===
      plan.resources.accelerators.length &&
    ids.length > 0 &&
    new Set(ids).size === ids.length &&
    receipt.objectIds.length === ids.length &&
    receipt.objectIds.every((id, index) => id === ids[index])
  );
}
function journaledOwnedResource(plan: ProvisionPlan, row: Row): OwnedResource {
  const id = stringField(val(row, "id"));
  const kind = stringField(val(row, "kind"));
  if (
    ![
      "container",
      "network_policy",
      "endpoint",
      "storage_reference",
      "volume",
    ].includes(kind)
  )
    throw new Error("Managed resource journal contains an unsupported kind");
  const ownershipJson = parseObject(stringField(val(row, "ownership_json")));
  const identity = ownershipJson as unknown as ProvisionPlan["identity"];
  if (
    identity.installationId !== plan.identity.installationId ||
    identity.runtimeIdentityId !== plan.identity.runtimeIdentityId ||
    identity.connectionRevisionId !== plan.identity.connectionRevisionId ||
    identity.allocationId !== plan.identity.allocationId ||
    identity.generation !== plan.identity.generation ||
    identity.purpose !== plan.identity.purpose
  )
    throw new Error(
      "Managed resource journal owner does not match the frozen Operation",
    );
  const details = parseObject(stringField(val(row, "details_json")));
  return {
    id,
    kind: kind as OwnedResource["kind"],
    ownership: "owned",
    ...(typeof ownershipJson.referenceKey === "string"
      ? { referenceKey: ownershipJson.referenceKey }
      : {}),
    details,
    identity,
    contractHash: plan.resolved.contractHash,
    evidence: {
      artifactDigest: plan.artifact.digest,
      resourcesHash: hash(plan.resources),
      networkHash: hash(plan.resolved.network),
      mountsHash: hash(plan.resolved.mounts),
      accessProtocol: plan.accessProtocol,
    },
  };
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
