import { afterEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage, type Storage } from "../dist/storage/index.js";
import { HostAgents } from "../src/application/host-agents.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { HostHeartbeat } from "@hitchlet/contracts/internal";
const paths: string[] = [];
const dbs: Storage[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
  await Promise.all(
    paths.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-host-"));
  paths.push(dir);
  const db = await openStorage(dir);
  dbs.push(db);
  const installationId = randomUUID(),
    machineId = randomUUID(),
    hostIdentity = randomUUID(),
    adminId = randomUUID();
  let now = Date.parse("2026-10-20T00:00:00Z");
  await db.batchTransaction([
    {
      kind: "run",
      sql: "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
      params: [installationId, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO machines(id,name,usage_mode,host_os,architecture,created_at_ms,updated_at_ms) VALUES(?,'Host','shared','macos','arm64',?,?)",
      params: [machineId, now, now],
    },
  ]);
  const service = new HostAgents(db, () => now);
  const pair = await service.pair(
    { machineId, hostIdentity, reason: "test registration" },
    adminId,
    randomUUID(),
  );
  const enrollment = {
    agentId: pair.agentId,
    machineId,
    installationId,
    hostIdentity,
    pairingToken: pair.pairingToken,
    hostOs: "macos" as const,
    architecture: "arm64" as const,
    protocolVersion: 1 as const,
    role: "physical_host" as const,
  };
  const enrolled = await service.enroll(enrollment),
    authorization = `Bearer ${enrolled.credential}`;
  const bootId = randomUUID();
  const bootRequest = {
    installationId,
    controllerEpoch: 1,
    bootId,
    expectedSessionEpoch: 0,
  };
  await service.start(pair.agentId, authorization, bootRequest);
  const heartbeat = (sequence = 0): HostHeartbeat => ({
    installationId,
    controllerEpoch: 1,
    sessionEpoch: 1,
    protocolVersion: 1,
    agentVersion: "test",
    snapshot: {
      agentId: pair.agentId,
      machineId,
      bootId,
      sequence,
      observedAt: new Date(now).toISOString(),
      probeStatus: "complete",
      sessionsComplete: true,
      sessions: [],
      activeInteraction: false,
      resources: { cpuPercent: 2, memoryUsedBytes: 1, memoryTotalBytes: 2 },
      unmanagedActivityHold: false,
      errorCodes: [],
    },
  });
  return {
    dir,
    db,
    service,
    pair,
    enrolled,
    enrollment,
    authorization,
    bootRequest,
    heartbeat,
    machineId,
    installationId,
    adminId,
    hostIdentity,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now,
  };
}
describe("authenticated physical Host SQLite observations", () => {
  it("persists exact duplicates without renewing freshness, rejects altered/old sequences and time rollback", async () => {
    const f = await fixture();
    const first = f.heartbeat();
    const receipt = await f.service.heartbeat(
      f.pair.agentId,
      f.authorization,
      first,
    );
    f.setNow(f.now() + 1000);
    expect(
      await f.service.heartbeat(f.pair.agentId, f.authorization, first),
    ).toEqual({ ...receipt, duplicate: true });
    expect((await f.service.snapshot(f.machineId))?.humanPresence).toBe(
      "absent",
    );
    await expect(
      f.service.heartbeat(f.pair.agentId, f.authorization, {
        ...first,
        snapshot: { ...first.snapshot, activeInteraction: true },
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    const second = f.heartbeat(2);
    await f.service.heartbeat(f.pair.agentId, f.authorization, second);
    await expect(
      f.service.heartbeat(f.pair.agentId, f.authorization, f.heartbeat(1)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    const rollback = f.heartbeat(3);
    rollback.snapshot.observedAt = first.snapshot.observedAt;
    await expect(
      f.service.heartbeat(f.pair.agentId, f.authorization, rollback),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    f.setNow(f.now() + 30_001);
    const stale = await f.service.snapshot(f.machineId);
    expect(stale).toMatchObject({
      fresh: false,
      humanPresence: "unknown",
      snapshot: { resources: { cpuPercent: 2 } },
    });
    await f.db.close();
    const reopened = await openStorage(f.dir);
    dbs.push(reopened);
    expect(
      await new HostAgents(reopened, () => f.now()).snapshot(f.machineId),
    ).toEqual(stale);
  });
  it("serializes competing heartbeat writes and never lets lower sequence or old boot win", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.service.heartbeat(f.pair.agentId, f.authorization, f.heartbeat(10)),
      f.service.heartbeat(f.pair.agentId, f.authorization, f.heartbeat(9)),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await f.service.snapshot(f.machineId))?.snapshot.sequence).toBe(10);
    expect(
      await f.service.start(f.pair.agentId, f.authorization, f.bootRequest),
    ).toMatchObject({ sessionEpoch: 1 });
    const newBoot = {
      ...f.bootRequest,
      bootId: randomUUID(),
      expectedSessionEpoch: 1,
    };
    await f.service.start(f.pair.agentId, f.authorization, newBoot);
    expect(await f.service.snapshot(f.machineId)).toBeNull();
    await expect(
      f.service.start(f.pair.agentId, f.authorization, {
        ...f.bootRequest,
        expectedSessionEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    await expect(
      f.service.heartbeat(f.pair.agentId, f.authorization, f.heartbeat(11)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    expect(
      (await f.service.session(f.pair.agentId, f.authorization)).sessionEpoch,
    ).toBe(2);
  });
  it("rejects foreign identity/installation, stale epoch/time and runtime credentials; revocation and re-pair survive restart", async () => {
    const f = await fixture();
    await expect(f.service.enroll(f.enrollment)).rejects.toMatchObject({
      code: "STORAGE_CAS_FAILED",
    });
    for (const changed of [
      { installationId: randomUUID() },
      { controllerEpoch: 2 },
      { sessionEpoch: 2 },
    ])
      await expect(
        f.service.heartbeat(f.pair.agentId, f.authorization, {
          ...f.heartbeat(),
          ...changed,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    const foreign = f.heartbeat();
    foreign.snapshot.machineId = randomUUID();
    await expect(
      f.service.heartbeat(f.pair.agentId, f.authorization, foreign),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.service.heartbeat(
        f.pair.agentId,
        `Bearer hcl_${"a".repeat(43)}`,
        f.heartbeat(),
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    const future = f.heartbeat();
    future.snapshot.observedAt = new Date(f.now() + 1).toISOString();
    await expect(
      f.service.heartbeat(f.pair.agentId, f.authorization, future),
    ).rejects.toBeInstanceOf(RangeError);
    await f.service.heartbeat(f.pair.agentId, f.authorization, f.heartbeat());
    await f.db.run(
      "UPDATE installations SET controller_epoch=2 WHERE singleton=1",
    );
    expect(await f.service.snapshot(f.machineId)).toMatchObject({
      humanPresence: "unknown",
      fresh: false,
    });
    expect(
      await f.service.session(f.pair.agentId, f.authorization),
    ).toMatchObject({ controllerEpoch: 2, sessionEpoch: 1 });
    await expect(
      f.service.start(f.pair.agentId, f.authorization, {
        ...f.bootRequest,
        bootId: randomUUID(),
        expectedSessionEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: "agent_epoch_conflict" });
    await f.service.start(f.pair.agentId, f.authorization, {
      ...f.bootRequest,
      controllerEpoch: 2,
      bootId: randomUUID(),
      expectedSessionEpoch: 1,
    });
    await f.service.revoke(
      f.pair.agentId,
      2,
      "lost credential",
      f.adminId,
      randomUUID(),
    );
    await expect(
      f.service.session(f.pair.agentId, f.authorization),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    const pair = await f.service.pair(
      {
        machineId: f.machineId,
        hostIdentity: f.hostIdentity,
        expectedSessionEpoch: 3,
        reason: "replace lost enrollment",
      },
      f.adminId,
      randomUUID(),
    );
    expect(pair.agentId).toBe(f.pair.agentId);
    const next = await f.service.enroll({
      ...f.enrollment,
      pairingToken: pair.pairingToken,
    });
    expect(next.sessionEpoch).toBe(3);
    expect(next.credential).not.toBe(f.enrolled.credential);
    await f.db.close();
    const db = await openStorage(f.dir);
    dbs.push(db);
    const service = new HostAgents(db, () => f.now());
    await expect(
      service.session(pair.agentId, f.authorization),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(
      await service.session(pair.agentId, `Bearer ${next.credential}`),
    ).toMatchObject({ sessionEpoch: 3 });
    const audit = await db.all(
      "SELECT action,safe_details_json FROM audit_entries",
    );
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain(next.credential);
    expect(JSON.stringify(await service.view(pair.agentId))).not.toMatch(
      /credential|hash|pairingToken/,
    );
  });
  it("fences simultaneous boot transitions and revoked snapshots at the SQLite commit boundary", async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((bootId) =>
        f.service.start(f.pair.agentId, f.authorization, {
          ...f.bootRequest,
          bootId,
          expectedSessionEpoch: 1,
        }),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await f.service.session(f.pair.agentId, f.authorization)).sessionEpoch,
    ).toBe(2);
    await f.service.revoke(
      f.pair.agentId,
      2,
      "test revoke",
      f.adminId,
      randomUUID(),
    );
    await expect(
      f.service.start(f.pair.agentId, f.authorization, {
        ...f.bootRequest,
        bootId: randomUUID(),
        expectedSessionEpoch: 3,
      }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("requires full admin for registration/revocation, separates Host routes, and validates public schemas", async () => {
    const f = await fixture();
    const token = `hcl_${"a".repeat(43)}`;
    const operator = `hcl_${"o".repeat(43)}`;
    for (const [key, role] of [
      [token, "admin"],
      [operator, "operator"],
    ]) {
      const consumer = randomUUID();
      await f.db.batchTransaction([
        {
          kind: "run",
          sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms) VALUES(?,'Test','human',?,'{}','{}',?)",
          params: [consumer, role!, f.now()],
        },
        {
          kind: "run",
          sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
          params: [
            randomUUID(),
            consumer,
            key!.slice(0, 12),
            createHash("sha256").update(key!).digest("hex"),
            JSON.stringify([
              "tickets:read",
              "tickets:write",
              "tickets:revoke",
              "images:read",
              "events:read",
            ]),
            f.now(),
          ],
        },
      ]);
    }
    const app = await buildApp(
      loadConfig({ DATA_DIR: f.dir, LOG_LEVEL: "silent" }),
      { storage: f.db },
    );
    try {
      const get = (authorization: string, url: string) =>
        app.inject({ method: "GET", url, headers: { authorization } });
      expect(
        (await get(f.authorization, `/v1/agents/${f.pair.agentId}/session`))
          .statusCode,
      ).toBe(200);
      expect(
        (await get(`Bearer ${token}`, `/v1/agents/${f.pair.agentId}/session`))
          .statusCode,
      ).toBe(401);
      expect(
        (await get(f.authorization, `/v1/agents/${f.pair.agentId}`)).statusCode,
      ).toBe(401);
      expect(
        (await get(`Bearer ${operator}`, `/v1/agents/${f.pair.agentId}`))
          .statusCode,
      ).toBe(403);
      const view = await get(`Bearer ${token}`, `/v1/agents/${f.pair.agentId}`);
      expect(view.statusCode).toBe(200);
      expect(view.headers["cache-control"]).toBe("no-store");
      const post = (authorization: string, url: string, payload: unknown) =>
        app.inject({
          method: "POST",
          url,
          headers: { authorization },
          payload,
        });
      expect(
        (
          await post(`Bearer ${operator}`, "/v1/agents/pairings", {
            machineId: f.machineId,
            hostIdentity: f.hostIdentity,
            reason: "forbidden",
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await post(
            f.authorization,
            `/v1/agents/${f.pair.agentId}/heartbeat`,
            {},
          )
        ).statusCode,
      ).toBe(422);
      const bootId = randomUUID();
      expect(
        (
          await post(f.authorization, `/v1/agents/${f.pair.agentId}/boot`, {
            ...f.bootRequest,
            bootId,
            expectedSessionEpoch: 1,
          })
        ).statusCode,
      ).toBe(200);
      const heartbeat = f.heartbeat();
      heartbeat.sessionEpoch = 2;
      heartbeat.snapshot.bootId = bootId;
      heartbeat.snapshot.observedAt = new Date().toISOString();
      heartbeat.snapshot.sessions = [
        {
          sessionId: "fixture",
          principalRef: "fixture-service-login",
          type: "rdp",
          connection: "disconnected",
          locked: "unknown",
        },
      ];
      const accepted = await post(
        f.authorization,
        `/v1/agents/${f.pair.agentId}/heartbeat`,
        heartbeat,
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      const replay = await post(
        f.authorization,
        `/v1/agents/${f.pair.agentId}/heartbeat`,
        heartbeat,
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ ...accepted.json(), duplicate: true });
      const snapshot = await get(
        `Bearer ${token}`,
        `/v1/machines/${f.machineId}/snapshot`,
      );
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json()).toMatchObject({
        fresh: true,
        humanPresence: "present",
        offlineLeaseEnforcement: false,
      });
      expect(
        (
          await post(`Bearer ${token}`, `/v1/agents/${f.pair.agentId}/revoke`, {
            expectedSessionEpoch: 0,
            reason: "stale",
          })
        ).statusCode,
      ).toBe(412);
      expect(
        (
          await post(`Bearer ${token}`, `/v1/agents/${f.pair.agentId}/revoke`, {
            expectedSessionEpoch: 2,
            reason: "remove host",
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await get(f.authorization, `/v1/agents/${f.pair.agentId}/session`))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("Host pairing recovery and commit races", () => {
  it("binds enrollment to identity/OS/architecture, hashes secrets, and expires unused pairings", async () => {
    const f = await fixture();
    await f.service.revoke(
      f.pair.agentId,
      1,
      "replace",
      f.adminId,
      randomUUID(),
    );
    const pair = await f.service.pair(
      {
        machineId: f.machineId,
        hostIdentity: f.hostIdentity,
        expectedSessionEpoch: 2,
        reason: "re-pair",
      },
      f.adminId,
      randomUUID(),
    );
    const enrollment = { ...f.enrollment, pairingToken: pair.pairingToken };
    for (const changed of [
      { hostIdentity: randomUUID() },
      { machineId: randomUUID() },
      { hostOs: "windows" as const },
      { architecture: "amd64" as const },
      { pairingToken: `hcp_${"z".repeat(43)}` },
    ])
      await expect(
        f.service.enroll({ ...enrollment, ...changed }),
      ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    const row = await f.db.get<Record<string, unknown>>(
      "SELECT credential_hash,enrollment_hash FROM agents WHERE id=?",
      [pair.agentId],
    );
    expect(row?.enrollment_hash).toBe(
      createHash("sha256").update(pair.pairingToken).digest("hex"),
    );
    expect(JSON.stringify(row)).not.toContain(pair.pairingToken);
    f.setNow(f.now() + 300_000);
    await expect(f.service.enroll(enrollment)).rejects.toMatchObject({
      code: "STORAGE_CAS_FAILED",
    });
    const replacement = await f.service.pair(
      {
        machineId: f.machineId,
        hostIdentity: f.hostIdentity,
        expectedSessionEpoch: 2,
        reason: "unused token lost",
      },
      f.adminId,
      randomUUID(),
    );
    await expect(f.service.enroll(enrollment)).rejects.toMatchObject({
      code: "STORAGE_CAS_FAILED",
    });
    const enrolled = await f.service.enroll({
      ...enrollment,
      pairingToken: replacement.pairingToken,
    });
    expect(await f.service.view(pair.agentId)).toMatchObject({
      paired: true,
      status: "active",
      sessionEpoch: 2,
    });
    expect(
      (
        await f.db.get<{ credential_hash: string }>(
          "SELECT credential_hash FROM agents WHERE id=?",
          [pair.agentId],
        )
      )?.credential_hash,
    ).toBe(createHash("sha256").update(enrolled.credential).digest("hex"));
  });
  it("reauthenticates inside the heartbeat transaction when revocation wins after the initial read", async () => {
    const f = await fixture();
    await f.service.heartbeat(f.pair.agentId, f.authorization, f.heartbeat());
    let intercept = true;
    const storage: Storage = {
      ...f.db,
      get: async <T>(
        sql: string,
        params?: readonly import("../src/storage/protocol.js").SqlValue[],
      ) => {
        const row = await f.db.get<T>(sql, params);
        if (intercept && sql.startsWith("SELECT * FROM agents WHERE")) {
          intercept = false;
          await f.service.revoke(
            f.pair.agentId,
            1,
            "revoked during heartbeat",
            f.adminId,
            randomUUID(),
          );
        }
        return row;
      },
    };
    const service = new HostAgents(storage, () => f.now());
    await expect(
      service.heartbeat(f.pair.agentId, f.authorization, f.heartbeat(1)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    expect(
      (
        await f.db.get<{ sequence: bigint }>(
          "SELECT sequence FROM machine_snapshots WHERE machine_id=?",
          [f.machineId],
        )
      )?.sequence,
    ).toBe(0n);
    expect(await f.service.snapshot(f.machineId)).toMatchObject({
      fresh: false,
      humanPresence: "unknown",
    });
  });
});
