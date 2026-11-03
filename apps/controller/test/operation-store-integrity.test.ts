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
    CREATE TABLE tickets (id TEXT PRIMARY KEY, phase TEXT);
    CREATE TABLE installations (singleton INTEGER PRIMARY KEY, controller_epoch INTEGER);
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
  db.prepare("INSERT INTO tickets VALUES(?, ?)").run(
    "ticket-1",
    input.phase ?? "ready",
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

it("refreshes both ready receipt snapshots atomically after endpoint verification", async () => {
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
    access: { host: "192.0.2.45" },
    integrity: { state: "healthy" },
  });
  expect(JSON.parse(allocation.actual_resources_json)).toMatchObject({
    receipt: {
      access: {
        host: "192.0.2.45",
        port: 22,
        username: "hitchlet",
        hostKeyFingerprint: "SHA256:host",
        clientPublicKeyFingerprint: "SHA256:client",
      },
    },
    manifestHash: "manifest-hash",
    objects: [{ id: "vm-1" }],
  });
});

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
  }
});
