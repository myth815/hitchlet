// Actual SELECT/JSON projection on isolated :memory: SQLite only. No production
// DB, credentials, provider/runtime calls, listener or lease is used.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  TicketCleanupProofReader,
  TICKET_CLEANUP_PROOF_SQL,
} from "../src/application/ticket-cleanup-proof.js";
import { registerCleanupProofRoute } from "../src/http/cleanup-proof-route.js";
import { resourceManifest } from "../src/domain/resource-manifest.js";
import { HitchletClient } from "../../../packages/sdk/src/index.js";
import { openApiDocument } from "../src/http/openapi.js";
import { TicketCleanupProofSchema } from "@hitchlet/contracts";
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
  db.exec(`CREATE TABLE tickets(id,consumer_id,phase,cleanup_status);
    CREATE TABLE leases(id,ticket_id,allocation_id,generation,state,revoked_at_ms);
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
    phase: "released",
    cleanup_status: "complete",
  });
  insert("leases", {
    id: ids.lease,
    ticket_id: ids.ticket,
    allocation_id: ids.allocation,
    generation: 1,
    state: "revoked",
    revoked_at_ms: 5000,
  });
  insert("allocations", {
    id: ids.allocation,
    ticket_id: ids.ticket,
    purpose: "tenant",
    runtime_identity_id: ids.runtime,
    generation: 1,
    control_version: 2,
    desired_state: "absent",
    observed_state: "absent",
    cleanup_status: "complete",
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
      observed_state: "absent",
      ownership_json: JSON.stringify(create),
    });
  insert("operations", {
    id: ids.cleanup,
    allocation_id: ids.allocation,
    installation_id: ids.installation,
    generation: 1,
    control_version: 2,
    runtime_identity_id: ids.runtime,
    connection_revision_id: ids.revision,
    kind: "allocation.cleanup",
    state: "succeeded",
    created_at_ms: 3000,
    updated_at_ms: 5000,
    result_json: JSON.stringify(evidence),
  });
  insert("capacity_claims", {
    allocation_id: ids.allocation,
    state: "released",
  });
  return { db, ready, evidence, manifest, insert };
}
function reader(f: Fixture, bigint = false) {
  f.db.exec("PRAGMA query_only=ON");
  const get = vi.fn(
    async <Row>(sql: string, params: readonly unknown[] = []) => {
      const statement = f.db.prepare(sql);
      statement.setReadBigInts(bigint);
      return statement.get(...(params as SQLInputValue[])) as Row | undefined;
    },
  );
  return {
    service: new TicketCleanupProofReader(
      {
        get: async <T>(sql: string, params?: readonly unknown[]) =>
          (await get(sql, params)) as T | undefined,
      },
      () => 6000,
    ),
    get,
  };
}
const query = { leaseId: ids.lease, generation: 1 };
const read = (service: TicketCleanupProofReader) =>
  service.read(ids.consumer, ids.ticket, query);
function updateReady(f: Fixture) {
  f.db
    .prepare("UPDATE allocations SET actual_resources_json=?")
    .run(JSON.stringify(f.ready));
}
function updateEvidence(f: Fixture) {
  f.db
    .prepare("UPDATE operations SET result_json=?")
    .run(JSON.stringify(f.evidence));
}

describe("owner-bound immutable cleanup proof", () => {
  it.each([
    ['{"code":"lease_or_authorization_changed"}', true],
    ['{"code":"decision_deadline_expired"}', true],
    [
      '{"code":"lease_or_authorization_changed","createEffects":[{"state":"unknown"}]}',
      false,
    ],
  ])(
    "handles a rejected renewal and preserves unknown-create protection",
    async (result, allowed) => {
      const f = seed();
      f.insert("operations", {
        id: "rejected-renewal",
        allocation_id: ids.allocation,
        installation_id: ids.installation,
        generation: 1,
        control_version: 1,
        runtime_identity_id: ids.runtime,
        connection_revision_id: ids.revision,
        kind: "lease.renew",
        state: "failed",
        created_at_ms: 2000,
        updated_at_ms: 2001,
        result_json: result,
      });
      const pending = read(reader(f).service);
      if (allowed) await expect(pending).resolves.not.toBeNull();
      else await expect(pending).rejects.toThrow();
    },
  );

  it("uses the singleton installation only when the original operation has no installation binding", async () => {
    const f = seed();
    f.db
      .prepare("UPDATE operations SET installation_id=NULL WHERE kind=?")
      .run("allocation.cleanup");
    await expect(read(reader(f, false).service)).resolves.not.toBeNull();
    const foreign = seed();
    foreign.db
      .prepare("UPDATE operations SET installation_id=? WHERE kind=?")
      .run(id(99), "allocation.cleanup");
    await expect(read(reader(foreign, false).service)).rejects.toThrow();
  });

  it.each([false, true])(
    "reads exact positive receipts + same full after-inventory in one query (bigint=%s)",
    async (bigint) => {
      const f = seed(),
        { service, get } = reader(f, bigint);
      const proof = await read(service);
      expect(proof).toMatchObject({
        ticketId: ids.ticket,
        leaseId: ids.lease,
        generation: 1,
        allocationId: ids.allocation,
        cleanupOperationId: ids.cleanup,
        cleanupControlVersion: 2,
        createIdentity: { controlVersion: 1 },
        cleanupIdentity: { controlVersion: 2 },
        after: { presence: "absent", verifiedAtMs: 4000 },
        readAtMs: 6000,
        io: "unknown",
        wholeScopeWriteExclusion: "unknown",
      });
      expect(proof!.objects).toHaveLength(3);
      expect(proof!.receipts).toHaveLength(3);
      expect(JSON.stringify(proof)).not.toContain("DO_NOT_DISCLOSE");
      expect(get).toHaveBeenCalledExactlyOnceWith(TICKET_CLEANUP_PROOF_SQL, [
        ids.ticket,
        ids.consumer,
        ids.lease,
        1,
      ]);
      expect(() =>
        f.db.prepare("UPDATE tickets SET phase='ready'").run(),
      ).toThrow(/readonly/i);
      const pinned = await service.read(ids.consumer, ids.ticket, {
        ...query,
        expected: {
          manifestId: f.manifest.manifestId,
          manifestHash: f.manifest.manifestHash,
          cleanupOperationId: ids.cleanup,
          cleanupControlVersion: 2,
        },
      });
      expect(pinned!.manifest).toEqual(proof!.manifest);
    },
  );
  it("missing real identity/resource, foreign owner and wrong lease never substitute empty proof", async () => {
    const f = seed(),
      { service } = reader(f);
    expect(await service.read(id(99), ids.ticket, query)).toBeNull();
    expect(
      await service.read(ids.consumer, ids.ticket, {
        leaseId: id(99),
        generation: 1,
      }),
    ).toBeNull();
    expect(
      await service.read(ids.consumer, ids.ticket, {
        leaseId: ids.lease,
        generation: 2,
      }),
    ).toBeNull();
    await expect(service.read("", ids.ticket, query)).rejects.toThrow();
    await expect(service.read(ids.consumer, "", query)).rejects.toThrow();
  });
  it.each(["allocation_owner", "runtime", "installation"] as const)(
    "rejects a mismatched actual %s domain before returning any proof",
    async (kind) => {
      const f = seed();
      if (kind === "allocation_owner")
        f.db.prepare("UPDATE allocations SET ticket_id=?").run(id(99));
      else if (kind === "runtime")
        f.db
          .prepare("UPDATE allocations SET runtime_identity_id=?")
          .run(id(99));
      else
        f.db.prepare("UPDATE installations SET installation_id=?").run(id(99));
      expect(await read(reader(f).service)).toBeNull();
    },
  );
  const invalid: [string, (f: Fixture) => void][] = [
    [
      "no new terminal control fence",
      (f) => {
        f.db.exec(
          "UPDATE allocations SET control_version=1; UPDATE operations SET control_version=1",
        );
        f.evidence.inventory.identity.controlVersion = 1;
        updateEvidence(f);
      },
    ],
    [
      "ordinary released label without actual resources",
      (f) => {
        f.ready.objects = [];
        updateReady(f);
      },
    ],
    [
      "empty managed objects",
      (f) => {
        f.db.exec("DELETE FROM managed_resources");
      },
    ],
    [
      "extra or foreign generation inventory",
      (f) => {
        f.db.exec("UPDATE managed_resources SET generation=2");
      },
    ],
    [
      "managed object not absent",
      (f) => {
        f.db.exec("UPDATE managed_resources SET observed_state='unknown'");
      },
    ],
    [
      "empty cleanup receipts",
      (f) => {
        f.evidence.destructionReceipts = [];
        updateEvidence(f);
      },
    ],
    [
      "duplicate receipts",
      (f) => {
        f.evidence.destructionReceipts[1] = f.evidence.destructionReceipts[0]!;
        updateEvidence(f);
      },
    ],
    [
      "mismatched after inventory",
      (f) => {
        f.evidence.inventory.identity.generation = 2;
        updateEvidence(f);
      },
    ],
    [
      "wrong runtime after readback",
      (f) => {
        f.evidence.inventory.runtime.runtimeIdentityId = id(99);
        updateEvidence(f);
      },
    ],
    [
      "wrong cleanup control version",
      (f) => {
        f.db.exec("UPDATE operations SET control_version=3");
      },
    ],
    [
      "ambiguous cleanup operations",
      (f) => {
        f.db.exec(
          "INSERT INTO operations SELECT 'second',allocation_id,installation_id,generation,control_version,runtime_identity_id,connection_revision_id,kind,state,created_at_ms,updated_at_ms,result_json FROM operations",
        );
      },
    ],
    [
      "wrong manifest",
      (f) => {
        f.ready.receipt.manifestHash = "f".repeat(64);
        updateReady(f);
      },
    ],
    [
      "unreleased Claim",
      (f) => {
        f.db.exec("UPDATE capacity_claims SET state='quarantined'");
      },
    ],
    [
      "unknown create effect",
      (f) => {
        f.db
          .prepare(
            "UPDATE operations SET result_json=json_set(result_json,'$.createEffects',json(?))",
          )
          .run('[{"state":"unknown"}]');
      },
    ],
    [
      "network rule removal not proven",
      (f) => {
        f.evidence.destructionReceipts[2]!.networkRules = "never_installed";
        updateEvidence(f);
      },
    ],
    [
      "receipt timestamp after final absence",
      (f) => {
        f.evidence.destructionReceipts[0]!.verifiedAtMs = 4500;
        updateEvidence(f);
      },
    ],
    [
      "future after readback",
      (f) => {
        f.evidence.verifiedAbsentAtMs = 7000;
        updateEvidence(f);
      },
    ],
  ];
  it.each(invalid)("rejects %s", async (_name, mutate) => {
    const f = seed();
    mutate(f);
    const { service } = reader(f);
    await expect(read(service)).rejects.toMatchObject({ code: "conflict" });
  });
  it("caller expected pins cannot silently select another operation or smaller inventory", async () => {
    const { service } = reader(seed());
    await expect(
      service.read(ids.consumer, ids.ticket, {
        ...query,
        expected: { cleanupOperationId: id(99) },
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

describe("ordinary authenticated route and SDK read method", () => {
  it("public SDK type and OpenAPI publish the exact read-only proof schema", () => {
    const document = openApiDocument();
    const operation =
      document.paths["/v1/tickets/{ticketId}/cleanup-proof"].get;
    expect(operation).toMatchObject({
      summary: "Read own completed cleanup proof",
    });
    expect(operation).not.toHaveProperty("requestBody");
    expect(document.components.schemas.TicketCleanupProof).toBeDefined();
    expect(document.components.schemas.CleanupProofQuery).toBeDefined();
  });
  it.each(["no_read_scope", "foreign_owner", "caller_proof_array"] as const)(
    "HTTP %s cannot supply an identity or proof substitute",
    async (kind) => {
      const { service, get } = reader(seed()),
        app = Fastify();
      const actor: Principal = {
        principalId: id(20),
        consumerId: kind === "foreign_owner" ? id(99) : ids.consumer,
        role: "consumer",
        scopes: kind === "no_read_scope" ? [] : ["tickets:read"],
        source: "bearer",
      };
      const identify = vi.fn(async () => actor);
      app.setErrorHandler((error, _request, reply) => {
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
      registerCleanupProofRoute(app, identify, service);
      try {
        const result = await app.inject({
          method: "GET",
          url:
            "/v1/tickets/" +
            ids.ticket +
            "/cleanup-proof?" +
            new URLSearchParams({
              leaseId: query.leaseId,
              generation: String(query.generation),
              ...(kind === "caller_proof_array" ? { objects: "[]" } : {}),
            }).toString(),
        });
        expect(result.statusCode).toBe(
          kind === "no_read_scope" ? 403 : kind === "foreign_owner" ? 404 : 422,
        );
        expect(get.mock.calls.length).toBe(kind === "foreign_owner" ? 1 : 0);
      } finally {
        await app.close();
      }
    },
  );
  it("actual SDK/HTTP bridge reads the same proof with existing tickets:read and no write identity path", async () => {
    const f = seed();
    const { service, get } = reader(f),
      app = Fastify();
    const principal: Principal = {
      principalId: id(20),
      consumerId: ids.consumer,
      role: "consumer",
      scopes: ["tickets:read"],
      source: "bearer",
    };
    const identify = vi.fn(
      async (_request: unknown, _write?: boolean) => principal,
    );
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code((error as { code?: string }).code === "not_found" ? 404 : 409)
        .send({ error: { code: (error as { code?: string }).code } }),
    );
    registerCleanupProofRoute(app, identify, service);
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
        const response = await app.inject({
          url: url.pathname + url.search,
          method: init?.method as "GET",
          headers,
          ...(typeof init?.body === "string" ? { payload: init.body } : {}),
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    );
    try {
      const sdk = new HitchletClient("https://controller.test", {
        fetch: request,
        auth: { kind: "bearer", token: "synthetic-unit-fixture-only" },
      });
      const proof = await sdk.tickets.cleanupProof(ids.ticket, {
        ...query,
        expected: {
          manifestHash: f.manifest.manifestHash,
          cleanupControlVersion: 2,
        },
      });
      expect(TicketCleanupProofSchema.safeParse(proof).success).toBe(true);
      expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe(
        "/v1/tickets/" + ids.ticket + "/cleanup-proof",
      );
      expect(request.mock.calls[0]?.[1]?.method).toBe("GET");
      expect(request.mock.calls[0]?.[1]?.body).toBeUndefined();
      const search = new URL(String(request.mock.calls[0]?.[0])).searchParams;
      expect(search.get("leaseId")).toBe(query.leaseId);
      expect(search.get("generation")).toBe("1");
      expect(search.get("manifestHash")).toBe(f.manifest.manifestHash);
      expect(search.get("cleanupControlVersion")).toBe("2");
      expect(
        new Headers(request.mock.calls[0]?.[1]?.headers).has("Idempotency-Key"),
      ).toBe(false);
      expect(identify.mock.calls[0]?.[1]).toBe(false);
      expect(get).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
