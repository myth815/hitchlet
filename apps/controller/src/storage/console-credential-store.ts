import { createHash } from "node:crypto";
import { z } from "zod";
import type { Storage } from "./index.js";
export const CONSOLE_CREDENTIAL_SCOPE = "tickets.console.credentials.intent";
const IntentSchema = z
  .object({
    version: z.literal(1),
    allocationId: z.string(),
    generation: z.number().int().positive(),
    nonce: z.string().uuid(),
    secretRef: z
      .string()
      .regex(/^secret:[a-f0-9]{32}$/)
      .nullable(),
    state: z.enum([
      "reserved",
      "prepared",
      "unknown",
      "applied",
      "destroying",
      "destroyed",
    ]),
  })
  .strict()
  .refine((v) => (v.state === "destroyed") === (v.secretRef === null));
export type ConsoleCredentialIntent = z.infer<typeof IntentSchema>;
export class ConsoleCredentialStore {
  constructor(private readonly db: Storage) {}
  async get(owner: string, ticket: string, generation: number) {
    const row = await this.db.get<{ safe_response_json: string | null }>(
      `SELECT safe_response_json FROM idempotency_keys WHERE consumer_id=? AND route_scope=? AND idempotency_key=?`,
      [owner, CONSOLE_CREDENTIAL_SCOPE, `${ticket}:${generation}`],
    );
    return row
      ? IntentSchema.parse(JSON.parse(row.safe_response_json!))
      : undefined;
  }
  async reserve(
    owner: string,
    ticket: string,
    value: ConsoleCredentialIntent,
    now: number,
  ) {
    await this.db.run(
      `INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,safe_response_json,created_at_ms,retain_until_ms)
 SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tickets t JOIN leases l ON l.ticket_id=t.id JOIN allocations a ON a.id=l.allocation_id
 WHERE t.id=? AND t.consumer_id=? AND t.phase='ready' AND l.state='active' AND l.claimed_at_ms IS NOT NULL AND l.expires_at_ms>?
 AND a.id=? AND a.generation=? AND l.generation=a.generation AND a.desired_state='present' AND a.observed_state='running')
 ON CONFLICT(consumer_id,route_scope,idempotency_key) DO NOTHING`,
      [
        owner,
        CONSOLE_CREDENTIAL_SCOPE,
        `${ticket}:${value.generation}`,
        createHash("sha256")
          .update(
            JSON.stringify({
              allocationId: value.allocationId,
              generation: value.generation,
            }),
          )
          .digest("hex"),
        ticket,
        JSON.stringify(IntentSchema.parse(value)),
        now,
        now + 180 * 86400000,
        ticket,
        owner,
        now,
        value.allocationId,
        value.generation,
      ],
    );
    const result = await this.get(owner, ticket, value.generation);
    if (!result)
      throw Error("Console credential lease changed before reservation");
    return result;
  }
  async update(
    owner: string,
    ticket: string,
    before: ConsoleCredentialIntent,
    after: ConsoleCredentialIntent,
  ) {
    const result = await this.db.run(
      `UPDATE idempotency_keys SET safe_response_json=? WHERE consumer_id=? AND route_scope=? AND idempotency_key=? AND safe_response_json=?`,
      [
        JSON.stringify(IntentSchema.parse(after)),
        owner,
        CONSOLE_CREDENTIAL_SCOPE,
        `${ticket}:${before.generation}`,
        JSON.stringify(before),
      ],
    );
    if (Number(result.changes) !== 1)
      throw Error("Console credential intent changed");
    return after;
  }
  async cleaned(
    owner: string,
    ticket: string,
    intent: ConsoleCredentialIntent,
  ) {
    return !!(await this.db.get(
      `SELECT 1 FROM tickets t JOIN allocations a ON a.ticket_id=t.id WHERE t.id=? AND t.consumer_id=? AND a.id=? AND a.generation=?
 AND t.phase='released' AND t.cleanup_status='complete' AND a.cleanup_status='complete' AND a.desired_state='absent' AND a.observed_state='absent'
 AND NOT EXISTS(SELECT 1 FROM managed_resources r WHERE r.allocation_id=a.id AND r.ownership='owned' AND r.observed_state<>'absent')
 AND NOT EXISTS(SELECT 1 FROM capacity_claims c WHERE c.allocation_id=a.id AND c.state<>'released')`,
      [ticket, owner, intent.allocationId, intent.generation],
    ));
  }
  async pendingCleanup() {
    const rows = await this.db.all<{
      consumer_id: string;
      ticket_id: string;
      safe_response_json: string;
    }>(
      `SELECT i.consumer_id,i.ticket_id,i.safe_response_json FROM idempotency_keys i JOIN tickets t ON t.id=i.ticket_id WHERE i.route_scope=? AND t.phase='released' AND json_extract(i.safe_response_json,'$.state')<>'destroyed' LIMIT 100`,
      [CONSOLE_CREDENTIAL_SCOPE],
    );
    return rows.map((row) => ({
      consumer_id: row.consumer_id,
      ticket_id: row.ticket_id,
      intent: IntentSchema.parse(JSON.parse(row.safe_response_json)),
    }));
  }
}
