import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStorage, type Storage } from "../dist/storage/index.js";
import {
  MaintenanceService,
  admissionOpen,
} from "../src/application/maintenance.js";
import {
  restoreBackup,
  acceptRecoveryControls,
  approveRecovery,
} from "../dist/application/recovery.js";
import { TicketService } from "../src/application/tickets.js";
import { OperationWorker } from "../src/application/operations.js";
import { PersistentSimulator } from "../src/providers/simulator.js";
import { TicketQueries } from "../src/application/queries.js";
import { SQLiteIdentityStore } from "../src/storage/identity-store.js";
import { pruneHistory } from "../src/storage/history-retention.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { recoveryControlVerifier } from "../src/providers/recovery-control.js";
import { SQLiteImageCacheStore } from "../src/storage/image-cache-store.js";
import { SQLiteImageValidationStore } from "../src/storage/image-validation-store.js";
import { HitchletClient } from "../../../packages/sdk/src/index.js";
import { RotatingLog } from "../src/rotating-log.js";

const dirs: string[] = [],
  dbs: Storage[] = [],
  apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of dbs.splice(0)) await db.close().catch(() => undefined);
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-d23-"));
  dirs.push(dir);
  return dir;
}
async function fixture() {
  const dir = await directory();
  const init = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist/init-simulator.js")],
    { encoding: "utf8", env: { ...process.env, DATA_DIR: dir } },
  );
  expect(init.status, init.stderr).toBe(0);
  const db = await openStorage(dir);
  dbs.push(db);
  const consumer = (await db.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='consumer'",
    ))!.id,
    admin = (await db.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='admin'",
    ))!.id;
  const image = (await db.get<{ id: string }>("SELECT id FROM images"))!.id,
    network = (await db.get<{ id: string }>("SELECT id FROM network_profiles"))!
      .id,
    installation = (await db.get<{ installation_id: string }>(
      "SELECT installation_id FROM installations",
    ))!.installation_id;
  const token = /Initial admin bearer token \(shown once\): (\S+)/.exec(
    init.stdout,
  )![1]!;
  const tickets = new TicketService({
    storage: db,
    installationId: installation,
  });
  const worker = new OperationWorker({
    storage: db,
    installationId: installation,
    execution: new PersistentSimulator(join(dir, "runtime")),
  });
  const request = {
    image: { imageId: image, alias: "latest" },
    resources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 1024 },
    networkProfileId: network,
    lease: { requestedSeconds: 900 },
  };
  return {
    dir,
    db,
    consumer,
    admin,
    token,
    tickets,
    worker,
    request,
    installation,
  };
}
describe("D23 operational lifecycle", () => {
  it("creates and replays a backup through the real SDK fetch and Fastify HTTP JSON parser", async () => {
    const f = await fixture(),
      app = await buildApp(
        loadConfig({ DATA_DIR: f.dir, LOG_LEVEL: "silent" }),
        { storage: f.db },
      );
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new HitchletClient(address, {
      auth: { kind: "bearer", token: f.token },
    });
    const first = await client.admin.backup("real-http-backup"),
      replay = await client.admin.backup("real-http-backup");
    expect(replay).toEqual(first);
    expect(await client.admin.backups()).toEqual([first]);
    expect(
      await f.db.get(
        "SELECT count(*) n FROM operations WHERE kind='system.backup'",
      ),
    ).toEqual({ n: 1n });
    const invalid = await fetch(`${address}/v1/system/backups`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
        "idempotency-key": "invalid-body",
      },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(invalid.status).toBe(422);
    const openapi = (await (
      await fetch(`${address}/v1/openapi.json`)
    ).json()) as {
      paths: Record<
        string,
        {
          post: {
            requestBody: {
              required: boolean;
              content: Record<string, { schema: unknown }>;
            };
          };
        }
      >;
    };
    expect(openapi.paths["/v1/system/backups"]!.post.requestBody).toMatchObject(
      {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: false },
          },
        },
      },
    );
  });

  it("online backup includes committed WAL, is checked, and serializes following writes and close", async () => {
    const dir = await directory(),
      db = await openStorage(dir);
    dbs.push(db);
    await db.run("CREATE TABLE proof(id INTEGER PRIMARY KEY,value TEXT)");
    await db.run("INSERT INTO proof VALUES(1,'committed-in-WAL')");
    const file = join(dir, "snapshot.sqlite");
    const backup = db.backup(file),
      write = db.run("INSERT INTO proof VALUES(2,'after-backup')"),
      close = db.close();
    await Promise.all([backup, write, close]);
    const snapshot = new Database(file, { readonly: true });
    expect(snapshot.prepare("SELECT value FROM proof").all()).toEqual([
      { value: "committed-in-WAL" },
    ]);
    expect(snapshot.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
    snapshot.close();
    const live = await openStorage(dir);
    dbs.push(live);
    expect(await live.get("SELECT count(*) n FROM proof")).toEqual({ n: 2n });
  });
  it("low/full/unknown disk blocks new work while the ordinary cleanup path still releases capacity", async () => {
    const f = await fixture();
    const ticket = await f.tickets.acquire(f.consumer, "before-low", f.request);
    await f.tickets.reserveNext();
    await f.worker.reconcile();
    expect(
      (await new TicketQueries(f.db).get(f.consumer, ticket.ticketId))?.phase,
    ).toBe("ready");
    let free = 50;
    const space = async () =>
      ({ bavail: free, bsize: 1048576 }) as Awaited<
        ReturnType<typeof import("node:fs/promises").statfs>
      >;
    const maintenance = new MaintenanceService(
      f.db,
      f.dir,
      { lowWaterMiB: 100, reserveMiB: 10 },
      Date.now,
      space,
    );
    expect((await maintenance.sampleDisk()).admission).toBe("disk_low");
    expect(await admissionOpen(f.db)).toBe(false);
    expect(await f.tickets.reserveNext()).toBeNull();
    await expect(
      f.tickets.acquire(f.consumer, "during-low", f.request),
    ).rejects.toMatchObject({ code: "STORAGE_MAINTENANCE" });
    await f.tickets.cancel(ticket.ticketId, f.consumer);
    await f.worker.reconcile();
    expect(
      (await new TicketQueries(f.db).get(f.consumer, ticket.ticketId))?.phase,
    ).toBe("released");
    expect(
      await f.db.get(
        "SELECT count(*) n FROM capacity_claims WHERE state<>'released'",
      ),
    ).toEqual({ n: 0n });
    free = 0;
    expect((await maintenance.sampleDisk()).admission).toBe("disk_full");
    await maintenance.maintain();
    expect(await maintenance.backups()).toHaveLength(0);
    const unknown = new MaintenanceService(
      f.db,
      f.dir,
      { lowWaterMiB: 100, reserveMiB: 10 },
      Date.now,
      async () => {
        throw new Error("unavailable");
      },
    );
    expect((await unknown.sampleDisk()).admission).toBe("disk_unknown");
    free = 200;
    expect((await maintenance.sampleDisk()).admission).toBe("open");
    expect(await admissionOpen(f.db)).toBe(true);
  });
  it("restores a real temporary database in isolation, rejects old credentials, and requires explicit takeover and approval", async () => {
    const f = await fixture(),
      maintenance = new MaintenanceService(f.db, f.dir);
    const view = await maintenance.backup();
    const target = await directory(),
      restored = await restoreBackup({
        backupFile: join(f.dir, "backups", `${view.id}.sqlite`),
        destination: target,
        oldControllerStopped: true,
      });
    const db = await openStorage(target);
    dbs.push(db);
    const identity = new SQLiteIdentityStore(db);
    const hash = await import("node:crypto");
    expect(
      await identity.bearer(
        f.token.slice(0, 12),
        hash.createHash("sha256").update(f.token).digest("hex"),
      ),
    ).toBeUndefined();
    expect(
      await identity.bearer(
        restored.adminToken.slice(0, 12),
        hash.createHash("sha256").update(restored.adminToken).digest("hex"),
      ),
    ).toBeDefined();
    expect(await admissionOpen(db)).toBe(false);
    await expect(
      new MaintenanceService(db, target).resume("before checks"),
    ).rejects.toBeDefined();
    await expect(
      approveRecovery(db, f.admin, randomUUID(), "too early"),
    ).rejects.toThrow("control");
    await acceptRecoveryControls(
      db,
      { oldControllerStopped: true, connections: [], runtimes: [] },
      {
        provider: async () => {
          throw new Error("unexpected simulator provider");
        },
        runtime: async () => {
          throw new Error("unexpected simulator runtime");
        },
      },
    );
    await approveRecovery(
      db,
      f.admin,
      randomUUID(),
      "isolated fixture reviewed",
    );
    expect(await admissionOpen(db)).toBe(false);
    await new MaintenanceService(db, target).resume("explicit admin open");
    expect(await admissionOpen(db)).toBe(true);
    await db.check();
    expect(
      await f.db.get(
        "SELECT count(*) n FROM consumer_credentials WHERE revoked_at_ms IS NULL",
      ),
    ).toEqual({ n: 2n });
    await expect(
      restoreBackup({
        backupFile: join(f.dir, "backups", `${view.id}.sqlite`),
        destination: target,
        oldControllerStopped: true,
      }),
    ).rejects.toThrow("empty isolated");
  });
  it("preserves pre-upgrade bytes and stays closed when a real migration fails", async () => {
    const dir = await directory();
    const raw = new Database(join(dir, "v6.sqlite"));
    for (const name of (
      await readdir(join(process.cwd(), "src/storage/migrations"))
    )
      .filter((f) => /^00[1-6]-/.test(f))
      .sort())
      raw.exec(
        await readFile(
          join(process.cwd(), "src/storage/migrations", name),
          "utf8",
        ),
      );
    raw.exec(
      "CREATE TABLE system_maintenance(collision TEXT); INSERT INTO system_maintenance VALUES('preserve-me')",
    );
    raw.close();
    const destination = await directory();
    await expect(
      restoreBackup({
        backupFile: join(dir, "v6.sqlite"),
        destination,
        oldControllerStopped: true,
      }),
    ).rejects.toMatchObject({ code: "STORAGE_OPEN_FAILED" });
    expect(
      JSON.parse(
        await readFile(join(destination, "maintenance-state.json"), "utf8"),
      ),
    ).toMatchObject({ state: "migration_failed", admission: "closed" });
    const backups = await readdir(join(destination, "backups"));
    expect(backups).toHaveLength(1);
    const old = new Database(join(destination, "backups", backups[0]!), {
      readonly: true,
    });
    expect(old.prepare("SELECT * FROM system_maintenance").get()).toEqual({
      collision: "preserve-me",
    });
    expect(
      old.prepare("SELECT max(version) n FROM schema_migrations").get(),
    ).toEqual({ n: 6 });
    old.close();
  });
  it("rotates credentials and all derived sessions atomically, with admin-only no-store API", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({ DATA_DIR: f.dir, LOG_LEVEL: "silent" }),
      { storage: f.db },
    );
    apps.push(app);
    const cred = (await f.db.get<{ id: string }>(
      "SELECT id FROM consumer_credentials WHERE consumer_id=?",
      [f.admin],
    ))!.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/system/credentials/rotate",
          payload: { consumerId: f.admin, credentialId: cred },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(login.statusCode).toBe(201);
    const rotated = await app.inject({
      method: "POST",
      url: "/v1/system/credentials/rotate",
      headers: { authorization: `Bearer ${f.token}` },
      payload: { consumerId: f.admin, credentialId: cred },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await app.inject({
          url: "/v1/system/health",
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await f.db.get(
        "SELECT count(*) n FROM gui_sessions WHERE revoked_at_ms IS NULL",
      ),
    ).toEqual({ n: 0n });
    expect(
      (
        await app.inject({
          url: "/v1/system/health",
          headers: { authorization: `Bearer ${rotated.json().token}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      JSON.stringify(
        await f.db.all("SELECT safe_details_json FROM audit_entries"),
      ),
    ).not.toContain(rotated.json().token);
  });
  it("prunes old terminal graphs while preserving pending/current JSON references and exact event references", async () => {
    const f = await fixture(),
      now = Date.now();
    const ticket = await f.tickets.acquire(
      f.consumer,
      "old-history",
      f.request,
    );
    await f.tickets.cancel(ticket.ticketId, f.consumer);
    await f.db.run(
      "UPDATE tickets SET released_at_ms=?,updated_at_ms=? WHERE id=?",
      [now - 181 * 86400000, now - 181 * 86400000, ticket.ticketId],
    );
    await f.db.run("UPDATE policies SET config_json=?", [
      JSON.stringify({ recoveryTicket: ticket.ticketId }),
    ]);
    expect((await pruneHistory(f.db, now)).tickets).toBe(0);
    await f.db.run("UPDATE policies SET config_json='{}'");
    expect((await pruneHistory(f.db, now)).tickets).toBe(1);
    expect(
      await f.db.get("SELECT id FROM tickets WHERE id=?", [ticket.ticketId]),
    ).toBeUndefined();
    await f.db.run(
      "INSERT INTO events(id,aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES(123,'installation','past',1,'past',1,'{}')",
    );
    await f.db.run(
      "UPDATE image_versions SET manifest_json='{\"unrelatedNumber\":12345}'",
    );
    await pruneHistory(f.db, now);
    expect(
      await f.db.get("SELECT id FROM events WHERE id=123"),
    ).toBeUndefined();
  });
  it("replays accepted acquisition during pause and recovers an interrupted backup receipt", async () => {
    const f = await fixture(),
      app = await buildApp(
        loadConfig({ DATA_DIR: f.dir, LOG_LEVEL: "silent" }),
        { storage: f.db },
      );
    apps.push(app);
    const consumerCredential = (
      await new MaintenanceService(f.db, f.dir).credentials(f.consumer)
    )[0]!;
    const receipt = await new MaintenanceService(f.db, f.dir).rotateCredential(
      f.consumer,
      consumerCredential.credentialId,
    );
    const request = {
      method: "POST" as const,
      url: "/v1/tickets",
      headers: {
        authorization: `Bearer ${receipt.token}`,
        "idempotency-key": "accepted-before-pause",
      },
      payload: f.request,
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(202);
    await new MaintenanceService(f.db, f.dir).pause("operator pause");
    const replay = await app.inject(request);
    expect(replay.statusCode).toBeLessThan(300);
    expect(replay.json().ticket.id).toBe(first.json().ticket.id);
    expect(
      (
        await app.inject({
          ...request,
          headers: {
            ...request.headers,
            "idempotency-key": "new-during-pause",
          },
        })
      ).statusCode,
    ).toBe(503);
    const maintenance = new MaintenanceService(f.db, f.dir),
      backup = await maintenance.backup("replay", f.admin);
    await f.db.run(
      "UPDATE operations SET state='running',result_json=NULL WHERE id=?",
      [backup.id],
    );
    expect(await maintenance.backup("replay", f.admin)).toEqual(backup);
    expect(await maintenance.backups()).toHaveLength(1);
    await f.db.run("UPDATE system_maintenance SET disk_state='low'");
    expect(await maintenance.backup("replay", f.admin)).toEqual(backup);
    await expect(
      maintenance.backup("genuinely-new", f.admin),
    ).rejects.toMatchObject({ code: "STORAGE_MAINTENANCE" });
    await f.db.run(
      "UPDATE operations SET state='running',result_json=NULL WHERE id=?",
      [backup.id],
    );
    expect(await maintenance.backup("replay", f.admin)).toEqual(backup);
  });
  it("latches a real SQLITE_FULL error until a successful probe", async () => {
    const dir = await directory(),
      db = await openStorage(dir);
    dbs.push(db);
    await db.run("CREATE TABLE fill(data BLOB)");
    const pages = await db.get<{ page_count: bigint }>("PRAGMA page_count");
    await db.run(`PRAGMA max_page_count=${pages!.page_count}`);
    await expect(
      db.run("INSERT INTO fill VALUES(zeroblob(1048576))"),
    ).rejects.toMatchObject({ code: "STORAGE_FULL" });
    expect(await admissionOpen(db)).toBe(false);
    await db.run("PRAGMA max_page_count=2147483646");
    await new MaintenanceService(
      db,
      dir,
      { lowWaterMiB: 10, reserveMiB: 1 },
      Date.now,
      async () =>
        ({ bavail: 100, bsize: 1048576 }) as Awaited<
          ReturnType<typeof import("node:fs/promises").statfs>
        >,
    ).sampleDisk();
    expect(await admissionOpen(db)).toBe(true);
  });
  it("requires fresh runtime capacity and rechecks it inside allocation insertion with no mounts", async () => {
    const f = await fixture(),
      node = (await f.db.get<{ id: string }>("SELECT id FROM nodes"))!;
    await f.db.run(
      "UPDATE nodes SET config_json=json_set(config_json,'$.executionMode','portainer')",
    );
    const time = Date.now(),
      allocation = randomUUID();
    const insert = {
      kind: "run" as const,
      sql: "INSERT INTO allocations(id,purpose,machine_id,node_id,runtime_identity_id,image_artifact_id,generation,desired_state,resource_contract_json,ownership_json,created_at_ms,updated_at_ms) SELECT ?,'infrastructure',n.machine_id,n.id,n.runtime_identity_id,a.id,1,'present',?,'{}',?,? FROM nodes n CROSS JOIN image_artifacts a LIMIT 1",
      params: [
        allocation,
        JSON.stringify({ request: f.request.resources }),
        time,
        time,
      ],
    };
    const facts = async (state: string, at = time) =>
      f.db.run("UPDATE system_maintenance SET runtime_disks_json=?", [
        JSON.stringify({
          [node.id]: {
            nodeId: node.id,
            state,
            availableMiB: 100000,
            reserveMiB: 128,
            observedAtMs: at,
            sampledAtMs: time + 5000,
          },
        }),
      ]);
    expect(await admissionOpen(f.db, node.id, time)).toBe(false);
    await expect(f.db.batchTransaction([insert])).rejects.toMatchObject({
      code: "STORAGE_MAINTENANCE",
    });
    await facts("unknown");
    expect(await admissionOpen(f.db, node.id, time)).toBe(false);
    await facts("healthy", time - 31000);
    expect(await admissionOpen(f.db, node.id, time)).toBe(false);
    await expect(f.db.batchTransaction([insert])).rejects.toMatchObject({
      code: "STORAGE_MAINTENANCE",
    });
    await facts("healthy", time + 10);
    expect(await admissionOpen(f.db, node.id, time)).toBe(false);
    await expect(f.db.batchTransaction([insert])).rejects.toMatchObject({
      code: "STORAGE_MAINTENANCE",
    });
    await facts("healthy");
    expect(await admissionOpen(f.db, node.id, time)).toBe(true);
    // A previously successful application read cannot authorize the later SQL
    // reservation when another observation has changed the capacity fact.
    await facts("full");
    await expect(f.db.batchTransaction([insert])).rejects.toMatchObject({
      code: "STORAGE_MAINTENANCE",
    });
    expect(await f.db.get("SELECT count(*) n FROM allocations")).toEqual({
      n: 0n,
    });
    await facts("healthy");
    await f.db.batchTransaction([insert]);
    expect(await f.db.get("SELECT count(*) n FROM allocations")).toEqual({
      n: 1n,
    });
  });
  it("keeps a restored ready lease and quarantines validation without a lease after authenticated takeover", async () => {
    const f = await fixture(),
      ticket = await f.tickets.acquire(f.consumer, "restore-ready", f.request);
    await f.tickets.reserveNext();
    await f.worker.reconcile();
    const original = await f.db.get<{
      id: string;
      node_id: string;
      image_artifact_id: string;
    }>(
      "SELECT id,node_id,image_artifact_id FROM allocations WHERE ticket_id=?",
      [ticket.ticketId],
    );
    const validation = randomUUID(),
      allocation = randomUUID(),
      time = Date.now();
    await f.db.run(
      "INSERT INTO image_validations(id,image_artifact_id,node_id,requested_by_consumer_id,accepted_contract_json,deadline_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'{}',?,?,?)",
      [
        validation,
        original!.image_artifact_id,
        original!.node_id,
        f.admin,
        time + 600000,
        time,
        time,
      ],
    );
    await f.db.run(
      "INSERT INTO allocations(id,purpose,image_validation_id,machine_id,node_id,runtime_identity_id,image_artifact_id,generation,desired_state,resource_contract_json,ownership_json,created_at_ms,updated_at_ms) SELECT ?,'validation',?,machine_id,node_id,runtime_identity_id,image_artifact_id,1,'present',resource_contract_json,ownership_json,?,? FROM allocations WHERE id=?",
      [allocation, validation, time, time, original!.id],
    );
    await f.db.run(
      "INSERT INTO capacity_claims(id,allocation_id,pool_id,state,cpu_millis,memory_mib,scratch_mib,created_at_ms,updated_at_ms) SELECT ?,?,pool_id,'reserved',1,1,1,?,? FROM capacity_claims LIMIT 1",
      [randomUUID(), allocation, time, time],
    );
    const sourceLease = await f.db.get(
      "SELECT id,expires_at_ms,claimed_at_ms FROM leases WHERE ticket_id=?",
      [ticket.ticketId],
    );
    const view = await new MaintenanceService(f.db, f.dir).backup(),
      target = await directory();
    await restoreBackup({
      backupFile: join(f.dir, "backups", `${view.id}.sqlite`),
      destination: target,
      oldControllerStopped: true,
    });
    const db = await openStorage(target);
    dbs.push(db);
    // Inject authenticated takeover evidence; the external Docker verifier is
    // independently exercised by the main review on the real isolated Engine.
    const profile = {
      accessHost: "192.0.2.1",
      networkCidrBase: "172.25.0.0/16",
      userlandProxy: false,
      managementDenyRevisionId: randomUUID(),
      managementDenyRules: [],
      runtimeAgent: {
        id: randomUUID(),
        baseUrl: "https://agent.test",
        tokenSecretRef: `secret:${"a".repeat(32)}`,
        caSecretRef: `secret:${"b".repeat(32)}`,
        clientCertSecretRef: `secret:${"c".repeat(32)}`,
        clientKeySecretRef: `secret:${"d".repeat(32)}`,
      },
    };
    const state = JSON.parse(
      (await db.get<{ recovery_json: string }>(
        "SELECT recovery_json FROM system_maintenance",
      ))!.recovery_json,
    );
    state.oldRuntimeProfiles = [
      {
        nodeId: original!.node_id,
        runtimeIdentityId: (await db.get<{ runtime_identity_id: string }>(
          "SELECT runtime_identity_id FROM nodes",
        ))!.runtime_identity_id,
        runtimeProfile: profile,
      },
    ];
    state.oldConnectionRevisions = [];
    // reconciling means all old credentials were rejected and inventory read.
    state.stage = "reconciling";
    await db.run("UPDATE system_maintenance SET recovery_json=?", [
      JSON.stringify(state),
    ]);
    await db.run("UPDATE allocations SET observed_state='running' WHERE id=?", [
      original!.id,
    ]);
    await db.run(
      "UPDATE operations SET result_json=json_set(result_json,'$.integrity',json(?)),controller_epoch=(SELECT controller_epoch FROM installations) WHERE allocation_id=? AND kind='allocation.provision'",
      [
        JSON.stringify({ state: "healthy", observedAtMs: Date.now() }),
        original!.id,
      ],
    );
    await approveRecovery(
      db,
      f.admin,
      randomUUID(),
      "fresh authenticated inventory and integrity reviewed",
    );
    expect(
      await db.get(
        "SELECT id,expires_at_ms,claimed_at_ms FROM leases WHERE ticket_id=?",
        [ticket.ticketId],
      ),
    ).toEqual(sourceLease);
    expect(
      await db.get("SELECT state FROM capacity_claims WHERE allocation_id=?", [
        allocation,
      ]),
    ).toEqual({ state: "quarantined" });
    expect(
      await db.get("SELECT admission FROM nodes WHERE id=?", [
        original!.node_id,
      ]),
    ).toEqual({ admission: "disabled" });
    expect(await admissionOpen(db)).toBe(false);
  });
  it("prunes an old graph despite an unrelated concurrent event, but preserves a newly present owned resource", async () => {
    const f = await fixture(),
      time = Date.now();
    const ticket = await f.tickets.acquire(
      f.consumer,
      "retention-race",
      f.request,
    );
    await f.tickets.reserveNext();
    await f.worker.reconcile();
    await f.tickets.cancel(ticket.ticketId, f.consumer);
    await f.worker.reconcile();
    await f.db.run(
      "UPDATE tickets SET released_at_ms=?,updated_at_ms=? WHERE id=?",
      [time - 181 * 86400000, time - 181 * 86400000, ticket.ticketId],
    );
    const resource = (await f.db.get<{ id: string }>(
      "SELECT m.id FROM managed_resources m JOIN allocations a ON a.id=m.allocation_id WHERE a.ticket_id=? AND m.ownership='owned' LIMIT 1",
      [ticket.ticketId],
    ))!;
    const batch = f.db.batchTransaction.bind(f.db);
    let race = true;
    vi.spyOn(f.db, "batchTransaction").mockImplementation(
      async (statements) => {
        if (
          race &&
          statements.some((s) => s.sql.startsWith("DELETE FROM tickets"))
        ) {
          race = false;
          await f.db.run(
            "UPDATE managed_resources SET observed_state='present' WHERE id=?",
            [resource.id],
          );
        }
        return batch(statements);
      },
    );
    expect((await pruneHistory(f.db, time)).tickets).toBe(0);
    expect(
      await f.db.get("SELECT id FROM tickets WHERE id=?", [ticket.ticketId]),
    ).toBeDefined();
    await f.db.run(
      "UPDATE managed_resources SET observed_state='absent' WHERE id=?",
      [resource.id],
    );
    vi.spyOn(f.db, "batchTransaction").mockImplementation(
      async (statements) => {
        if (statements.some((s) => s.sql.startsWith("DELETE FROM tickets")))
          await f.db.run(
            "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES('installation','unrelated',1,'unrelated',?,'{}')",
            [time],
          );
        return batch(statements);
      },
    );
    expect((await pruneHistory(f.db, time)).tickets).toBe(1);
  });
  it("continues healthy daily backups during an administrator pause", async () => {
    const f = await fixture(),
      maintenance = new MaintenanceService(
        f.db,
        f.dir,
        { lowWaterMiB: 10, reserveMiB: 1 },
        Date.now,
        async () =>
          ({ bavail: 100, bsize: 1048576 }) as Awaited<
            ReturnType<typeof import("node:fs/promises").statfs>
          >,
      );
    await maintenance.pause("new admission paused");
    await maintenance.maintain();
    expect(await maintenance.backups()).toHaveLength(1);
    expect(await admissionOpen(f.db)).toBe(false);
  });
  it("treats a reappearing completed allocation as unknown inventory", async () => {
    const f = await fixture(),
      ticket = await f.tickets.acquire(f.consumer, "reappeared", f.request);
    await f.tickets.reserveNext();
    await f.worker.reconcile();
    const row = (await f.db.get<{
      id: string;
      node_id: string;
      generation: bigint;
      contract_hash: string;
      operation_id: string;
    }>(
      "SELECT a.id,a.node_id,a.generation,c.contract_hash,o.id operation_id FROM allocations a JOIN resolved_provision_contracts c ON c.id=a.resolved_provision_contract_id JOIN operations o ON o.allocation_id=a.id AND o.kind='allocation.provision' WHERE a.ticket_id=?",
      [ticket.ticketId],
    ))!;
    await f.tickets.cancel(ticket.ticketId, f.consumer);
    await f.worker.reconcile();
    const profile = {
      accessHost: "192.0.2.1",
      networkCidrBase: "172.25.0.0/16",
      userlandProxy: false,
      managementDenyRevisionId: randomUUID(),
      managementDenyRules: [],
      runtimeAgent: {
        id: randomUUID(),
        baseUrl: "https://agent.test",
        tokenSecretRef: `secret:${"a".repeat(32)}`,
        caSecretRef: `secret:${"b".repeat(32)}`,
        clientCertSecretRef: `secret:${"c".repeat(32)}`,
        clientKeySecretRef: `secret:${"d".repeat(32)}`,
      },
    };
    let calls = 0;
    const verifier = recoveryControlVerifier(
      f.db,
      { get: async () => "unused" },
      () => ({
        storageFacts: async (request) => {
          if (calls++ === 0) throw new Error("Runtime Agent returned HTTP 401");
          return {
            ...request,
            observedAtMs: Date.now(),
            receivedAtMs: Date.now(),
            controllerEpoch: 55,
            imageStore: { root: "/fixture", availableMiB: 10000 },
            mounts: [],
            inventory: [
              {
                kind: "container",
                id: "reappeared",
                allocationId: row.id,
                generation: String(row.generation),
                contractHash: row.contract_hash,
                operationId: row.operation_id,
              },
            ],
          };
        },
      }),
    );
    expect(await verifier.runtime(profile, profile, row.node_id)).toEqual({
      controllerEpoch: 55,
      unknownResources: 1,
    });
  });
  it("verifies every historical logical connection credential and the unique Node Agent once", async () => {
    const f = await fixture(),
      node = (await f.db.get<{
        id: string;
        runtime_identity_id: string;
        provider_connection_id: string;
      }>("SELECT id,runtime_identity_id,provider_connection_id FROM nodes"))!;
    await expect(
      f.db.run(
        "INSERT INTO nodes(id,machine_id,name,backend_kind,provider_connection_id,runtime_identity_id,pool_id,created_at_ms,updated_at_ms) SELECT ?,machine_id,'duplicate','portainer',provider_connection_id,runtime_identity_id,pool_id,created_at_ms,updated_at_ms FROM nodes WHERE id=?",
        [randomUUID(), node.id],
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    const profile = {
      accessHost: "192.0.2.1",
      networkCidrBase: "172.25.0.0/16",
      userlandProxy: false,
      managementDenyRevisionId: randomUUID(),
      managementDenyRules: [],
      runtimeAgent: {
        id: randomUUID(),
        baseUrl: "https://agent.test",
        tokenSecretRef: `secret:${"a".repeat(32)}`,
        caSecretRef: `secret:${"b".repeat(32)}`,
        clientCertSecretRef: `secret:${"c".repeat(32)}`,
        clientKeySecretRef: `secret:${"d".repeat(32)}`,
      },
    };
    const oldConnections: {
        connectionId: string;
        runtimeIdentityId: string;
        revisionId: string;
        secretVersionRef: string | null;
      }[] = [],
      connections: { connectionId: string; revisionId: string }[] = [];
    const old = (await f.db.get<{ id: string }>(
      "SELECT id FROM provider_connection_revisions WHERE connection_id=?",
      [node.provider_connection_id],
    ))!.id;
    oldConnections.push({
      connectionId: node.provider_connection_id,
      runtimeIdentityId: node.runtime_identity_id,
      revisionId: old,
      secretVersionRef: null,
    });
    for (const [connectionId, start] of [
      [node.provider_connection_id, 2],
      [randomUUID(), 1],
    ] as const) {
      if (start === 1)
        await f.db.run(
          "INSERT INTO provider_connections(id,backend_kind,runtime_identity_id,created_at_ms,updated_at_ms) VALUES(?,'portainer',?,?,?)",
          [connectionId, node.runtime_identity_id, Date.now(), Date.now()],
        );
      for (let revision = start; revision <= start + 1; revision++) {
        const id = randomUUID();
        const ref = `secret:${(revision === start ? "e" : "f").repeat(32)}`;
        await f.db.run(
          "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,secret_version_ref,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) VALUES(?,?,?,'https://portainer.test','1',?,?,?,'{}',?)",
          [
            id,
            connectionId,
            revision,
            ref,
            node.runtime_identity_id,
            Date.now(),
            Date.now(),
          ],
        );
        if (revision === start)
          oldConnections.push({
            connectionId,
            runtimeIdentityId: node.runtime_identity_id,
            revisionId: id,
            secretVersionRef: ref,
          });
        else {
          connections.push({ connectionId, revisionId: id });
          await f.db.run(
            "UPDATE provider_connections SET current_revision_id=? WHERE id=?",
            [id, connectionId],
          );
        }
      }
    }
    await f.db.run("UPDATE system_maintenance SET paused=1,recovery_json=?", [
      JSON.stringify({
        id: randomUUID(),
        restoredAtMs: Date.now(),
        stage: "controls_required",
        oldConnectionRevisions: oldConnections,
        oldRuntimeProfiles: [
          {
            nodeId: node.id,
            runtimeIdentityId: node.runtime_identity_id,
            runtimeProfile: profile,
          },
        ],
        restoredAllocationIds: [],
        quarantinedNodes: [],
      }),
    ]);
    const provider = vi.fn(async () => {}),
      runtime = vi.fn(async () => ({
        controllerEpoch: 57,
        unknownResources: 0,
      }));
    await acceptRecoveryControls(
      f.db,
      {
        oldControllerStopped: true,
        connections,
        runtimes: [
          {
            nodeId: node.id,
            runtimeProfile: {
              ...profile,
              runtimeAgent: {
                ...profile.runtimeAgent,
                tokenSecretRef: `secret:${"0".repeat(32)}`,
              },
            },
          },
        ],
      },
      { provider, runtime },
    );
    expect(provider.mock.calls).toHaveLength(3);
    expect(runtime).toHaveBeenCalledOnce();
    expect(
      await f.db.get("SELECT controller_epoch FROM installations"),
    ).toEqual({ controller_epoch: 58n });
    expect(await admissionOpen(f.db)).toBe(false);
  });
  it("executes exact cache eviction ledger steps while local disk is low", async () => {
    const f = await fixture();
    await f.db.run(
      "INSERT INTO image_caches(node_id,image_artifact_id,desired_state,observed_state,local_ref,digest_verified_at_ms) SELECT n.id,a.id,'present','ready',a.content_digest,? FROM nodes n CROSS JOIN image_artifacts a LIMIT 1",
      [Date.now()],
    );
    const cache = (await f.db.get<{
      node_id: string;
      image_artifact_id: string;
    }>("SELECT node_id,image_artifact_id FROM image_caches LIMIT 1"))!;
    const plan = await new SQLiteImageValidationStore(f.db).planCacheEviction({
      nodeId: cache.node_id,
      artifactId: cache.image_artifact_id,
    });
    expect(plan.state).toBe("queued");
    await f.db.run("UPDATE system_maintenance SET disk_state='low'");
    const store = new SQLiteImageCacheStore(f.db),
      op = (await store.claimDue())[0]!;
    expect(op.kind).toBe("image-cache.evict");
    expect(await store.evictionBlock(op)).toBeUndefined();
    expect(await store.markDeleteStarted(op, "exact-image")).toBe(true);
    expect(await store.markDeleteConfirmed(op)).toBe(true);
    expect(await store.recordAbsent(op)).toBe(true);
    expect(
      await f.db.get(
        "SELECT observed_state FROM image_caches WHERE node_id=? AND image_artifact_id=?",
        [cache.node_id, cache.image_artifact_id],
      ),
    ).toEqual({ observed_state: "missing" });
  });
  it("bounds log files, including oversized records", async () => {
    const dir = await directory(),
      stream = new RotatingLog(dir, 1024, 2);
    for (let i = 0; i < 8; i++)
      await new Promise<void>((resolve, reject) =>
        stream.write(Buffer.from("x".repeat(600) + "\n"), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    await new Promise<void>((resolve, reject) =>
      stream.write(Buffer.from("secret-sized".repeat(200)), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    stream.end();
    expect((await readdir(dir)).length).toBeLessThanOrEqual(3);
    expect(await readFile(join(dir, "controller.log"), "utf8")).toContain(
      "omitted",
    );
  });
});
