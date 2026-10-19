import { randomUUID } from "node:crypto";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";
import type { Storage } from "./index.js";
import { hash, integer, parseJson, type Row } from "./admin-store-utils.js";

type ScheduleRequest = ImageValidationRequest & {
  versionId: string;
  requestedBy: string;
};

type ValidationBinding = {
  storageProfileId: string;
  storageProfileRevisionId: string;
  profileVersion: number;
  protocol: string;
  sourceRef: string;
  authorizedSubpath: string;
  mountPath: string;
  mode: "read_only" | "read_write";
  secretVersionRef: string | null;
};

export type ValidationContext = {
  readonly consumer: Row | undefined;
  readonly network: Row | undefined;
  readonly storageProfiles: ReadonlyMap<string, Row | undefined>;
  readonly target: Row | undefined;
};

export class SQLiteValidationStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}

  async loadContext(input: ScheduleRequest): Promise<ValidationContext> {
    const [consumer, network, target] = await Promise.all([
      this.db.get<Row>(
        "SELECT authorization_json,version,status FROM consumers WHERE id=?",
        [input.requestedBy],
      ),
      this.db.get<Row>(
        "SELECT p.id,p.current_revision_id,p.version,p.status,r.policy_json FROM network_profiles p LEFT JOIN network_profile_revisions r ON r.id=p.current_revision_id WHERE p.id=?",
        [input.networkProfileId],
      ),
      this.db.get<Row>(
        "SELECT a.id,a.image_version_id,a.architecture,a.guest_os,a.content_digest,a.minimum_cpu_millis,a.minimum_memory_mib,a.minimum_scratch_mib,a.requirements_json,a.access_recipe_json,v.image_id,v.status AS version_status,v.entity_version AS version_entity_version,n.id AS node_id,n.machine_id,n.pool_id,n.runtime_identity_id,n.provider_connection_id,n.admission,n.observed_health,n.observed_at_ms,n.version AS node_version,n.capabilities_json,m.architecture AS machine_arch,m.host_os AS machine_os,m.admission AS machine_admission,m.observed_power,m.source AS machine_source,m.version AS machine_version,co.enabled AS connection_enabled,co.version AS connection_version,co.current_revision_id AS connection_revision_id,p.version AS pool_version FROM image_artifacts a JOIN image_versions v ON v.id=a.image_version_id JOIN nodes n ON n.id=? JOIN machines m ON m.id=n.machine_id JOIN capacity_pools p ON p.id=n.pool_id JOIN provider_connections co ON co.id=n.provider_connection_id WHERE a.id=? AND a.image_version_id=? AND v.status IN ('draft','validating') AND a.backend_kind=n.backend_kind AND a.architecture=m.architecture AND co.current_revision_id IS NOT NULL",
        [input.nodeId, input.imageArtifactId, input.versionId],
      ),
    ]);
    const storageProfiles = new Map<string, Row | undefined>();
    for (const request of input.storage) {
      if (storageProfiles.has(request.storageProfileId)) continue;
      storageProfiles.set(
        request.storageProfileId,
        await this.db.get<Row>(
          "SELECT p.id,p.current_revision_id,p.version,p.status,r.kind,r.config_json,r.secret_version_ref FROM storage_profiles p LEFT JOIN storage_profile_revisions r ON r.id=p.current_revision_id WHERE p.id=?",
          [request.storageProfileId],
        ),
      );
    }
    return { consumer, network, storageProfiles, target };
  }

  async persistSchedule(input: {
    readonly request: ScheduleRequest;
    readonly context: ValidationContext;
    readonly bindings: readonly ValidationBinding[];
    readonly contract: Readonly<Record<string, unknown>>;
    readonly blockReason: string | null;
    readonly ids: {
      readonly validationId: string;
      readonly allocationId: string;
      readonly claimId: string;
      readonly operationId: string;
    };
    readonly now: number;
    readonly deadlineMs: number;
  }) {
    const { request, context, bindings, contract, ids, now, deadlineMs } =
      input;
    const { consumer, network, target } = context;
    if (!consumer || !network || !target)
      throw new RangeError("Validation snapshot is incomplete");
    const resources = request.resources.request;
    const networkRevisionId = String(network.current_revision_id);
    const storageFences = bindings
      .map(
        () =>
          " AND EXISTS(SELECT 1 FROM storage_profiles sp WHERE sp.id=? AND sp.status='active' AND sp.version=? AND sp.current_revision_id=? AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations pr WHERE pr.storage_profile_revision_id=sp.current_revision_id))",
      )
      .join("");
    const storageFenceParams = bindings.flatMap((binding) => [
      binding.storageProfileId,
      binding.profileVersion,
      binding.storageProfileRevisionId,
    ]);
    const statements: import("./protocol.js").Statement[] = [
      {
        kind: "run",
        sql: "INSERT INTO image_validations(id,image_artifact_id,node_id,requested_by_consumer_id,accepted_contract_json,scope_json,checks_json,deadline_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
        params: [
          ids.validationId,
          request.imageArtifactId,
          request.nodeId,
          request.requestedBy,
          JSON.stringify(contract),
          JSON.stringify({ purpose: "validation", internalOnly: true }),
          JSON.stringify(
            input.blockReason
              ? { scheduler: "blocked", reason: input.blockReason }
              : { scheduler: "queued" },
          ),
          deadlineMs,
          now,
          now,
        ],
      },
    ];
    if (!input.blockReason) {
      statements.push(
        {
          kind: "run",
          sql: `INSERT INTO allocations(id,purpose,image_validation_id,node_id,machine_id,runtime_identity_id,image_artifact_id,generation,desired_state,resource_contract_json,ownership_json,cleanup_status,created_at_ms,updated_at_ms) SELECT ?,'validation',?,?,?,?,?,1,'present',?,?,'pending',?,? FROM capacity_pools p WHERE p.id=? AND ?<=p.total_cpu_millis-p.system_cpu_millis-COALESCE((SELECT sum(cpu_millis) FROM capacity_claims c WHERE c.pool_id=p.id AND c.state IN ('reserved','committed','quarantined')),0) AND ?<=p.total_memory_mib-p.system_memory_mib-COALESCE((SELECT sum(memory_mib) FROM capacity_claims c WHERE c.pool_id=p.id AND c.state IN ('reserved','committed','quarantined')),0) AND ?<=p.total_scratch_mib-p.system_scratch_mib-COALESCE((SELECT sum(scratch_mib) FROM capacity_claims c WHERE c.pool_id=p.id AND c.state IN ('reserved','committed','quarantined')),0) AND p.version=? AND EXISTS(SELECT 1 FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN provider_connections pc ON pc.id=n.provider_connection_id JOIN provider_connection_revisions cr ON cr.id=pc.current_revision_id JOIN image_artifacts a ON a.id=? JOIN image_versions v ON v.id=a.image_version_id JOIN consumers c ON c.id=? JOIN network_profiles np ON np.id=? WHERE n.id=? AND n.version=? AND n.admission='enabled' AND n.observed_health='healthy' AND n.observed_at_ms+120000>? AND n.capabilities_json=? AND m.source='local' AND m.admission='enabled' AND m.observed_power='on' AND m.version=? AND pc.enabled=1 AND pc.version=? AND pc.current_revision_id=? AND cr.verified_runtime_identity_id=n.runtime_identity_id AND v.status IN ('draft','validating') AND v.entity_version=? AND c.status='active' AND c.version=? AND c.authorization_json=? AND (json_extract(c.authorization_json,'$.imageIds')='all' OR EXISTS(SELECT 1 FROM json_each(c.authorization_json,'$.imageIds') WHERE value=v.image_id)) AND np.status='active' AND np.version=? AND np.current_revision_id=? AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations pr WHERE pr.network_profile_revision_id=np.current_revision_id)${storageFences})`,
          params: [
            ids.allocationId,
            ids.validationId,
            request.nodeId,
            String(target.machine_id),
            String(target.runtime_identity_id),
            request.imageArtifactId,
            JSON.stringify(request.resources),
            JSON.stringify({ validationId: ids.validationId }),
            now,
            now,
            String(target.pool_id),
            resources.cpuMillis,
            resources.memoryMiB,
            resources.scratchMiB,
            Number(target.pool_version),
            request.imageArtifactId,
            request.requestedBy,
            request.networkProfileId,
            request.nodeId,
            Number(target.node_version),
            now,
            String(target.capabilities_json),
            Number(target.machine_version),
            Number(target.connection_version),
            String(target.connection_revision_id),
            Number(target.version_entity_version),
            Number(consumer.version),
            String(consumer.authorization_json),
            Number(network.version),
            networkRevisionId,
            ...storageFenceParams,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "INSERT INTO capacity_claims(id,allocation_id,pool_id,cpu_millis,memory_mib,scratch_mib,state,created_at_ms) SELECT ?,?,?,?, ?,?,'reserved',? WHERE EXISTS(SELECT 1 FROM allocations WHERE id=?)",
          params: [
            ids.claimId,
            ids.allocationId,
            String(target.pool_id),
            resources.cpuMillis,
            resources.memoryMiB,
            resources.scratchMiB,
            now,
            ids.allocationId,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "INSERT INTO operations(id,installation_id,allocation_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms,runtime_identity_id,connection_revision_id,image_artifact_id,node_id) SELECT ?,NULL,?,1,1,i.controller_epoch,'validation.prepare',?,?,'planned',?,?,?, ?,?,?,?, ?,?,NULL FROM installations i JOIN allocations a ON a.id=? JOIN capacity_claims c ON c.allocation_id=a.id WHERE i.singleton=1",
          params: [
            ids.operationId,
            ids.allocationId,
            ids.validationId,
            `validation:${ids.validationId}`,
            hash(JSON.stringify(contract)),
            JSON.stringify({
              validationId: ids.validationId,
              allocationId: ids.allocationId,
              contract,
            }),
            now,
            deadlineMs,
            now,
            now,
            String(target.runtime_identity_id),
            String(target.connection_revision_id),
            request.imageArtifactId,
            ids.allocationId,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "UPDATE image_versions SET status='validating',entity_version=entity_version+1,updated_at_ms=? WHERE id=? AND status IN ('draft','validating') AND entity_version=? AND EXISTS(SELECT 1 FROM allocations WHERE id=?)",
          params: [
            now,
            String(target.image_version_id),
            Number(target.version_entity_version),
            ids.allocationId,
          ],
          expectChanges: 1,
        },
      );
    }
    let reservationConflict = false;
    try {
      await this.db.batchTransaction(statements);
    } catch (error) {
      if (
        input.blockReason ||
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "STORAGE_CAS_FAILED"
      )
        throw error;
      reservationConflict = true;
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: "INSERT INTO image_validations(id,image_artifact_id,node_id,requested_by_consumer_id,accepted_contract_json,scope_json,checks_json,deadline_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)",
          params: [
            ids.validationId,
            request.imageArtifactId,
            request.nodeId,
            request.requestedBy,
            JSON.stringify(contract),
            JSON.stringify({ purpose: "validation", internalOnly: true }),
            JSON.stringify({
              scheduler: "blocked",
              reason: "admission_or_authorization_changed_before_reservation",
            }),
            deadlineMs,
            now,
            now,
          ],
        },
      ]);
    }
    const reserved =
      !input.blockReason &&
      !reservationConflict &&
      !!(await this.db.get<Row>(
        "SELECT id FROM capacity_claims WHERE allocation_id=? AND state='reserved'",
        [ids.allocationId],
      ));
    return { reserved, reservationConflict };
  }

  async getValidation(id: string) {
    const r = await this.db.get<Row>(
      "SELECT id,image_artifact_id,node_id,requested_by_consumer_id,accepted_contract_json,state,test_outcome,cleanup_status,scope_json,checks_json,deadline_ms,finished_at_ms,evidence_expires_at_ms,version,created_at_ms,updated_at_ms FROM image_validations WHERE id=?",
      [id],
    );
    if (!r) return undefined;
    return {
      id: String(r.id),
      imageArtifactId: String(r.image_artifact_id),
      nodeId: String(r.node_id),
      requestedByConsumerId: String(r.requested_by_consumer_id),
      acceptedContract: parseJson(String(r.accepted_contract_json)),
      state: String(r.state),
      testOutcome: String(r.test_outcome),
      cleanupStatus: String(r.cleanup_status),
      scope: parseJson(String(r.scope_json)),
      checks: parseJson(String(r.checks_json)),
      deadlineMs: integer(r.deadline_ms),
      finishedAtMs:
        r.finished_at_ms === null ? null : integer(r.finished_at_ms),
      evidenceExpiresAtMs:
        r.evidence_expires_at_ms === null
          ? null
          : integer(r.evidence_expires_at_ms),
      version: integer(r.version),
      createdAtMs: integer(r.created_at_ms),
      updatedAtMs: integer(r.updated_at_ms),
    };
  }
}
