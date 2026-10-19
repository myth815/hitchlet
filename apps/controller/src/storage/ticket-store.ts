import type { Storage } from "./index.js";
import { createHash } from "node:crypto";
import type { IdempotencyCompletionRef } from "./termination-context.js";

type Row = Record<string, string | number | bigint | null>;

export interface ReservationWrite {
  readonly allocationId: string;
  readonly claimId: string;
  readonly leaseId: string;
  readonly ticketId: string;
  readonly consumerId: string;
  readonly consumerVersion: number;
  readonly quotaJson: string;
  readonly nodeId: string;
  readonly nodeVersion: number;
  readonly machineId: string;
  readonly machineVersion: number;
  readonly runtimeIdentityId: string;
  readonly connectionRevisionId: string;
  readonly executionMode: "simulator" | "portainer" | "unconfigured";
  readonly operationId: string;
  readonly installationId: string | null;
  readonly controllerEpoch: number;
  readonly artifactId: string;
  readonly poolId: string;
  readonly poolVersion: number;
  readonly ticketVersion: number;
  readonly generation: number;
  readonly resourceContractJson: string;
  readonly requested: {
    readonly cpuMillis: number;
    readonly memoryMiB: number;
    readonly scratchMiB: number;
  };
  readonly consumerLimits: {
    readonly maxActiveTickets: number;
    readonly cpuMillis: number;
    readonly memoryMiB: number;
    readonly scratchMiB: number;
  };
  readonly now: number;
  readonly deadline: number;
}

/** SQLite transaction boundary for a reservation. Every guard and write is evaluated together. */
export class SQLiteTicketStore {
  constructor(private readonly storage: Storage) {}

  idempotency(consumerId: string, key: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT request_hash,ticket_id FROM idempotency_keys WHERE consumer_id=? AND route_scope='tickets.acquire' AND idempotency_key=?",
      [consumerId, key],
    );
  }
  consumer(consumerId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT authorization_json,quota_json,status,version FROM consumers WHERE id=?",
      [consumerId],
    );
  }
  queuedCount(consumerId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT count(*) AS count FROM tickets WHERE consumer_id=? AND phase='queued'",
      [consumerId],
    );
  }
  imageAlias(imageId: string, alias: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT a.image_version_id FROM image_aliases a JOIN image_versions v ON v.id=a.image_version_id WHERE a.image_id=? AND a.alias=? AND v.status='published'",
      [imageId, alias],
    );
  }
  imageVersion(versionId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT v.image_id,v.status,v.manifest_json,i.status AS image_status,i.owner_consumer_id FROM image_versions v JOIN images i ON i.id=v.image_id WHERE v.id=?",
      [versionId],
    );
  }
  networkRevision(profileId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT p.current_revision_id,r.id,r.policy_json FROM network_profiles p JOIN network_profile_revisions r ON r.id=p.current_revision_id AND r.profile_id=p.id WHERE p.id=? AND p.status='active'",
      [profileId],
    );
  }
  storageRevision(profileId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT p.current_revision_id,r.config_json,r.kind,r.secret_version_ref FROM storage_profiles p JOIN storage_profile_revisions r ON r.id=p.current_revision_id AND r.profile_id=p.id WHERE p.id=? AND p.status='active'",
      [profileId],
    );
  }
  authorizedDirectory(
    versionId: string,
    nodeIds?: readonly string[],
  ): Promise<Row[]> {
    return this.storage.all<Row>(
      `SELECT n.id,n.machine_id,n.backend_kind,m.site_id,a.architecture FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN image_artifacts a ON a.image_version_id=? AND a.backend_kind=n.backend_kind WHERE n.admission IN ('enabled','draining') AND m.admission IN ('enabled','draining') AND m.source='local' ${nodeIds ? `AND n.id IN (${nodeIds.map(() => "?").join(",")})` : ""}`,
      [versionId, ...(nodeIds ?? [])],
    );
  }
  lifecyclePolicy(policyId?: string): Promise<Row | undefined> {
    return policyId
      ? this.storage.get<Row>(
          "SELECT id,config_json FROM policies WHERE id=? AND kind='lifecycle'",
          [policyId],
        )
      : this.storage.get<Row>(
          "SELECT id,config_json FROM policies WHERE kind='lifecycle' ORDER BY id LIMIT 1",
        );
  }
  networkDenyBaseline(): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT id,management_deny_rules_json FROM platform_network_deny_revisions ORDER BY revision DESC LIMIT 1",
    );
  }
  refreshSimulatorFixtureObservation(
    installationId: string,
    now: number,
  ): Promise<unknown> {
    const observedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 3600000).toISOString();
    return this.storage.run(
      `UPDATE nodes SET observed_at_ms=?,capabilities_json=json_set(capabilities_json,'$.observedAt',?,'$.expiresAt',?),version=version+1,updated_at_ms=?
      WHERE id IN (
        SELECT n.id FROM nodes n
        JOIN machines m ON m.id=n.machine_id
        JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=n.runtime_identity_id
        JOIN provider_connection_revisions pcr ON pcr.id=pc.current_revision_id AND pcr.verified_runtime_identity_id=n.runtime_identity_id
        JOIN runtime_identities ri ON ri.id=n.runtime_identity_id
        WHERE m.source='local' AND n.backend_kind='portainer' AND n.observed_health='healthy'
          AND json_extract(n.config_json,'$.executionMode')='simulator'
          AND json_extract(n.config_json,'$.simulatorFixtureInstallationId')=?
          AND json_extract(n.capabilities_json,'$.providerVersion')='simulator'
          AND pcr.endpoint_ref='simulator://local'
          AND json_extract(pcr.evidence_json,'$.executionMode')='simulator'
          AND ri.native_id='hitchlet-simulator'
          AND (n.observed_at_ms+30000<=? OR json_extract(n.capabilities_json,'$.expiresAt')<=?)
      )`,
      [now, observedAt, expiresAt, now, installationId, now, observedAt],
    );
  }
  async createQueuedTicket(input: {
    readonly ticketId: string;
    readonly consumerId: string;
    readonly versionId: string;
    readonly networkRevisionId: string;
    readonly networkProfileId: string;
    readonly denyRevisionId: string;
    readonly acceptedJson: string;
    readonly requestHash: string;
    readonly frozenJson: string;
    readonly cpuMillis: number;
    readonly memoryMiB: number;
    readonly scratchMiB: number;
    readonly clientRef: string | null;
    readonly now: number;
    readonly queueDeadline: number;
    readonly quotaJson: string;
    readonly consumerVersion: number;
    readonly maxQueued: number;
    readonly storageRows: readonly {
      profileId: string;
      revisionId: string;
      path: string;
      mount: string;
      mode: string;
    }[];
    readonly storageGrantIds: readonly string[];
    readonly key: string;
  }): Promise<void> {
    await this.storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO tickets(id,consumer_id,image_version_id,network_profile_revision_id,request_json,request_hash,accepted_contract_json,requested_cpu_millis,requested_memory_mib,requested_scratch_mib,client_ref,version,created_at_ms,updated_at_ms,queue_deadline_ms,scheduling_reason_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM tickets WHERE consumer_id=? AND phase='queued') < ? AND EXISTS(SELECT 1 FROM consumers c WHERE c.id=? AND c.version=? AND c.status='active' AND c.quota_json=?) AND EXISTS(SELECT 1 FROM image_versions v JOIN images i ON i.id=v.image_id WHERE v.id=? AND v.status='published' AND i.status='active' AND (i.owner_consumer_id IS NULL OR i.owner_consumer_id=?)) AND EXISTS(SELECT 1 FROM network_profiles p WHERE p.id=? AND p.current_revision_id=? AND p.status='active') AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=?) AND ?=(SELECT id FROM platform_network_deny_revisions ORDER BY revision DESC LIMIT 1)",
        params: [
          input.ticketId,
          input.consumerId,
          input.versionId,
          input.networkRevisionId,
          input.acceptedJson,
          input.requestHash,
          input.frozenJson,
          input.cpuMillis,
          input.memoryMiB,
          input.scratchMiB,
          input.clientRef,
          1,
          input.now,
          input.now,
          input.queueDeadline,
          JSON.stringify({ code: "awaiting_scheduler" }),
          input.consumerId,
          input.maxQueued,
          input.consumerId,
          input.consumerVersion,
          input.quotaJson,
          input.versionId,
          input.consumerId,
          input.networkProfileId,
          input.networkRevisionId,
          input.networkRevisionId,
          input.denyRevisionId,
        ],
        expectChanges: 1,
      },
      ...input.storageRows.map((row, i) => {
        const grantId = input.storageGrantIds[i];
        if (!grantId) throw new Error("Missing frozen storage grant id");
        return {
          kind: "run" as const,
          sql: "INSERT INTO ticket_storage_grants(id,ticket_id,storage_profile_revision_id,authorized_subpath,mount_path,mode,created_at_ms) SELECT ?,?,r.id,?,?,?,? FROM storage_profiles p JOIN storage_profile_revisions r ON r.id=p.current_revision_id AND r.profile_id=p.id WHERE p.id=? AND p.status='active' AND r.id=? AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations rev WHERE rev.storage_profile_revision_id=r.id)",
          params: [
            grantId,
            input.ticketId,
            row.path,
            row.mount,
            row.mode,
            input.now,
            row.profileId,
            row.revisionId,
          ],
          expectChanges: 1,
        };
      }),
      {
        kind: "run",
        sql: "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,response_status,safe_response_json,created_at_ms,retain_until_ms) VALUES(?,'tickets.acquire',?,?,?,202,?,?,?)",
        params: [
          input.consumerId,
          input.key,
          input.requestHash,
          input.ticketId,
          JSON.stringify({ ticketId: input.ticketId, phase: "queued" }),
          input.now,
          input.now + 180 * 86400000,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) VALUES('ticket',?,1,'ticket.queued',?,?,?)",
        params: [
          input.ticketId,
          input.consumerId,
          input.now,
          JSON.stringify({ phase: "queued" }),
        ],
      },
    ]);
  }
  queuedTickets(now: number): Promise<Row[]> {
    return this.storage.all<Row>(
      "SELECT * FROM tickets WHERE phase='queued' AND queue_deadline_ms>? ORDER BY created_at_ms,id",
      [now],
    );
  }
  eligibleCandidates(query: {
    imageVersion: string;
    providers: readonly string[];
    siteIds: readonly string[];
    nodeIds: readonly string[];
    machineIds: readonly string[];
    kind: string;
    architectures: readonly string[];
  }): Promise<Row[]> {
    return this.storage.all<Row>(
      `SELECT n.id AS node_id,n.version AS node_version,n.machine_id,n.runtime_identity_id,n.backend_kind,n.pool_id,n.capabilities_json,n.config_json,n.observed_at_ms,m.version AS machine_version,m.site_id,m.labels_json AS machine_labels,m.admission AS machine_admission,m.observed_power,m.power_lifecycle,m.power_cycle_id,m.power_transition_id,m.shutdown_operation_id,m.accepted_shutdown_receipt_id,m.out_of_band_evidence_id,m.wake_not_before_ms,m.shutdown_accepted_at_ms,m.power_transition_deadline_ms,m.wake_attempt_count,m.updated_at_ms AS machine_updated_at_ms,m.desired_power,m.capabilities_json AS machine_capabilities,power_policy.config_json AS power_policy_json,p.version AS pool_version,p.parent_allocation_id,p.total_cpu_millis,p.total_memory_mib,p.total_scratch_mib,p.system_cpu_millis,p.system_memory_mib,p.system_scratch_mib,a.id AS artifact_id,a.architecture,a.guest_os,a.environment_kind,a.requirements_json,a.minimum_cpu_millis,a.minimum_memory_mib,a.minimum_scratch_mib,a.access_recipe_json,pcr.id AS connection_revision_id,EXISTS(SELECT 1 FROM operations o JOIN agent_commands c ON c.operation_id=o.id AND c.kind='machine.shutdown' JOIN agents ag ON ag.id=c.agent_id AND ag.machine_id=m.id JOIN agent_receipts r ON r.command_id=c.id AND r.agent_id=c.agent_id WHERE o.id=m.shutdown_operation_id AND o.machine_id=m.id AND o.kind='machine.shutdown' AND o.state IN ('running','succeeded') AND r.id=m.accepted_shutdown_receipt_id AND r.phase='accepted' AND r.observed_at_ms>=m.shutdown_accepted_at_ms AND r.received_at_ms<=m.power_transition_deadline_ms) AS shutdown_evidence
      FROM nodes n JOIN machines m ON m.id=n.machine_id LEFT JOIN policies power_policy ON power_policy.id=m.policy_id AND power_policy.kind='machine' JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.enabled=1 AND pc.runtime_identity_id=n.runtime_identity_id JOIN provider_connection_revisions pcr ON pcr.id=pc.current_revision_id AND pcr.verified_runtime_identity_id=n.runtime_identity_id JOIN capacity_pools p ON p.id=n.pool_id JOIN image_artifacts a ON a.image_version_id=? AND a.backend_kind=n.backend_kind WHERE n.admission='enabled' AND (n.observed_health='healthy' OR (n.observed_health='unknown' AND (m.observed_power IN ('off','sleeping') OR (m.observed_power='unknown' AND m.power_lifecycle='off_expected')))) AND m.admission='enabled' AND m.source='local' AND (m.observed_power IN ('on','off','sleeping') OR (m.observed_power='unknown' AND m.power_lifecycle='off_expected')) AND n.backend_kind IN (${query.providers.map(() => "?").join(",")}) AND m.site_id IN (${query.siteIds.map(() => "?").join(",")}) AND n.id IN (${query.nodeIds.map(() => "?").join(",")}) AND m.id IN (${query.machineIds.map(() => "?").join(",")}) AND a.environment_kind=? AND a.architecture IN (${query.architectures.map(() => "?").join(",")}) ORDER BY n.id,a.architecture`,
      [
        query.imageVersion,
        ...query.providers,
        ...query.siteIds,
        ...query.nodeIds,
        ...query.machineIds,
        query.kind,
        ...query.architectures,
      ],
    );
  }
  consumerQuota(consumerId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT quota_json,version,status FROM consumers WHERE id=?",
      [consumerId],
    );
  }
  setSchedulingReason(
    ticketId: string,
    ticketVersion: number,
    now: number,
  ): Promise<unknown> {
    return this.storage.run(
      "UPDATE tickets SET scheduling_reason_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND phase='queued'",
      [
        JSON.stringify({ code: "capacity_or_eligibility_unavailable" }),
        now,
        ticketId,
        ticketVersion,
      ],
    );
  }
  bind(input: {
    contractId: string;
    now: number;
    allocationId: string;
    generation: number;
    controlVersion: number;
    ticketVersion: number;
    selectionHash: string;
    nodeVersion: number;
  }): Promise<unknown[]> {
    return this.storage.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE allocations SET resolved_provision_contract_id=?,version=version+1,updated_at_ms=? WHERE id=? AND generation=? AND control_version=? AND resolved_provision_contract_id IS NULL AND EXISTS(SELECT 1 FROM tickets t WHERE t.id=allocations.ticket_id AND t.phase IN ('reserved','provisioning') AND t.version=? AND json_extract(t.accepted_contract_json,'$.selectionHash')=? AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=t.network_profile_revision_id) AND NOT EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id)) AND EXISTS(SELECT 1 FROM nodes n JOIN machines m ON m.id=n.machine_id WHERE n.id=allocations.node_id AND n.version=? AND n.observed_health='healthy' AND n.observed_at_ms+120000>? AND m.observed_power='on') AND EXISTS(SELECT 1 FROM resolved_provision_contracts c WHERE c.id=? AND c.node_id=allocations.node_id AND c.selection_hash=? AND c.selection_hash=json_extract((SELECT accepted_contract_json FROM tickets WHERE id=allocations.ticket_id),'$.selectionHash'))",
        params: [
          input.contractId,
          input.now,
          input.allocationId,
          input.generation,
          input.controlVersion,
          input.ticketVersion,
          input.selectionHash,
          input.nodeVersion,
          input.now,
          input.contractId,
          input.selectionHash,
        ],
        expectChanges: 1,
      },
    ]);
  }
  cancelTarget(ticketId: string, consumerId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT t.phase,t.version,t.consumer_id,a.generation FROM tickets t LEFT JOIN allocations a ON a.ticket_id=t.id WHERE t.id=? AND t.consumer_id=?",
      [ticketId, consumerId],
    );
  }
  revokeTarget(ticketId: string): Promise<Row | undefined> {
    return this.storage.get<Row>(
      "SELECT t.phase,t.version,t.consumer_id,t.request_json,t.image_version_id,i.image_id,a.generation,a.node_id,a.machine_id FROM tickets t JOIN image_versions i ON i.id=t.image_version_id LEFT JOIN allocations a ON a.ticket_id=t.id WHERE t.id=?",
      [ticketId],
    );
  }
  cancelQueued(input: {
    ticketId: string;
    consumerId: string;
    version: number;
    now: number;
    reason: string;
    audit?: { actorId: string; requestId: string; reason: string };
    completion?: IdempotencyCompletionRef;
  }): Promise<unknown[]> {
    return this.storage.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='released',terminal_reason=?,released_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND consumer_id=? AND phase='queued' AND version=?",
        params: [
          input.reason,
          input.now,
          input.now,
          input.ticketId,
          input.consumerId,
          input.version,
        ],
        expectChanges: 1,
      },
      ...(input.completion ? [completionStatement(input.completion, 200)] : []),
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) VALUES('ticket',?,?,'ticket.terminated',?,?,?)",
        params: [
          input.ticketId,
          input.version + 1,
          input.consumerId,
          input.now,
          JSON.stringify({ reason: input.reason }),
        ],
      },
      ...(input.audit
        ? [
            {
              kind: "run" as const,
              sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('controller',?,'ticket.revoke','ticket',?,?,?,?)",
              params: [
                input.audit.actorId,
                input.ticketId,
                input.audit.requestId,
                input.now,
                JSON.stringify({ reason: input.audit.reason }),
              ],
            },
          ]
        : []),
    ]);
  }
  cancelAllocated(input: {
    ticketId: string;
    consumerId: string;
    phase: string;
    version: number;
    now: number;
    reason: string;
    operationId: string;
    generation?: number;
    expectedGeneration?: number | null;
    audit?: { actorId: string; requestId: string; reason: string };
    completion?: IdempotencyCompletionRef;
  }): Promise<unknown[]> {
    return this.storage.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='releasing',terminal_reason=?,cleanup_status='pending',termination_requested_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND consumer_id=? AND phase=? AND version=?",
        params: [
          input.reason,
          input.now,
          input.now,
          input.ticketId,
          input.consumerId,
          input.phase,
          input.version,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET desired_state='absent',control_version=control_version+1,version=version+1,updated_at_ms=? WHERE ticket_id=? AND generation=? AND desired_state<>'absent' AND (?=0 OR generation=?)",
        params: [
          input.now,
          input.ticketId,
          input.generation ?? 1,
          input.expectedGeneration === undefined ? 0 : 1,
          input.expectedGeneration ?? 0,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE leases SET state='revoking',version=version+1,updated_at_ms=?,revoked_at_ms=NULL WHERE ticket_id=? AND state IN ('pending','active')",
        params: [input.now, input.ticketId],
      },
      {
        kind: "run",
        sql: "UPDATE lease_renewals SET state='cancelled',rejection_json=json_object('code','termination_requested'),version=version+1,updated_at_ms=? WHERE lease_id IN (SELECT id FROM leases WHERE ticket_id=?) AND state='pending'",
        params: [input.now, input.ticketId],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='cancelled',version=version+1,updated_at_ms=? WHERE id IN (SELECT operation_id FROM lease_renewals WHERE lease_id IN (SELECT id FROM leases WHERE ticket_id=?) AND state='cancelled') AND kind='lease.renew' AND state='planned'",
        params: [input.now, input.ticketId],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='cancelled',version=version+1,owner_token=NULL,locked_until_ms=NULL,updated_at_ms=? WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.provision' AND state='planned'",
        params: [input.now, input.ticketId],
      },
      {
        kind: "run",
        sql: "INSERT INTO operations(id,installation_id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms) SELECT ?,o.installation_id,a.id,a.runtime_identity_id,o.connection_revision_id,a.image_artifact_id,a.generation,a.control_version,o.controller_epoch,'allocation.cleanup','cleanup',a.id||':cleanup:'||a.generation||':'||a.control_version,'planned',?,json_object('reason',?,'purpose','tenant','executionMode',json_extract(o.intent_json,'$.executionMode')),?,?,?,? FROM allocations a JOIN operations o ON o.allocation_id=a.id AND o.kind='allocation.provision' WHERE a.ticket_id=?",
        params: [
          input.operationId,
          createHash("sha256")
            .update(`${input.ticketId}:cleanup`)
            .digest("hex"),
          input.reason,
          input.now,
          input.now + 30000,
          input.now,
          input.now,
          input.ticketId,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) VALUES('ticket',?,?,'ticket.terminated',?,?,?)",
        params: [
          input.ticketId,
          input.version + 1,
          input.consumerId,
          input.now,
          JSON.stringify({ reason: input.reason }),
        ],
      },
      ...(input.completion ? [completionStatement(input.completion, 202)] : []),
      ...(input.audit
        ? [
            {
              kind: "run" as const,
              sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('controller',?,'ticket.revoke','ticket',?,?,?,?)",
              params: [
                input.audit.actorId,
                input.ticketId,
                input.audit.requestId,
                input.now,
                JSON.stringify({ reason: input.audit.reason }),
              ],
            },
          ]
        : []),
    ]);
  }

  async reserve(input: ReservationWrite): Promise<void> {
    const activeCount =
      "(SELECT count(*) FROM tickets WHERE consumer_id=? AND phase IN ('reserved','provisioning','ready','releasing'))";
    const capCheck =
      "((SELECT coalesce(sum(cpu_millis),0) FROM capacity_claims WHERE pool_id=? AND state<>'released') + ?) <= p.total_cpu_millis-p.system_cpu_millis AND ((SELECT coalesce(sum(memory_mib),0) FROM capacity_claims WHERE pool_id=? AND state<>'released') + ?) <= p.total_memory_mib-p.system_memory_mib AND ((SELECT coalesce(sum(scratch_mib),0) FROM capacity_claims WHERE pool_id=? AND state<>'released') + ?) <= p.total_scratch_mib-p.system_scratch_mib";
    const usage = (column: string) =>
      `(SELECT coalesce(sum(c.${column}),0) FROM capacity_claims c JOIN allocations a ON a.id=c.allocation_id JOIN tickets t ON t.id=a.ticket_id WHERE t.consumer_id=? AND a.purpose='tenant' AND c.state<>'released')`;
    const request = input.requested;
    const limits = input.consumerLimits;
    const guardParams = [
      input.poolId,
      request.cpuMillis,
      input.poolId,
      request.memoryMiB,
      input.poolId,
      request.scratchMiB,
      input.consumerId,
      limits.maxActiveTickets,
      input.consumerId,
      request.cpuMillis,
      limits.cpuMillis,
      input.consumerId,
      request.memoryMiB,
      limits.memoryMiB,
      input.consumerId,
      request.scratchMiB,
      limits.scratchMiB,
    ];
    await this.storage.batchTransaction([
      {
        kind: "run",
        sql:
          "INSERT INTO allocations(id,purpose,ticket_id,machine_id,node_id,runtime_identity_id,resolved_provision_contract_id,image_artifact_id,generation,control_version,desired_state,observed_state,cleanup_status,resource_contract_json,ownership_json,version,created_at_ms,updated_at_ms) SELECT ?, 'tenant', ?, ?, ?, ?, NULL, ?, ?,1,'present','unknown','pending',?,'{}',1,?,? WHERE EXISTS(SELECT 1 FROM tickets t WHERE t.id=? AND t.phase='queued' AND t.version=? AND json_extract(t.request_json,'$.locality')='local_only' AND EXISTS(SELECT 1 FROM consumers c WHERE c.id=t.consumer_id AND c.version=? AND c.status='active' AND c.quota_json=?) AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=t.network_profile_revision_id) AND NOT EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id)) AND EXISTS(SELECT 1 FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN capacity_pools p ON p.id=n.pool_id WHERE n.id=? AND n.version=? AND m.id=? AND m.version=? AND m.source='local' AND m.admission='enabled' AND n.admission='enabled' AND p.version=? AND p.id=? AND (p.parent_allocation_id IS NULL OR EXISTS(SELECT 1 FROM allocations pa JOIN image_artifacts pai ON pai.id=pa.image_artifact_id WHERE pa.id=p.parent_allocation_id AND pa.machine_id=m.id AND pa.purpose='infrastructure' AND pai.environment_kind='vm' AND pa.desired_state='present' AND pa.observed_state='running' AND pa.cleanup_status IN ('pending','running') AND p.total_cpu_millis<=(SELECT coalesce(sum(c.cpu_millis),0) FROM capacity_claims c WHERE c.allocation_id=pa.id AND c.state='committed') AND p.total_memory_mib<=(SELECT coalesce(sum(c.memory_mib),0) FROM capacity_claims c WHERE c.allocation_id=pa.id AND c.state='committed') AND p.total_scratch_mib<=(SELECT coalesce(sum(c.scratch_mib),0) FROM capacity_claims c WHERE c.allocation_id=pa.id AND c.state='committed'))) AND " +
          capCheck +
          `) AND ${activeCount} < ? AND ${usage("cpu_millis")} + ? <= ? AND ${usage("memory_mib")} + ? <= ? AND ${usage("scratch_mib")} + ? <= ?`,
        params: [
          input.allocationId,
          input.ticketId,
          input.machineId,
          input.nodeId,
          input.runtimeIdentityId,
          input.artifactId,
          input.generation,
          input.resourceContractJson,
          input.now,
          input.now,
          input.ticketId,
          input.ticketVersion,
          input.consumerVersion,
          input.quotaJson,
          input.nodeId,
          input.nodeVersion,
          input.machineId,
          input.machineVersion,
          input.poolVersion,
          input.poolId,
          ...guardParams,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO leases(id,ticket_id,allocation_id,generation,state,created_at_ms,updated_at_ms,claim_by_ms) VALUES(?,?,?,?,'pending',?,?,?)",
        params: [
          input.leaseId,
          input.ticketId,
          input.allocationId,
          input.generation,
          input.now,
          input.now,
          input.deadline,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO operations(id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,1,?,'allocation.provision','provision',?,'planned',?,?,?, ?,?,?)",
        params: [
          input.operationId,
          input.allocationId,
          input.runtimeIdentityId,
          input.connectionRevisionId,
          input.artifactId,
          input.generation,
          input.controllerEpoch,
          `${input.allocationId}:provision:${input.generation}:1`,
          createHash("sha256")
            .update(
              `${input.allocationId}:${input.ticketId}:${input.generation}`,
            )
            .digest("hex"),
          JSON.stringify({
            ticketId: input.ticketId,
            purpose: "tenant",
            executionMode: input.executionMode,
          }),
          input.now,
          input.deadline,
          input.now,
          input.now,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO capacity_claims(id,allocation_id,pool_id,component,state,cpu_millis,memory_mib,scratch_mib,version,created_at_ms,updated_at_ms) VALUES(?,?,?,'combined','reserved',?,?,?,?,?,?)",
        params: [
          input.claimId,
          input.allocationId,
          input.poolId,
          request.cpuMillis,
          request.memoryMiB,
          request.scratchMiB,
          1,
          input.now,
          input.now,
        ],
      },
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='reserved',version=version+1,updated_at_ms=?,provision_deadline_ms=?,scheduling_reason_json=NULL WHERE id=? AND version=? AND phase='queued'",
        params: [
          input.now,
          input.deadline,
          input.ticketId,
          input.ticketVersion,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE capacity_pools SET version=version+1,updated_at_ms=? WHERE id=? AND version=?",
        params: [input.now, input.poolId, input.poolVersion],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE nodes SET version=version+1,updated_at_ms=? WHERE id=? AND version=?",
        params: [input.now, input.nodeId, input.nodeVersion],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) VALUES('ticket',?,?,'ticket.reserved',?,?,?)",
        params: [
          input.ticketId,
          input.ticketVersion + 1,
          input.consumerId,
          input.now,
          JSON.stringify({ nodeId: input.nodeId }),
        ],
      },
    ]);
  }
}

function completionStatement(
  completion: IdempotencyCompletionRef,
  status: 200 | 202,
): {
  kind: "run";
  sql: string;
  params: readonly (string | number)[];
  expectChanges: 1;
} {
  return {
    kind: "run",
    sql: "UPDATE idempotency_keys SET response_status=?,safe_response_json=? WHERE consumer_id=? AND route_scope=? AND idempotency_key=? AND request_hash=? AND ticket_id=? AND safe_response_json IS NULL",
    params: [
      status,
      JSON.stringify({ ticketId: completion.ticketId }),
      completion.consumerId,
      completion.routeScope,
      completion.key,
      completion.requestHash,
      completion.ticketId,
    ],
    expectChanges: 1,
  };
}
