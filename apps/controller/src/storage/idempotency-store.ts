import type { Storage } from "./index.js";
type Row = Record<string, string | number | bigint | null>;
export class SQLiteIdempotencyStore {
  constructor(private readonly db: Storage) {}
  get(
    consumerId: string,
    scope: string,
    key: string,
  ): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT request_hash,ticket_id,safe_response_json FROM idempotency_keys WHERE consumer_id=? AND route_scope=? AND idempotency_key=?",
      [consumerId, scope, key],
    );
  }
  async reserve(input: {
    consumerId: string;
    scope: string;
    key: string;
    hash: string;
    ticketId: string;
    now: number;
  }): Promise<{ created: boolean; row: Row }> {
    const result = await this.db.run(
      `INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,created_at_ms,retain_until_ms)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(consumer_id,route_scope,idempotency_key) DO NOTHING`,
      [
        input.consumerId,
        input.scope,
        input.key,
        input.hash,
        input.ticketId,
        input.now,
        input.now + 180 * 86400000,
      ],
    );
    const row = await this.db.get<Row>(
      "SELECT request_hash,ticket_id,safe_response_json FROM idempotency_keys WHERE consumer_id=? AND route_scope=? AND idempotency_key=?",
      [input.consumerId, input.scope, input.key],
    );
    if (!row) throw new Error("Idempotency record unavailable");
    return { created: result.changes === 1n, row };
  }
  finish(input: {
    consumerId: string;
    scope: string;
    key: string;
    hash: string;
    status: number;
    ticketId: string;
  }): Promise<unknown> {
    return this.db.run(
      "UPDATE idempotency_keys SET response_status=?,safe_response_json=? WHERE consumer_id=? AND route_scope=? AND idempotency_key=? AND request_hash=? AND ticket_id=?",
      [
        input.status,
        JSON.stringify({ ticketId: input.ticketId }),
        input.consumerId,
        input.scope,
        input.key,
        input.hash,
        input.ticketId,
      ],
    );
  }
  remove(
    consumerId: string,
    scope: string,
    key: string,
    hash: string,
  ): Promise<unknown> {
    return this.db.run(
      "DELETE FROM idempotency_keys WHERE consumer_id=? AND route_scope=? AND idempotency_key=? AND request_hash=? AND safe_response_json IS NULL",
      [consumerId, scope, key, hash],
    );
  }
}
