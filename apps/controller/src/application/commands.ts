import { createHash } from "node:crypto";
import type { TicketView } from "@hitchlet/contracts";
import { SQLiteIdempotencyStore } from "../storage/idempotency-store.js";
import type { IdempotencyCompletionRef } from "../storage/termination-context.js";
import { StorageError, type Storage } from "../storage/index.js";
import { TicketQueries } from "./queries.js";
import { conflict, notFound } from "./errors.js";

/** Owner-scoped durable idempotency for commands whose target Ticket already exists. */
export class TicketCommandService {
  private readonly idempotency: SQLiteIdempotencyStore;
  constructor(
    storage: Storage,
    private readonly queries: TicketQueries,
    private readonly now = Date.now,
  ) {
    this.idempotency = new SQLiteIdempotencyStore(storage);
  }
  async idempotent(
    input: {
      consumerId: string;
      anyOwner?: boolean;
      ticketId: string;
      scope: string;
      key: string;
      body: unknown;
    },
    work: (
      ticket: TicketView,
      completion: IdempotencyCompletionRef,
    ) => Promise<void>,
  ): Promise<TicketView> {
    const current = input.anyOwner
      ? await this.queries.getAny(input.ticketId)
      : await this.queries.get(input.consumerId, input.ticketId);
    if (!current) throw notFound();
    const hash = createHash("sha256")
      .update(stable({ ticketId: input.ticketId, body: input.body }))
      .digest("hex");
    const reservation = await this.idempotency.reserve({
      consumerId: input.consumerId,
      scope: input.scope,
      key: input.key,
      hash,
      ticketId: input.ticketId,
      now: this.now(),
    });
    if (reservation.row.request_hash !== hash)
      throw conflict("idempotency_key_reused");
    // A reserved key can survive a crash before the domain command starts.
    // Only a completed reservation is a replay. Termination writes this marker
    // in the same transaction as its domain transition; unfinished reservations
    // are retried after a crash, and authorization/version failures still escape.
    if (reservation.row.safe_response_json === null || reservation.created) {
      try {
        await work(current, {
          consumerId: input.consumerId,
          routeScope: input.scope,
          key: input.key,
          requestHash: hash,
          ticketId: input.ticketId,
        });
      } catch (error) {
        if (
          !(error instanceof StorageError) ||
          error.code !== "STORAGE_CAS_FAILED"
        )
          throw error;
        // A same-key concurrent request can win the termination CAS and
        // atomically commit this exact reservation. Accept only that durable
        // evidence; authorization, request, and application conflicts escape.
        const committed = await this.idempotency.get(
          input.consumerId,
          input.scope,
          input.key,
        );
        if (
          committed?.request_hash !== hash ||
          committed.ticket_id !== input.ticketId ||
          committed.safe_response_json === null
        )
          throw error;
      }
    }
    const latest = input.anyOwner
      ? await this.queries.getAny(input.ticketId)
      : await this.queries.get(input.consumerId, input.ticketId);
    if (!latest) throw notFound();
    const status = latest.phase === "released" ? 200 : 202;
    await this.idempotency.finish({
      consumerId: input.consumerId,
      scope: input.scope,
      key: input.key,
      hash,
      status,
      ticketId: input.ticketId,
    });
    return latest;
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
