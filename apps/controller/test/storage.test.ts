import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  openStorage,
  openStorageWithWorker,
  StorageError,
} from "../dist/storage/index.js";
import type { Storage } from "../dist/storage/index.js";

const dirs: string[] = [];
const opened: Storage[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-storage-"));
  dirs.push(dir);
  const storage = await openStorage(dir);
  opened.push(storage);
  return { dir, storage };
}
afterEach(async () => {
  await Promise.all(
    opened.splice(0).map((storage) => storage.close().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SQLite storage worker", () => {
  it("applies the full schema, is idempotent on restart, and uses the fixed driver baseline", async () => {
    const { dir, storage } = await fixture();
    const tables = await storage.all<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    expect(tables).toHaveLength(41);
    expect(
      await storage.get(
        "SELECT version FROM schema_migrations WHERE version = 1",
      ),
    ).toBeDefined();
    const version = await storage.get<{ version: string }>(
      "SELECT sqlite_version() AS version",
    );
    expect(version?.version).toMatch(/^3\.(5[1-9]|[6-9]\d)\.\d/);
    await storage.close();
    const restarted = await openStorage(dir);
    opened.push(restarted);
    expect(
      await restarted.get("SELECT count(*) AS count FROM schema_migrations"),
    ).toMatchObject({ count: 1n });
  });

  it("enforces foreign keys, immutable rows, and active grant cleanup guards", async () => {
    const { storage } = await fixture();
    await expect(
      storage.run(
        "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES ('cred','missing','pref','hash','[]',1)",
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    await storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO storage_profiles(id,name,created_at_ms) VALUES ('p','P',1)",
      },
      {
        kind: "run",
        sql: "INSERT INTO storage_profile_revisions(id,profile_id,revision,kind,config_json,created_at_ms) VALUES ('r','p',1,'nfs','{}',1)",
      },
    ]);
    await expect(
      storage.run(
        "UPDATE storage_profile_revisions SET config_json='{}' WHERE id='r'",
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    await storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO consumers(id,name,kind,authorization_json,quota_json,created_at_ms) VALUES ('c','C','agent','{}','{}',1)",
      },
      {
        kind: "run",
        sql: "INSERT INTO images(id,name,created_at_ms) VALUES ('i','I',1)",
      },
      {
        kind: "run",
        sql: "INSERT INTO image_versions(id,image_id,version,manifest_json,created_at_ms) VALUES ('iv','i','1','{}',1)",
      },
      {
        kind: "run",
        sql: "INSERT INTO network_profiles(id,name,created_at_ms) VALUES ('np','NP',1)",
      },
      {
        kind: "run",
        sql: "INSERT INTO network_profile_revisions(id,profile_id,revision,policy_json,created_at_ms) VALUES ('nr','np',1,'{}',1)",
      },
      {
        kind: "run",
        sql: "INSERT INTO tickets(id,consumer_id,image_version_id,network_profile_revision_id,request_json,request_hash,accepted_contract_json,requested_cpu_millis,requested_memory_mib,requested_scratch_mib,created_at_ms,queue_deadline_ms) VALUES ('t','c','iv','nr','{}',?, '{}',1,1,0,1,2)",
        params: ["a".repeat(64)],
      },
      {
        kind: "run",
        sql: "INSERT INTO ticket_storage_grants(id,ticket_id,storage_profile_revision_id,authorized_subpath,mount_path,mode,created_at_ms) VALUES ('g','t','r','/data','/data','read_write',1)",
      },
    ]);
    await expect(
      storage.run("DELETE FROM ticket_storage_grants WHERE id='g'"),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
  });

  it("rolls back partial batches and failed compare-and-swap updates", async () => {
    const { storage } = await fixture();
    await storage.run(
      "INSERT INTO images(id,name,created_at_ms) VALUES ('i','I',1)",
    );
    await expect(
      storage.batchTransaction([
        {
          kind: "run",
          sql: "INSERT INTO image_versions(id,image_id,version,manifest_json,created_at_ms) VALUES ('v','i','1','{}',1)",
        },
        {
          kind: "run",
          sql: "INSERT INTO image_versions(id,image_id,version,manifest_json,created_at_ms) VALUES ('v2','missing','1','{}',1)",
        },
      ]),
    ).rejects.toBeInstanceOf(StorageError);
    expect(
      await storage.get("SELECT id FROM image_versions WHERE id='v'"),
    ).toBeUndefined();
    await expect(
      storage.batchTransaction([
        {
          kind: "run",
          sql: "UPDATE images SET description='changed' WHERE id='i'",
        },
        {
          kind: "run",
          sql: "UPDATE images SET description='lost' WHERE id='i' AND rowid=99",
          expectChanges: 1,
        },
      ]),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    expect(
      await storage.get("SELECT description FROM images WHERE id='i'"),
    ).toMatchObject({ description: "" });
  });

  it("rejects a second active controller and releases exclusivity on close", async () => {
    const { dir, storage } = await fixture();
    await expect(openStorage(dir)).rejects.toMatchObject({
      code: "STORAGE_OPEN_FAILED",
    });
    await storage.close();
    const second = await openStorage(dir);
    opened.push(second);
    // After the new owner closes, another worker can acquire the ledger.
    await Promise.all([second.close(), second.close()]);
    const third = await openStorage(dir);
    opened.push(third);
  }, 10000);

  it("preserves event cursors beyond JavaScript's safe integer range", async () => {
    const { storage } = await fixture();
    const value = "9007199254740993123";
    await storage.run(
      "INSERT INTO events(id,aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES (?, 'ticket','t',1,'test',1,'{}')",
      [BigInt(value)],
    );
    expect(
      await storage.get("SELECT id FROM events WHERE id=?", [BigInt(value)]),
    ).toMatchObject({ id: BigInt(value) });
  });

  it("rejects pending requests when the worker exits unexpectedly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-worker-crash-"));
    dirs.push(dir);
    const storage = await openStorageWithWorker(
      dir,
      new URL("./fixtures/crash-worker.mjs", import.meta.url),
    );
    opened.push(storage);
    await expect(storage.get("SELECT 1")).rejects.toMatchObject({
      code: "STORAGE_WORKER_FAILED",
    });
    await expect(storage.get("SELECT 2")).rejects.toMatchObject({
      code: "STORAGE_WORKER_FAILED",
    });
  }, 5000);

  it("builds the same migration bytes from the single source file", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(resolve("../../docs/design/schema.sql"));
    const built = await readFile(
      resolve("dist/storage/migrations/001-initial.sql"),
    );
    expect(built.equals(source)).toBe(true);
  });
});
