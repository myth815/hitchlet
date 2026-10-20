import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { ManagementDenyUpdate } from "@hitchlet/contracts/admin";
import {
  ConsumerViewSchema,
  ConsumerQuotaSchema,
  ConsumerAuthorizationSchema,
  type ConsumerInput,
  type ConsumerUpdate,
} from "@hitchlet/contracts/admin";
import { StorageError, type Storage } from "./index.js";
import type { Statement } from "./protocol.js";
import { integer, canonicalJson, type Row } from "./admin-store-utils.js";
import { ApplicationError } from "../application/errors.js";
import { roleScopes } from "../domain/role-scopes.js";

/** Null is the already-authorized full-admin view. All other reads use the persisted grants. */
export type ManagementReadScope = ConsumerInput["authorization"] | null;
const scopeCte = "WITH scope(authorization,full_admin) AS (VALUES(?,?))";
const imageVisible =
  "(json_extract(s.authorization,'$.imageIds')='all' OR v.image_id IN (SELECT value FROM json_each(s.authorization,'$.imageIds')))";
const nodeVisible = (column: string) =>
  `(json_extract(s.authorization,'$.nodeIds')='all' OR ${column} IN (SELECT value FROM json_each(s.authorization,'$.nodeIds')))`;
// A queued Ticket with bounded grants is visible only if every explicit allowed Node is granted.
// This predicate is shared by point authorization and aggregate counts, so a list window cannot change visibility.
const ticketVisible = `(s.full_admin=1 OR (${imageVisible} AND ((a.node_id IS NOT NULL AND ${nodeVisible("a.node_id")}) OR (a.node_id IS NULL AND (json_extract(s.authorization,'$.nodeIds')='all' OR (json_type(t.request_json,'$.allowedNodeIds')='array' AND json_array_length(t.request_json,'$.allowedNodeIds')>0 AND NOT EXISTS(SELECT 1 FROM json_each(t.request_json,'$.allowedNodeIds') requested WHERE requested.value NOT IN (SELECT value FROM json_each(s.authorization,'$.nodeIds')))))))))`;
const scopeParams = (scope: ManagementReadScope) => [
  scope === null ? null : JSON.stringify(scope),
  scope === null ? 1 : 0,
];
const operationProjection =
  "o.id,o.image_artifact_id,a.ticket_id,COALESCE(o.node_id,a.node_id) AS node_id,o.runtime_identity_id,o.connection_revision_id,o.kind,o.state,o.attempt_count,o.version,o.next_check_at_ms,o.updated_at_ms,json_extract(o.result_json,'$.code') AS error_code";
const parse = (value: unknown): unknown => JSON.parse(String(value));

/** Administrative configuration and safe directory queries. No provider side effects or Ticket rewriting. */
export class SQLiteManagementStore {
  constructor(
    readonly db: Storage,
    readonly now = Date.now,
  ) {}
  async consumers() {
    const rows = await this.db.all<Row>(
      "SELECT id,name,kind,role,status,authorization_json,quota_json,version,updated_at_ms FROM consumers ORDER BY name,id",
    );
    return rows.map((r) =>
      ConsumerViewSchema.parse({
        id: r.id,
        name: r.name,
        kind: r.kind,
        role: r.role,
        status: r.status,
        authorization: parse(r.authorization_json),
        quota: parse(r.quota_json),
        version: integer(r.version),
        updatedAtMs: integer(r.updated_at_ms),
      }),
    );
  }
  policies() {
    return this.db
      .all<Row>(
        "SELECT id,name,version,updated_at_ms AS updatedAtMs FROM policies WHERE kind='lifecycle' ORDER BY name,id",
      )
      .then((rows) =>
        rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          version: integer(r.version),
          updatedAtMs: integer(r.updatedAtMs),
        })),
      );
  }
  async savePolicy(
    name: string,
    actor: string,
    requestId: string,
    id: string = randomUUID(),
    expected?: number,
  ) {
    const time = this.now();
    await this.db.batchTransaction([
      expected === undefined
        ? {
            kind: "run",
            sql: "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES(?,?,'lifecycle','{}',?,?)",
            params: [id, name, time, time],
          }
        : {
            kind: "run",
            sql: "UPDATE policies SET name=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND kind='lifecycle'",
            params: [name, time, id, expected],
            expectChanges: 1,
          },
      this.audit(actor, requestId, "policy.saved", "policy", id, {
        expectedVersion: expected ?? null,
      }),
    ]);
    return { id, name, version: (expected ?? 0) + 1, updatedAtMs: time };
  }
  async saveConsumer(
    input: ConsumerInput | ConsumerUpdate,
    actor: string,
    requestId: string,
    id: string = randomUUID(),
  ) {
    await this.validateGrants(input);
    const expected =
      "expectedVersion" in input ? input.expectedVersion : undefined;
    const time = this.now();
    // Keep one usable full administrator. The predicate is rechecked under the same IMMEDIATE transaction.
    const keepAdmin =
      "(role<>'admin' OR status<>'active' OR (?='admin' AND ?='active') OR EXISTS(SELECT 1 FROM consumers other JOIN consumer_credentials cc ON cc.consumer_id=other.id WHERE other.id<>consumers.id AND other.role='admin' AND other.status='active' AND cc.revoked_at_ms IS NULL AND (cc.expires_at_ms IS NULL OR cc.expires_at_ms>?) AND json_array_length(cc.scopes_json)=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM json_each(?) required WHERE required.value NOT IN (SELECT value FROM json_each(cc.scopes_json)))))";
    const statements: Statement[] = [
      expected === undefined
        ? {
            kind: "run",
            sql: "INSERT INTO consumers(id,name,kind,role,status,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
            params: [
              id,
              input.name,
              input.kind,
              input.role,
              input.status,
              JSON.stringify(input.authorization),
              JSON.stringify(input.quota),
              time,
              time,
            ],
          }
        : {
            kind: "run",
            sql: `UPDATE consumers SET name=?,kind=?,role=?,status=?,authorization_json=?,quota_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND ${keepAdmin}`,
            params: [
              input.name,
              input.kind,
              input.role,
              input.status,
              JSON.stringify(input.authorization),
              JSON.stringify(input.quota),
              time,
              id,
              expected,
              input.role,
              input.status,
              time,
              JSON.stringify(roleScopes("admin")),
              JSON.stringify(roleScopes("admin")),
            ],
            expectChanges: 1,
          },
    ];
    if (expected !== undefined) {
      // Session scope cannot grow after a role edit. Bearers are immediately synchronized to the new bounded role.
      statements.push({
        kind: "run",
        sql: "UPDATE consumer_credentials SET scopes_json=(SELECT json_group_array(value) FROM json_each(consumer_credentials.scopes_json) WHERE value IN (SELECT value FROM json_each(?))) WHERE consumer_id=?",
        params: [JSON.stringify(roleScopes(input.role)), id],
      });
      statements.push({
        kind: "run",
        sql: "UPDATE gui_sessions SET revoked_at_ms=? WHERE consumer_id=? AND revoked_at_ms IS NULL",
        params: [time, id],
      });
    }
    statements.push(
      this.audit(actor, requestId, "consumer.saved", "consumer", id, {
        expectedVersion: expected ?? null,
        role: input.role,
        status: input.status,
        impact: "new admission; existing accepted contracts unchanged",
      }),
    );
    await this.db.batchTransaction(statements);
    const { name, kind, role, status, authorization, quota } = input;
    return ConsumerViewSchema.parse({
      name,
      kind,
      role,
      status,
      authorization,
      quota,
      id,
      version: (expected ?? 0) + 1,
      updatedAtMs: time,
    });
  }
  private async validateGrants(input: ConsumerInput) {
    for (const [key, table] of [
      ["imageIds", "images"],
      ["nodeIds", "nodes"],
      ["networkProfileIds", "network_profiles"],
      ["storageProfileIds", "storage_profiles"],
    ] as const) {
      const ids = input.authorization[key];
      if (ids !== "all")
        for (const id of ids)
          if (
            !(await this.db.get<Row>(`SELECT id FROM ${table} WHERE id=?`, [
              id,
            ]))
          )
            throw new RangeError(`Unknown ${key} grant`);
    }
    if (
      !(await this.db.get<Row>(
        "SELECT id FROM policies WHERE id=? AND kind='lifecycle'",
        [input.quota.defaultExpiryPolicyId],
      ))
    )
      throw new RangeError("Unknown lifecycle policy");
  }
  async issueCredential(
    consumerId: string,
    actor: string,
    requestId: string,
    key?: string,
  ) {
    if (
      key &&
      (await this.db.get<Row>(
        "SELECT 1 FROM idempotency_keys WHERE consumer_id=? AND route_scope='admin:POST /v1/admin/credentials' AND idempotency_key=?",
        [actor, key],
      ))
    )
      throw new ApplicationError("conflict");
    const consumer = await this.db.get<Row>(
      "SELECT role FROM consumers WHERE id=? AND status='active'",
      [consumerId],
    );
    if (!consumer) throw new ApplicationError("not_found");
    const role = ConsumerViewSchema.shape.role.parse(consumer.role),
      token = `hcl_${randomBytes(32).toString("base64url")}`,
      credentialId = randomUUID(),
      time = this.now();
    await this.db.batchTransaction([
      ...(key
        ? [
            {
              kind: "run" as const,
              sql: "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,response_status,safe_response_json,created_at_ms,retain_until_ms) VALUES(?,'admin:POST /v1/admin/credentials',?,?,201,?,?,?)",
              params: [
                actor,
                key,
                createHash("sha256").update(consumerId).digest("hex"),
                JSON.stringify({
                  consumerId,
                  credentialId,
                  tokenOmitted: true,
                }),
                time,
                time + 180 * 86400000,
              ],
            },
          ]
        : []),
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM consumers WHERE id=? AND role=? AND status='active')",
        params: [
          credentialId,
          consumerId,
          token.slice(0, 12),
          createHash("sha256").update(token).digest("hex"),
          JSON.stringify(roleScopes(role)),
          time,
          consumerId,
          role,
        ],
        expectChanges: 1,
      },
      this.audit(
        actor,
        requestId,
        "credential.issued",
        "consumer",
        consumerId,
        { credentialId },
      ),
    ]);
    return { consumerId, credentialId, token };
  }
  async scope(consumerId: string) {
    const row = await this.db.get<Row>(
      "SELECT authorization_json,quota_json FROM consumers WHERE id=? AND status='active'",
      [consumerId],
    );
    if (!row) throw new ApplicationError("not_found");
    return {
      authorization: ConsumerAuthorizationSchema.parse(
        parse(row.authorization_json),
      ),
      quota: ConsumerQuotaSchema.parse(parse(row.quota_json)),
    };
  }
  visibleTicket(ticketId: string, scope: ManagementReadScope) {
    return this.db.get<Row>(
      `${scopeCte} SELECT t.id FROM tickets t JOIN image_versions v ON v.id=t.image_version_id LEFT JOIN allocations a ON a.ticket_id=t.id CROSS JOIN scope s WHERE t.id=? AND ${ticketVisible}`,
      [...scopeParams(scope), ticketId],
    );
  }
  /** Ledger-size aggregate work stays inside SQLite; no Ticket/Operation documents are loaded into the polling process. */
  async overviewCounts(scope: ManagementReadScope, consumerId: string) {
    const parameters = scopeParams(scope);
    const phases = await this.db.all<Row>(
      `${scopeCte} SELECT t.phase,count(*) AS count,sum(CASE WHEN t.cleanup_status='blocked' THEN 1 ELSE 0 END) AS cleanup_blocked FROM tickets t JOIN image_versions v ON v.id=t.image_version_id LEFT JOIN allocations a ON a.ticket_id=t.id CROSS JOIN scope s WHERE ${ticketVisible} GROUP BY t.phase`,
      parameters,
    );
    const unknown = await this.db.get<Row>(
      `${scopeCte} SELECT count(*) AS count FROM operations o LEFT JOIN allocations a ON a.id=o.allocation_id LEFT JOIN tickets t ON t.id=a.ticket_id LEFT JOIN image_versions v ON v.id=t.image_version_id LEFT JOIN image_artifacts artifact ON artifact.id=o.image_artifact_id LEFT JOIN image_versions cache_version ON cache_version.id=artifact.image_version_id CROSS JOIN scope s WHERE o.state='unknown' AND (s.full_admin=1 OR (t.id IS NOT NULL AND ${ticketVisible}) OR (t.id IS NULL AND o.kind LIKE 'image-cache.%' AND COALESCE(o.node_id,a.node_id) IS NOT NULL AND ${nodeVisible("COALESCE(o.node_id,a.node_id)")} AND (json_extract(s.authorization,'$.imageIds')='all' OR cache_version.image_id IN (SELECT value FROM json_each(s.authorization,'$.imageIds')))))`,
      parameters,
    );
    const initialization =
      scope === null
        ? (await this.initialization())!
        : (await this.db.get<Row>(
            `${scopeCte} SELECT (SELECT count(DISTINCT n.provider_connection_id) FROM nodes n JOIN machines m ON m.id=n.machine_id WHERE m.source='local' AND ${nodeVisible("n.id")}) AS connections,(SELECT count(DISTINCT n.machine_id) FROM nodes n JOIN machines m ON m.id=n.machine_id WHERE m.source='local' AND ${nodeVisible("n.id")}) AS machines,(SELECT count(*) FROM nodes n JOIN machines m ON m.id=n.machine_id WHERE m.source='local' AND ${nodeVisible("n.id")}) AS nodes,(SELECT count(DISTINCT v.id) FROM image_versions v JOIN images i ON i.id=v.image_id JOIN image_artifacts artifact ON artifact.image_version_id=v.id WHERE v.status='published' AND i.status='active' AND artifact.environment_kind='container' AND (i.owner_consumer_id IS NULL OR i.owner_consumer_id=?) AND ${imageVisible}) AS publishedVersions FROM scope s`,
            [...parameters, consumerId],
          ))!;
    return {
      phases,
      unknownOperations: integer(unknown!.count),
      initialization,
    };
  }
  artifactScope(id: string) {
    return this.db.get<Row>(
      "SELECT v.image_id FROM image_artifacts a JOIN image_versions v ON v.id=a.image_version_id WHERE a.id=?",
      [id],
    );
  }
  async updateNetworkDeny(
    input: ManagementDenyUpdate,
    actor: string,
    requestId: string,
  ) {
    for (const rule of input.rules) {
      const [address, prefix, ...rest] = rule.cidr.split("/");
      const bits = isIP(address ?? "");
      if (
        !bits ||
        prefix === undefined ||
        rest.length ||
        !/^\d+$/.test(prefix) ||
        Number(prefix) > (bits === 4 ? 32 : 128)
      )
        throw new RangeError("Invalid management CIDR");
    }
    const current = await this.db.get<Row>(
      "SELECT r.management_deny_rules_json,r.revision FROM installations i JOIN platform_network_deny_revisions r ON r.id=i.current_network_deny_revision_id WHERE i.singleton=1 AND r.id=?",
      [input.expectedRevisionId],
    );
    if (!current)
      throw new StorageError(
        "STORAGE_CAS_FAILED",
        "Management deny revision changed",
      );
    const old = JSON.parse(
      String(current.management_deny_rules_json),
    ) as unknown[];
    const tightening = old.every((rule) =>
        input.rules.some(
          (candidate) => canonicalJson(candidate) === canonicalJson(rule),
        ),
      ),
      id = randomUUID(),
      time = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO platform_network_deny_revisions(id,revision,management_deny_rules_json,reason,created_by_consumer_id,created_at_ms) SELECT ?,?,?,?,?,? WHERE ?=1 OR (NOT EXISTS(SELECT 1 FROM capacity_claims WHERE state<>'released') AND NOT EXISTS(SELECT 1 FROM allocations WHERE cleanup_status<>'complete'))",
        params: [
          id,
          integer(current.revision) + 1,
          JSON.stringify(input.rules),
          input.reason,
          actor,
          time,
          tightening ? 1 : 0,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE installations SET current_network_deny_revision_id=? WHERE singleton=1 AND current_network_deny_revision_id=?",
        params: [id, input.expectedRevisionId],
        expectChanges: 1,
      },
      this.audit(
        actor,
        requestId,
        "network.deny_revision",
        "installation",
        id,
        {
          previousRevisionId: input.expectedRevisionId,
          tightening,
          reason: input.reason,
        },
      ),
    ]);
  }
  initialization() {
    return this.db.get<Row>(
      "SELECT (SELECT count(*) FROM provider_connections) AS connections,(SELECT count(*) FROM machines) AS machines,(SELECT count(*) FROM nodes) AS nodes,(SELECT count(*) FROM image_versions WHERE status='published') AS publishedVersions",
    );
  }
  machinePower() {
    return this.db.all<Row>("SELECT id,observed_power FROM machines");
  }
  versions() {
    return this.db.all<Row>(
      "SELECT v.id,v.image_id,v.version,i.name AS image_name,i.owner_consumer_id,a.architecture,a.id AS artifact_id,a.content_digest,a.minimum_cpu_millis,a.minimum_memory_mib,a.minimum_scratch_mib FROM image_versions v JOIN images i ON i.id=v.image_id JOIN image_artifacts a ON a.image_version_id=v.id WHERE v.status='published' AND i.status='active' AND a.environment_kind='container' ORDER BY i.name,v.version,a.id",
    );
  }
  profiles(kind: "network" | "storage") {
    return this.db.all<Row>(
      kind === "network"
        ? "SELECT p.id,p.name,r.id AS revision_id,r.revision,r.policy_json AS config_json FROM network_profiles p JOIN network_profile_revisions r ON r.id=p.current_revision_id WHERE p.status='active' AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations rev WHERE rev.network_profile_revision_id=r.id) ORDER BY p.name"
        : "SELECT p.id,p.name,r.id AS revision_id,r.revision,r.config_json FROM storage_profiles p JOIN storage_profile_revisions r ON r.id=p.current_revision_id WHERE p.status='active' AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations rev WHERE rev.storage_profile_revision_id=r.id) ORDER BY p.name",
    );
  }
  nodes() {
    return this.db.all<Row>(
      "SELECT n.id,n.name,n.version,n.provider_connection_id,n.machine_id,m.name AS machine_name,m.architecture,n.admission,n.observed_health,n.observed_at_ms FROM nodes n JOIN machines m ON m.id=n.machine_id WHERE m.source='local' ORDER BY n.name,n.id",
    );
  }
  async ticketIds(query: {
    consumerId?: string | undefined;
    nodeId?: string | undefined;
    imageVersionId?: string | undefined;
    phase?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }) {
    return this.db.all<Row>(
      "SELECT t.id,t.phase,t.cleanup_status FROM tickets t LEFT JOIN allocations a ON a.ticket_id=t.id WHERE (? IS NULL OR t.consumer_id=?) AND (? IS NULL OR a.node_id=?) AND (? IS NULL OR t.image_version_id=?) AND (? IS NULL OR t.phase=?) AND (? IS NULL OR t.id>?) ORDER BY t.id LIMIT ?",
      [
        query.consumerId ?? null,
        query.consumerId ?? null,
        query.nodeId ?? null,
        query.nodeId ?? null,
        query.imageVersionId ?? null,
        query.imageVersionId ?? null,
        query.phase ?? null,
        query.phase ?? null,
        query.cursor ?? null,
        query.cursor ?? null,
        query.limit,
      ],
    );
  }
  operations(ticketId?: string, limit = 200) {
    return this.db.all<Row>(
      `SELECT ${operationProjection} FROM operations o LEFT JOIN allocations a ON a.id=o.allocation_id ${ticketId ? "WHERE a.ticket_id=?" : ""} ORDER BY o.updated_at_ms DESC,o.id LIMIT ?`,
      ticketId ? [ticketId, limit] : [limit],
    );
  }
  operation(id: string) {
    return this.db.get<Row>(
      `SELECT ${operationProjection} FROM operations o LEFT JOIN allocations a ON a.id=o.allocation_id WHERE o.id=?`,
      [id],
    );
  }
  events(ticketId: string) {
    return this.db.all<Row>(
      "SELECT CAST(id AS TEXT) AS id,event_type AS type,occurred_at_ms AS occurredAtMs,aggregate_version AS version,NULL AS actorId,json_extract(payload_json,'$.reason') AS reason FROM events WHERE aggregate_type='ticket' AND aggregate_id=? UNION ALL SELECT 'audit:'||id,action,occurred_at_ms,NULL,actor_id,json_extract(safe_details_json,'$.reason') FROM audit_entries WHERE (target_type='ticket' AND target_id=?) OR (target_type='operation' AND target_id IN(SELECT o.id FROM operations o JOIN allocations a ON a.id=o.allocation_id WHERE a.ticket_id=?)) ORDER BY occurredAtMs DESC LIMIT 200",
      [ticketId, ticketId, ticketId],
    );
  }
  audit(
    actor: string,
    requestId: string,
    action: string,
    target: string,
    id: string,
    details: unknown,
  ): Statement {
    return {
      kind: "run",
      sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,?,?,?,?,?,?)",
      params: [
        actor,
        action,
        target,
        id,
        requestId,
        this.now(),
        JSON.stringify(details),
      ],
    };
  }
  async admission(
    kind: "nodes" | "machines",
    id: string,
    input: { expectedVersion: number; admission: string; reason: string },
    actor: string,
    requestId: string,
  ) {
    const row = await this.db.get<Row>(
      `SELECT admission FROM ${kind} WHERE id=?`,
      [id],
    );
    if (!row) throw new ApplicationError("not_found");
    // Resuming a drain restores prior attestation, never manufactures one. Disabled Nodes need trusted attestation.
    if (
      input.admission === "enabled" &&
      kind === "nodes" &&
      row.admission === "disabled"
    )
      throw new RangeError(
        "Disabled Node requires trusted capability attestation",
      );
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: `UPDATE ${kind} SET admission=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND admission=?`,
        params: [
          input.admission,
          this.now(),
          id,
          input.expectedVersion,
          String(row.admission),
        ],
        expectChanges: 1,
      },
      this.audit(actor, requestId, `${kind}.admission`, kind, id, input),
    ]);
    return { id, version: input.expectedVersion + 1 };
  }
  async retire(
    id: string,
    expected: number,
    reason: string,
    actor: string,
    requestId: string,
  ) {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE image_versions SET status='deprecated',entity_version=entity_version+1,updated_at_ms=? WHERE id=? AND entity_version=? AND status='published'",
        params: [this.now(), id, expected],
        expectChanges: 1,
      },
      this.audit(actor, requestId, "image.retired", "image_version", id, {
        reason,
      }),
    ]);
    return { id, version: expected + 1 };
  }
}
