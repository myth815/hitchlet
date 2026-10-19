import type { Storage } from "./index.js";
import type { OwnedResource, ReadyReceipt } from "../providers/port.js";

type Row = Record<string, string | number | bigint | null>;

/** D04's cohesive SQLite boundary for durable operation claims and receipts. */
export class SQLiteOperationStore {
  constructor(private readonly db: Storage) {}

  dueOperations(
    installationId: string,
    epoch: number,
    now: number,
  ): Promise<Row[]> {
    return this.db.all<Row>(
      "SELECT id FROM operations WHERE kind IN ('allocation.provision','allocation.cleanup') AND json_extract(intent_json,'$.executionMode')='simulator' AND (installation_id=? OR installation_id IS NULL) AND controller_epoch<=? AND ((state IN ('planned','unknown','failed') AND next_check_at_ms<=?) OR (state='running' AND locked_until_ms<=?)) ORDER BY next_check_at_ms,id LIMIT 32",
      [installationId, epoch, now, now],
    );
  }

  expiredTickets(now: number): Promise<Row[]> {
    return this.db.all<Row>(
      "SELECT t.id,t.phase,t.version,t.queue_deadline_ms,t.provision_deadline_ms,l.state AS lease_state,l.claim_by_ms,l.claimed_at_ms,l.expires_at_ms FROM tickets t LEFT JOIN leases l ON l.ticket_id=t.id WHERE (t.phase='queued' AND t.queue_deadline_ms<=?) OR (t.phase IN ('reserved','provisioning') AND t.provision_deadline_ms<=?) OR (t.phase='ready' AND ((l.claimed_at_ms IS NULL AND l.claim_by_ms<=?) OR l.expires_at_ms<=?)) ORDER BY t.id",
      [now, now, now, now],
    );
  }

  async releaseExpiredQueued(
    id: string,
    version: number,
    now: number,
    reason: string,
  ): Promise<void> {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='released',terminal_reason=?,cleanup_status='not_needed',released_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND phase='queued' AND version=? AND queue_deadline_ms<=?",
        params: [reason, now, now, id, version, now],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) SELECT 'ticket',id,version,'ticket.released',?,? FROM tickets WHERE id=? AND phase='released'",
        params: [now, JSON.stringify({ reason }), id],
      },
    ]);
  }

  async terminateExpired(input: {
    id: string;
    phase: string;
    version: number;
    reason: string;
    cleanupId: string;
    requestHash: string;
    now: number;
  }): Promise<void> {
    const { id, phase, version, reason, cleanupId, requestHash, now } = input;
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='releasing',terminal_reason=?,cleanup_status='pending',termination_requested_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND phase=? AND version=?",
        params: [reason, now, now, id, phase, version],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET desired_state='absent',control_version=control_version+1,version=version+1,updated_at_ms=? WHERE ticket_id=? AND desired_state<>'absent'",
        params: [now, id],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE leases SET state='revoking',version=version+1,updated_at_ms=? WHERE ticket_id=? AND state IN ('pending','active')",
        params: [now, id],
      },
      {
        kind: "run",
        sql: "UPDATE lease_renewals SET state='cancelled',rejection_json=json_object('code','termination_requested'),version=version+1,updated_at_ms=? WHERE lease_id IN (SELECT id FROM leases WHERE ticket_id=?) AND state='pending'",
        params: [now, id],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='cancelled',version=version+1,owner_token=NULL,locked_until_ms=NULL,updated_at_ms=? WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.provision' AND state='planned'",
        params: [now, id],
      },
      {
        kind: "run",
        sql: "INSERT INTO operations(id,installation_id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms) SELECT ?,o.installation_id,a.id,a.runtime_identity_id,o.connection_revision_id,a.image_artifact_id,a.generation,a.control_version,o.controller_epoch,'allocation.cleanup','cleanup',a.id||':cleanup:'||a.generation||':'||a.control_version,'planned',?,json_object('reason',?,'purpose','tenant','executionMode',json_extract(o.intent_json,'$.executionMode')),?,?,?,? FROM allocations a JOIN operations o ON o.allocation_id=a.id AND o.kind='allocation.provision' WHERE a.ticket_id=?",
        params: [
          cleanupId,
          requestHash,
          reason,
          now,
          now + 30_000,
          now,
          now,
          id,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) SELECT 'ticket',id,version,'ticket.terminated',?,? FROM tickets WHERE id=? AND phase='releasing'",
        params: [now, JSON.stringify({ reason }), id],
      },
    ]);
  }

  async claimOperation(input: {
    operationId: string;
    installationId: string;
    epoch: number;
    token: string;
    now: number;
  }): Promise<Row | undefined> {
    const { operationId, installationId, epoch, token, now } = input;
    const claimed = await this.db.run(
      "UPDATE operations SET state='running',controller_epoch=?,owner_token=?,locked_until_ms=?,attempt_count=attempt_count+1,version=version+1,updated_at_ms=? WHERE id=? AND kind IN ('allocation.provision','allocation.cleanup') AND json_extract(intent_json,'$.executionMode')='simulator' AND (installation_id=? OR installation_id IS NULL) AND controller_epoch<=? AND ((state IN ('planned','unknown','failed') AND next_check_at_ms<=?) OR (state='running' AND locked_until_ms<=?))",
      [
        epoch,
        token,
        now + 30_000,
        now,
        operationId,
        installationId,
        epoch,
        now,
        now,
      ],
    );
    if (claimed.changes !== 1n) return undefined;
    return this.db.get<Row>(
      "SELECT o.*,a.ticket_id,a.node_id,a.generation,a.control_version,a.desired_state,a.runtime_identity_id,a.resolved_provision_contract_id FROM operations o JOIN allocations a ON a.id=o.allocation_id WHERE o.id=? AND o.owner_token=?",
      [operationId, token],
    );
  }

  markProvisioning(ticketId: string, now: number): Promise<unknown> {
    return this.db.run(
      "UPDATE tickets SET phase='provisioning',version=version+1,updated_at_ms=? WHERE id=? AND phase='reserved' AND provision_deadline_ms>?",
      [now, ticketId, now],
    );
  }
  ticketForReady(ticketId: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT request_json,phase,version FROM tickets WHERE id=?",
      [ticketId],
    );
  }
  recordResource(input: {
    id: string;
    allocationId: string;
    nodeId: string;
    generation: number;
    kind: string;
    ownership: string;
    ownershipJson: string;
    detailsJson: string;
  }): Promise<{ changes: bigint }> {
    return this.db.run(
      "INSERT INTO managed_resources(id,allocation_id,node_id,generation,kind,provider_id,ownership,ownership_json,cleanup_policy,observed_state,details_json) VALUES(?,?,?,?,?,?,?, ?,?,'present',?) ON CONFLICT(id) DO UPDATE SET observed_state='present',details_json=excluded.details_json WHERE managed_resources.allocation_id=excluded.allocation_id AND managed_resources.generation=excluded.generation",
      [
        input.id,
        input.allocationId,
        input.nodeId,
        input.generation,
        input.kind,
        input.id,
        input.ownership,
        input.ownershipJson,
        input.ownership === "reference" ? "keep" : "destroy",
        input.detailsJson,
      ],
    );
  }
  provisionInputs(allocationId: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT t.request_json,t.accepted_contract_json,a.node_id,a.resolved_provision_contract_id,a.runtime_identity_id,art.artifact_ref,art.content_digest FROM tickets t JOIN allocations a ON a.ticket_id=t.id JOIN image_artifacts art ON art.id=a.image_artifact_id WHERE a.id=?",
      [allocationId],
    );
  }
  resolvedContract(id: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT contract_hash,selection_hash,node_id FROM resolved_provision_contracts WHERE id=?",
      [id],
    );
  }
  async bindResolvedContract(input: {
    contractId: string;
    selectionHash: string;
    now: number;
    networkRevisionId: string;
    denyRevisionId: string;
    contractHash: string;
    storageJson: string;
    networkJson: string;
    allocationId: string;
    generation: number;
    controlVersion: number;
  }): Promise<void> {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json) SELECT ?,a.node_id,?,?,?, ?,?,?,? FROM allocations a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=? AND a.resolved_provision_contract_id IS NULL AND a.control_version=? AND a.desired_state='present' AND t.phase IN ('reserved','provisioning') AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=t.network_profile_revision_id) AND NOT EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id)",
        params: [
          input.contractId,
          input.selectionHash,
          input.now,
          input.networkRevisionId,
          input.denyRevisionId,
          input.contractHash,
          input.storageJson,
          input.networkJson,
          input.allocationId,
          input.controlVersion,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET resolved_provision_contract_id=?,version=version+1,updated_at_ms=? WHERE id=? AND generation=? AND control_version=? AND desired_state='present' AND resolved_provision_contract_id IS NULL AND EXISTS(SELECT 1 FROM tickets t WHERE t.id=allocations.ticket_id AND t.phase IN ('reserved','provisioning')) AND EXISTS(SELECT 1 FROM nodes n JOIN machines m ON m.id=n.machine_id WHERE n.id=allocations.node_id AND n.observed_health='healthy' AND n.observed_at_ms+120000>? AND m.observed_power='on')",
        params: [
          input.contractId,
          input.now,
          input.allocationId,
          input.generation,
          input.controlVersion,
          input.now,
        ],
        expectChanges: 1,
      },
    ]);
  }
  createOperation(allocationId: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT id,state,locked_until_ms,attempt_count FROM operations WHERE allocation_id=? AND kind='allocation.provision'",
      [allocationId],
    );
  }

  async retryFailedOperation(
    operationId: string,
    reason: string,
    now: number,
  ): Promise<void> {
    if (!reason.trim() || reason.length > 500)
      throw new RangeError("Retry reason must contain 1-500 characters");
    const operation = await this.db.get<Row>(
      "SELECT o.version,o.attempt_count,a.ticket_id,t.version AS ticket_version FROM operations o JOIN allocations a ON a.id=o.allocation_id JOIN tickets t ON t.id=a.ticket_id WHERE o.id=? AND o.state='failed' AND o.kind IN ('allocation.provision','allocation.cleanup') AND json_extract(o.intent_json,'$.executionMode')='simulator'",
      [operationId],
    );
    if (!operation) throw new Error("Failed Simulator operation was not found");
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE operations SET state='unknown',attempt_count=0,next_check_at_ms=?,owner_token=NULL,locked_until_ms=NULL,result_json=?,version=version+1,updated_at_ms=? WHERE id=? AND state='failed' AND version=?",
        params: [
          now,
          JSON.stringify({
            code: "operator_retry_requested",
            reason: reason.trim(),
            previousAttempts: Number(operation.attempt_count),
          }),
          now,
          operationId,
          Number(operation.version),
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES('ticket',?,?,'operation.retry_requested',?,?)",
        params: [
          operation.ticket_id ?? null,
          Number(operation.ticket_version),
          now,
          JSON.stringify({
            operationId,
            reason: reason.trim(),
            previousAttempts: Number(operation.attempt_count),
          }),
        ],
      },
    ]);
  }

  completeReady(input: {
    receipt: ReadyReceipt;
    starts: number;
    claimBy: number;
    expires: number;
    renewUntil: number;
    operationId: string;
    token: string;
    operationVersion: number;
    allocationId: string;
    generation: number;
    controlVersion: number;
    ticketId: string;
    contractId: string;
    objects: readonly OwnedResource[];
  }): Promise<unknown[]> {
    const {
      receipt,
      starts,
      claimBy,
      expires,
      renewUntil,
      operationId,
      token,
      operationVersion,
      allocationId,
      generation,
      controlVersion,
      ticketId,
      contractId,
      objects,
    } = input;
    return this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE operations SET state='succeeded',result_json=?,owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND owner_token=? AND version=? AND state='running' AND locked_until_ms>?",
        params: [
          JSON.stringify(receipt),
          starts,
          operationId,
          token,
          operationVersion,
          starts,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET observed_state='running',manifest_complete=1,manifest_id=?,manifest_revision=1,actual_resources_json=?,cleanup_status='running',version=version+1,updated_at_ms=? WHERE id=? AND generation=? AND control_version=? AND desired_state='present' AND resolved_provision_contract_id=?",
        params: [
          receipt.manifestHash,
          JSON.stringify({
            simulator: true,
            offlineLeaseEnforcement: "unsupported",
            receipt,
            manifestHash: receipt.manifestHash,
            objects,
          }),
          starts,
          allocationId,
          generation,
          controlVersion,
          contractId,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE leases SET state='active',starts_at_ms=?,claim_by_ms=?,expires_at_ms=?,renew_until_ms=?,version=version+1,updated_at_ms=? WHERE ticket_id=? AND generation=? AND state='pending' AND version=1",
        params: [
          starts,
          claimBy,
          expires,
          renewUntil,
          starts,
          ticketId,
          generation,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE capacity_claims SET state='committed',version=version+1,updated_at_ms=? WHERE allocation_id=? AND state='reserved'",
        params: [starts, allocationId],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='ready',ready_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND phase='provisioning' AND provision_deadline_ms>?",
        params: [starts, starts, ticketId, starts],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) SELECT 'ticket',id,version,'ticket.ready',?,? FROM tickets WHERE id=? AND phase='ready'",
        params: [
          starts,
          JSON.stringify({
            simulator: true,
            offlineLeaseEnforcement: "unsupported",
            manifestHash: receipt.manifestHash,
          }),
          ticketId,
        ],
      },
    ]);
  }

  async finishCleanup(input: {
    operationId: string;
    allocationId: string;
    ticketId: string;
    token: string;
    operationVersion: number;
    controlVersion: number;
    now: number;
  }): Promise<void> {
    const {
      operationId,
      allocationId,
      ticketId,
      token,
      operationVersion,
      controlVersion,
      now,
    } = input;
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE operations SET state='succeeded',result_json='{}',owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND owner_token=? AND version=? AND state='running' AND locked_until_ms>?",
        params: [now, operationId, token, operationVersion, now],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='cancelled',owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE (allocation_id=? AND kind='allocation.provision' AND state IN ('unknown','failed')) OR (allocation_id=? AND kind='allocation.provision' AND state='running' AND locked_until_ms<=?)",
        params: [now, allocationId, allocationId, now],
      },
      {
        kind: "run",
        sql: "UPDATE managed_resources SET observed_state='absent' WHERE allocation_id=? AND ownership IN ('owned','reference')",
        params: [allocationId],
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET observed_state='absent',cleanup_status='complete',manifest_complete=CASE WHEN manifest_id IS NULL THEN 0 ELSE 1 END,version=version+1,updated_at_ms=? WHERE id=? AND desired_state='absent' AND control_version=?",
        params: [now, allocationId, controlVersion],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE capacity_claims SET state='released',released_at_ms=?,version=version+1,updated_at_ms=? WHERE allocation_id=? AND state<>'released'",
        params: [now, now, allocationId],
      },
      {
        kind: "run",
        sql: "UPDATE leases SET state='revoked',revoked_at_ms=?,version=version+1,updated_at_ms=? WHERE ticket_id=? AND state='revoking'",
        params: [now, now, ticketId],
      },
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='released',cleanup_status='complete',released_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND phase='releasing'",
        params: [now, now, ticketId],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) SELECT 'ticket',id,version,'ticket.released',?,? FROM tickets WHERE id=? AND phase='released'",
        params: [
          now,
          JSON.stringify({ cleanup: "complete", simulator: true }),
          ticketId,
        ],
      },
    ]);
  }

  async deferOperation(input: {
    operationId: string;
    allocationId: string;
    ticketId: string;
    controlVersion: number;
    token: string;
    operationVersion: number;
    attempt: number;
    now: number;
    diagnostic: string;
  }): Promise<void> {
    const {
      operationId,
      allocationId,
      ticketId,
      token,
      operationVersion,
      attempt,
      now,
      diagnostic,
    } = input;
    const delay =
      attempt >= 5
        ? 300_000
        : Math.min(300_000, 2_000 * 2 ** Math.min(attempt - 1, 8));
    const blocked = attempt >= 5;
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE operations SET state=?,result_json=?,next_check_at_ms=?,owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND owner_token=? AND version=?",
        params: [
          blocked ? "failed" : "unknown",
          JSON.stringify({
            code: "simulator_operation_pending",
            diagnostic: diagnostic.slice(0, 160),
          }),
          now + delay,
          now,
          operationId,
          token,
          operationVersion,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET observed_state='unknown',cleanup_status=CASE WHEN desired_state='absent' THEN 'blocked' ELSE cleanup_status END,version=version+1,updated_at_ms=? WHERE id=? AND control_version=?",
        params: [now, allocationId, input.controlVersion],
      },
      {
        kind: "run",
        sql: "UPDATE tickets SET cleanup_status=CASE WHEN phase='releasing' THEN 'blocked' ELSE cleanup_status END,version=version+1,updated_at_ms=? WHERE id=? AND phase IN ('provisioning','releasing')",
        params: [now, ticketId],
      },
    ]);
  }
}
