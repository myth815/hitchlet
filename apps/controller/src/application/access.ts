import {
  AcceptedAcquireRequestSchema,
  AccessGrantSchema,
} from "@hitchlet/contracts";
import type { Storage } from "../storage/index.js";
import { SQLiteReadStore } from "../storage/read-store.js";
import { createHash } from "node:crypto";
import { SQLiteIdempotencyStore } from "../storage/idempotency-store.js";
import { conflict, notFound } from "./errors.js";
import type { LocalSecretStore } from "../storage/secret-store.js";
type Row = Record<string, string | number | bigint | null>;
/** Owner-scoped access grant; Portainer private material is resolved only from the encrypted local store. */
export class AccessService {
  private readonly store: SQLiteReadStore;
  private readonly idempotency: SQLiteIdempotencyStore;
  constructor(
    storage: Storage,
    private readonly now = Date.now,
    private readonly secrets?: LocalSecretStore,
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
    const simulator = row.execution_mode === "simulator";
    if (!simulator && row.execution_mode !== "portainer")
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
      row.observed_state !== "running" ||
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
    let access: Record<string, unknown>;
    let authentication: Record<string, unknown>;
    if (simulator) {
      access = {
        protocol,
        host: "simulator.invalid",
        port: protocol === "ssh" ? 22 : 3389,
        username: "simulator",
        hostKeyFingerprint: protocol === "ssh" ? "SIMULATOR_ONLY" : null,
        expiresAt: new Date(expires).toISOString(),
      };
      authentication = {
        kind: "ephemeral_password",
        password: "SIMULATOR_ONLY_NO_NETWORK_ENDPOINT",
      };
    } else {
      if (
        !this.secrets ||
        typeof row.access_secret_ref !== "string" ||
        typeof row.actual_resources_json !== "string"
      )
        throw conflict("access_material_unavailable");
      const actual = parseJson(row.actual_resources_json);
      const evidence =
        typeof actual === "object" && actual !== null && "receipt" in actual
          ? (actual as { receipt?: unknown }).receipt
          : undefined;
      const readyAccess =
        typeof evidence === "object" &&
        evidence !== null &&
        "access" in evidence
          ? (evidence as { access?: unknown }).access
          : undefined;
      if (!readyAccess || typeof readyAccess !== "object")
        throw conflict("access_material_unavailable");
      const endpoint = readyAccess as Record<string, unknown>;
      const privateKey = await this.secrets.get(row.access_secret_ref);
      access = {
        protocol,
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.username,
        hostKeyFingerprint: endpoint.hostKeyFingerprint,
        expiresAt: new Date(expires).toISOString(),
      };
      authentication = { kind: "ephemeral_private_key", privateKey };
    }
    const grant = AccessGrantSchema.parse({
      ticketId,
      leaseId: row.lease_id,
      leaseVersion: Number(row.lease_version),
      generation,
      access,
      authentication,
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
