import { afterEach, describe, expect, it, vi } from "vitest";
import { HitchletClient, ComputeClientError } from "../src/index.js";
import type { PreparedTicketCommand } from "@hitchlet/contracts/public";

const ids = {
  consumer: "00000000-0000-4000-8000-000000000001",
  image: "00000000-0000-4000-8000-000000000002",
  network: "00000000-0000-4000-8000-000000000003",
  machine: "00000000-0000-4000-8000-000000000004",
  node: "00000000-0000-4000-8000-000000000005",
  ticket: "00000000-0000-4000-8000-000000000006",
  lease: "00000000-0000-4000-8000-000000000007",
  renewal: "00000000-0000-4000-8000-000000000008",
  artifact: "00000000-0000-4000-8000-000000000009",
};
const at = "2026-10-19T00:00:00.000Z";
const amounts = { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 };

function ticket(
  phase: "queued" | "ready" | "released" = "queued",
  overrides: Record<string, unknown> = {},
) {
  const lease =
    phase === "ready" || phase === "released"
      ? {
          id: ids.lease,
          generation: 1,
          version: 1,
          state: "active",
          claimBy: at,
          claimedAt: null,
          expiresAt: "2026-10-19T01:00:00.000Z",
          renewUntil: "2026-10-20T00:00:00.000Z",
          revokedAt: null,
        }
      : null;
  return {
    id: ids.ticket,
    consumerId: ids.consumer,
    phase,
    version: 1,
    pinnedImageVersionId: ids.image,
    terminalReason: phase === "released" ? "consumer_release" : null,
    cleanupStatus: phase === "released" ? "complete" : "not_needed",
    createdAt: at,
    updatedAt: at,
    readyAt: phase === "ready" || phase === "released" ? at : null,
    releasedAt: phase === "released" ? at : null,
    acceptedRequest: {
      image: { versionId: ids.image },
      resources: {
        request: amounts,
        limit: amounts,
        scratchEnforcement: "best_effort",
        isolation: "shared_kernel",
        accelerators: [],
      },
      networkProfileId: ids.network,
      kind: "container",
      allowedArchitectures: ["amd64"],
      allowedProviders: ["portainer"],
      locality: "local_only",
      siteIds: ["lab"],
      requiredLabels: {},
      requiredCapabilities: [],
      storage: [],
      access: { protocol: "ssh" },
      lease: {
        requestedSeconds: 900,
        maximumLifetimeSeconds: 86400,
        queueTimeoutSeconds: 1800,
        provisioningTimeoutSeconds: 1200,
        expiryPolicyId: ids.network,
        maximumTtlSeconds: 900,
      },
      labels: {},
    },
    pinnedProfileRevisions: {
      networkProfileRevisionId: ids.network,
      storageProfileRevisionIds: [],
    },
    queueDeadline: "2026-10-19T00:30:00.000Z",
    provisioningDeadline: null,
    lease,
    placement:
      phase === "ready" || phase === "released"
        ? {
            machineId: ids.machine,
            nodeId: ids.node,
            provider: "portainer",
            architecture: "amd64",
            imageArtifactId: ids.artifact,
          }
        : null,
    health: { state: "healthy", observedAt: at, reasonCodes: [] },
    scheduling: {
      checkedAt: at,
      reasonCodes: [],
      matchingNodeCount: 1,
      nextCheckAt: null,
    },
    renewalPending: null,
    cleanupBlockedResources: [],
    ...overrides,
  };
}
function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function acquireRequest() {
  return {
    image: { versionId: ids.image },
    resources: amounts,
    networkProfileId: ids.network,
  };
}
function pendingRenewal(state: "pending" | "confirmed" = "pending") {
  const receipt = {
    renewalId: ids.renewal,
    ticketId: ids.ticket,
    generation: 1,
    leaseId: ids.lease,
    leaseVersion: 2,
    claimedAt: at,
    expiresAt: "2026-10-19T02:00:00.000Z",
    renewUntil: "2026-10-20T00:00:00.000Z",
    offlineEnforcement: "not_guaranteed",
    guardAcknowledgementId: null,
  };
  return {
    id: ids.renewal,
    leaseId: ids.lease,
    proposedVersion: 2,
    proposedExpiresAt: "2026-10-19T02:00:00.000Z",
    isInitialClaim: true,
    decisionDeadline: "2026-10-20T00:01:00.000Z",
    createdAt: at,
    updatedAt: at,
    state,
    reasonCode: null,
    confirmedReceipt: state === "confirmed" ? receipt : null,
  };
}
const acquireReceipt = (key: string) => ({
  ticket: ticket(),
  idempotencyKey: key,
});

afterEach(() => vi.restoreAllMocks());

describe("HitchletClient consumer surface", () => {
  it("keeps health available and injects bearer or cookie/CSRF auth without putting credentials in URLs", async () => {
    const bearerFetch = vi.fn(async () =>
      response({
        status: "ok",
        stage: "D05",
        executionMode: "simulator",
        recoveryState: "ready",
      }),
    );
    const bearer = new HitchletClient("http://localhost:3000", {
      fetch: bearerFetch,
      auth: { kind: "bearer", token: "secret-token" },
    });
    await expect(bearer.health()).resolves.toMatchObject({ stage: "D05" });
    expect(bearerFetch.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    expect(String(bearerFetch.mock.calls[0]?.[0])).not.toContain(
      "secret-token",
    );
    expect(
      new Headers(bearerFetch.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer secret-token");

    const cookieFetch = vi.fn(async () => response(ticket("queued"), 202));
    const cookie = new HitchletClient("http://localhost:3000", {
      fetch: cookieFetch,
      auth: { kind: "cookie", csrfToken: "csrf-secret" },
    });
    await cookie.tickets.cancel(ids.ticket);
    const init = cookieFetch.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-secret");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(String(cookieFetch.mock.calls[0]?.[0])).not.toContain("csrf-secret");
  });

  it("awaits prepared persistence before sending and does not send when persistence fails", async () => {
    let saved = false;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(saved).toBe(true);
        return response(
          acquireReceipt(
            new Headers(init?.headers).get("Idempotency-Key") ?? "",
          ),
          202,
        );
      },
    );
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    const receipt = await client.tickets.acquire(acquireRequest(), {
      onPrepared: async (command) => {
        expect(Object.isFrozen(command)).toBe(true);
        saved = true;
      },
    });
    expect(receipt.ticket.id).toBe(ids.ticket);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const failingFetch = vi.fn();
    const failing = new HitchletClient("http://localhost", {
      fetch: failingFetch,
    });
    await expect(
      failing.tickets.acquire(acquireRequest(), {
        onPrepared: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toMatchObject({ code: "PREPARED_COMMAND_SAVE_FAILED" });
    expect(failingFetch).not.toHaveBeenCalled();
  });

  it("freezes a deep request snapshot and retries a lost write with identical key and body", async () => {
    const mutable = acquireRequest();
    const calls: Array<{ key: string | null; body: string | undefined }> = [];
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          key: new Headers(init?.headers).get("Idempotency-Key"),
          body: init?.body?.toString(),
        });
        if (calls.length === 1)
          throw new TypeError("connection reset after send");
        return response(acquireReceipt(calls[1]?.key ?? ""), 202);
      },
    );
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    const saved: PreparedTicketCommand[] = [];
    const operation = client.tickets.acquire(mutable, {
      idempotencyKey: "acquire-key",
      onPrepared: async (command) => {
        saved.push(command);
      },
    });
    mutable.resources.cpuMillis = 8000;
    await operation;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(calls[0]?.key).toBe("acquire-key");
    expect(calls[1]).toEqual(calls[0]);
    expect(JSON.parse(calls[0]?.body ?? "{}").resources.cpuMillis).toBe(1000);
    expect(saved).toHaveLength(1);
  });

  it("resumes a saved renewal in a new client without rereading the Ticket and polls only its original renewal", async () => {
    const command: PreparedTicketCommand = {
      schemaVersion: 1,
      kind: "renew",
      idempotencyKey: "renew-key",
      ticketId: ids.ticket,
      request: {
        generation: 1,
        expectedLeaseVersion: 1,
        requestedTtlSec: 3600,
      },
    };
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/renew"))
        return response(
          {
            outcome: "pending",
            renewal: pendingRenewal(),
            location: `/v1/tickets/${ids.ticket}/renewals/${ids.renewal}`,
            lastConfirmedExpiresAt: at,
          },
          202,
        );
      if (url.endsWith(`/renewals/${ids.renewal}`))
        return response(pendingRenewal("confirmed"));
      throw new Error(`Unexpected read ${url}`);
    });
    const client = new HitchletClient("http://localhost", {
      fetch: fetcher,
      now: () => Date.parse(at),
      sleep: async () => undefined,
    });
    const receipt = await client.tickets.resume(command);
    expect(receipt.renewalId).toBe(ids.renewal);
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => !url.endsWith(`/tickets/${ids.ticket}`))).toBe(
      true,
    );
  });

  it("validates resume commands, rejects unknown fields, and does not freeze the caller's saved object", async () => {
    const command: PreparedTicketCommand = {
      schemaVersion: 1,
      kind: "cancel",
      idempotencyKey: "cancel-key",
      ticketId: ids.ticket,
      request: {},
    };
    const fetcher = vi.fn(async () => response(ticket("queued"), 202));
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    await client.tickets.resume(command);
    expect(Object.isFrozen(command)).toBe(false);
    const invalid = { ...command, surprise: true };
    await expect(client.tickets.resume(invalid)).rejects.toMatchObject({
      code: "INVALID_PREPARED_COMMAND",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects same-key changed intent and a same-key command for another Ticket", async () => {
    const fetcher = vi.fn(async () => response(ticket("queued"), 202));
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    await client.tickets.cancel(
      ids.ticket,
      { reason: "done" },
      { idempotencyKey: "cancel-key" },
    );
    await expect(
      client.tickets.cancel(
        ids.ticket,
        { reason: "different" },
        { idempotencyKey: "cancel-key" },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(
      client.tickets.cancel(
        ids.consumer,
        { reason: "done" },
        { idempotencyKey: "cancel-key" },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns recovery data when the original renewal stays pending, and rejects same-key changes", async () => {
    let now = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/renew"))
        return response(
          {
            outcome: "pending",
            renewal: pendingRenewal(),
            location: "renewal",
            lastConfirmedExpiresAt: at,
          },
          202,
        );
      return response(pendingRenewal());
    });
    const client = new HitchletClient("http://localhost", {
      fetch: fetcher,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const command: PreparedTicketCommand = {
      schemaVersion: 1,
      kind: "renew",
      idempotencyKey: "same",
      ticketId: ids.ticket,
      request: { generation: 1, expectedLeaseVersion: 1, requestedTtlSec: 900 },
    };
    const error = await client.tickets
      .resume(command)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ComputeClientError);
    expect(error).toMatchObject({
      code: "RENEWAL_PENDING",
      recovery: {
        command,
        ticketId: ids.ticket,
        renewalId: ids.renewal,
        idempotencyKey: "same",
      },
    });
    const conflictingCommand = { ...command, ticketId: ids.consumer };
    await expect(
      client.tickets.resume(conflictingCommand),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("does not turn a 409/412 version conflict into a fresh proposal", async () => {
    let reads = 0;
    let writes = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/renew")) {
        writes += 1;
        return response(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "changed",
              details: {},
              retryable: false,
              requestId: ids.renewal,
            },
          },
          412,
        );
      }
      reads += 1;
      return response(ticket("ready"));
    });
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    await expect(client.tickets.claim(ids.ticket)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(reads).toBe(1);
    expect(writes).toBe(1);
  });

  it("reads, waits, claims, gets access, renewals and releases through their typed routes", async () => {
    const routes: string[] = [];
    const claimed = ticket("ready", {
      lease: {
        id: ids.lease,
        generation: 1,
        version: 2,
        state: "active",
        claimBy: at,
        claimedAt: at,
        expiresAt: "2026-10-19T02:00:00.000Z",
        renewUntil: "2026-10-20T00:00:00.000Z",
        revokedAt: null,
      },
    });
    const releasing = ticket("ready", {
      phase: "releasing",
      terminalReason: "consumer_release",
      cleanupStatus: "pending",
      releasedAt: null,
    });
    const access = {
      ticketId: ids.ticket,
      leaseId: ids.lease,
      leaseVersion: 2,
      generation: 1,
      access: {
        protocol: "ssh",
        host: "dev.example",
        port: 22,
        username: "tenant",
        hostKeyFingerprint: "SHA256:host",
        expiresAt: at,
      },
      authentication: {
        kind: "ssh_certificate",
        certificate: "ephemeral-certificate",
      },
    };
    const receipt = {
      renewalId: ids.renewal,
      ticketId: ids.ticket,
      generation: 1,
      leaseId: ids.lease,
      leaseVersion: 2,
      claimedAt: at,
      expiresAt: "2026-10-19T02:00:00.000Z",
      renewUntil: "2026-10-20T00:00:00.000Z",
      offlineEnforcement: "not_guaranteed",
      guardAcknowledgementId: null,
    };
    let claimConfirmed = false;
    let releaseRequested = false;
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        routes.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (
          url.pathname === `/v1/tickets/${ids.ticket}` &&
          init?.method === "GET"
        )
          return response(
            releaseRequested
              ? ticket("released")
              : claimConfirmed
                ? claimed
                : ticket("ready"),
          );
        if (url.pathname === "/v1/tickets" && init?.method === "GET") {
          const value = ticket("queued");
          return response({
            items: [
              {
                id: value.id,
                consumerId: value.consumerId,
                phase: value.phase,
                version: value.version,
                pinnedImageVersionId: value.pinnedImageVersionId,
                terminalReason: value.terminalReason,
                cleanupStatus: value.cleanupStatus,
                createdAt: value.createdAt,
                updatedAt: value.updatedAt,
                readyAt: value.readyAt,
                releasedAt: value.releasedAt,
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname.endsWith("/renew") && init?.method === "POST") {
          claimConfirmed = true;
          return response(receipt, 200);
        }
        if (url.pathname.endsWith(`/renewals/${ids.renewal}`))
          return response(pendingRenewal("confirmed"));
        if (url.pathname.endsWith("/access"))
          return response(access, 200, {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          });
        if (url.pathname.endsWith("/release")) {
          releaseRequested = true;
          return response(releasing, 202);
        }
        if (
          url.pathname ===
          "/v1/image-versions/00000000-0000-4000-8000-00000000000a"
        )
          return response({
            id: "00000000-0000-4000-8000-00000000000a",
            imageId: ids.image,
            version: "v1",
            status: "published",
            minimumResources: amounts,
            artifacts: [
              {
                id: ids.artifact,
                provider: "portainer",
                kind: "container",
                architecture: "amd64",
                guestOs: "linux",
                digest: `sha256:${"a".repeat(64)}`,
                accessProtocols: ["ssh"],
              },
            ],
          });
        throw new Error(`Unexpected route ${init?.method} ${url.pathname}`);
      },
    );
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    await expect(client.tickets.get(ids.ticket)).resolves.toMatchObject({
      id: ids.ticket,
    });
    await expect(client.tickets.list()).resolves.toMatchObject({
      items: [{ id: ids.ticket }],
      nextCursor: null,
    });
    await expect(
      client.tickets.waitUntilReady(ids.ticket),
    ).resolves.toMatchObject({
      phase: "ready",
      lease: { state: "active" },
      placement: { nodeId: ids.node },
    });
    await expect(
      client.tickets.claim(ids.ticket, { idempotencyKey: "claim-key" }),
    ).resolves.toEqual(receipt);
    await expect(
      client.tickets.getRenewal(ids.ticket, ids.renewal),
    ).resolves.toMatchObject({ state: "confirmed" });
    await expect(
      client.tickets.getAccess(ids.ticket, { idempotencyKey: "access-key" }),
    ).resolves.toEqual(access);
    await expect(
      client.tickets.release(
        ids.ticket,
        { reclaimable: true },
        { idempotencyKey: "release-key" },
      ),
    ).resolves.toMatchObject({ phase: "releasing" });
    await expect(
      client.tickets.waitUntilReleased(ids.ticket),
    ).resolves.toMatchObject({ phase: "released", cleanupStatus: "complete" });
    await expect(
      client.images.getVersion("00000000-0000-4000-8000-00000000000a"),
    ).resolves.toMatchObject({ status: "published" });
    expect(routes).toContain(`POST /v1/tickets/${ids.ticket}/renew`);
    expect(routes).toContain(`POST /v1/tickets/${ids.ticket}/release`);
    expect(routes).toContain(`POST /v1/tickets/${ids.ticket}/access`);
  });

  it("stops a local wait on cancellation or a hanging fetch without writing to the Ticket", async () => {
    let calls = 0;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls > 1)
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        return response(ticket("queued"));
      },
    );
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    await expect(
      client.tickets.waitUntilReady(ids.ticket, { timeoutMilliseconds: 20 }),
    ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    expect(
      fetcher.mock.calls.every(([, init]) => init?.method !== "POST"),
    ).toBe(true);

    const cancelledFetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const cancelledClient = new HitchletClient("http://localhost", {
      fetch: cancelledFetcher,
    });
    let cancelled = false;
    const timer = setTimeout(() => {
      cancelled = true;
    }, 5);
    await expect(
      cancelledClient.tickets.waitUntilReady(ids.ticket, {
        timeoutMilliseconds: 1000,
        isCancelled: () => cancelled,
      }),
    ).rejects.toMatchObject({ code: "WAIT_CANCELLED" });
    clearTimeout(timer);
    expect(
      cancelledFetcher.mock.calls.every(([, init]) => init?.method !== "POST"),
    ).toBe(true);
  });

  it("passes large opaque cursors through as strings and rejects invalid image responses", async () => {
    const cursor = "9223372036854775807";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get("cursor")).toBe(cursor);
      return response({ items: [], nextCursor: "next" });
    });
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    await expect(client.images.list({ cursor })).resolves.toEqual({
      items: [],
      nextCursor: "next",
    });

    const invalid = new HitchletClient("http://localhost", {
      fetch: async () =>
        response({ items: [{ secret: "leak" }], nextCursor: null }),
    });
    await expect(invalid.images.list()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
