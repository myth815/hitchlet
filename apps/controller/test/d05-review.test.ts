import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { TicketService } from "../dist/application/tickets.js";
import { TicketQueries } from "../dist/application/queries.js";
import { LeaseService } from "../dist/application/leases.js";
import { OperationWorker } from "../dist/application/operations.js";
import { PersistentSimulator } from "../dist/providers/simulator.js";
import { buildApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-d05-review-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "db");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    {
      env: { ...process.env, DATA_DIR: dataDir },
    },
  );
  const token = stdout.match(/Bearer token \(shown once\): (\S+)/)?.[1];
  const consumerId = stdout.match(/Consumer ID: (\S+)/)?.[1];
  const versionId = stdout.match(/Image version: (\S+)/)?.[1];
  const networkProfileId = stdout.match(/Network profile: (\S+)/)?.[1];
  if (!token || !consumerId || !versionId || !networkProfileId)
    throw new Error("Incomplete Simulator fixture");
  const storage = await openStorage(dataDir);
  cleanup.push(() => storage.close());
  const installation = await storage.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations WHERE singleton=1",
  );
  if (!installation) throw new Error("Fixture has no installation");
  let current = Date.now();
  const now = () => current;
  const tickets = new TicketService({
    storage,
    installationId: installation.installation_id,
    now,
  });
  const worker = new OperationWorker({
    storage,
    installationId: installation.installation_id,
    execution: new PersistentSimulator(join(dir, "external")),
    now,
  });
  const leases = new LeaseService(storage, now);
  const queries = new TicketQueries(storage, now);
  const accepted = await tickets.acquire(consumerId, "fixture-acquire", {
    image: { versionId },
    resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
    networkProfileId,
    lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
  });
  await tickets.reserveNext();
  await worker.reconcileBeforeScheduling();
  const ready = await queries.get(consumerId, accepted.ticketId);
  if (ready?.phase !== "ready" || !ready.lease)
    throw new Error("Fixture did not become ready");
  const request = {
    generation: ready.lease.generation,
    expectedLeaseVersion: ready.lease.version,
  };
  return {
    storage,
    dataDir,
    dir,
    token,
    consumerId,
    versionId,
    networkProfileId,
    tickets,
    worker,
    leases,
    queries,
    ready,
    request,
    now,
    setTime(value: number) {
      current = value;
    },
  };
}

describe("independent D05 protocol and lease review", () => {
  it("hides another consumer's Ticket and renewal across every owner route", async () => {
    const f = await fixture();
    const pending = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "owner-renewal",
      f.request,
    );
    expect(pending.outcome).toBe("pending");
    if (pending.outcome !== "pending")
      throw new Error("Expected a pending renewal");
    const other = randomUUID();
    const token = `hcl_${randomBytes(32).toString("base64url")}`;
    await f.storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) SELECT ?,?,'agent','consumer',authorization_json,quota_json,?,? FROM consumers WHERE id=?",
        params: [other, other, f.now(), f.now(), f.consumerId],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          randomUUID(),
          other,
          token.slice(0, 12),
          createHash("sha256").update(token).digest("hex"),
          JSON.stringify([
            "tickets:read",
            "tickets:write",
            "events:read",
            "images:read",
          ]),
          f.now(),
        ],
      },
    ]);
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        GUI_DIR: join(f.dir, "no-gui"),
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const headers = {
      authorization: `Bearer ${token}`,
      "idempotency-key": "foreign-command",
    };
    for (const [method, suffix, payload] of [
      ["GET", "", undefined],
      ["GET", "/events", undefined],
      ["GET", `/renewals/${pending.renewal.id}`, undefined],
      ["POST", "/renew", f.request],
      ["POST", "/cancel", {}],
      [
        "POST",
        "/release",
        { generation: f.request.generation, reclaimable: true },
      ],
      ["POST", "/access", { generation: f.request.generation }],
    ] as const) {
      const result = await app.inject({
        method,
        url: `/v1/tickets/${f.ready.id}${suffix}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(result.statusCode, `${method} ${suffix}`).toBe(404);
    }
  });

  it("rejects first claim exactly at claimBy even before the expiry sweeper runs", async () => {
    const f = await fixture();
    f.setTime(Date.parse(f.ready.lease!.claimBy!));
    await expect(
      f.leases.renew(f.consumerId, f.ready.id, "late-claim", f.request),
    ).rejects.toMatchObject({ code: "claim_deadline_expired" });
    expect(
      (
        await f.storage.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM lease_renewals",
        )
      )?.n,
    ).toBe(0n);
  });

  it("rejects a pending decision at its exact deadline and retains capacity until cleanup", async () => {
    const f = await fixture();
    const pending = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "deadline-renewal",
      f.request,
    );
    if (pending.outcome !== "pending")
      throw new Error("Expected a pending renewal");
    f.setTime(Date.parse(pending.renewal.decisionDeadline));
    await f.leases.reconcilePending();
    expect(
      (await f.leases.get(f.consumerId, f.ready.id, pending.renewal.id))?.state,
    ).toBe("rejected");
    const ticket = await f.queries.get(f.consumerId, f.ready.id);
    expect(ticket?.phase).toBe("releasing");
    expect(
      (
        await f.storage.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
        )
      )?.n,
    ).toBeGreaterThan(0n);
  });

  it("cancels a pending renewal with termination and never revives the lease", async () => {
    const f = await fixture();
    const duplicate = await Promise.allSettled([
      f.leases.renew(f.consumerId, f.ready.id, "cancel-renewal", f.request),
      f.leases.renew(f.consumerId, f.ready.id, "cancel-renewal", f.request),
    ]);
    expect(duplicate.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    if (
      duplicate[0]?.status !== "fulfilled" ||
      duplicate[1]?.status !== "fulfilled"
    )
      throw new Error(
        "Same-key concurrent renewal must recover the original proposal",
      );
    const pending = duplicate[0].value;
    expect(duplicate[1].value).toEqual(pending);
    await expect(
      f.leases.renew(f.consumerId, f.ready.id, "competing-renewal", f.request),
    ).rejects.toMatchObject({ code: "renewal_in_progress" });
    if (pending.outcome !== "pending")
      throw new Error("Expected a pending renewal");
    await f.tickets.cancel(f.ready.id, f.consumerId);
    await f.leases.reconcilePending();
    expect(
      (await f.leases.get(f.consumerId, f.ready.id, pending.renewal.id))?.state,
    ).toBe("cancelled");
    expect((await f.queries.get(f.consumerId, f.ready.id))?.phase).toBe(
      "releasing",
    );
    await f.worker.reconcile();
    expect((await f.queries.get(f.consumerId, f.ready.id))?.phase).toBe(
      "released",
    );
  });

  it("keeps frozen TTL bounds and replays the same confirmed receipt after termination", async () => {
    const f = await fixture();
    await f.storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxLeaseTtlSeconds',120),version=version+1 WHERE id=?",
      [f.consumerId],
    );
    const pending = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "frozen-renewal",
      { ...f.request, requestedTtlSec: 900 },
    );
    expect(pending.outcome).toBe("pending");
    await f.leases.reconcilePending();
    const receipt = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "frozen-renewal",
      { ...f.request, requestedTtlSec: 900 },
    );
    expect(receipt.outcome).toBe("confirmed");
    await f.tickets.cancel(f.ready.id, f.consumerId);
    expect(
      await f.leases.renew(f.consumerId, f.ready.id, "frozen-renewal", {
        ...f.request,
        requestedTtlSec: 900,
      }),
    ).toEqual(receipt);
    expect((await f.queries.get(f.consumerId, f.ready.id))?.phase).toBe(
      "releasing",
    );
  });

  it("resumes termination after its idempotency reservation survived a controller crash", async () => {
    const f = await fixture();
    const key = "reserved-before-crash";
    const hash = createHash("sha256")
      .update(JSON.stringify({ body: {}, ticketId: f.ready.id }))
      .digest("hex");
    await f.storage.run(
      "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,created_at_ms,retain_until_ms) VALUES(?,'tickets.cancel',?,?,?,?,?)",
      [f.consumerId, key, hash, f.ready.id, f.now(), f.now() + 86400000],
    );
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/cancel`,
      headers: { authorization: `Bearer ${f.token}`, "idempotency-key": key },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().phase).toBe("releasing");
    const conflict = await app.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/cancel`,
      headers: { authorization: `Bearer ${f.token}`, "idempotency-key": key },
      payload: { reason: "a different command" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("replays a queued cancellation whose atomic completion survived a lost reply", async () => {
    const f = await fixture();
    const queued = await f.tickets.acquire(
      f.consumerId,
      "queued-cancel-target",
      {
        image: { versionId: f.versionId },
        resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
        networkProfileId: f.networkProfileId,
        lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
      },
    );
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const originalRun = f.storage.run.bind(f.storage);
    let completionInterrupted = false;
    const write = vi
      .spyOn(f.storage, "run")
      .mockImplementation(async (sql, params) => {
        if (
          !completionInterrupted &&
          sql.startsWith("UPDATE idempotency_keys SET response_status")
        ) {
          completionInterrupted = true;
          throw new Error("Injected loss before idempotency completion");
        }
        return originalRun(sql, params);
      });
    const first = await app.inject({
      method: "POST",
      url: `/v1/tickets/${queued.ticketId}/cancel`,
      headers: {
        authorization: `Bearer ${f.token}`,
        "idempotency-key": "queued-cancel-commit",
      },
      payload: {},
    });
    write.mockRestore();
    expect(completionInterrupted).toBe(true);
    expect(first.statusCode).toBe(500);
    const replay = await app.inject({
      method: "POST",
      url: `/v1/tickets/${queued.ticketId}/cancel`,
      headers: {
        authorization: `Bearer ${f.token}`,
        "idempotency-key": "queued-cancel-commit",
      },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      id: queued.ticketId,
      phase: "released",
    });
  });

  it("accepts numeric HTTP page limits while keeping invalid query values rejected", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    for (const path of [
      "/v1/tickets",
      "/v1/images",
      `/v1/tickets/${f.ready.id}/events`,
    ]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${path}?limit=1`,
            headers: { authorization: `Bearer ${f.token}` },
          })
        ).statusCode,
        path,
      ).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/tickets?limit=1.5",
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).statusCode,
    ).toBe(422);
  });

  it("maps stale generations, unavailable contracts and queued quota to deliberate HTTP errors", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const headers = {
      authorization: `Bearer ${f.token}`,
      "idempotency-key": "stale-release",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/tickets/${f.ready.id}/release`,
          headers,
          payload: { generation: f.request.generation + 1, reclaimable: true },
        })
      ).statusCode,
    ).toBe(412);
    const request = {
      image: { versionId: f.versionId },
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      networkProfileId: f.ready.acceptedRequest.networkProfileId,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers: { ...headers, "idempotency-key": "unavailable-image" },
          payload: { ...request, image: { versionId: randomUUID() } },
        })
      ).statusCode,
    ).toBe(422);
    await f.storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxQueuedTickets',1),version=version+1 WHERE id=?",
      [f.consumerId],
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers: { ...headers, "idempotency-key": "last-queue-slot" },
          payload: request,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers: { ...headers, "idempotency-key": "queue-full" },
          payload: request,
        })
      ).statusCode,
    ).toBe(429);
    await f.storage.run("DROP TRIGGER ticket_request_no_update");
    await f.storage.run("UPDATE tickets SET request_json='{}' WHERE id=?", [
      f.ready.id,
    ]);
    const projectionFailure = await app.inject({
      method: "GET",
      url: `/v1/tickets/${f.ready.id}`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(projectionFailure.statusCode).toBe(500);
    expect(projectionFailure.json().error.code).toBe("internal_error");
  });

  it("maps acquire idempotency conflicts and profile authorization failures", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const headers = {
      authorization: `Bearer ${f.token}`,
      "idempotency-key": "http-acquire-body",
    };
    const request = {
      image: { versionId: f.versionId },
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      networkProfileId: f.networkProfileId,
      lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers,
          payload: request,
        })
      ).statusCode,
    ).toBe(202);
    const reused = await app.inject({
      method: "POST",
      url: "/v1/tickets",
      headers,
      payload: {
        ...request,
        lease: { ...request.lease, requestedSeconds: 901 },
      },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("idempotency_key_reused");

    const unauthorizedNetwork = await app.inject({
      method: "POST",
      url: "/v1/tickets",
      headers: { ...headers, "idempotency-key": "unauthorized-network" },
      payload: { ...request, networkProfileId: randomUUID() },
    });
    expect(unauthorizedNetwork.statusCode).toBe(422);
    expect(unauthorizedNetwork.json().error.code).toBe("invalid_request");

    const unauthorizedStorage = await app.inject({
      method: "POST",
      url: "/v1/tickets",
      headers: { ...headers, "idempotency-key": "unauthorized-storage" },
      payload: {
        ...request,
        storage: [
          {
            storageProfileId: randomUUID(),
            authorizedSubpath: "documents",
            mountPath: "/data",
            mode: "read_only",
          },
        ],
      },
    });
    expect(unauthorizedStorage.statusCode).toBe(422);
    expect(unauthorizedStorage.json().error.code).toBe("invalid_request");
  });

  it("limits operator revoke to its authorized image and node scope", async () => {
    const f = await fixture();
    const allocation = await f.storage.get<{ node_id: string }>(
      "SELECT node_id FROM allocations WHERE ticket_id=?",
      [f.ready.id],
    );
    const image = await f.storage.get<{ image_id: string }>(
      "SELECT image_id FROM image_versions WHERE id=?",
      [f.versionId],
    );
    if (!allocation || !image)
      throw new Error("Missing fixture authorization targets");
    const mintOperator = async (nodeId: string) => {
      const consumerId = randomUUID();
      const token = `hcl_${randomBytes(32).toString("base64url")}`;
      await f.storage.batchTransaction([
        {
          kind: "run",
          sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) SELECT ?,?,'human','operator',json_object('imageIds',json_array(?),'nodeIds',json_array(?),'networkProfileIds','all','storageProfileIds',json_array()),quota_json,?,? FROM consumers WHERE id=?",
          params: [
            consumerId,
            consumerId,
            image.image_id,
            nodeId,
            f.now(),
            f.now(),
            f.consumerId,
          ],
        },
        {
          kind: "run",
          sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
          params: [
            randomUUID(),
            consumerId,
            token.slice(0, 12),
            createHash("sha256").update(token).digest("hex"),
            JSON.stringify(["tickets:revoke"]),
            f.now(),
          ],
        },
      ]);
      return token;
    };
    const authorized = await mintOperator(allocation.node_id);
    const outside = await mintOperator(randomUUID());
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    try {
      const snapshot = await app.inject({
        method: "GET",
        url: `/v1/tickets/${f.ready.id}`,
        headers: { authorization: `Bearer ${f.token}` },
      });
      expect(snapshot.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/tickets/${f.ready.id}`,
            headers: {
              authorization: `Bearer ${f.token}`,
              "if-none-match": snapshot.headers.etag,
            },
          })
        ).statusCode,
      ).toBe(304);
      const payload = {
        generation: f.request.generation,
        expectedTicketVersion: f.ready.version,
        reason: "scoped review revoke",
      };
      const denied = await app.inject({
        method: "POST",
        url: `/v1/tickets/${f.ready.id}/revoke`,
        headers: {
          authorization: `Bearer ${outside}`,
          "idempotency-key": "out-of-scope",
        },
        payload,
      });
      expect(denied.statusCode).toBe(404);
      // Interrupt only the separate completion write. If completion is already
      // part of the domain transaction there is no such crash boundary.
      const originalRun = f.storage.run.bind(f.storage);
      let completionInterrupted = false;
      const write = vi
        .spyOn(f.storage, "run")
        .mockImplementation(async (sql, params) => {
          if (
            !completionInterrupted &&
            sql.startsWith("UPDATE idempotency_keys SET response_status")
          ) {
            completionInterrupted = true;
            throw new Error("Injected loss before idempotency completion");
          }
          return originalRun(sql, params);
        });
      const allowed = await app.inject({
        method: "POST",
        url: `/v1/tickets/${f.ready.id}/revoke`,
        headers: {
          authorization: `Bearer ${authorized}`,
          "idempotency-key": "in-scope",
        },
        payload,
      });
      write.mockRestore();
      expect(allowed.statusCode).toBe(completionInterrupted ? 500 : 202);
      const replayed = await app.inject({
        method: "POST",
        url: `/v1/tickets/${f.ready.id}/revoke`,
        headers: {
          authorization: `Bearer ${authorized}`,
          "idempotency-key": "in-scope",
        },
        payload,
      });
      expect(replayed.statusCode).toBe(202);
      expect(replayed.json()).toMatchObject({ phase: "releasing" });
      for (const key of ["outside-new-key", "in-scope"]) {
        const deniedReplay = await app.inject({
          method: "POST",
          url: `/v1/tickets/${f.ready.id}/revoke`,
          headers: {
            authorization: `Bearer ${outside}`,
            "idempotency-key": key,
          },
          payload,
        });
        expect(deniedReplay.statusCode).toBe(404);
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/tickets/${f.ready.id}/revoke`,
            headers: {
              authorization: `Bearer ${authorized}`,
              "idempotency-key": "stale-version",
            },
            payload: { ...payload, expectedTicketVersion: f.ready.version - 1 },
          })
        ).statusCode,
      ).toBe(412);
      const audit = await f.storage.get<{ safe_details_json: string }>(
        "SELECT safe_details_json FROM audit_entries WHERE action='ticket.revoke' AND target_id=?",
        [f.ready.id],
      );
      expect(audit?.safe_details_json).toContain("scoped review revoke");
    } finally {
      await app.close();
    }
  });

  it("exchanges a full-scope bearer for a CSRF-protected HttpOnly session and revokes it", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { authorization: `Bearer ${f.token}` },
      });
      expect(login.statusCode).toBe(201);
      expect(login.headers["cache-control"]).toBe("no-store");
      const csrf = String(login.headers["x-csrf-token"]);
      const cookies = login.headers["set-cookie"] as string[];
      const sessionCookie = cookies
        .find((cookie) => cookie.startsWith("hitchlet_session="))
        ?.split(";")[0];
      const csrfCookie = cookies
        .find((cookie) => cookie.startsWith("hitchlet_csrf="))
        ?.split(";")[0];
      if (!sessionCookie || !csrfCookie)
        throw new Error("Session cookies are missing");
      const cookie = `${sessionCookie}; ${csrfCookie}`;
      const me = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { cookie },
      });
      expect(me.headers["cache-control"]).toBe("no-store");
      expect(me.json()).toMatchObject({ source: "session", role: "consumer" });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/tickets/${f.ready.id}/cancel`,
            headers: { cookie, "idempotency-key": "csrf-missing" },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const logout = await app.inject({
        method: "DELETE",
        url: "/v1/auth/session",
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(logout.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/auth/me",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("does not elevate scoped tokens, and invalidates sessions when their source credential is revoked", async () => {
    const f = await fixture();
    const limited = `hcl_${randomBytes(32).toString("base64url")}`;
    const limitedCredential = randomUUID();
    const viewer = randomUUID();
    const viewerToken = `hcl_${randomBytes(32).toString("base64url")}`;
    await f.storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          limitedCredential,
          f.consumerId,
          limited.slice(0, 12),
          createHash("sha256").update(limited).digest("hex"),
          JSON.stringify(["images:read"]),
          f.now(),
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) SELECT ?,?,'human','viewer','{}',quota_json,?,? FROM consumers WHERE id=?",
        params: [viewer, viewer, f.now(), f.now(), f.consumerId],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          randomUUID(),
          viewer,
          viewerToken.slice(0, 12),
          createHash("sha256").update(viewerToken).digest("hex"),
          JSON.stringify([]),
          f.now(),
        ],
      },
    ]);
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    try {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/tickets",
            headers: { authorization: `Bearer ${viewerToken}` },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/session",
            headers: { authorization: `Bearer ${limited}` },
          })
        ).statusCode,
      ).toBe(403);
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { authorization: `Bearer ${f.token}` },
      });
      const sessionCookies = login.headers["set-cookie"] as string[];
      const cookie = sessionCookies
        .map((item) => item.split(";")[0])
        .join("; ");
      let last = 0;
      for (let i = 0; i < 6; i++)
        last = (
          await app.inject({
            method: "POST",
            url: "/v1/auth/session",
            headers: { authorization: "Bearer invalid-token" },
          })
        ).statusCode;
      expect(last).toBe(429);
      await f.storage.run(
        "UPDATE consumer_credentials SET revoked_at_ms=? WHERE consumer_id=? AND token_prefix=?",
        [f.now(), f.consumerId, f.token.slice(0, 12)],
      );
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/auth/me",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("uses the shared API error envelope when real static assets are enabled", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "index.html"), "<main>GUI</main>");
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        GUI_DIR: f.dir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());

    expect((await app.inject({ url: "/" })).statusCode).toBe(200);
    const responses = [
      await app.inject({ url: "/v1/auth/me" }),
      await app.inject({
        url: "/v1/tickets?limit=invalid",
        headers: { authorization: `Bearer ${f.token}` },
      }),
      await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { "content-type": "application/json" },
        payload: '{"invalid"',
      }),
    ];
    await f.storage.run("DROP TRIGGER ticket_request_no_update");
    await f.storage.run("UPDATE tickets SET request_json='{}' WHERE id=?", [
      f.ready.id,
    ]);
    responses.push(
      await app.inject({
        url: `/v1/tickets/${f.ready.id}`,
        headers: { authorization: `Bearer ${f.token}` },
      }),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 422, 400, 500,
    ]);
    expect(responses[2]?.json().error.code).toBe("invalid_request");
    for (const response of responses) {
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toMatchObject({
        error: {
          requestId: expect.any(String),
          code: expect.any(String),
          message: expect.any(String),
          details: {},
          retryable: expect.any(Boolean),
        },
      });
      expect(response.json().statusCode).toBeUndefined();
    }
  });

  it("refreshes only the installation-bound Simulator fixture after expiry", async () => {
    const f = await fixture();
    const future = f.now() + 3_700_000;
    f.setTime(future);
    const queued = await f.tickets.acquire(
      f.consumerId,
      "after-simulator-expiry",
      {
        image: { versionId: f.versionId },
        resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
        networkProfileId: f.networkProfileId,
        lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
      },
    );
    expect(await f.tickets.reserveNext()).toBeNull();
    await f.tickets.refreshSimulatorFixtureObservation();
    expect(await f.tickets.reserveNext()).toMatchObject({
      ticketId: queued.ticketId,
    });
    await f.worker.reconcileBeforeScheduling();
    await f.leases.reconcilePending();
    await f.worker.reconcile();
    expect((await f.queries.get(f.consumerId, queued.ticketId))?.phase).toBe(
      "ready",
    );
  });

  it("does not refresh stale observations for a non-Simulator node", async () => {
    const f = await fixture();
    const node = await f.storage.get<{ id: string }>(
      "SELECT id FROM nodes LIMIT 1",
    );
    if (!node) throw new Error("Missing fixture node");
    await f.storage.run(
      "UPDATE nodes SET config_json=json_object('executionMode','portainer'),observed_at_ms=0,capabilities_json=json_set(capabilities_json,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE id=?",
      [node.id],
    );
    f.setTime(f.now() + 3_700_000);
    await f.tickets.refreshSimulatorFixtureObservation();
    const unchanged = await f.storage.get<{
      observed_at_ms: number | bigint;
      expires_at: string;
    }>(
      "SELECT observed_at_ms,json_extract(capabilities_json,'$.expiresAt') AS expires_at FROM nodes WHERE id=?",
      [node.id],
    );
    expect(Number(unchanged?.observed_at_ms)).toBe(0);
    expect(unchanged?.expires_at).toBe("2000-01-01T00:00:00.000Z");
  });

  it("closes a loopback SSE stream on logout and on server shutdown", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${f.token}` },
    });
    const cookies = login.headers["set-cookie"] as string[];
    const cookie = cookies.map((item) => item.split(";")[0]).join("; ");
    const csrf = String(login.headers["x-csrf-token"]);
    const stream = await fetch(`${address}/v1/events/stream?after=0`, {
      headers: { cookie },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    let frame = "";
    const decoder = new TextDecoder();
    const untilEvent = (async () => {
      while (!/\nid: [0-9]+\nevent:/.test(frame)) {
        const next = await reader.read();
        if (next.done) break;
        frame += decoder.decode(next.value);
      }
      return frame;
    })();
    await Promise.race([
      untilEvent,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("SSE did not send a stored event")),
          3000,
        ),
      ),
    ]);
    expect(frame).toMatch(/\nid: [0-9]+\nevent:/);
    const id = frame.match(/\nid: ([0-9]+)\nevent:/)?.[1];
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    const logout = await fetch(`${address}/v1/auth/session`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(logout.status).toBe(204);
    const ended = await Promise.race([
      (async () => {
        let result = await reader.read();
        while (!result.done) result = await reader.read();
        return result;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("SSE did not close after logout")),
          2500,
        ),
      ),
    ]);
    expect(ended.done).toBe(true);

    const bearerStream = await fetch(`${address}/v1/events/stream?after=0`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    const bearerReader = bearerStream.body!.getReader();
    await bearerReader.read();
    const closed = app.close();
    await closed;
    expect((await bearerReader.read()).done).toBe(true);
  }, 10000);
});
