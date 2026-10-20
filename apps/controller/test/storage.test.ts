import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { SQLiteIdentityStore } from "../dist/storage/identity-store.js";
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
    expect(tables).toHaveLength(42);
    expect(
      await storage.get(
        "SELECT version FROM schema_migrations WHERE version = 2",
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
    ).toMatchObject({ count: 5n });
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
    const source = await readFile(
      resolve("src/storage/migrations/001-initial.sql"),
    );
    const built = await readFile(
      resolve("dist/storage/migrations/001-initial.sql"),
    );
    expect(built.equals(source)).toBe(true);
    const sourceUpgrade = await readFile(
      resolve("src/storage/migrations/002-session-credential-lineage.sql"),
    );
    const builtUpgrade = await readFile(
      resolve("dist/storage/migrations/002-session-credential-lineage.sql"),
    );
    expect(builtUpgrade.equals(sourceUpgrade)).toBe(true);
  });

  it("upgrades a v1 data directory in place without replacing its ledger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-upgrade-v1-"));
    dirs.push(dir);
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(resolve("src/storage/migrations/001-initial.sql"), "utf8"),
    );
    const raw = new Database(join(dir, "hitchlet.sqlite"));
    raw.exec(source);
    raw
      .prepare(
        "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES('legacy-consumer','Legacy','human','consumer','{}','{}',1,1)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO gui_sessions(id,consumer_id,token_hash,csrf_token_hash,created_at_ms,expires_at_ms) VALUES('legacy-session','legacy-consumer',?,?,1,9999999999999)",
      )
      .run("a".repeat(64), "b".repeat(64));
    raw
      .prepare(
        "INSERT INTO events(id,aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        9007199254740993n,
        "ticket",
        "legacy-ticket",
        1,
        "legacy.event",
        "legacy-consumer",
        1,
        "{}",
      );
    raw.close();
    const storage = await openStorage(dir);
    opened.push(storage);
    expect(
      await storage.get("SELECT count(*) AS count FROM schema_migrations"),
    ).toMatchObject({ count: 5n });
    expect(
      await storage.get<{ user_version: bigint }>("PRAGMA user_version"),
    ).toMatchObject({ user_version: 5n });
    expect(
      await storage.get(
        "SELECT name FROM pragma_table_info('gui_sessions') WHERE name='source_credential_id'",
      ),
    ).toBeDefined();
    expect(
      await storage.get<{ name: string }>(
        "SELECT name FROM consumers WHERE id='legacy-consumer'",
      ),
    ).toMatchObject({ name: "Legacy" });
    expect(
      await storage.get<{ id: bigint }>(
        "SELECT id FROM events WHERE id=9007199254740993",
      ),
    ).toMatchObject({ id: 9007199254740993n });
    expect(
      await storage.get<{ source_credential_id: string | null }>(
        "SELECT source_credential_id FROM gui_sessions WHERE id='legacy-session'",
      ),
    ).toMatchObject({ source_credential_id: null });
    expect(
      await new SQLiteIdentityStore(storage).session("a".repeat(64)),
    ).toBeUndefined();
    await expect(
      storage.run(
        "INSERT INTO gui_sessions(id,consumer_id,token_hash,csrf_token_hash,created_at_ms,expires_at_ms,source_credential_id) VALUES('bad-session','legacy-consumer',?,?,1,9999999999999,'missing-credential')",
        ["c".repeat(64), "d".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
  });
  it("upgrades v2 to the same evidence-protection schema as a new ledger", async () => {
    const { readFile } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-upgrade-v2-"));
    dirs.push(dir);
    const raw = new Database(join(dir, "hitchlet.sqlite"));
    raw.exec(
      await readFile(resolve("src/storage/migrations/001-initial.sql"), "utf8"),
    );
    raw.exec(
      await readFile(
        resolve("src/storage/migrations/002-session-credential-lineage.sql"),
        "utf8",
      ),
    );
    raw
      .prepare(
        "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES('installation','legacy',1,'legacy.event',1,'{}')",
      )
      .run();
    raw.close();
    const upgraded = await openStorage(dir);
    opened.push(upgraded);
    const { storage: fresh } = await fixture();
    const schema =
      "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    expect(await upgraded.all(schema)).toEqual(await fresh.all(schema));
    expect(
      await upgraded.get(
        "SELECT count(*) n FROM events WHERE aggregate_id='legacy'",
      ),
    ).toEqual({ n: 1n });
    expect(await upgraded.get("PRAGMA user_version")).toEqual({
      user_version: 5n,
    });
    expect(
      (
        await readFile(
          resolve("dist/storage/migrations/003-validation-evidence.sql"),
        )
      ).equals(
        await readFile(
          resolve("src/storage/migrations/003-validation-evidence.sql"),
        ),
      ),
    ).toBe(true);
  });
});
