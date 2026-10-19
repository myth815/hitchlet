import {
  TicketSummaryPageSchema,
  TicketViewSchema,
  type TicketSummary,
  type TicketView,
} from "@hitchlet/contracts";
import type { Storage } from "../storage/index.js";
import { SQLiteReadStore, type ReadRow } from "../storage/read-store.js";

type Row = ReadRow;
const iso = (value: unknown): string | null => {
  const n = integer(value);
  return n === null ? null : new Date(n).toISOString();
};
function integer(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number)
    ? number
    : null;
}
function json(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
function cursorEncode(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}
function cursorDecode(
  value: string | undefined,
): { createdAt: number; id: string } | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (typeof decoded !== "object" || decoded === null) return null;
    const r = decoded as Record<string, unknown>;
    return Number.isSafeInteger(r.createdAt) && typeof r.id === "string"
      ? { createdAt: r.createdAt as number, id: r.id }
      : null;
  } catch {
    return null;
  }
}

/** Read-only, explicit public projections. Internal rows and secrets never escape this module. */
export class TicketQueries {
  private readonly store: SQLiteReadStore;
  constructor(
    storage: Storage,
    private readonly now = Date.now,
  ) {
    this.store = new SQLiteReadStore(storage);
  }

  async list(
    consumerId: string,
    query: {
      cursor?: string | undefined;
      limit?: number | undefined;
      phase?: string | undefined;
    },
  ) {
    const cursor = cursorDecode(query.cursor);
    if (query.cursor && !cursor) throw new RangeError("Invalid page cursor");
    const limit = query.limit ?? 50;
    const rows = await this.store.ticketPage(
      consumerId,
      query.phase ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? "",
      limit + 1,
    );
    const items = rows.slice(0, limit).map(summary);
    const last = rows.length > limit ? items.at(-1) : undefined;
    const nextCursor = last
      ? cursorEncode(Date.parse(last.createdAt), last.id)
      : null;
    return TicketSummaryPageSchema.parse({ items, nextCursor });
  }

  async get(consumerId: string, ticketId: string): Promise<TicketView | null> {
    return this.project(await this.store.ticketDetail(ticketId, consumerId));
  }
  async getAny(ticketId: string): Promise<TicketView | null> {
    return this.project(await this.store.ticketDetail(ticketId));
  }
  private async project(row: Row | undefined): Promise<TicketView | null> {
    if (!row) return null;
    const summaryView = summary(row);
    const accepted = json(row.request_json);
    if (!accepted || typeof accepted !== "object")
      throw new Error("Ticket contract unavailable");
    const grants = await this.store.ticketGrants(String(row.id));
    const lease =
      row.lease_id === null
        ? null
        : {
            id: row.lease_id,
            generation: integer(row.lease_generation),
            version: integer(row.lease_version),
            state: row.lease_state,
            claimBy: iso(row.claim_by_ms),
            claimedAt: iso(row.claimed_at_ms),
            expiresAt: iso(row.expires_at_ms),
            renewUntil: iso(row.renew_until_ms),
            revokedAt: iso(row.revoked_at_ms),
          };
    const placement =
      row.machine_id === null
        ? null
        : {
            machineId: row.machine_id,
            nodeId: row.node_id,
            provider: row.backend_kind,
            architecture: row.architecture,
            imageArtifactId: row.image_artifact_id,
          };
    const pending =
      row.renewal_id === null
        ? null
        : {
            renewalId: row.renewal_id,
            proposedLeaseVersion: integer(row.renewal_version),
            proposedExpiresAt: iso(row.renewal_expires),
            lastConfirmedExpiresAt: iso(row.expires_at_ms),
            decisionDeadline: iso(row.renewal_deadline),
          };
    const reason = json(row.scheduling_reason_json);
    return TicketViewSchema.parse({
      ...summaryView,
      acceptedRequest: accepted,
      pinnedProfileRevisions: {
        networkProfileRevisionId: row.network_profile_revision_id,
        storageProfileRevisionIds: grants.map(
          (grant) => grant.storage_profile_revision_id,
        ),
      },
      queueDeadline: iso(row.queue_deadline_ms),
      provisioningDeadline: iso(row.provision_deadline_ms),
      lease,
      placement,
      health: health(
        row.phase,
        row.observed_health,
        row.observed_at_ms,
        this.now(),
      ),
      scheduling: {
        checkedAt: iso(row.updated_at_ms),
        reasonCodes:
          isRecord(reason) && typeof reason.code === "string"
            ? [reason.code]
            : [],
        matchingNodeCount: 0,
        nextCheckAt: null,
      },
      renewalPending: pending,
      cleanupBlockedResources: cleanupBlockers(row.cleanup_blockers),
    });
  }

  async images(consumerId: string, afterId: string | null, limit: number) {
    const scope = await this.store.consumerImageScope(consumerId);
    const authorization = isRecord(json(scope?.authorization_json))
      ? (json(scope?.authorization_json) as Record<string, unknown>)
      : {};
    const imageIds =
      authorization.imageIds === "all"
        ? "all"
        : Array.isArray(authorization.imageIds) &&
            authorization.imageIds.every((id) => typeof id === "string")
          ? (authorization.imageIds as string[])
          : [];
    return this.store.images(consumerId, imageIds, afterId, limit);
  }
  async imageVersion(consumerId: string, versionId: string) {
    const scope = await this.store.consumerImageScope(consumerId);
    const authorization = isRecord(json(scope?.authorization_json))
      ? (json(scope?.authorization_json) as Record<string, unknown>)
      : {};
    const imageIds =
      authorization.imageIds === "all"
        ? "all"
        : Array.isArray(authorization.imageIds) &&
            authorization.imageIds.every((id) => typeof id === "string")
          ? (authorization.imageIds as string[])
          : [];
    const version = await this.store.imageVersion(
      versionId,
      consumerId,
      imageIds,
    );
    if (!version) return null;
    return { version, artifacts: await this.store.imageArtifacts(versionId) };
  }
  events(
    consumerId: string,
    after: bigint,
    ticketId: string | null,
    limit: number,
  ) {
    return this.store.events(consumerId, after, ticketId, limit);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function health(phase: unknown, observed: unknown, at: unknown, now: number) {
  if (phase === "provisioning")
    return {
      state: "preparing" as const,
      observedAt: iso(at),
      reasonCodes: [],
    };
  const observedAt = iso(at);
  const timestamp = integer(at);
  if (
    phase !== "ready" ||
    timestamp === null ||
    timestamp > now ||
    now - timestamp > 30_000
  )
    return {
      state: "unknown" as const,
      observedAt,
      reasonCodes: [
        timestamp !== null && now - timestamp > 30_000
          ? "observation_stale"
          : "observation_unavailable",
      ],
    };
  const state =
    observed === "healthy" || observed === "degraded" || observed === "lost"
      ? observed
      : "unknown";
  return {
    state,
    observedAt,
    reasonCodes: state === "healthy" ? [] : [`node_${state}`],
  };
}
function cleanupBlockers(value: unknown) {
  const rows = json(value);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((item) =>
    isRecord(item) &&
    typeof item.managedResourceId === "string" &&
    typeof item.kind === "string"
      ? [
          {
            managedResourceId: item.managedResourceId,
            kind: item.kind,
            reasonCodes: ["cleanup_blocked"],
            retainUntil: iso(item.retainUntilMs),
            nextCheckAt: null,
          },
        ]
      : [],
  );
}
function summary(row: Row): TicketSummary {
  return {
    id: String(row.id),
    consumerId: String(row.consumer_id),
    phase: String(row.phase) as TicketSummary["phase"],
    version: integer(row.version) ?? 1,
    pinnedImageVersionId: String(row.image_version_id),
    terminalReason: row.terminal_reason as TicketSummary["terminalReason"],
    cleanupStatus: String(row.cleanup_status) as TicketSummary["cleanupStatus"],
    createdAt: iso(row.created_at_ms)!,
    updatedAt: iso(row.updated_at_ms)!,
    readyAt: iso(row.ready_at_ms),
    releasedAt: iso(row.released_at_ms),
  };
}
