import {
  AcceptedAcquireRequestSchema,
  AccessGrantSchema,
} from "@hitchlet/contracts";
import type { Storage } from "../storage/index.js";
import { SQLiteReadStore } from "../storage/read-store.js";
import { createHash } from "node:crypto";
import { SQLiteIdempotencyStore } from "../storage/idempotency-store.js";
import { conflict, notFound } from "./errors.js";
type Row = Record<string, string | number | bigint | null>;
/** Simulator-only public endpoint; never resolves management URLs or secret references. */
export class AccessService {
  private readonly store: SQLiteReadStore;
  private readonly idempotency: SQLiteIdempotencyStore;
  constructor(
    storage: Storage,
    private readonly now = Date.now,
  ) {
    this.store = new SQLiteReadStore(storage);
    this.idempotency = new SQLiteIdempotencyStore(storage);
  }
  async get(
    consumerId: string,
    ticketId: string,
    key: string,
    generation: number,
  ) {
    const hash = createHash("sha256")
      .update(JSON.stringify({ ticketId, generation }))
      .digest("hex");
    const reservation = await this.idempotency.reserve({
      consumerId,
      scope: "tickets.access",
      key,
      hash,
      ticketId,
      now: this.now(),
    });
    if (reservation.row.request_hash !== hash)
      throw conflict("idempotency_key_reused");
    const row = await this.store.accessContext(ticketId, consumerId);
    if (!row) throw notFound();
    const expires =
      typeof row.expires_at_ms === "bigint"
        ? Number(row.expires_at_ms)
        : Number(row.expires_at_ms);
    if (row.execution_mode !== "simulator")
      throw conflict("execution_mode_unsupported");
    if (
      row.network_revoked === 1 ||
      row.network_revoked === 1n ||
      row.storage_revoked === 1 ||
      row.storage_revoked === 1n
    )
      throw conflict("profile_grant_revoked");
    if (
      row.phase !== "ready" ||
      row.lease_state !== "active" ||
      row.desired_state !== "present" ||
      row.claimed_at_ms === null ||
      Number(row.generation) !== generation ||
      !Number.isSafeInteger(expires) ||
      expires <= this.now()
    )
      throw conflict("lease_not_accessible");
    const request = AcceptedAcquireRequestSchema.parse(
      parseJson(row.request_json),
    );
    const protocol = request.access.protocol;
    const grant = AccessGrantSchema.parse({
      ticketId,
      leaseId: row.lease_id,
      leaseVersion: Number(row.lease_version),
      generation,
      access: {
        protocol,
        host: "simulator.invalid",
        port: protocol === "ssh" ? 22 : 3389,
        username: "simulator",
        hostKeyFingerprint: protocol === "ssh" ? "SIMULATOR_ONLY" : null,
        expiresAt: new Date(expires).toISOString(),
      },
      authentication: {
        kind: "ephemeral_password",
        password: "SIMULATOR_ONLY_NO_NETWORK_ENDPOINT",
      },
    });
    await this.idempotency.finish({
      consumerId,
      scope: "tickets.access",
      key,
      hash,
      status: 200,
      ticketId,
    });
    return grant;
  }
}
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Ticket contract unavailable");
  return JSON.parse(value) as unknown;
}
