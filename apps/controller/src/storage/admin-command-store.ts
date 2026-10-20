import { createHash } from "node:crypto";
import type { Storage } from "./index.js";
import { ApplicationError } from "../application/errors.js";
import type { AdminCommandReview } from "@hitchlet/contracts/admin";
import { canonicalJson } from "./admin-store-utils.js";
type Row = Record<string, string | number | bigint | null>;
const receiptProjection =
  "i.idempotency_key,i.route_scope,i.response_status,i.safe_response_json IS NULL AS unknown,i.created_at_ms,(SELECT max(a.occurred_at_ms) FROM audit_entries a WHERE a.actor_id=i.consumer_id AND a.action='management.command.reviewed' AND a.target_id=i.idempotency_key AND json_extract(a.safe_details_json,'$.path')=substr(i.route_scope,7)) AS reviewed_at_ms";
const receipt = (r: Row) => ({
  key: String(r.idempotency_key),
  path: String(r.route_scope).slice(6),
  state: Number(r.unknown) === 1 ? "unknown" : "completed",
  status: r.response_status === null ? null : Number(r.response_status),
  createdAtMs: Number(r.created_at_ms),
  reviewedAtMs: r.reviewed_at_ms === null ? null : Number(r.reviewed_at_ms),
});
/** Optional journal for management clients using Idempotency-Key. A crash before completion remains unknown and can never execute twice. */
export class SQLiteAdminCommandStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async prepare(consumerId: string, key: string, path: string, body: unknown) {
    if (!key || key.length > 200)
      throw new RangeError("Invalid Idempotency-Key");
    const hash = createHash("sha256")
        .update(canonicalJson({ path, body }))
        .digest("hex"),
      scope = `admin:${path}`;
    const result = await this.db.run(
      "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,created_at_ms,retain_until_ms) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      [consumerId, scope, key, hash, this.now(), this.now() + 180 * 86400000],
    );
    const row = await this.db.get<Row>(
      "SELECT request_hash,safe_response_json,response_status FROM idempotency_keys WHERE consumer_id=? AND route_scope=? AND idempotency_key=?",
      [consumerId, scope, key],
    );
    if (row?.request_hash !== hash) throw new ApplicationError("conflict");
    if (result.changes === 1n) return { fresh: true as const };
    if (row.safe_response_json === null)
      throw new ApplicationError("management_result_unknown");
    return {
      fresh: false as const,
      status: Number(row.response_status),
      body: JSON.parse(String(row.safe_response_json)) as unknown,
    };
  }
  complete(
    consumerId: string,
    key: string,
    path: string,
    status: number,
    body: unknown,
  ) {
    // A server/storage failure cannot certify absence of effects. Leave it unknown.
    if (status >= 500) return Promise.resolve();
    return this.db.run(
      "UPDATE idempotency_keys SET safe_response_json=?,response_status=? WHERE consumer_id=? AND route_scope=? AND idempotency_key=? AND safe_response_json IS NULL",
      [JSON.stringify(body), status, consumerId, `admin:${path}`, key],
    );
  }
  async receipts(consumerId: string) {
    const rows = await this.db.all<Row>(
      `SELECT ${receiptProjection} FROM idempotency_keys i WHERE i.consumer_id=? AND i.route_scope LIKE 'admin:%' ORDER BY i.created_at_ms DESC LIMIT 100`,
      [consumerId],
    );
    return rows.map(receipt);
  }
  private async receipt(consumerId: string, path: string, key: string) {
    const row = await this.db.get<Row>(
      `SELECT ${receiptProjection} FROM idempotency_keys i WHERE i.consumer_id=? AND i.route_scope=? AND i.idempotency_key=?`,
      [consumerId, `admin:${path}`, key],
    );
    if (!row) throw new ApplicationError("not_found");
    return receipt(row);
  }
  async review(
    consumerId: string,
    input: AdminCommandReview,
    requestId: string,
  ) {
    const row = await this.db.get<Row>(
      "SELECT 1 FROM idempotency_keys WHERE consumer_id=? AND route_scope=? AND idempotency_key=?",
      [consumerId, `admin:${input.path}`, input.key],
    );
    if (!row) throw new ApplicationError("not_found");
    const evidence = await this.db.get<Row>(
      "SELECT 1 WHERE EXISTS(SELECT 1 FROM operations WHERE id=?) OR EXISTS(SELECT 1 FROM tickets WHERE id=?) OR EXISTS(SELECT 1 FROM provider_connections WHERE id=?) OR EXISTS(SELECT 1 FROM image_versions WHERE id=?) OR EXISTS(SELECT 1 FROM nodes WHERE id=?) OR EXISTS(SELECT 1 FROM machines WHERE id=?) OR EXISTS(SELECT 1 FROM consumers WHERE id=?) OR EXISTS(SELECT 1 FROM network_profiles WHERE id=?) OR EXISTS(SELECT 1 FROM storage_profiles WHERE id=?) OR EXISTS(SELECT 1 FROM policies WHERE id=?)",
      Array(10).fill(input.evidenceTargetId) as string[],
    );
    if (!evidence)
      throw new RangeError(
        "Investigation must reference an existing original operation or resource, never assumed absence",
      );
    await this.db.run(
      "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'management.command.reviewed','management_command',?,?,?,?)",
      [
        consumerId,
        input.key,
        requestId,
        this.now(),
        JSON.stringify({
          ...input,
          conclusion: "human_investigated; original outcome remains unchanged",
        }),
      ],
    );
    // Investigation does not resolve the unknown outcome, and is not limited to the recent-list window.
    return this.receipt(consumerId, input.path, input.key);
  }
}
