import { createHash } from "node:crypto";
import type { Statement } from "./protocol.js";
import { StorageError, type Storage } from "./index.js";
import type {
  OwnedResource,
  ReadyReceipt,
  CreateEffect,
} from "../providers/port.js";

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
      "SELECT id FROM operations WHERE kind IN ('allocation.provision','allocation.cleanup') AND json_extract(intent_json,'$.executionMode') IN ('simulator','portainer') AND (installation_id=? OR installation_id IS NULL) AND controller_epoch<=? AND (?=(SELECT controller_epoch FROM installations WHERE singleton=1) OR (json_extract(intent_json,'$.executionMode')='simulator' AND NOT EXISTS(SELECT 1 FROM installations))) AND ((state IN ('planned','unknown','failed') AND next_check_at_ms<=?) OR (state='running' AND locked_until_ms<=?)) ORDER BY next_check_at_ms,id LIMIT 32",
      [installationId, epoch, epoch, now, now],
    );
  }

  dueIntegrityAudits(now: number, limit = 16): Promise<Row[]> {
    return this.db.all<Row>(
      "SELECT o.id,o.version,o.allocation_id,o.control_version,o.controller_epoch FROM operations o JOIN allocations a ON a.id=o.allocation_id JOIN tickets t ON t.id=a.ticket_id WHERE o.kind='allocation.provision' AND json_extract(o.intent_json,'$.executionMode')='portainer' AND o.state='succeeded' AND a.purpose='tenant' AND a.desired_state='present' AND a.control_version=o.control_version AND t.phase='ready' AND COALESCE(json_extract(o.result_json,'$.integrity.nextCheckAtMs'),0)<=? ORDER BY COALESCE(json_extract(o.result_json,'$.integrity.nextCheckAtMs'),0),o.id LIMIT ?",
      [now, limit],
    );
  }

  integrityManifest(allocationId: string, generation: number): Promise<Row[]> {
    return this.db.all<Row>(
      "SELECT COALESCE(provider_id,id) AS id,kind,ownership,observed_state,ownership_json FROM managed_resources WHERE allocation_id=? AND generation=? ORDER BY kind,id",
      [allocationId, generation],
    );
  }

  async claimIntegrityAudit(input: {
    operationId: string;
    operationVersion: number;
    token: string;
    epoch: number;
    now: number;
    intervalMs: number;
  }): Promise<Row | undefined> {
    const { operationId, operationVersion, token, epoch, now, intervalMs } =
      input;
    const result = await this.db.run(
      "UPDATE operations SET controller_epoch=?,owner_token=?,locked_until_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND kind='allocation.provision' AND state='succeeded' AND version=? AND controller_epoch<=? AND (SELECT controller_epoch FROM installations WHERE singleton=1)=? AND (owner_token IS NULL OR locked_until_ms<=?) AND COALESCE(json_extract(result_json,'$.integrity.nextCheckAtMs'),0)<=? AND EXISTS(SELECT 1 FROM allocations a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=operations.allocation_id AND a.desired_state='present' AND a.control_version=operations.control_version AND t.phase='ready')",
      [
        epoch,
        token,
        now + 30_000,
        now,
        operationId,
        operationVersion,
        epoch,
        epoch,
        now,
        now,
      ],
    );
    if (result.changes !== 1n) return undefined;
    // Reserve the next check time before the network call, so a transient
    // failure cannot cause a hot loop. The final report replaces the state.
    await this.db.run(
      "UPDATE operations SET result_json=json_set(COALESCE(result_json,'{}'),'$.integrity',json_object('state','checking','nextCheckAtMs',?)) WHERE id=? AND owner_token=?",
      [now + intervalMs, operationId, token],
    );
    return this.db.get<Row>(
      "SELECT o.*,a.ticket_id,a.image_validation_id,a.purpose,a.node_id,a.control_version AS allocation_control_version,a.desired_state,a.runtime_identity_id,a.resolved_provision_contract_id,a.actual_resources_json,t.version AS ticket_version,t.phase AS ticket_phase FROM operations o JOIN allocations a ON a.id=o.allocation_id JOIN tickets t ON t.id=a.ticket_id WHERE o.id=? AND o.owner_token=?",
      [operationId, token],
    );
  }

  async recordIntegrityAudit(input: {
    operationId: string;
    allocationId: string;
    ticketId: string;
    token: string;
    operationVersion: number;
    controlVersion: number;
    epoch: number;
    now: number;
    state: "healthy" | "unknown";
    reason?: string;
  }): Promise<boolean> {
    try {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: "UPDATE operations SET result_json=json_set(COALESCE(result_json,'{}'),'$.integrity',json(?)),owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND state='succeeded' AND owner_token=? AND version=? AND controller_epoch=? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1) AND EXISTS(SELECT 1 FROM allocations a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=operations.allocation_id AND a.id=? AND a.ticket_id=? AND a.desired_state='present' AND a.control_version=? AND t.phase='ready')",
          params: [
            JSON.stringify({
              state: input.state,
              reason: input.reason ?? null,
              observedAtMs: input.now,
              nextCheckAtMs: input.now + 30_000,
            }),
            input.now,
            input.operationId,
            input.token,
            input.operationVersion,
            input.epoch,
            input.allocationId,
            input.ticketId,
            input.controlVersion,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "UPDATE allocations SET observed_state=?,version=version+1,updated_at_ms=? WHERE id=? AND desired_state='present' AND control_version=? AND EXISTS(SELECT 1 FROM tickets t WHERE t.id=allocations.ticket_id AND t.phase='ready') AND EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.state='succeeded' AND o.version=? AND o.controller_epoch=? AND o.owner_token IS NULL)",
          params: [
            input.state === "healthy" ? "running" : "unknown",
            input.now,
            input.allocationId,
            input.controlVersion,
            input.operationId,
            input.operationVersion + 1,
            input.epoch,
          ],
          expectChanges: 1,
        },
      ]);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.code === "STORAGE_CAS_FAILED")
        return false;
      throw error;
    }
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
    expectedControlVersion?: number;
    expectedEpoch?: number;
    detail?: string;
    auditOperationId?: string;
    auditToken?: string;
    auditOperationVersion?: number;
  }): Promise<void> {
    const { id, phase, version, reason, cleanupId, requestHash, now } = input;
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='releasing',terminal_reason=?,cleanup_status='pending',termination_requested_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND phase=? AND version=? AND (? IS NULL OR EXISTS(SELECT 1 FROM installations WHERE singleton=1 AND controller_epoch=?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM allocations a WHERE a.ticket_id=tickets.id AND a.desired_state='present' AND a.control_version=?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.owner_token=? AND o.version=? AND o.state='succeeded' AND o.controller_epoch=?))",
        params: [
          reason,
          now,
          now,
          id,
          phase,
          version,
          input.expectedEpoch ?? null,
          input.expectedEpoch ?? null,
          input.expectedControlVersion ?? null,
          input.expectedControlVersion ?? null,
          input.auditOperationId ?? null,
          input.auditOperationId ?? null,
          input.auditToken ?? null,
          input.auditOperationVersion ?? null,
          input.expectedEpoch ?? null,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET desired_state='absent',control_version=control_version+1,version=version+1,updated_at_ms=? WHERE ticket_id=? AND desired_state<>'absent' AND (? IS NULL OR control_version=?)",
        params: [
          now,
          id,
          input.expectedControlVersion ?? null,
          input.expectedControlVersion ?? null,
        ],
        expectChanges: 1,
      },
      ...(input.auditOperationId
        ? [
            {
              kind: "run" as const,
              sql: "UPDATE operations SET owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND owner_token=? AND version=? AND state='succeeded' AND controller_epoch=? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)",
              params: [
                now,
                input.auditOperationId,
                input.auditToken ?? null,
                input.auditOperationVersion ?? null,
                input.expectedEpoch ?? null,
              ],
              expectChanges: 1,
            },
          ]
        : []),
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
        sql: "UPDATE operations SET state='cancelled',version=version+1,updated_at_ms=? WHERE id IN (SELECT operation_id FROM lease_renewals WHERE lease_id IN (SELECT id FROM leases WHERE ticket_id=?) AND state='cancelled') AND kind='lease.renew' AND state='planned'",
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
        params: [
          now,
          JSON.stringify({
            reason,
            ...(input.detail ? { detail: input.detail } : {}),
          }),
          id,
        ],
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
      "UPDATE operations SET result_json=CASE WHEN kind='allocation.provision' AND json_extract(intent_json,'$.executionMode')='portainer' AND attempt_count=0 THEN json_set(COALESCE(result_json,'{}'),'$.createJournalVersion',1) ELSE result_json END,state='running',controller_epoch=?,owner_token=?,locked_until_ms=?,attempt_count=attempt_count+1,version=version+1,updated_at_ms=? WHERE id=? AND kind IN ('allocation.provision','allocation.cleanup') AND json_extract(intent_json,'$.executionMode') IN ('simulator','portainer') AND (installation_id=? OR installation_id IS NULL) AND controller_epoch<=? AND (?=(SELECT controller_epoch FROM installations WHERE singleton=1) OR (json_extract(intent_json,'$.executionMode')='simulator' AND NOT EXISTS(SELECT 1 FROM installations))) AND ((state IN ('planned','unknown','failed') AND next_check_at_ms<=?) OR (state='running' AND locked_until_ms<=?))",
      [
        epoch,
        token,
        now + 30_000,
        now,
        operationId,
        installationId,
        epoch,
        epoch,
        now,
        now,
      ],
    );
    if (claimed.changes !== 1n) return undefined;
    return this.db.get<Row>(
      "SELECT o.*,a.ticket_id,a.image_validation_id,a.purpose,a.node_id,a.control_version AS allocation_control_version,a.desired_state,a.runtime_identity_id,a.resolved_provision_contract_id FROM operations o JOIN allocations a ON a.id=o.allocation_id WHERE o.id=? AND o.owner_token=?",
      [operationId, token],
    );
  }

  async assertProvisionActive(
    operationId: string,
    token: string,
    version: number,
    now: number,
  ) {
    const renewed = await this.db.run(
      "UPDATE operations SET locked_until_ms=? WHERE id=? AND owner_token=? AND version=? AND state='running' AND locked_until_ms>? AND deadline_ms>? AND EXISTS(SELECT 1 FROM allocations a WHERE a.id=operations.allocation_id AND a.desired_state='present' AND a.control_version=operations.control_version AND EXISTS(SELECT 1 FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN provider_connections pc ON pc.id=n.provider_connection_id WHERE n.id=a.node_id AND n.admission='enabled' AND m.admission='enabled' AND m.observed_power='on' AND n.observed_health='healthy' AND n.observed_at_ms+120000>? AND pc.enabled=1)) AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)",
      [now + 30_000, operationId, token, version, now, now, now],
    );
    if (renewed.changes !== 1n)
      throw new Error("Provision operation fence is no longer active");
  }

  async beforeCreate(input: {
    operationId: string;
    token: string;
    operationVersion: number;
    effect: CreateEffect;
    now: number;
  }) {
    const path = `$.createEffects.${input.effect.kind}`;
    const result = await this.db.run(
      "UPDATE operations SET result_json=json_set(COALESCE(result_json,'{}'),?,json(?)) WHERE id=? AND kind='allocation.provision' AND owner_token=? AND version=? AND state='running' AND locked_until_ms>? AND deadline_ms>? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1) AND json_extract(result_json,'$.createJournalVersion')=1 AND json_type(result_json,?) IS NULL AND EXISTS(SELECT 1 FROM allocations a WHERE a.id=operations.allocation_id AND a.desired_state='present' AND a.control_version=operations.control_version)",
      [
        path,
        JSON.stringify({
          ...input.effect,
          state: "unknown",
          requestedAtMs: input.now,
        }),
        input.operationId,
        input.token,
        input.operationVersion,
        input.now,
        input.now,
        path,
      ],
    );
    if (result.changes !== 1n)
      throw new Error(
        "Create intent already exists or the operation fence is no longer active",
      );
  }

  async unknownCreateEffects(allocationId: string): Promise<boolean> {
    return !!(await this.db.get(
      "SELECT 1 FROM operations o WHERE o.allocation_id=? AND o.kind='allocation.provision' AND ((json_extract(o.intent_json,'$.executionMode')='portainer' AND o.attempt_count>0 AND COALESCE(json_extract(o.result_json,'$.createJournalVersion'),0)<>1) OR EXISTS(SELECT 1 FROM json_each(COALESCE(o.result_json,'{}'),'$.createEffects') e WHERE json_extract(e.value,'$.state')='unknown')) LIMIT 1",
      [allocationId],
    ));
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
  async recordResource(input: {
    id: string;
    allocationId: string;
    nodeId: string;
    generation: number;
    kind: string;
    ownership: string;
    ownershipJson: string;
    detailsJson: string;
    observedAtMs: number;
  }): Promise<{ changes: bigint }> {
    // Upgraded rows retain their assigned UUID. A repeated receipt locates only the same owner.
    const existing = await this.db.get<{ id: string }>(
      "SELECT id FROM managed_resources WHERE allocation_id=? AND generation=? AND node_id=? AND kind=? AND provider_id=? AND ownership=?",
      [
        input.allocationId,
        input.generation,
        input.nodeId,
        input.kind,
        input.id,
        input.ownership,
      ],
    );
    const bytes = createHash("sha256")
      .update(
        JSON.stringify([
          "hitchlet-managed-resource-v1",
          input.allocationId,
          input.generation,
          input.nodeId,
          input.kind,
          input.ownership,
          input.id,
        ]),
      )
      .digest();
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString("hex");
    const internalId =
      existing?.id ??
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const statements: Statement[] = [
      {
        kind: "run",
        sql: "INSERT INTO managed_resources(id,allocation_id,node_id,generation,kind,provider_id,ownership,ownership_json,cleanup_policy,observed_state,details_json) VALUES(?,?,?,?,?,?,?, ?,?,'present',?) ON CONFLICT(id) DO UPDATE SET observed_state='present',details_json=json_patch(managed_resources.details_json,CASE WHEN json_array_length(json_extract(excluded.details_json,'$.publishedPorts'))=0 AND json_array_length(json_extract(managed_resources.details_json,'$.publishedPorts'))>0 THEN json_set(excluded.details_json,'$.publishedPorts',json_extract(managed_resources.details_json,'$.publishedPorts')) ELSE excluded.details_json END) WHERE managed_resources.allocation_id=excluded.allocation_id AND managed_resources.generation=excluded.generation AND managed_resources.node_id=excluded.node_id AND managed_resources.kind=excluded.kind AND managed_resources.provider_id=excluded.provider_id AND managed_resources.ownership=excluded.ownership",
        params: [
          internalId,
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
        expectChanges: 1,
      },
    ];
    if (
      input.ownership === "owned" &&
      ["network_policy", "volume", "container"].includes(input.kind)
    ) {
      const path = `$.createEffects.${input.kind}`;
      statements.push({
        kind: "run",
        sql: "UPDATE operations SET result_json=json_set(result_json,?,'observed',?,?,?,?) WHERE id=json_extract(?,'$.operationId') AND allocation_id=? AND generation=? AND runtime_identity_id=json_extract(?,'$.runtimeIdentityId') AND connection_revision_id=json_extract(?,'$.connectionRevisionId') AND kind='allocation.provision' AND json_extract(result_json,?)=json_extract(?,'$.nativeName') AND (json_extract(result_json,?)='unknown' OR (json_extract(result_json,?)='observed' AND json_extract(result_json,?)=?)) AND EXISTS(SELECT 1 FROM allocations a JOIN resolved_provision_contracts c ON c.id=a.resolved_provision_contract_id WHERE a.id=operations.allocation_id AND c.contract_hash=json_extract(?,'$.contractHash'))",
        params: [
          `${path}.state`,
          `${path}.resourceId`,
          input.id,
          `${path}.observedAtMs`,
          input.observedAtMs,
          input.ownershipJson,
          input.allocationId,
          input.generation,
          input.ownershipJson,
          input.ownershipJson,
          `${path}.name`,
          input.detailsJson,
          `${path}.state`,
          `${path}.state`,
          `${path}.resourceId`,
          input.id,
          input.detailsJson,
        ],
      });
    }
    await this.db.batchTransaction(statements);
    return { changes: 1n };
  }
  provisionInputs(allocationId: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT (SELECT COALESCE(json_extract(o.intent_json,'$.runtimeConfig'),json_extract(o.intent_json,'$.executionSnapshot.config')) FROM operations o WHERE o.allocation_id=a.id AND o.kind='allocation.provision') AS frozen_config_json,a.purpose,COALESCE(t.request_json,json_extract(v.accepted_contract_json,'$.request')) AS request_json,COALESCE(t.accepted_contract_json,v.accepted_contract_json) AS accepted_contract_json,a.node_id,a.resolved_provision_contract_id,a.runtime_identity_id,CASE WHEN a.purpose='validation' THEN json_extract(v.accepted_contract_json,'$.artifactRef') ELSE art.artifact_ref END AS artifact_ref,CASE WHEN a.purpose='validation' THEN json_extract(v.accepted_contract_json,'$.digest') ELSE art.content_digest END AS content_digest,CASE WHEN a.purpose='validation' THEN json_extract(v.accepted_contract_json,'$.requirements') ELSE art.requirements_json END AS requirements_json,CASE WHEN a.purpose='validation' THEN json_extract(v.accepted_contract_json,'$.access') ELSE art.access_recipe_json END AS access_recipe_json FROM allocations a LEFT JOIN tickets t ON a.ticket_id=t.id LEFT JOIN image_validations v ON v.id=a.image_validation_id JOIN image_artifacts art ON art.id=a.image_artifact_id WHERE a.id=?",
      [allocationId],
    );
  }
  cleanupResources(allocationId: string, generation: number): Promise<Row[]> {
    return this.db.all<Row>(
      "SELECT COALESCE(provider_id,id) AS id,kind,ownership,ownership_json,details_json FROM managed_resources WHERE allocation_id=? AND generation=? AND ownership='owned' ORDER BY CASE kind WHEN 'container' THEN 1 WHEN 'network_policy' THEN 2 ELSE 3 END,id",
      [allocationId, generation],
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
        sql: "INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json) SELECT ?,a.node_id,?,?,?, ?,?,?,? FROM allocations a LEFT JOIN tickets t ON t.id=a.ticket_id LEFT JOIN image_validations v ON v.id=a.image_validation_id WHERE a.id=? AND a.resolved_provision_contract_id IS NULL AND a.control_version=? AND a.desired_state='present' AND ((a.purpose='tenant' AND t.phase IN ('reserved','provisioning')) OR (a.purpose='validation' AND v.state IN ('queued','running') AND v.deadline_ms>?)) AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=COALESCE(t.network_profile_revision_id,json_extract(v.accepted_contract_json,'$.networkRevisionId'))) AND NOT EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id)",
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
          input.now,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET resolved_provision_contract_id=?,version=version+1,updated_at_ms=? WHERE id=? AND generation=? AND control_version=? AND desired_state='present' AND resolved_provision_contract_id IS NULL AND (EXISTS(SELECT 1 FROM tickets t WHERE t.id=allocations.ticket_id AND t.phase IN ('reserved','provisioning')) OR EXISTS(SELECT 1 FROM image_validations v WHERE v.id=allocations.image_validation_id AND v.state IN ('queued','running'))) AND EXISTS(SELECT 1 FROM nodes n JOIN machines m ON m.id=n.machine_id WHERE n.id=allocations.node_id AND n.observed_health='healthy' AND n.observed_at_ms+120000>? AND m.observed_power='on')",
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
      "SELECT o.version,o.attempt_count,a.ticket_id,a.image_validation_id,COALESCE(t.version,v.version) AS subject_version FROM operations o JOIN allocations a ON a.id=o.allocation_id LEFT JOIN tickets t ON t.id=a.ticket_id LEFT JOIN image_validations v ON v.id=a.image_validation_id WHERE o.id=? AND o.state='failed' AND o.kind IN ('allocation.provision','allocation.cleanup') AND json_extract(o.intent_json,'$.executionMode') IN ('simulator','portainer')",
      [operationId],
    );
    if (!operation)
      throw new Error("Failed allocation operation was not found");
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE operations SET state='unknown',attempt_count=CASE WHEN json_extract(intent_json,'$.executionMode')='portainer' AND COALESCE(json_extract(result_json,'$.createJournalVersion'),0)<>1 THEN MAX(attempt_count,1) ELSE 0 END,next_check_at_ms=?,owner_token=NULL,locked_until_ms=NULL,result_json=json_patch(COALESCE(result_json,'{}'),json(?)),version=version+1,updated_at_ms=? WHERE id=? AND state='failed' AND version=?",
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
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES(?,?,?,'operation.retry_requested',?,?)",
        params: [
          typeof operation.ticket_id === "string"
            ? "ticket"
            : "image_validation",
          operation.ticket_id ?? operation.image_validation_id ?? null,
          Number(operation.subject_version),
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
    executionMode: string;
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
        sql: "UPDATE operations SET state='succeeded',result_json=json_patch(json_remove(COALESCE(result_json,'{}'),'$.code','$.diagnostic','$.reason'),json(?)),owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND owner_token=? AND version=? AND state='running' AND locked_until_ms>? AND NOT EXISTS(SELECT 1 FROM json_each(COALESCE(operations.result_json,'{}'),'$.createEffects') e WHERE json_extract(e.value,'$.state')='unknown') AND (controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1) OR (json_extract(intent_json,'$.executionMode')='simulator' AND NOT EXISTS(SELECT 1 FROM installations)))",
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
          receipt.manifestId,
          JSON.stringify({
            executionMode: input.executionMode,
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
            executionMode: input.executionMode,
            offlineLeaseEnforcement: "unsupported",
            manifestHash: receipt.manifestHash,
          }),
          ticketId,
        ],
      },
    ]);
  }

  async finishCleanup(input: {
    cleanupEvidence: Readonly<Record<string, unknown>>;
    operationId: string;
    allocationId: string;
    ticketId: string | null;
    validationId?: string;
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
        sql: "UPDATE operations SET state='succeeded',result_json=json_patch(json_remove(COALESCE(result_json,'{}'),'$.code','$.diagnostic','$.reason'),json(?)),owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND owner_token=? AND version=? AND state='running' AND locked_until_ms>? AND NOT EXISTS(SELECT 1 FROM json_each(COALESCE(operations.result_json,'{}'),'$.createEffects') e WHERE json_extract(e.value,'$.state')='unknown') AND (controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1) OR (json_extract(intent_json,'$.executionMode')='simulator' AND NOT EXISTS(SELECT 1 FROM installations)))",
        params: [
          JSON.stringify(input.cleanupEvidence),
          now,
          operationId,
          token,
          operationVersion,
          now,
        ],
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
        sql: "UPDATE allocations SET observed_state='absent',cleanup_status='complete',manifest_complete=CASE WHEN manifest_id IS NULL THEN 0 ELSE 1 END,version=version+1,updated_at_ms=? WHERE id=? AND desired_state='absent' AND control_version=? AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.allocation_id=allocations.id AND o.kind='allocation.provision' AND ((json_extract(o.intent_json,'$.executionMode')='portainer' AND o.attempt_count>0 AND COALESCE(json_extract(o.result_json,'$.createJournalVersion'),0)<>1) OR EXISTS(SELECT 1 FROM json_each(COALESCE(o.result_json,'{}'),'$.createEffects') e WHERE json_extract(e.value,'$.state')='unknown')))",
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
      ...(input.validationId
        ? [
            {
              kind: "run" as const,
              sql: "UPDATE image_validations SET state=CASE WHEN json_extract(checks_json,'$.terminationReason')='cancelled' THEN 'cancelled' WHEN json_extract(checks_json,'$.testedEvidence.outcome')='passed' THEN 'succeeded' ELSE 'failed' END,test_outcome=CASE WHEN json_extract(checks_json,'$.testedEvidence.outcome')='passed' THEN 'passed' ELSE 'failed' END,cleanup_status='complete',report_id=id,finished_at_ms=?,version=version+1,checks_json=json_set(checks_json,'$.scheduler','complete','$.cleanupEvidence',json(?)),updated_at_ms=? WHERE id=? AND state='releasing'",
              params: [
                now,
                JSON.stringify({ ...input.cleanupEvidence, operationId }),
                now,
                input.validationId,
              ],
              expectChanges: 1,
            },
          ]
        : [
            {
              kind: "run" as const,
              sql: "UPDATE tickets SET phase='released',cleanup_status='complete',released_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND phase='releasing'",
              params: [now, now, ticketId],
              expectChanges: 1,
            },
          ]),
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) SELECT 'ticket',id,version,'ticket.released',?,? FROM tickets WHERE id=? AND phase='released'",
        params: [now, JSON.stringify({ cleanup: "complete" }), ticketId],
      },
    ]);
  }

  async deferOperation(input: {
    operationId: string;
    allocationId: string;
    ticketId: string | null;
    validationId?: string;
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
        sql: "UPDATE operations SET state=?,result_json=json_patch(COALESCE(result_json,'{}'),json(?)),next_check_at_ms=?,owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE id=? AND owner_token=? AND version=? AND (controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1) OR (json_extract(intent_json,'$.executionMode')='simulator' AND NOT EXISTS(SELECT 1 FROM installations)))",
        params: [
          blocked ? "failed" : "unknown",
          JSON.stringify({
            code: "operation_pending",
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
        sql: "UPDATE image_validations SET cleanup_status=CASE WHEN state='releasing' THEN 'blocked' ELSE cleanup_status END,version=version+1,updated_at_ms=? WHERE id=? AND state IN ('running','releasing')",
        params: [now, input.validationId ?? null],
      },
      {
        kind: "run",
        sql: "UPDATE tickets SET cleanup_status=CASE WHEN phase='releasing' THEN 'blocked' ELSE cleanup_status END,version=version+1,updated_at_ms=? WHERE id=? AND phase IN ('provisioning','releasing')",
        params: [now, ticketId],
      },
    ]);
  }
}
