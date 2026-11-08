import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { ConsoleService } from "../src/application/console.js";
import { rgb565Png } from "../src/domain/console-frame.js";
import type { Storage } from "../src/storage/index.js";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const identity = {
  installationId: "i",
  runtimeIdentityId: "r",
  connectionRevisionId: "c",
  allocationId: "a",
  generation: 1,
  operationId: "o",
  controlVersion: 1,
  purpose: "tenant",
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tickets(id TEXT,consumer_id TEXT,phase TEXT,request_json TEXT,network_profile_revision_id TEXT);
 CREATE TABLE leases(id TEXT,ticket_id TEXT,allocation_id TEXT,generation INTEGER,version INTEGER,state TEXT,claimed_at_ms INTEGER,expires_at_ms INTEGER);
 CREATE TABLE allocations(id TEXT,generation INTEGER,desired_state TEXT,observed_state TEXT,ownership_json TEXT,actual_resources_json TEXT,access_secret_ref TEXT);
 CREATE TABLE operations(allocation_id TEXT,kind TEXT,intent_json TEXT,created_at_ms INTEGER);
 CREATE TABLE profile_grant_revocations(network_profile_revision_id TEXT,storage_profile_revision_id TEXT);
 CREATE TABLE ticket_storage_grants(ticket_id TEXT,storage_profile_revision_id TEXT);
 CREATE TABLE managed_resources(allocation_id TEXT,generation INTEGER,kind TEXT,ownership TEXT,observed_state TEXT,ownership_json TEXT);
 INSERT INTO tickets VALUES('ticket','owner','ready','{}','network');
 INSERT INTO leases VALUES('lease','ticket','a',1,2,'active',1,9000);
 INSERT INTO allocations VALUES('a',1,'present','running','{}','{}',NULL);
 INSERT INTO operations VALUES('a','allocation.provision','{"executionMode":"hyperv"}',1);`);
  db.prepare(
    "INSERT INTO managed_resources VALUES('a',1,'vm','owned','present',?)",
  ).run(JSON.stringify(identity));
  const storage = {
    get: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...(params as any[])),
    all: async (sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as any[])),
  } as unknown as Storage;
  let calls = 0;
  let onExecute = () => {};
  const service = new ConsoleService(
    storage,
    async (r) => {
      calls++;
      onExecute();
      return {
        identity: r.identity,
        commandId: r.commandId,
        status: "available",
        account: "workspace",
      };
    },
    () => 5000,
  );
  const command = {
    generation: 1,
    commandId: "5a0f42b6-94d1-462c-953a-e8cc1622981c",
    action: { kind: "access" as const },
  };
  return {
    db,
    service,
    command,
    get calls() {
      return calls;
    },
    during(fn: () => void) {
      onExecute = fn;
    },
  };
}
it("console accepts only the claimed owner and does not invent interactive credentials", async () => {
  const f = fixture();
  const result = await f.service.command("owner", "ticket", f.command);
  expect(result).toMatchObject({
    protocol: "console",
    status: "available",
    generation: 1,
    authentication: {
      kind: "existing_account_login_required",
      username: "workspace",
    },
  });
  await expect(
    f.service.command("different", "ticket", f.command),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(f.calls).toBe(1);
});
it.each([
  ["unclaimed", "UPDATE leases SET claimed_at_ms=NULL"],
  ["expired", "UPDATE leases SET expires_at_ms=4000"],
  ["released", "UPDATE tickets SET phase='released'"],
  ["cleanup", "UPDATE allocations SET desired_state='absent'"],
  ["revoked", "INSERT INTO profile_grant_revocations VALUES('network',NULL)"],
  ["generation", "UPDATE leases SET generation=2"],
  [
    "not hyperv",
    `UPDATE operations SET intent_json='{"executionMode":"tart"}'`,
  ],
  ["missing VM", "DELETE FROM managed_resources"],
])("console rejects %s before native execution", async (_name, sql) => {
  const f = fixture();
  f.db.exec(sql);
  await expect(
    f.service.command("owner", "ticket", f.command),
  ).rejects.toThrow();
  expect(f.calls).toBe(0);
});
it("console suppresses a frame/access result when release races native work", async () => {
  const f = fixture();
  f.during(() => f.db.exec("UPDATE tickets SET phase='releasing'"));
  await expect(
    f.service.command("owner", "ticket", f.command),
  ).rejects.toMatchObject({ code: "lease_not_accessible" });
  expect(f.calls).toBe(1);
});
it("RGB565 thumbnail produces real primary-color PNG pixels and rejects malformed frames", () => {
  const raw = Buffer.alloc(16 * 16 * 2);
  raw.writeUInt16LE(0xf800, 0);
  raw.writeUInt16LE(0x07e0, 2);
  raw.writeUInt16LE(0x001f, 4);
  const png = rgb565Png(raw, 16, 16);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  let cursor = 8;
  let data = Buffer.alloc(0);
  while (cursor < png.length) {
    const n = png.readUInt32BE(cursor);
    if (png.toString("ascii", cursor + 4, cursor + 8) === "IDAT")
      data = png.subarray(cursor + 8, cursor + 8 + n);
    cursor += n + 12;
  }
  expect([...inflateSync(data).subarray(0, 10)]).toEqual([
    0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
  ]);
  expect(() => rgb565Png(Buffer.alloc(1), 16, 16)).toThrow();
});
