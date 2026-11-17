import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { pruneHistory } from "../src/storage/history-retention.js";
import type { Storage } from "../src/storage/index.js";

it("retains tenant cleanup evidence with its ticket while pruning other old details", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE tickets(id TEXT);
      CREATE TABLE allocations(id TEXT,ticket_id TEXT,cleanup_status TEXT);
      CREATE TABLE operations(id TEXT,kind TEXT,state TEXT,updated_at_ms INTEGER,allocation_id TEXT,result_json TEXT);
      CREATE TABLE agent_commands(operation_id TEXT);
      CREATE TABLE lease_renewals(operation_id TEXT);
      CREATE TABLE image_versions(manifest_json TEXT);
      INSERT INTO tickets VALUES('ticket');
      INSERT INTO allocations VALUES('allocation','ticket','complete');
      INSERT INTO operations VALUES('cleanup','allocation.cleanup','succeeded',1,'allocation','{"destructionReceipts":[1]}');
      INSERT INTO operations VALUES('other','allocation.provision','succeeded',1,'allocation','{"detail":1}');`);
    const storage = {
      all: async () => [],
      run: async (sql: string, params: readonly unknown[] = []) => {
        if (
          sql.startsWith(
            "UPDATE operations SET result_json=json_object('detailsPrunedAtMs'",
          )
        ) {
          const result = db
            .prepare(sql)
            .run(...(params as (number | string)[]));
          return { changes: BigInt(result.changes), lastInsertRowid: 0n };
        }
        return { changes: 0n, lastInsertRowid: 0n };
      },
    } as unknown as Storage;
    await pruneHistory(storage, 31 * 86400000 + 1);
    const rows = db
      .prepare("SELECT id,result_json FROM operations ORDER BY id")
      .all() as { id: string; result_json: string }[];
    expect(JSON.parse(rows[0]!.result_json)).toEqual({
      destructionReceipts: [1],
    });
    expect(JSON.parse(rows[1]!.result_json)).toMatchObject({
      outcome: "succeeded",
    });
  } finally {
    db.close();
  }
});
