import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ConsoleCredentialService } from "../src/application/console-credentials.js";
import { CONSOLE_CREDENTIAL_SCOPE } from "../src/storage/console-credential-store.js";
import type { Storage } from "../src/storage/index.js";
import type { HyperVInteractiveRequest } from "@hitchlet/contracts/internal";
import { loadConfig } from "../src/config.js";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
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
function fixture(enabled = true) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tickets(id TEXT,consumer_id TEXT,phase TEXT,request_json TEXT,network_profile_revision_id TEXT,cleanup_status TEXT);
 CREATE TABLE leases(id TEXT,ticket_id TEXT,allocation_id TEXT,generation INTEGER,version INTEGER,state TEXT,claimed_at_ms INTEGER,expires_at_ms INTEGER);
 CREATE TABLE allocations(id TEXT,ticket_id TEXT,generation INTEGER,desired_state TEXT,observed_state TEXT,ownership_json TEXT,actual_resources_json TEXT,access_secret_ref TEXT,cleanup_status TEXT);
 CREATE TABLE operations(allocation_id TEXT,kind TEXT,intent_json TEXT,created_at_ms INTEGER);
 CREATE TABLE profile_grant_revocations(network_profile_revision_id TEXT,storage_profile_revision_id TEXT);
 CREATE TABLE ticket_storage_grants(ticket_id TEXT,storage_profile_revision_id TEXT);
 CREATE TABLE managed_resources(allocation_id TEXT,generation INTEGER,kind TEXT,ownership TEXT,observed_state TEXT,ownership_json TEXT);
 CREATE TABLE capacity_claims(allocation_id TEXT,state TEXT);
 CREATE TABLE idempotency_keys(consumer_id TEXT,route_scope TEXT,idempotency_key TEXT,request_hash TEXT CHECK(length(request_hash)=64),ticket_id TEXT,safe_response_json TEXT,created_at_ms INTEGER,retain_until_ms INTEGER,response_status INTEGER,PRIMARY KEY(consumer_id,route_scope,idempotency_key));
 INSERT INTO tickets VALUES('ticket','owner','ready','{}','network','pending');
 INSERT INTO leases VALUES('lease','ticket','a',1,2,'active',1,9000);
 INSERT INTO allocations VALUES('a','ticket',1,'present','running','{}','{}',NULL,'pending');
 INSERT INTO capacity_claims VALUES('a','active');
 INSERT INTO operations VALUES('a','allocation.provision','{"executionMode":"hyperv"}',1);`);
  db.prepare(
    "INSERT INTO managed_resources VALUES('a',1,'vm','owned','present',?)",
  ).run(JSON.stringify(identity));
  const storage = {
    get: async (sql: string, params: any[] = []) =>
      db.prepare(sql).get(...params),
    all: async (sql: string, params: any[] = []) =>
      db.prepare(sql).all(...params),
    run: async (sql: string, params: any[] = []) =>
      db.prepare(sql).run(...params),
  } as unknown as Storage;
  const material = new Map<string, string>();
  let creates = 0,
    removes = 0,
    failRemove = false,
    lost = false,
    applied = false,
    after = () => {},
    clock = 5000;
  const secrets = {
    get: async (ref: string) => {
      const v = material.get(ref);
      if (!v) throw Error("missing");
      return v;
    },
    getOrCreate: async (ref: string, make: () => string) => {
      if (!material.has(ref)) {
        creates++;
        material.set(ref, make());
      }
      return material.get(ref)!;
    },
    remove: async (ref: string) => {
      removes++;
      material.delete(ref);
      if (failRemove) throw Error("lost cleanup receipt");
    },
  };
  const calls: HyperVInteractiveRequest[] = [];
  const execute = async (r: HyperVInteractiveRequest) => {
    calls.push(r);
    if (r.mode === "prepare") applied = true;
    after();
    if (lost) {
      lost = false;
      throw Error("reply lost after apply");
    }
    return {
      identity: r.identity,
      nonce: r.nonce,
      passwordHash: r.passwordHash,
      account: "workspace",
      status: applied ? "applied" : "not_applied",
    };
  };
  const service = new ConsoleCredentialService(
    storage,
    secrets,
    execute,
    enabled,
    () => clock,
  );
  return {
    db,
    storage,
    secrets,
    material,
    calls,
    service,
    restart: () =>
      new ConsoleCredentialService(
        storage,
        secrets,
        execute,
        enabled,
        () => clock,
      ),
    get creates() {
      return creates;
    },
    get removes() {
      return removes;
    },
    lose: () => (lost = true),
    failRemoval: (value: boolean) => (failRemove = value),
    during: (fn: () => void) => (after = fn),
    expire: () => (clock = 9500),
    release: () =>
      db.exec(
        "UPDATE tickets SET phase='released',cleanup_status='complete';UPDATE leases SET state='expired';UPDATE allocations SET desired_state='absent',observed_state='absent',cleanup_status='complete';UPDATE managed_resources SET observed_state='absent';UPDATE capacity_claims SET state='released';",
      ),
  };
}
it("defaults disabled: preparation performs no ledger, secret or native work", async () => {
  expect(
    loadConfig({ DATA_DIR: "/synthetic" }).HITCHLET_CONSOLE_PASSWORDS,
  ).toBe(false);
  const f = fixture(false);
  await expect(
    f.service.prepare("owner", "ticket", 1, "key"),
  ).rejects.toMatchObject({ code: "console_credentials_disabled" });
  expect(f.db.prepare("SELECT count(*) n FROM idempotency_keys").get()!.n).toBe(
    0,
  );
  expect(f.creates).toBe(0);
  expect(f.calls).toEqual([]);
});
it("lease generations retain one reference and nonce across restarts and different retry keys", async () => {
  const f = fixture();
  const a = await f.service.prepare("owner", "ticket", 1, "first");
  const b = await f.restart().prepare("owner", "ticket", 1, "different-key");
  expect(a).toEqual(b);
  expect(a.status).toBe("ready");
  expect(f.creates).toBe(1);
  expect(f.material.size).toBe(1);
  const rows = f.db
    .prepare(
      "SELECT safe_response_json FROM idempotency_keys WHERE route_scope=?",
    )
    .all(CONSOLE_CREDENTIAL_SCOPE);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.safe_response_json).not.toContain(a.authentication!.password);
});
it("a lost mutation reply recovers by read-only inspection without a second prepare", async () => {
  const f = fixture();
  f.lose();
  const first = await f.service.prepare("owner", "ticket", 1, "key");
  expect(first.status).toBe("unknown");
  expect(first.authentication).toBeUndefined();
  const recovered = await f.restart().read("owner", "ticket", 1);
  expect(recovered.status).toBe("ready");
  expect(f.calls.map((v) => v.mode)).toEqual(["prepare", "inspect"]);
  expect(f.calls[1]).not.toHaveProperty("password");
  expect(f.creates).toBe(1);
});
it("crash after reserved material write reuses it; missing prepared material never regenerates", async () => {
  const f = fixture();
  await f.service.prepare("owner", "ticket", 1, "key");
  const row = f.db
    .prepare(
      "SELECT safe_response_json FROM idempotency_keys WHERE route_scope=?",
    )
    .get(CONSOLE_CREDENTIAL_SCOPE)!;
  const saved = JSON.parse(String(row.safe_response_json));
  f.db
    .prepare(
      "UPDATE idempotency_keys SET safe_response_json=? WHERE route_scope=?",
    )
    .run(
      JSON.stringify({ ...saved, state: "reserved" }),
      CONSOLE_CREDENTIAL_SCOPE,
    );
  await f.restart().prepare("owner", "ticket", 1, "retry");
  expect(f.creates).toBe(1);
  f.material.clear();
  await expect(
    f.restart().prepare("owner", "ticket", 1, "third"),
  ).rejects.toMatchObject({ code: "access_material_unavailable" });
  expect(f.creates).toBe(1);
});
it.each([
  ["owner", null, "other"],
  ["generation", null, "owner"],
  ["unclaimed", "UPDATE leases SET claimed_at_ms=NULL", "owner"],
  [
    "revoked",
    "INSERT INTO profile_grant_revocations VALUES('network',NULL)",
    "owner",
  ],
  ["missing VM", "DELETE FROM managed_resources", "owner"],
])("rejects %s before material/native mutation", async (name, sql, owner) => {
  const f = fixture();
  if (sql) f.db.exec(sql);
  await expect(
    f.service.prepare(owner!, "ticket", name === "generation" ? 2 : 1, "key"),
  ).rejects.toThrow();
  expect(f.creates).toBe(0);
  expect(f.calls).toEqual([]);
});
it("reused write key binds its original request", async () => {
  const f = fixture();
  await f.service.prepare("owner", "ticket", 1, "key");
  f.db.exec(
    "UPDATE leases SET generation=2;UPDATE allocations SET generation=2;UPDATE managed_resources SET generation=2",
  );
  f.db
    .prepare("UPDATE managed_resources SET ownership_json=?")
    .run(JSON.stringify({ ...identity, generation: 2 }));
  await expect(
    f.service.prepare("owner", "ticket", 2, "key"),
  ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  expect(f.creates).toBe(1);
});
it("release or expiry racing native observation suppresses plaintext", async () => {
  const f = fixture();
  f.during(f.expire);
  await expect(
    f.service.prepare("owner", "ticket", 1, "key"),
  ).rejects.toMatchObject({ code: "lease_not_accessible" });
  expect(f.material.size).toBe(1);
  expect((await f.service.read("owner", "ticket", 1)).status).toBe(
    "cleanup_pending",
  );
});
it("cleanup waits for real absence/Claim release and restarts deletion without recreation", async () => {
  const f = fixture();
  await f.service.prepare("owner", "ticket", 1, "key");
  f.db.exec("UPDATE tickets SET phase='released',cleanup_status='complete'");
  await f.service.cleanup();
  expect(f.removes).toBe(0);
  expect(
    (await f.service.read("owner", "ticket", 1)).authentication,
  ).toBeUndefined();
  f.release();
  f.failRemoval(true);
  await expect(f.service.cleanup()).rejects.toThrow("lost cleanup receipt");
  expect(f.material.size).toBe(0);
  f.failRemoval(false);
  await f.restart().cleanup();
  const view = await f.service.read("owner", "ticket", 1);
  expect(view.status).toBe("destroyed");
  expect(view.authentication).toBeUndefined();
  expect(f.creates).toBe(1);
  const saved = f.db
    .prepare(
      "SELECT safe_response_json FROM idempotency_keys WHERE route_scope=?",
    )
    .get(CONSOLE_CREDENTIAL_SCOPE)!;
  expect(JSON.parse(String(saved.safe_response_json))).toMatchObject({
    state: "destroyed",
    secretRef: null,
  });
  await expect(
    f.service.prepare("owner", "ticket", 1, "new"),
  ).rejects.toThrow();
});
it("read without intent does not allocate anything and concurrent prepare shares one intent", async () => {
  const f = fixture();
  expect((await f.service.read("owner", "ticket", 1)).status).toBe(
    "not_prepared",
  );
  expect(f.creates).toBe(0);
  const [a, b] = await Promise.all([
    f.service.prepare("owner", "ticket", 1, "a"),
    f.service.prepare("owner", "ticket", 1, "b"),
  ]);
  expect(a).toEqual(b);
  expect(f.creates).toBe(1);
});
