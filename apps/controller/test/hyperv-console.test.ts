import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { Storage } from "../src/storage/index.js";
import type { LocalSecretStore } from "../src/storage/secret-store.js";
const runtime = vi.hoisted(() => ({ create: vi.fn(), console: vi.fn() }));
vi.mock("../src/providers/runtime-credentials.js", () => ({
  createHyperVRuntimeClient: runtime.create,
}));
import { createHyperVConsoleExecutor } from "../src/providers/hyperv-console.js";
const roots: DatabaseSync[] = [];
afterEach(() => {
  roots.splice(0).forEach((d) => d.close());
  vi.clearAllMocks();
});
const identity = {
  installationId: "i",
  runtimeIdentityId: "r",
  connectionRevisionId: "c",
  allocationId: "a",
  generation: 1,
  operationId: "o",
  controlVersion: 1,
  purpose: "tenant" as const,
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  roots.push(db);
  db.exec(`CREATE TABLE allocations(id TEXT,node_id TEXT,runtime_identity_id TEXT,generation INTEGER,control_version INTEGER,desired_state TEXT,observed_state TEXT);
 CREATE TABLE operations(id TEXT,allocation_id TEXT,kind TEXT,state TEXT,control_version INTEGER,generation INTEGER,connection_revision_id TEXT);
 CREATE TABLE nodes(id TEXT,runtime_identity_id TEXT,backend_kind TEXT,provider_connection_id TEXT,config_json TEXT);
 CREATE TABLE runtime_identities(id TEXT,backend_kind TEXT);
 CREATE TABLE provider_connections(id TEXT,enabled INTEGER,runtime_identity_id TEXT,current_revision_id TEXT,backend_kind TEXT);
 CREATE TABLE provider_connection_revisions(id TEXT,connection_id TEXT,verified_runtime_identity_id TEXT);
 CREATE TABLE installations(singleton INTEGER,installation_id TEXT,controller_epoch INTEGER);
 CREATE TABLE leases(allocation_id TEXT,state TEXT,claimed_at_ms INTEGER,ticket_id TEXT,expires_at_ms INTEGER);
 CREATE TABLE tickets(id TEXT,phase TEXT);
 INSERT INTO allocations VALUES('a','node','r',1,1,'present','running');
 INSERT INTO operations VALUES('o','a','allocation.provision','succeeded',1,1,'c');
 INSERT INTO runtime_identities VALUES('r','hyperv');
 INSERT INTO provider_connections VALUES('connection',1,'r','current','hyperv');
 INSERT INTO provider_connection_revisions VALUES('current','connection','r'),('c','connection','r');
 INSERT INTO installations VALUES(1,'i',3);
 INSERT INTO leases VALUES('a','active',1,'ticket',${Date.now() + 60000});
 INSERT INTO tickets VALUES('ticket','ready');`);
  const ref = "secret:" + "a".repeat(32);
  const profile = {
    switchName: "Default Switch",
    runtimeAgent: {
      id: "afac98ae-0287-43c9-bce3-21ff77918d14",
      baseUrl: "https://synthetic.invalid",
      tokenSecretRef: ref,
      caSecretRef: ref,
      clientCertSecretRef: ref,
      clientKeySecretRef: ref,
    },
    managementDenyRevisionId: "d5b2e7fa-48e5-452d-8f2c-c59e31cf67f2",
    managementDenyRules: [],
  };
  db.prepare(
    "INSERT INTO nodes VALUES('node','r','hyperv','connection',?)",
  ).run(JSON.stringify({ runtimeProfile: profile }));
  const storage = {
    get: async (sql: string, params: unknown[]) =>
      db.prepare(sql).get(...(params as any[])),
  } as unknown as Storage;
  runtime.create.mockResolvedValue({ console: runtime.console });
  runtime.console.mockResolvedValue({ sent: true });
  const request = {
    identity,
    commandId: "5a0f42b6-94d1-462c-953a-e8cc1622981c",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    action: { kind: "access" as const },
  };
  return {
    db,
    request,
    execute: createHyperVConsoleExecutor(storage, {} as LocalSecretStore),
  };
}
it("console resolves only the exact original operation over its current authenticated Node transport", async () => {
  const f = fixture();
  expect(await f.execute(f.request)).toEqual({ sent: true });
  expect(runtime.create.mock.calls[0]![0]).toMatchObject({
    installationId: "i",
    runtimeIdentityId: "r",
    controllerEpoch: 3,
    profile: { switchName: "Default Switch" },
  });
  expect(runtime.console).toHaveBeenCalledWith(f.request);
});
it.each([
  [
    "cleanup fence",
    "UPDATE allocations SET control_version=2,desired_state='absent'",
  ],
  ["released lease", "UPDATE leases SET state='released'"],
  ["replaced runtime", "UPDATE nodes SET runtime_identity_id='other'"],
  ["revoked connection", "UPDATE provider_connections SET enabled=0"],
  [
    "foreign current revision",
    "UPDATE provider_connection_revisions SET connection_id='foreign' WHERE id='current'",
  ],
  ["expired lease", "UPDATE leases SET expires_at_ms=0"],
])(
  "console refuses %s without resolving credentials or touching native state",
  async (_name, sql) => {
    const f = fixture();
    f.db.exec(sql);
    await expect(f.execute(f.request)).rejects.toThrow(
      "active allocation unavailable",
    );
    expect(runtime.create).not.toHaveBeenCalled();
    expect(runtime.console).not.toHaveBeenCalled();
  },
);
