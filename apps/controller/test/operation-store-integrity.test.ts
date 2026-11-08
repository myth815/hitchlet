import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SQLiteOperationStore } from "../src/storage/operation-store.js";
import { StorageError, type Storage } from "../src/storage/index.js";
import type { Statement } from "../src/storage/protocol.js";

const directories: string[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(input: {
  phase?: string;
  desiredState?: string;
  controlVersion?: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), "hitchlet-integrity-audit-"));
  directories.push(directory);
  const db = new Database(join(directory, "audit.sqlite"));
  databases.push(db);
  db.exec(`
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, allocation_id TEXT, state TEXT, owner_token TEXT,
      version INTEGER, controller_epoch INTEGER, locked_until_ms INTEGER,
      result_json TEXT, updated_at_ms INTEGER
    );
    CREATE TABLE allocations (
      id TEXT PRIMARY KEY, ticket_id TEXT, desired_state TEXT, control_version INTEGER,
      actual_resources_json TEXT, observed_state TEXT, version INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE tickets (id TEXT PRIMARY KEY, phase TEXT, consumer_id TEXT, version INTEGER DEFAULT 1);
    CREATE TABLE installations (singleton INTEGER PRIMARY KEY, controller_epoch INTEGER);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT, aggregate_id TEXT,
      aggregate_version INTEGER, event_type TEXT, consumer_id TEXT,
      occurred_at_ms INTEGER, payload_json TEXT
    );
  `);
  const receipt = {
    identity: { allocationId: "allocation-1", controlVersion: 7 },
    access: {
      host: "192.0.2.44",
      port: 22,
      username: "hitchlet",
      hostKeyFingerprint: "SHA256:host",
      clientPublicKeyFingerprint: "SHA256:client",
    },
  };
  const actualResources = {
    receipt,
    manifestHash: "manifest-hash",
    objects: [{ id: "vm-1" }],
  };
  db.prepare("INSERT INTO installations VALUES(1, 3)").run();
  db.prepare("INSERT INTO tickets(id,phase,consumer_id) VALUES(?, ?, ?)").run(
    "ticket-1",
    input.phase ?? "ready",
    "consumer-1",
  );
  db.prepare("INSERT INTO allocations VALUES(?, ?, ?, ?, ?, ?, ?, ?)").run(
    "allocation-1",
    "ticket-1",
    input.desiredState ?? "present",
    input.controlVersion ?? 7,
    JSON.stringify(actualResources),
    "running",
    4,
    100,
  );
  db.prepare(
    "INSERT INTO operations(id,allocation_id,state,owner_token,version,controller_epoch,result_json,updated_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "operation-1",
    "allocation-1",
    "succeeded",
    "audit-token",
    9,
    3,
    JSON.stringify(receipt),
    100,
  );

  const storage: Storage = {
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...params);
      return {
        changes: BigInt(result.changes),
        lastInsertRowid: BigInt(result.lastInsertRowid),
      };
    },
    async get<T>(sql: string, params = []) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async batchTransaction(statements: readonly Statement[]) {
      const transaction = db.transaction(() =>
        statements.map((statement) => {
          const result = db
            .prepare(statement.sql)
            .run(...(statement.params ?? []));
          if (
            statement.kind === "run" &&
            statement.expectChanges !== undefined &&
            result.changes !== statement.expectChanges
          )
            throw new StorageError(
              "STORAGE_CAS_FAILED",
              "Compare-and-swap condition failed",
            );
          return result;
        }),
      );
      return transaction();
    },
    async backup(destination) {
      await db.backup(destination);
    },
    async check() {},
    async close() {
      db.close();
    },
  };
  return { db, store: new SQLiteOperationStore(storage) };
}

it.each([undefined, 41001])(
  "refreshes both ready receipt snapshots atomically after endpoint verification (port %s)",
  async (port) => {
    const { db, store } = await fixture({});
    expect(
      await store.recordIntegrityAudit({
        operationId: "operation-1",
        allocationId: "allocation-1",
        ticketId: "ticket-1",
        token: "audit-token",
        operationVersion: 9,
        controlVersion: 7,
        epoch: 3,
        now: 200,
        state: "healthy",
        endpointHost: "192.0.2.45",
        ...(port !== undefined ? { endpointPort: port } : {}),
      }),
    ).toBe(true);

    const operation = db
      .prepare("SELECT result_json FROM operations WHERE id='operation-1'")
      .get() as { result_json: string };
    const allocation = db
      .prepare(
        "SELECT actual_resources_json FROM allocations WHERE id='allocation-1'",
      )
      .get() as { actual_resources_json: string };
    expect(JSON.parse(operation.result_json)).toMatchObject({
      access: { host: "192.0.2.45", port: port ?? 22 },
      integrity: { state: "healthy" },
    });
    expect(JSON.parse(allocation.actual_resources_json)).toMatchObject({
      receipt: {
        access: {
          host: "192.0.2.45",
          port: port ?? 22,
          username: "hitchlet",
          hostKeyFingerprint: "SHA256:host",
          clientPublicKeyFingerprint: "SHA256:client",
        },
      },
      manifestHash: "manifest-hash",
      objects: [{ id: "vm-1" }],
    });
  },
);

it("rejects endpoint refresh after control-version change or release begins", async () => {
  for (const fence of [
    { controlVersion: 8 },
    { phase: "releasing", desiredState: "absent" },
  ]) {
    const { db, store } = await fixture(fence);
    expect(
      await store.recordIntegrityAudit({
        operationId: "operation-1",
        allocationId: "allocation-1",
        ticketId: "ticket-1",
        token: "audit-token",
        operationVersion: 9,
        controlVersion: 7,
        epoch: 3,
        now: 200,
        state: "healthy",
        endpointHost: "192.0.2.45",
        endpointPort: 41002,
      }),
    ).toBe(false);
    const allocation = db
      .prepare(
        "SELECT actual_resources_json,observed_state FROM allocations WHERE id='allocation-1'",
      )
      .get() as { actual_resources_json: string; observed_state: string };
    expect(
      JSON.parse(allocation.actual_resources_json).receipt.access.host,
    ).toBe("192.0.2.44");
    expect(allocation.observed_state).toBe("running");
    expect(db.prepare("SELECT * FROM events").all()).toHaveLength(0);
  }
});

it("journals unknown and recovery transitions once, retaining the unknown cause", async () => {
  const { db, store } = await fixture({});
  expect(
    await store.recordIntegrityAudit({
      operationId: "operation-1",
      allocationId: "allocation-1",
      ticketId: "ticket-1",
      token: "audit-token",
      operationVersion: 9,
      controlVersion: 7,
      epoch: 3,
      now: 200,
      state: "unknown",
      reason: "ssh_verification_failed",
    }),
  ).toBe(true);
  db.prepare(
    "UPDATE operations SET owner_token='audit-token-2' WHERE id=?",
  ).run("operation-1");
  expect(
    await store.recordIntegrityAudit({
      operationId: "operation-1",
      allocationId: "allocation-1",
      ticketId: "ticket-1",
      token: "audit-token-2",
      operationVersion: 10,
      controlVersion: 7,
      epoch: 3,
      now: 300,
      state: "unknown",
      reason: "ssh_verification_failed",
    }),
  ).toBe(true);
  db.prepare(
    "UPDATE operations SET owner_token='audit-token-3' WHERE id=?",
  ).run("operation-1");
  expect(
    await store.recordIntegrityAudit({
      operationId: "operation-1",
      allocationId: "allocation-1",
      ticketId: "ticket-1",
      token: "audit-token-3",
      operationVersion: 11,
      controlVersion: 7,
      epoch: 3,
      now: 400,
      state: "healthy",
    }),
  ).toBe(true);
  const events = db
    .prepare(
      "SELECT aggregate_type,aggregate_id,event_type,consumer_id,payload_json FROM events ORDER BY id",
    )
    .all() as Array<Record<string, string>>;
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    aggregate_type: "ticket",
    aggregate_id: "ticket-1",
    event_type: "allocation.observation_unknown",
    consumer_id: "consumer-1",
  });
  expect(JSON.parse(events[0]!.payload_json!)).toMatchObject({
    allocationId: "allocation-1",
    operationId: "operation-1",
    reason: "ssh_verification_failed",
  });
  expect(events[1]!.event_type).toBe("allocation.observation_recovered");
  expect(JSON.parse(events[1]!.payload_json!)).toMatchObject({
    allocationId: "allocation-1",
    operationId: "operation-1",
  });
  expect(JSON.parse(events[0]!.payload_json!).reason).toBe(
    "ssh_verification_failed",
  );
});

it("does not expose unsafe reasons in events or emit an event after a CAS miss", async () => {
  const { db, store } = await fixture({});
  expect(
    await store.recordIntegrityAudit({
      operationId: "operation-1",
      allocationId: "allocation-1",
      ticketId: "ticket-1",
      token: "audit-token",
      operationVersion: 9,
      controlVersion: 7,
      epoch: 3,
      now: 200,
      state: "unknown",
      reason: "raw-secret-value E:/private/path",
    }),
  ).toBe(true);
  const safeEvent = db.prepare("SELECT payload_json FROM events").get() as {
    payload_json: string;
  };
  expect(safeEvent.payload_json).not.toContain("raw-secret-value");
  expect(JSON.parse(safeEvent.payload_json).reason).toBe(
    "integrity_observation_failed",
  );

  const cas = await fixture({});
  expect(
    await cas.store.recordIntegrityAudit({
      operationId: "operation-1",
      allocationId: "allocation-1",
      ticketId: "ticket-1",
      token: "wrong-token",
      operationVersion: 9,
      controlVersion: 7,
      epoch: 3,
      now: 200,
      state: "unknown",
      reason: "raw-secret-value",
    }),
  ).toBe(false);
  expect(cas.db.prepare("SELECT * FROM events").all()).toHaveLength(0);
});
