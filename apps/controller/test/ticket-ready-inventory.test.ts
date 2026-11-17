// Isolated in-memory SQLite + actual reader/route/SDK. No listener, credentials or provider calls.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  TicketReadyInventoryReader,
  TICKET_READY_INVENTORY_SQL,
} from "../src/application/ticket-ready-inventory.js";
import { registerReadyInventoryRoute } from "../src/http/ready-inventory-route.js";
import { resourceManifest } from "../src/domain/resource-manifest.js";
import { HitchletClient } from "../../../packages/sdk/dist/index.js";
import { openApiDocument } from "../src/http/openapi.js";
import type { Principal } from "../src/http/auth.js";
const id = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const ids = {
  ticket: id(1),
  consumer: id(2),
  lease: id(3),
  allocation: id(4),
  installation: id(5),
  runtime: id(6),
  revision: id(7),
  create: id(8),
  cleanup: id(9),
};
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
type Fixture = ReturnType<typeof seed>;
function seed() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec(`CREATE TABLE tickets(id,consumer_id,phase,cleanup_status,ready_at_ms);
    CREATE TABLE leases(id,ticket_id,allocation_id,generation,state,revoked_at_ms,expires_at_ms,claimed_at_ms,claim_by_ms);
    CREATE TABLE allocations(id,ticket_id,purpose,runtime_identity_id,generation,control_version,desired_state,observed_state,cleanup_status,manifest_complete,manifest_id,resolved_provision_contract_id,actual_resources_json);
    CREATE TABLE installations(singleton,installation_id);
    CREATE TABLE resolved_provision_contracts(id,contract_hash);
    CREATE TABLE managed_resources(id,provider_id,allocation_id,generation,kind,ownership,observed_state,ownership_json);
    CREATE TABLE operations(id,allocation_id,installation_id,generation,control_version,runtime_identity_id,connection_revision_id,kind,state,created_at_ms,updated_at_ms,result_json);
    CREATE TABLE capacity_claims(allocation_id,state);`);
  const create = {
    installationId: ids.installation,
    allocationId: ids.allocation,
    generation: 1,
    operationId: ids.create,
    purpose: "tenant" as const,
    controlVersion: 1,
    runtimeIdentityId: ids.runtime,
    connectionRevisionId: ids.revision,
  };
  const cleanup = { ...create, controlVersion: 2 };
  const objects = (["container", "volume", "network_policy"] as const).map(
    (kind) => ({
      id: "native-" + kind,
      kind,
      ownership: "owned" as const,
      identity: create,
      contractHash: "a".repeat(64),
      evidence: {
        artifactDigest: "sha256:" + "b".repeat(64),
        resourcesHash: "c".repeat(64),
        networkHash: "d".repeat(64),
        mountsHash: "e".repeat(64),
        accessProtocol: "ssh" as const,
      },
      details: { privateExample: "DO_NOT_DISCLOSE" },
    }),
  );
  const manifest = resourceManifest(
    { identity: create, resolved: { contractHash: "a".repeat(64) } },
    objects,
  );
  const ready = {
    executionMode: "portainer",
    receipt: {
      identity: create,
      contractHash: "a".repeat(64),
      ...manifest,
      objectIds: objects.map((o) => o.id),
      access: { privateExample: "DO_NOT_DISCLOSE" },
    },
    objects,
  };
  const runtime = {
    runtimeIdentityId: ids.runtime,
    connectionRevisionId: ids.revision,
  };
  const evidence = {
    verifiedAbsentAtMs: 4000,
    inventory: { completeness: "complete", runtime, identity: cleanup },
    resources: objects.map(({ id, kind, ownership }) => ({
      id,
      kind,
      ownership,
    })),
    destructionReceipts: objects.map((o) => ({
      resourceId: o.id,
      kind: o.kind,
      presence: "absent",
      identity: cleanup,
      runtime,
      networkRules: o.kind === "network_policy" ? "removed" : "not_applicable",
      verifiedAtMs: 3500,
      agentResult: { privateExample: "DO_NOT_DISCLOSE" },
    })),
  };
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    ).run(...(Object.values(row) as SQLInputValue[]));
  };
  insert("tickets", {
    id: ids.ticket,
    consumer_id: ids.consumer,
    phase: "ready",
    ready_at_ms: 1000,
    cleanup_status: "running",
  });
  insert("leases", {
    id: ids.lease,
    ticket_id: ids.ticket,
    allocation_id: ids.allocation,
    generation: 1,
    state: "active",
    expires_at_ms: 10000,
    claimed_at_ms: null,
    claim_by_ms: 9000,
    revoked_at_ms: null,
  });
  insert("allocations", {
    id: ids.allocation,
    ticket_id: ids.ticket,
    purpose: "tenant",
    runtime_identity_id: ids.runtime,
    generation: 1,
    control_version: 1,
    desired_state: "present",
    observed_state: "running",
    cleanup_status: "running",
    manifest_complete: 1,
    manifest_id: manifest.manifestId,
    resolved_provision_contract_id: "contract",
    actual_resources_json: JSON.stringify(ready),
  });
  insert("installations", { singleton: 1, installation_id: ids.installation });
  insert("resolved_provision_contracts", {
    id: "contract",
    contract_hash: "a".repeat(64),
  });
  for (const o of objects)
    insert("managed_resources", {
      id: "row-" + o.id,
      provider_id: o.id,
      allocation_id: ids.allocation,
      generation: 1,
      kind: o.kind,
      ownership: "owned",
      observed_state: "present",
      ownership_json: JSON.stringify({ ...create, referenceKey: null }),
    });
  insert("operations", {
    id: ids.create,
    allocation_id: ids.allocation,
    installation_id: ids.installation,
    generation: 1,
    control_version: 1,
    runtime_identity_id: ids.runtime,
    connection_revision_id: ids.revision,
    kind: "allocation.provision",
    state: "succeeded",
    created_at_ms: 3000,
    updated_at_ms: 5000,
    result_json: JSON.stringify({}),
  });
  insert("capacity_claims", {
    allocation_id: ids.allocation,
    state: "committed",
  });
  return { db, ready, evidence, manifest, insert };
}

function reader(f: Fixture, bigint = false) {
  f.db.exec("PRAGMA query_only=ON");
  const get = vi.fn(async <T>(sql: string, params: readonly unknown[] = []) => {
    const stmt = f.db.prepare(sql);
    stmt.setReadBigInts(bigint);
    return stmt.get(...(params as SQLInputValue[])) as T | undefined;
  });
  return { service: new TicketReadyInventoryReader({ get }, () => 6000), get };
}
const query = { leaseId: ids.lease, generation: 1 };
const read = (service: TicketReadyInventoryReader) =>
  service.read(ids.consumer, ids.ticket, query);
function updateReady(f: Fixture) {
  f.db
    .prepare("UPDATE allocations SET actual_resources_json=?")
    .run(JSON.stringify(f.ready));
}
describe("ordinary same-lease persisted ready inventory", () => {
  it("uses the singleton installation only when the original operation has no installation binding", async () => {
    const f = seed();
    f.db
      .prepare("UPDATE operations SET installation_id=NULL WHERE kind=?")
      .run("allocation.provision");
    await expect(read(reader(f, false).service)).resolves.not.toBeNull();
    const foreign = seed();
    foreign.db
      .prepare("UPDATE operations SET installation_id=? WHERE kind=?")
      .run(id(99), "allocation.provision");
    await expect(read(reader(foreign, false).service)).rejects.toThrow();
  });

  it.each([false, true])(
    "projects complete exact ready inventory via one readonly snapshot (bigint=%s)",
    async (bigint) => {
      const f = seed(),
        { service, get } = reader(f, bigint),
        answer = await read(service);
      expect(answer).toMatchObject({
        ticketId: ids.ticket,
        leaseId: ids.lease,
        generation: 1,
        completeness: "complete",
        ticketPhase: "ready",
        basis: "persisted_ready_manifest",
        nativeObservedAtRead: false,
        createIdentity: { controlVersion: 1 },
        readyAtMs: 1000,
        readAtMs: 6000,
      });
      expect(answer!.objects.map((o) => o.kind).sort()).toEqual([
        "container",
        "network_policy",
        "volume",
      ]);
      expect(
        answer!.objects.every(
          (o) =>
            o.identity.allocationId === ids.allocation &&
            o.identity.generation === 1,
        ),
      ).toBe(true);
      expect(JSON.stringify(answer)).not.toContain("DO_NOT_DISCLOSE");
      expect(JSON.stringify(answer)).not.toContain("referenceKey");
      expect(get).toHaveBeenCalledExactlyOnceWith(TICKET_READY_INVENTORY_SQL, [
        ids.ticket,
        ids.consumer,
        ids.lease,
        1,
      ]);
      expect(() => f.db.exec("UPDATE tickets SET phase='released'")).toThrow(
        /readonly/i,
      );
    },
  );
  it("foreign owner/lease/generation never selects another allocation or empty inventory", async () => {
    const { service } = reader(seed());
    expect(await service.read(id(99), ids.ticket, query)).toBeNull();
    expect(
      await service.read(ids.consumer, ids.ticket, {
        ...query,
        leaseId: id(99),
      }),
    ).toBeNull();
    expect(
      await service.read(ids.consumer, ids.ticket, { ...query, generation: 2 }),
    ).toBeNull();
  });
  const negatives: [string, (f: Fixture) => void][] = [
    [
      "released cleanup is not ready",
      (f) => {
        f.db.exec(
          "UPDATE tickets SET phase='released';UPDATE leases SET state='revoked';UPDATE allocations SET desired_state='absent'",
        );
      },
    ],
    [
      "expired lease",
      (f) => {
        f.db.exec("UPDATE leases SET expires_at_ms=6000");
      },
    ],
    [
      "unclaimed deadline",
      (f) => {
        f.db.exec("UPDATE leases SET claim_by_ms=6000");
      },
    ],
    [
      "incomplete manifest",
      (f) => {
        f.db.exec("UPDATE allocations SET manifest_complete=0");
      },
    ],
    [
      "missing native object",
      (f) => {
        f.ready.objects.pop();
        updateReady(f);
      },
    ],
    [
      "managed state unknown",
      (f) => {
        f.db.exec("UPDATE managed_resources SET observed_state='unknown'");
      },
    ],
    [
      "foreign managed ownership",
      (f) => {
        f.db
          .prepare(
            "UPDATE managed_resources SET ownership_json=json_set(ownership_json,'$.generation',2)",
          )
          .run();
      },
    ],
    [
      "new allocation control version",
      (f) => {
        f.db.exec("UPDATE allocations SET control_version=2");
      },
    ],
    [
      "unconfirmed provision",
      (f) => {
        f.db.exec("UPDATE operations SET state='running'");
      },
    ],
    [
      "unknown create intent",
      (f) => {
        f.db.exec(
          'UPDATE operations SET result_json=\'{"createEffects":[{"state":"unknown"}]}\'',
        );
      },
    ],
    [
      "wrong manifest digest",
      (f) => {
        Object.assign(f.ready.receipt, { manifestHash: "f".repeat(64) });
        updateReady(f);
      },
    ],
    [
      "quarantined capacity claim",
      (f) => {
        f.db.exec("UPDATE capacity_claims SET state='quarantined'");
      },
    ],
  ];
  it.each(negatives)("rejects %s", async (_name, mutate) => {
    const f = seed();
    mutate(f);
    await expect(read(reader(f).service)).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("caller cannot override inventory; expected pins must match", async () => {
    const { service } = reader(seed());
    await expect(
      service.read(ids.consumer, ids.ticket, {
        ...query,
        expected: { manifestHash: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      service.read(ids.consumer, ids.ticket, {
        ...query,
        objects: [],
      } as never),
    ).rejects.toThrow();
  });
});
function actor(scope = true, foreign = false): Principal {
  return {
    principalId: id(20),
    consumerId: foreign ? id(99) : ids.consumer,
    role: "consumer",
    scopes: scope ? ["tickets:read"] : [],
    source: "bearer",
  };
}
function appFor(service: TicketReadyInventoryReader, p: Principal) {
  const app = Fastify(),
    identify = vi.fn(async () => p);
  app.setErrorHandler((error, _req, reply) => {
    const code = (error as { code?: string }).code;
    reply
      .code(
        code === "forbidden"
          ? 403
          : code === "not_found"
            ? 404
            : code === "invalid_request"
              ? 422
              : 409,
      )
      .send({ error: { code } });
  });
  registerReadyInventoryRoute(app, identify, service);
  return { app, identify };
}
describe("actual public SDK to ordinary GET route", () => {
  it("SDK refuses a well-shaped response for another lease rather than accepting it as this inventory", async () => {
    const proof = await read(reader(seed()).service);
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...proof, leaseId: id(999) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new HitchletClient("https://controller.test", {
      fetch: fetcher,
      auth: { kind: "bearer", token: "synthetic-test-only" },
    });
    await expect(
      client.tickets.readyInventory(ids.ticket, query),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["scope", "owner", "injected_objects"] as const)(
    "fails closed for %s",
    async (kind) => {
      const { service, get } = reader(seed()),
        { app } = appFor(service, actor(kind !== "scope", kind === "owner"));
      try {
        const response = await app.inject({
          method: "GET",
          url: `/v1/tickets/${ids.ticket}/ready-inventory?leaseId=${ids.lease}&generation=1${kind === "injected_objects" ? "&objects=[]" : ""}`,
        });
        expect(response.statusCode).toBe(
          kind === "scope" ? 403 : kind === "owner" ? 404 : 422,
        );
        expect(get.mock.calls.length).toBe(kind === "owner" ? 1 : 0);
      } finally {
        await app.close();
      }
    },
  );
  it("fixes missing method and reads actual SQLite inventory through SDK/HTTP without any command", async () => {
    const { service, get } = reader(seed()),
      { app, identify } = appFor(service, actor());
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(input)),
          headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
        const res = await app.inject({
          method: init?.method as "GET",
          url: u.pathname + u.search,
          headers,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        return new Response(res.body, {
          status: res.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    );
    try {
      const sdk = new HitchletClient("https://controller.test", {
        fetch: fetcher,
        auth: { kind: "bearer", token: "synthetic-test-only" },
      });
      expect(typeof sdk.tickets.readyInventory).toBe("function");
      const answer = await sdk.tickets.readyInventory(ids.ticket, query);
      expect(answer.objects).toHaveLength(3);
      expect(answer.leaseId).toBe(ids.lease);
      expect(fetcher).toHaveBeenCalledOnce();
      const [u, init] = fetcher.mock.calls[0]!;
      expect(new URL(String(u)).pathname).toBe(
        `/v1/tickets/${ids.ticket}/ready-inventory`,
      );
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
      expect(identify.mock.calls[0]).toHaveLength(2);
      expect(get).toHaveBeenCalledOnce();
      const before = fetcher.mock.calls.length;
      await expect(
        sdk.tickets.readyInventory(ids.ticket, { ...query, generation: 0 }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(fetcher.mock.calls.length).toBe(before);
      const doc = openApiDocument();
      expect(doc.components.schemas.TicketReadyInventory).toBeDefined();
      expect(
        doc.paths["/v1/tickets/{ticketId}/ready-inventory"].get,
      ).not.toHaveProperty("requestBody");
    } finally {
      await app.close();
    }
  });
});
