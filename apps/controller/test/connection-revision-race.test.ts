import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { SQLiteProviderConnectionStore } from "../src/storage/provider-connection-store.js";
import type { Storage } from "../src/storage/index.js";
import type { Statement } from "../src/storage/protocol.js";

it("rolls back a late revision when the original probe already completed", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE provider_connection_revisions(id TEXT,connection_id TEXT,revision INTEGER,endpoint_ref TEXT,provider_endpoint_id TEXT,secret_version_ref TEXT,config_json TEXT,verified_runtime_identity_id TEXT,verified_at_ms INTEGER,evidence_json TEXT,created_at_ms INTEGER);
      CREATE TABLE operations(id TEXT,state TEXT,result_json TEXT,version INTEGER,updated_at_ms INTEGER);
      INSERT INTO operations VALUES('original','running',NULL,1,0);`);
    const storage = {
      get: async (sql: string, params: unknown[] = []) =>
        db.prepare(sql).get(...params),
      batchTransaction: async (statements: Statement[]) =>
        db.transaction(() =>
          statements.map((s) => {
            if (s.kind !== "run") throw new Error("unexpected query");
            const result = db.prepare(s.sql).run(...(s.params ?? []));
            if (
              s.expectChanges !== undefined &&
              result.changes !== s.expectChanges
            )
              throw new Error("CAS failed");
            return result;
          }),
        )(),
    } as unknown as Storage;
    const store = new SQLiteProviderConnectionStore(storage, () => 1000);
    const target = {
      connectionId: "connection",
      endpointUrl: "https://example.test",
      environmentId: "1",
      secretVersionRef: "secret:test",
    };
    const evidence = {
      engineId: "engine",
      dockerVersion: "1",
      apiVersion: "1",
      minimumApiVersion: "1",
      os: "linux",
      architecture: "amd64",
      portainerVersion: "1",
      cpuCount: 1,
      memoryBytes: 1,
      containerCount: 0,
      unmanagedContainerCount: 0,
    };
    await store.completeRevision("original", target, "runtime", evidence);
    await expect(
      store.completeRevision("original", target, "runtime", evidence),
    ).rejects.toThrow("CAS failed");
    expect(
      db
        .prepare("SELECT count(*) AS n FROM provider_connection_revisions")
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
