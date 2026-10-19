import { randomUUID } from "node:crypto";
import type { Storage } from "./index.js";
import { StorageError } from "./index.js";
import type { PortainerEvidence } from "../providers/port.js";
import {
  hash,
  integer,
  nullableString,
  parseJson,
  projectEvidence,
  type Row,
} from "./admin-store-utils.js";

export class SQLiteProviderConnectionStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async listConnections() {
    const rows = await this.db.all<Row>(
      "SELECT c.id,c.backend_kind,c.runtime_identity_id,c.current_revision_id,c.enabled,c.version,r.revision,r.endpoint_ref,r.provider_endpoint_id,r.verified_at_ms,r.evidence_json FROM provider_connections c LEFT JOIN provider_connection_revisions r ON r.id=c.current_revision_id ORDER BY c.created_at_ms",
    );
    return rows.map((r) => ({
      id: String(r.id),
      backendKind: String(r.backend_kind),
      runtimeIdentityId: String(r.runtime_identity_id),
      currentRevisionId: nullableString(r.current_revision_id),
      enabled: Number(r.enabled) === 1,
      version: integer(r.version),
      revision: r.revision === null ? null : integer(r.revision),
      endpointUrl: nullableString(r.endpoint_ref),
      environmentId: nullableString(r.provider_endpoint_id),
      verifiedAtMs:
        r.verified_at_ms === null ? null : integer(r.verified_at_ms),
      evidence:
        r.evidence_json === null
          ? null
          : projectEvidence(String(r.evidence_json)),
    }));
  }
  discoveryOperation(operationId: string) {
    return this.db.get<Row>(
      "SELECT id,state,intent_json,result_json,created_at_ms,updated_at_ms FROM operations WHERE id=? AND kind='provider.discover'",
      [operationId],
    );
  }
  connectionRevisionOperation(operationId: string) {
    return this.db.get<Row>(
      "SELECT id,state,intent_json,result_json,created_at_ms,updated_at_ms FROM operations WHERE id=? AND kind='provider.connection.probe'",
      [operationId],
    );
  }
  async beginDiscovery(
    operationId: string,
    target: {
      endpointUrl: string;
      environmentId: string;
      secretVersionRef: string;
    },
  ) {
    const installation = await this.db.get<Row>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation) throw new Error("Installation is not initialized");
    const time = this.now(),
      intent = { type: "portainer.discovery", ...target };
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,'provider.discover',?,?,'planned',?,?,?, ?,?,?) ON CONFLICT(id) DO NOTHING",
        params: [
          operationId,
          String(installation.installation_id),
          Number(installation.controller_epoch),
          operationId,
          `provider.discover:${operationId}`,
          hash(JSON.stringify(intent)),
          JSON.stringify(intent),
          time,
          time + 120_000,
          time,
          time,
        ],
      },
    ]);
    const op = await this.db.get<Row>(
      "SELECT state,intent_json,result_json FROM operations WHERE id=? AND installation_id=? AND kind='provider.discover'",
      [operationId, String(installation.installation_id)],
    );
    if (!op || typeof op.intent_json !== "string")
      throw new RangeError("Discovery operation not found");
    const saved = parseJson(String(op.intent_json));
    if (JSON.stringify(saved) !== JSON.stringify(intent))
      throw new RangeError(
        "Discovery retry must use its persisted target and secret version",
      );
    if (op.state === "succeeded" && typeof op.result_json === "string")
      return { complete: parseJson(op.result_json) };
    await this.db.run(
      "UPDATE operations SET state='running',attempt_count=attempt_count+1,version=version+1,updated_at_ms=? WHERE id=? AND state IN ('planned','running','unknown')",
      [this.now(), operationId],
    );
    return { complete: null };
  }
  async completeDiscovery(
    operationId: string,
    target: {
      endpointUrl: string;
      environmentId: string;
      secretVersionRef: string;
    },
    evidence: PortainerEvidence,
  ) {
    const runtime = await this.db.get<Row>(
      "SELECT id FROM runtime_identities WHERE backend_kind='portainer' AND native_kind='docker_engine' AND native_id=?",
      [evidence.engineId],
    );
    const existing = await this.db.get<Row>(
      "SELECT c.id FROM provider_connections c WHERE c.runtime_identity_id=?",
      [runtime?.id ?? ""],
    );
    if (existing) {
      const result = {
        duplicateRuntime: true,
        connectionId: existing.id,
        engineId: evidence.engineId,
      };
      await this.db.run(
        "UPDATE operations SET state='succeeded',result_json=?,version=version+1,updated_at_ms=? WHERE id=? AND state='running'",
        [JSON.stringify(result), this.now(), operationId],
      );
      return { operationId, ...result };
    }
    const runtimeId = String(runtime?.id ?? randomUUID()),
      connectionId = randomUUID(),
      revisionId = randomUUID(),
      time = this.now();
    const result = {
      duplicateRuntime: false,
      runtimeIdentityId: runtimeId,
      connectionId,
      connectionRevisionId: revisionId,
      engineId: evidence.engineId,
      evidence,
    };
    try {
      await this.db.batchTransaction([
        ...(!runtime
          ? [
              {
                kind: "run" as const,
                sql: "INSERT INTO runtime_identities(id,backend_kind,native_kind,native_id,created_at_ms) VALUES(?,'portainer','docker_engine',?,?)",
                params: [runtimeId, evidence.engineId, time],
              },
            ]
          : []),
        {
          kind: "run",
          sql: "INSERT INTO provider_connections(id,backend_kind,runtime_identity_id,created_at_ms,updated_at_ms) VALUES(?,'portainer',?,?,?)",
          params: [connectionId, runtimeId, time, time],
        },
        {
          kind: "run",
          sql: "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,secret_version_ref,config_json,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) VALUES(?,?,1,?,?,?,?,?,?,?,?)",
          params: [
            revisionId,
            connectionId,
            target.endpointUrl,
            target.environmentId,
            target.secretVersionRef,
            JSON.stringify({ portainerVersion: evidence.portainerVersion }),
            runtimeId,
            time,
            JSON.stringify(evidence),
            time,
          ],
        },
        {
          kind: "run",
          sql: "UPDATE provider_connections SET current_revision_id=?,version=version+1,updated_at_ms=? WHERE id=? AND runtime_identity_id=? AND current_revision_id IS NULL",
          params: [revisionId, time, connectionId, runtimeId],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "UPDATE operations SET state='succeeded',result_json=?,version=version+1,updated_at_ms=? WHERE id=? AND state='running'",
          params: [JSON.stringify(result), time, operationId],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      const winner = await this.db.get<Row>(
        "SELECT c.id FROM runtime_identities r JOIN provider_connections c ON c.runtime_identity_id=r.id WHERE r.backend_kind='portainer' AND r.native_kind='docker_engine' AND r.native_id=?",
        [evidence.engineId],
      );
      if (!winner) throw error;
      const duplicate = {
        duplicateRuntime: true,
        connectionId: winner.id,
        engineId: evidence.engineId,
      };
      await this.db.run(
        "UPDATE operations SET state='succeeded',result_json=?,version=version+1,updated_at_ms=? WHERE id=? AND state='running'",
        [JSON.stringify(duplicate), this.now(), operationId],
      );
      return { operationId, ...duplicate };
    }
    return { operationId, ...result };
  }
  async beginRevision(
    operationId: string,
    target: {
      connectionId: string;
      endpointUrl: string;
      environmentId: string;
      secretVersionRef: string;
    },
  ) {
    const connection = await this.db.get<Row>(
      "SELECT runtime_identity_id FROM provider_connections WHERE id=? AND backend_kind='portainer' AND enabled=1",
      [target.connectionId],
    );
    if (!connection) throw new RangeError("Portainer connection not found");
    const installation = await this.db.get<Row>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation) throw new Error("Installation is not initialized");
    const intent = {
        type: "portainer.connection_revision",
        ...target,
        expectedRuntimeIdentityId: String(connection.runtime_identity_id),
      },
      time = this.now();
    await this.db.run(
      "INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,'provider.connection.probe',?,?,'planned',?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      [
        operationId,
        String(installation.installation_id),
        Number(installation.controller_epoch),
        operationId,
        `provider.connection.probe:${operationId}`,
        hash(JSON.stringify(intent)),
        JSON.stringify(intent),
        time,
        time + 120_000,
        time,
        time,
      ],
    );
    const op = await this.db.get<Row>(
      "SELECT state,intent_json,result_json FROM operations WHERE id=? AND installation_id=? AND kind='provider.connection.probe'",
      [operationId, String(installation.installation_id)],
    );
    if (
      !op ||
      typeof op.intent_json !== "string" ||
      JSON.stringify(parseJson(String(op.intent_json))) !==
        JSON.stringify(intent)
    )
      throw new RangeError(
        "Connection revision retry must use its persisted proposal",
      );
    if (op.state === "succeeded" && typeof op.result_json === "string")
      return {
        complete: parseJson(String(op.result_json)),
        expectedRuntimeIdentityId: intent.expectedRuntimeIdentityId,
      };
    await this.db.run(
      "UPDATE operations SET state='running',attempt_count=attempt_count+1,version=version+1,updated_at_ms=? WHERE id=? AND state IN ('planned','running','unknown')",
      [time, operationId],
    );
    return {
      complete: null,
      expectedRuntimeIdentityId: intent.expectedRuntimeIdentityId,
    };
  }
  async runtimeNativeId(runtimeIdentityId: string) {
    return this.db.get<Row>(
      "SELECT native_id FROM runtime_identities WHERE id=?",
      [runtimeIdentityId],
    );
  }
  async completeRevision(
    operationId: string,
    target: {
      connectionId: string;
      endpointUrl: string;
      environmentId: string;
      secretVersionRef: string;
    },
    expectedRuntimeIdentityId: string,
    evidence: PortainerEvidence,
  ) {
    const next = await this.db.get<Row>(
      "SELECT max(revision) AS revision FROM provider_connection_revisions WHERE connection_id=?",
      [target.connectionId],
    );
    const revisionId = randomUUID(),
      revision = Number(next?.revision ?? 0) + 1,
      time = this.now();
    const result = {
      operationId,
      connectionId: target.connectionId,
      connectionRevisionId: revisionId,
      revision,
      verifiedRuntimeIdentityId: expectedRuntimeIdentityId,
      evidence,
    };
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,secret_version_ref,config_json,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        params: [
          revisionId,
          target.connectionId,
          revision,
          target.endpointUrl,
          target.environmentId,
          target.secretVersionRef,
          "{}",
          expectedRuntimeIdentityId,
          time,
          JSON.stringify(evidence),
          time,
        ],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='succeeded',result_json=?,version=version+1,updated_at_ms=? WHERE id=? AND state='running'",
        params: [JSON.stringify(result), time, operationId],
      },
    ]);
    return result;
  }
  async markUnknown(operationId: string, reasonCode: string) {
    await this.db.run(
      "UPDATE operations SET state='unknown',result_json=?,next_check_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND state='running'",
      [
        JSON.stringify({ code: reasonCode }),
        this.now() + 5000,
        this.now(),
        operationId,
      ],
    );
  }
  async activateConnectionRevision(
    connectionId: string,
    revisionId: string,
    expectedVersion: number,
  ) {
    const result = await this.db.run(
      "UPDATE provider_connections SET current_revision_id=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM provider_connection_revisions r WHERE r.id=? AND r.connection_id=provider_connections.id AND r.verified_runtime_identity_id=provider_connections.runtime_identity_id)",
      [revisionId, this.now(), connectionId, expectedVersion, revisionId],
    );
    if (result.changes !== 1n)
      throw new StorageError(
        "STORAGE_CAS_FAILED",
        "Connection revision activation conflict or identity mismatch",
      );
    return {
      connectionId,
      currentRevisionId: revisionId,
      version: expectedVersion + 1,
    };
  }
}
