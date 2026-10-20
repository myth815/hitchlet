import { createHash, randomUUID } from "node:crypto";
import type {
  ProfileGrantRevokeRequest,
  RevocationImpact,
  ProfileGrantRevocation,
} from "@hitchlet/contracts/admin";
import { ApplicationError } from "../application/errors.js";
import { StorageError, type Storage } from "./index.js";
import type { Statement } from "./protocol.js";
import type { Row } from "./admin-store-utils.js";
import { SQLiteTicketStore } from "./ticket-store.js";
import { SQLiteValidationStore } from "./validation-store.js";

/** The immutable grant is the fence. Existing termination builders retain ownership and capacity until verified cleanup. */
export class SQLiteProfileRevocationStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}

  async revisions(kind: "network" | "storage", profileId: string) {
    const rows = await this.db.all<Row>(
      `SELECT r.id,r.profile_id,r.revision,p.current_revision_id,rev.created_at_ms AS revoked_at FROM ${kind}_profile_revisions r JOIN ${kind}_profiles p ON p.id=r.profile_id LEFT JOIN profile_grant_revocations rev ON rev.${kind}_profile_revision_id=r.id WHERE p.id=? ORDER BY r.revision DESC`,
      [profileId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      profileId: String(r.profile_id),
      revision: Number(r.revision),
      isCurrent: r.id === r.current_revision_id,
      revokedAt:
        r.revoked_at === null
          ? null
          : new Date(Number(r.revoked_at)).toISOString(),
    }));
  }

  private selections(input: ProfileGrantRevokeRequest) {
    const revision = input.profileRevisionId;
    const ticketMatch =
      input.profileKind === "network"
        ? "t.network_profile_revision_id=?"
        : "EXISTS(SELECT 1 FROM ticket_storage_grants g WHERE g.ticket_id=t.id AND g.storage_profile_revision_id=?)";
    const validationMatch =
      input.profileKind === "network"
        ? "json_extract(v.accepted_contract_json,'$.networkRevisionId')=?"
        : "EXISTS(SELECT 1 FROM json_each(v.accepted_contract_json,'$.storageBindings') b WHERE json_extract(b.value,'$.storageProfileRevisionId')=?)";
    // Unresolved infrastructure cannot establish independence from a revision. VM dependency teardown is deliberately unsupported in M2.
    const infrastructureMatch =
      input.profileKind === "network"
        ? "c.network_profile_revision_id=?"
        : "EXISTS(SELECT 1 FROM json_each(c.storage_bindings_json) b WHERE COALESCE(json_extract(b.value,'$.storageProfileRevisionId'),json_extract(b.value,'$.revisionId'))=?)";
    return {
      revision,
      tickets: `SELECT t.id,t.consumer_id,t.phase,t.version,a.generation,a.control_version FROM tickets t LEFT JOIN allocations a ON a.ticket_id=t.id WHERE t.phase<>'released' AND ${ticketMatch} ORDER BY t.id`,
      validations: `SELECT v.id,v.version,v.state,a.generation,a.control_version FROM image_validations v LEFT JOIN allocations a ON a.image_validation_id=v.id WHERE v.state IN ('queued','running','releasing') AND ${validationMatch} ORDER BY v.id`,
      unsupported: `SELECT t.id FROM tickets t WHERE t.phase<>'released' AND ${ticketMatch} AND json_extract(t.request_json,'$.kind')='vm' UNION ALL SELECT v.id FROM image_validations v WHERE v.state IN ('queued','running','releasing') AND ${validationMatch} AND json_extract(v.accepted_contract_json,'$.environmentKind')<>'container'`,
      infrastructure: `SELECT a.id FROM allocations a LEFT JOIN resolved_provision_contracts c ON c.id=a.resolved_provision_contract_id WHERE a.purpose='infrastructure' AND a.cleanup_status<>'complete' AND (c.id IS NULL OR ${infrastructureMatch}) ORDER BY a.id`,
    };
  }

  private async snapshot(input: ProfileGrantRevokeRequest) {
    const query = this.selections(input);
    const profile = await this.db.get<Row>(
      `SELECT p.id,p.version,rev.id AS revocation_id FROM ${input.profileKind}_profiles p JOIN ${input.profileKind}_profile_revisions r ON r.profile_id=p.id LEFT JOIN profile_grant_revocations rev ON rev.${input.profileKind}_profile_revision_id=r.id WHERE r.id=?`,
      [query.revision],
    );
    if (!profile) throw new ApplicationError("not_found");
    if (Number(profile.version) !== input.expectedProfileVersion)
      throw new StorageError("STORAGE_CAS_FAILED", "Profile version conflict");
    if (profile.revocation_id !== null)
      throw new ApplicationError("profile_grant_revoked");
    const tickets = await this.db.all<Row>(query.tickets, [query.revision]);
    const validations = await this.db.all<Row>(query.validations, [
      query.revision,
    ]);
    const infrastructure = await this.db.all<Row>(query.infrastructure, [
      query.revision,
    ]);
    const unsupported = await this.db.all<Row>(query.unsupported, [
      query.revision,
      query.revision,
    ]);
    const impact: RevocationImpact = {
      affectedTicketIds: tickets.map((r) => String(r.id)),
      affectedValidationIds: validations.map((r) => String(r.id)),
      affectedInfrastructureAllocationIds: infrastructure.map((r) =>
        String(r.id),
      ),
      canRevoke: infrastructure.length === 0 && unsupported.length === 0,
      disabledReasons: [
        ...(infrastructure.length
          ? ["infrastructure_revocation_unsupported" as const]
          : []),
        ...(unsupported.length ? ["vm_revocation_unsupported" as const] : []),
      ],
    };
    return { query, profile, tickets, validations, impact };
  }

  async preview(input: ProfileGrantRevokeRequest) {
    return (await this.snapshot(input)).impact;
  }

  async revoke(
    input: ProfileGrantRevokeRequest,
    actorId: string,
    requestId: string,
    journal?: { key: string; path: string },
  ) {
    const { query, profile, tickets, validations, impact } =
      await this.snapshot(input);
    if (!impact.canRevoke)
      throw new ApplicationError("execution_mode_unsupported");
    const now = this.now(),
      id = randomUUID(),
      operationId = randomUUID();
    const receipt: ProfileGrantRevocation = {
      ...impact,
      id,
      profileKind: input.profileKind,
      profileRevisionId: input.profileRevisionId,
      reason: input.reason,
      createdAt: new Date(now).toISOString(),
      createdBy: actorId,
      operationId,
    };
    // Re-enumerate in the write transaction: any added/removed reference or lifecycle change rejects the entire operation.
    const fingerprint = (sql: string, stateColumn: "phase" | "state") =>
      `SELECT json_group_array(json_object('id',id,'version',version,'state',${stateColumn},'generation',generation,'controlVersion',control_version)) AS value FROM (${sql})`;
    const ticketFingerprint = fingerprint(query.tickets, "phase"),
      validationFingerprint = fingerprint(query.validations, "state");
    const expectedFingerprint = (rows: Row[], key: "phase" | "state") =>
      JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          version: Number(r.version),
          state: r[key],
          generation: r.generation === null ? null : Number(r.generation),
          controlVersion:
            r.control_version === null ? null : Number(r.control_version),
        })),
      );
    const statements: Statement[] = [
      {
        kind: "run",
        sql: `UPDATE ${input.profileKind}_profiles SET version=version+1 WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations WHERE ${input.profileKind}_profile_revision_id=?) AND (${ticketFingerprint})=? AND (${validationFingerprint})=? AND NOT EXISTS(${query.infrastructure}) AND NOT EXISTS(${query.unsupported})`,
        params: [
          String(profile.id),
          input.expectedProfileVersion,
          query.revision,
          query.revision,
          expectedFingerprint(tickets, "phase"),
          query.revision,
          expectedFingerprint(validations, "state"),
          query.revision,
          query.revision,
          query.revision,
        ],
        expectChanges: 1,
      },
    ];
    statements.push(
      {
        kind: "run",
        sql: "INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,result_json,next_check_at_ms,created_at_ms,updated_at_ms) SELECT ?,installation_id,controller_epoch,'profile.revoke',?,?,'succeeded',?,?,?,?,?,? FROM installations WHERE singleton=1",
        params: [
          operationId,
          id,
          `profile.revoke:${id}`,
          createHash("sha256").update(JSON.stringify(input)).digest("hex"),
          JSON.stringify(input),
          JSON.stringify(receipt),
          now,
          now,
          now,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: `INSERT INTO profile_grant_revocations(id,${input.profileKind}_profile_revision_id,reason,created_by_consumer_id,operation_id,created_at_ms) VALUES(?,?,?,?,?,?)`,
        params: [id, query.revision, input.reason, actorId, operationId, now],
      },
    );
    const ticketStore = new SQLiteTicketStore(this.db);
    for (const t of tickets) {
      if (t.phase === "releasing") continue;
      const common = {
        ticketId: String(t.id),
        consumerId: String(t.consumer_id),
        version: Number(t.version),
        now,
        reason: "admin_revoke",
        audit: { actorId, requestId, reason: input.reason },
      };
      statements.push(
        ...(t.phase === "queued"
          ? ticketStore.queuedTerminationStatements(common)
          : ticketStore.allocatedTerminationStatements({
              ...common,
              phase: String(t.phase),
              generation: Number(t.generation),
              expectedGeneration: Number(t.generation),
              operationId: randomUUID(),
            })),
      );
      statements.push({
        kind: "run",
        sql: "UPDATE tickets SET scheduling_reason_json=json_object('code','PROFILE_GRANT_REVOKED','profileRevocationId',?) WHERE id=?",
        params: [id, String(t.id)],
      });
    }
    const validationStore = new SQLiteValidationStore(this.db, this.now);
    for (const v of validations)
      statements.push(
        ...(await validationStore.terminationStatements(
          String(v.id),
          "PROFILE_GRANT_REVOKED",
          now,
        )),
      );
    statements.push({
      kind: "run",
      sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'profile.grants_revoked','profile_revision',?,?,?,?)",
      params: [
        actorId,
        query.revision,
        requestId,
        now,
        JSON.stringify(receipt),
      ],
    });
    if (journal)
      statements.push({
        kind: "run",
        sql: "UPDATE idempotency_keys SET safe_response_json=?,response_status=200,operation_id=? WHERE consumer_id=? AND route_scope=? AND idempotency_key=? AND safe_response_json IS NULL",
        params: [
          JSON.stringify(receipt),
          operationId,
          actorId,
          `admin:${journal.path}`,
          journal.key,
        ],
        expectChanges: 1,
      });
    await this.db.batchTransaction(statements);
    return receipt;
  }
}
