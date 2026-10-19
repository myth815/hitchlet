import { createHash, randomUUID } from "node:crypto";
import {
  AcceptedAcquireRequestSchema,
  LeaseRenewalViewSchema,
  RenewOutcomeSchema,
  type RenewOutcome,
  type LeaseRenewalView,
  type RenewRequest,
} from "@hitchlet/contracts";
import { StorageError, type Storage } from "../storage/index.js";
import { SQLiteRenewalStore } from "../storage/renewal-store.js";
import { conflict, notFound, preconditionFailed } from "./errors.js";
type Row = Record<string, string | number | bigint | null>;
const milliseconds = (value: unknown): number | null => {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
};
const iso = (value: unknown): string =>
  new Date(milliseconds(value) ?? 0).toISOString();
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Persisted JSON unavailable");
  return JSON.parse(value) as unknown;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Fixed accepted lease bounds; controller confirmation never implies offline enforcement. */
export class LeaseService {
  private readonly store: SQLiteRenewalStore;
  constructor(
    storage: Storage,
    private readonly now = Date.now,
    private readonly id = randomUUID,
  ) {
    this.store = new SQLiteRenewalStore(storage);
  }

  async renew(
    consumerId: string,
    ticketId: string,
    key: string,
    request: RenewRequest,
  ): Promise<RenewOutcome> {
    const requestHash = createHash("sha256")
      .update(stable({ ticketId, request }))
      .digest("hex");
    const prior = await this.store.idempotency(consumerId, key);
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw conflict("idempotency_key_reused");
      if (typeof prior.renewal_id !== "string")
        throw new Error("Renewal idempotency record is incomplete");
      return this.outcome(ticketId, consumerId, prior.renewal_id);
    }
    const row = await this.store.context(ticketId, consumerId);
    if (!row) throw notFound();
    if (row.phase !== "ready" || row.lease_state !== "active")
      throw conflict("lease_not_renewable");
    if (
      row.network_revoked === 1 ||
      row.network_revoked === 1n ||
      row.storage_revoked === 1 ||
      row.storage_revoked === 1n
    )
      throw conflict("profile_grant_revoked");
    if (
      row.execution_mode !== "simulator" &&
      row.execution_mode !== "portainer"
    )
      throw conflict("execution_mode_unsupported");
    if (Number(row.generation) !== request.generation)
      throw preconditionFailed("generation_conflict");
    if (Number(row.lease_version) !== request.expectedLeaseVersion)
      throw preconditionFailed("lease_version_conflict");
    const now = this.now();
    const expiry = milliseconds(row.expires_at_ms);
    const renewUntil = milliseconds(row.renew_until_ms);
    const claimBy = milliseconds(row.claim_by_ms);
    const claimedAtMs = milliseconds(row.claimed_at_ms);
    if (
      expiry === null ||
      expiry <= now ||
      renewUntil === null ||
      renewUntil <= now
    )
      throw conflict("lease_expired");
    const accepted = AcceptedAcquireRequestSchema.parse(
      parseJson(row.request_json),
    );
    const requestedTtl =
      request.requestedTtlSec ?? accepted.lease.requestedSeconds;
    if (requestedTtl > accepted.lease.maximumTtlSeconds)
      throw new RangeError("requestedTtlSec exceeds the accepted maximum TTL");
    const initial = claimedAtMs === null;
    if (initial && (claimBy === null || claimBy <= now))
      throw conflict("claim_deadline_expired");
    const proposedExpiresAt = Math.min(now + requestedTtl * 1000, renewUntil);
    if (proposedExpiresAt <= now) throw conflict("lease_lifetime_exhausted");
    const decisionDeadline = Math.min(
      expiry,
      now + 10_000,
      ...(initial && claimBy !== null ? [claimBy] : []),
    );
    if (now >= decisionDeadline) throw conflict("renewal_deadline_expired");
    const renewalId = this.id();
    const operationId = this.id();
    try {
      await this.store.createPending({
        ticketId,
        consumerId,
        key,
        requestHash,
        renewalId,
        operationId,
        generation: request.generation,
        expectedVersion: request.expectedLeaseVersion,
        proposedExpiresAt,
        decisionDeadline,
        initial,
        executionMode: row.execution_mode,
        now,
      });
    } catch (error) {
      if (
        error instanceof StorageError &&
        (error.code === "STORAGE_CAS_FAILED" ||
          error.code === "STORAGE_CONSTRAINT")
      ) {
        // A concurrent same-key request may have committed the proposal
        // between our initial idempotency lookup and transaction.
        const winner = await this.store.idempotency(consumerId, key);
        if (winner) {
          if (winner.request_hash !== requestHash)
            throw conflict("idempotency_key_reused");
          if (typeof winner.renewal_id !== "string")
            throw new Error("Renewal idempotency record is incomplete");
          return this.outcome(ticketId, consumerId, winner.renewal_id);
        }
        // A distinct key racing the same Lease should consistently see the
        // extant proposal before stale-version classification.
        if (await this.store.pendingForTicket(ticketId, consumerId))
          throw conflict("renewal_in_progress");
        if (error.code === "STORAGE_CAS_FAILED")
          throw preconditionFailed("lease_version_conflict");
      }
      throw error;
    }
    return this.outcome(ticketId, consumerId, renewalId);
  }

  /** Controller lease decision loop; it never fabricates an offline guard ACK. */
  async reconcilePending(): Promise<number> {
    const rows = await this.store.pendingRows(this.now());
    let decided = 0;
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.ticket_id !== "string" ||
        typeof row.consumer_id !== "string"
      )
        continue;
      const now = this.now();
      const deadline = milliseconds(row.decision_deadline_ms);
      const expires = milliseconds(row.expires_at_ms);
      const proposed = milliseconds(row.proposed_expires_at_ms);
      const claimBy = milliseconds(row.claim_by_ms);
      const invalid =
        row.phase !== "ready" ||
        row.lease_state !== "active" ||
        (row.execution_mode !== "simulator" &&
          row.execution_mode !== "portainer") ||
        Number(row.lease_version) !== Number(row.expected_version) ||
        row.network_revoked === 1 ||
        row.network_revoked === 1n ||
        row.storage_revoked === 1 ||
        row.storage_revoked === 1n ||
        deadline === null ||
        deadline <= now ||
        expires === null ||
        expires <= now ||
        proposed === null ||
        proposed <= now ||
        (Number(row.is_initial_claim) === 1 &&
          (claimBy === null || claimBy <= now));
      if (invalid) {
        if (deadline !== null && deadline <= now) {
          await this.store.rejectExpiredAndTerminate({
            renewalId: row.id,
            cleanupId: this.id(),
            now,
          });
        } else {
          await this.store.decidePending({
            renewalId: row.id,
            now,
            claimedAt: now,
            receiptJson: "{}",
            rejectCode: "lease_or_authorization_changed",
          });
        }
        decided++;
        continue;
      }
      const receipt = {
        renewalId: row.id,
        ticketId: row.ticket_id,
        generation: Number(row.generation),
        leaseId: String(row.lease_id),
        leaseVersion: Number(row.proposed_version),
        claimedAt: new Date(
          milliseconds(row.claimed_at_ms) ?? now,
        ).toISOString(),
        expiresAt: new Date(proposed!).toISOString(),
        renewUntil: iso(row.renew_until_ms),
        offlineEnforcement: "not_guaranteed" as const,
        guardAcknowledgementId: null,
      };
      try {
        await this.store.decidePending({
          renewalId: row.id,
          now,
          claimedAt: milliseconds(row.claimed_at_ms) ?? now,
          receiptJson: JSON.stringify(receipt),
        });
        decided++;
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "STORAGE_CAS_FAILED"
          )
        )
          throw error;
      }
    }
    return decided;
  }

  async get(
    consumerId: string,
    ticketId: string,
    renewalId: string,
  ): Promise<LeaseRenewalView | null> {
    const row = await this.store.renewal(ticketId, consumerId, renewalId);
    if (!row) return null;
    const state = String(row.state) as LeaseRenewalView["state"];
    const rejection = row.rejection_json ? parseJson(row.rejection_json) : null;
    const receipt = row.confirmed_receipt_json
      ? parseJson(row.confirmed_receipt_json)
      : null;
    return LeaseRenewalViewSchema.parse({
      id: row.id,
      leaseId: row.lease_id,
      proposedVersion: Number(row.proposed_version),
      proposedExpiresAt: iso(row.proposed_expires_at_ms),
      isInitialClaim: Number(row.is_initial_claim) === 1,
      decisionDeadline: iso(row.decision_deadline_ms),
      createdAt: iso(row.created_at_ms),
      updatedAt: iso(row.updated_at_ms),
      state,
      reasonCode:
        state === "rejected" || state === "cancelled"
          ? isRecord(rejection) && typeof rejection.code === "string"
            ? rejection.code
            : "renewal_rejected"
          : null,
      confirmedReceipt: state === "confirmed" ? receipt : null,
    });
  }
  private async outcome(
    ticketId: string,
    consumerId: string,
    renewalId: string,
  ): Promise<RenewOutcome> {
    const view = await this.get(consumerId, ticketId, renewalId);
    if (!view) throw new Error("Renewal is unavailable");
    if (view.state === "confirmed" && view.confirmedReceipt)
      return RenewOutcomeSchema.parse({
        outcome: "confirmed",
        renewalId,
        receipt: view.confirmedReceipt,
      });
    if (view.state === "pending") {
      const row = await this.store.context(ticketId, consumerId);
      return RenewOutcomeSchema.parse({
        outcome: "pending",
        renewal: view,
        location: `/v1/tickets/${ticketId}/renewals/${renewalId}`,
        lastConfirmedExpiresAt: iso(row?.expires_at_ms ?? null),
      });
    }
    return RenewOutcomeSchema.parse({
      outcome: "rejected",
      renewal: view,
      reasonCode: view.reasonCode ?? "renewal_rejected",
    });
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
