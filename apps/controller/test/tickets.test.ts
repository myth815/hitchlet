import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { TicketService } from "../dist/application/tickets.js";

const dirs: string[] = [];
const opened: Awaited<ReturnType<typeof openStorage>>[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-tickets-"));
  dirs.push(dir);
  const storage = await openStorage(dir);
  opened.push(storage);
  const now = 1_790_000_000_000;
  const auth = JSON.stringify({
    imageIds: "all",
    nodeIds: ["40000000-0000-4000-8000-000000000001"],
    networkProfileIds: ["30000000-0000-4000-8000-000000000001"],
    storageProfileIds: "all",
  });
  const quota = JSON.stringify({
    maxQueuedTickets: 10,
    maxActiveTickets: 2,
    maxLeaseTtlSeconds: 1800,
    maxLifetimeSeconds: 86400,
    maxResources: { cpuMillis: 8000, memoryMiB: 16000, scratchMiB: 100000 },
  });
  await storage.batchTransaction([
    {
      kind: "run",
      sql: "INSERT INTO consumers(id,name,kind,authorization_json,quota_json,created_at_ms) VALUES('10000000-0000-4000-8000-000000000001','one','agent',?,?,?)",
      params: [auth, quota, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO consumers(id,name,kind,authorization_json,quota_json,created_at_ms) VALUES('10000000-0000-4000-8000-000000000002','two','agent',?,?,?)",
      params: [auth, quota, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO images(id,name,created_at_ms) VALUES('20000000-0000-4000-8000-000000000001','image',?)",
      params: [now],
    },
    {
      kind: "run",
      sql: "INSERT INTO image_versions(id,image_id,version,status,manifest_json,created_at_ms,published_at_ms) VALUES('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','1','published','{}',?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO image_versions(id,image_id,version,status,manifest_json,created_at_ms,published_at_ms) VALUES('20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','2','published','{}',?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO image_aliases(image_id,alias,image_version_id) VALUES('20000000-0000-4000-8000-000000000001','stable','20000000-0000-4000-8000-000000000002')",
    },
    {
      kind: "run",
      sql: "INSERT INTO network_profiles(id,name,created_at_ms) VALUES('30000000-0000-4000-8000-000000000001','network',?)",
      params: [now],
    },
    {
      kind: "run",
      sql: 'INSERT INTO network_profile_revisions(id,profile_id,revision,policy_json,created_at_ms) VALUES(\'30000000-0000-4000-8000-000000000002\',\'30000000-0000-4000-8000-000000000001\',1,\'{"allowedEgress":[],"allowedIngressSourceCidrs":[],"ipv6":"disabled"}\',?)',
      params: [now],
    },
    {
      kind: "run",
      sql: "UPDATE network_profiles SET current_revision_id='30000000-0000-4000-8000-000000000002' WHERE id='30000000-0000-4000-8000-000000000001'",
    },
    {
      kind: "run",
      sql: "INSERT INTO storage_profiles(id,name,created_at_ms) VALUES('b0000000-0000-4000-8000-000000000001','storage',?)",
      params: [now],
    },
    {
      kind: "run",
      sql: "INSERT INTO storage_profile_revisions(id,profile_id,revision,kind,config_json,created_at_ms) VALUES('b0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001',1,'nfs',?,?)",
      params: [
        JSON.stringify({
          sourceRef: "nas://projects",
          allowedModes: ["read_write"],
          allowedSubpaths: ["project-a"],
        }),
        now,
      ],
    },
    {
      kind: "run",
      sql: "UPDATE storage_profiles SET current_revision_id='b0000000-0000-4000-8000-000000000002' WHERE id='b0000000-0000-4000-8000-000000000001'",
    },
    {
      kind: "run",
      sql: "INSERT INTO platform_network_deny_revisions(id,revision,management_deny_rules_json,reason,created_by_consumer_id,created_at_ms) VALUES('70000000-0000-4000-8000-000000000001',1,'[]','fixture','10000000-0000-4000-8000-000000000001',?)",
      params: [now],
    },
    {
      kind: "run",
      sql: "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES('70000000-0000-4000-8000-000000000002','destroy','lifecycle','{}',?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO runtime_identities(id,backend_kind,native_kind,native_id,created_at_ms) VALUES('80000000-0000-4000-8000-000000000001','portainer','docker_engine','engine-1',?)",
      params: [now],
    },
    {
      kind: "run",
      sql: "INSERT INTO provider_connections(id,backend_kind,runtime_identity_id,created_at_ms,updated_at_ms) VALUES('80000000-0000-4000-8000-000000000002','portainer','80000000-0000-4000-8000-000000000001',?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) VALUES('80000000-0000-4000-8000-000000000003','80000000-0000-4000-8000-000000000002',1,'fixture','1','80000000-0000-4000-8000-000000000001',?,'{}',?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "UPDATE provider_connections SET current_revision_id='80000000-0000-4000-8000-000000000003' WHERE id='80000000-0000-4000-8000-000000000002'",
    },
    {
      kind: "run",
      sql: "INSERT INTO machines(id,name,usage_mode,host_os,architecture,admission,observed_power,labels_json,created_at_ms,updated_at_ms) VALUES('50000000-0000-4000-8000-000000000001','machine','dedicated','linux','amd64','enabled','on','{}',?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO capacity_pools(id,machine_id,total_cpu_millis,total_memory_mib,total_scratch_mib,system_cpu_millis,system_memory_mib,system_scratch_mib,created_at_ms,updated_at_ms) VALUES('90000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',4000,8192,10000,1000,1024,1000,?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO nodes(id,machine_id,name,backend_kind,provider_connection_id,runtime_identity_id,pool_id,admission,observed_health,capabilities_json,observed_at_ms,created_at_ms,updated_at_ms) VALUES('40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','node','portainer','80000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','enabled','healthy',?, ?,?,?)",
      params: [
        JSON.stringify({
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 600_000).toISOString(),
          providerVersion: "fixture",
          resourceKinds: ["container"],
          guestOs: ["linux"],
          architectures: ["amd64"],
          cpuHardLimit: "verified",
          memoryHardLimit: "verified",
          scratchHardLimit: "unverified",
          offlineLeaseEnforcement: "unsupported",
          networkPolicyEnforcement: "verified",
          supportedAccess: ["ssh"],
          verifiedNetworkProfileRevisionIds: [
            "30000000-0000-4000-8000-000000000002",
          ],
          verifiedStorageProfileRevisionIds: [],
          accelerators: [],
          reportId: "70000000-0000-4000-8000-000000000003",
        }),
        now,
        now,
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,access_recipe_json,created_at_ms) VALUES('a0000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','portainer','container','amd64','linux','alpine@sha256:x','sha256:abc',1,1,0,'{\"accessProtocols\":[\"ssh\",\"rdp\"]}',?)",
      params: [now],
    },
  ]);
  return {
    storage,
    service: new TicketService({
      storage,
      now: () => now,
      id: (() => {
        let i = 0;
        return () => `60000000-0000-4000-8000-${String(++i).padStart(12, "0")}`;
      })(),
    }),
  };
}

async function addChildNode(
  storage: Awaited<ReturnType<typeof openStorage>>,
  now: number,
  parentObservedState: "running" | "stopped" = "running",
) {
  const capabilities =
    (
      await storage.get<{ capabilities_json: string }>(
        "SELECT capabilities_json FROM nodes WHERE id='40000000-0000-4000-8000-000000000001'",
      )
    )?.capabilities_json ?? "{}";
  await storage.batchTransaction([
    {
      kind: "run",
      sql: "INSERT INTO runtime_identities(id,backend_kind,native_kind,native_id,created_at_ms) VALUES('80000000-0000-4000-8000-000000000004','portainer','docker_engine','engine-child',?)",
      params: [now],
    },
    {
      kind: "run",
      sql: "INSERT INTO provider_connections(id,backend_kind,runtime_identity_id,created_at_ms,updated_at_ms) VALUES('80000000-0000-4000-8000-000000000005','portainer','80000000-0000-4000-8000-000000000004',?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) VALUES('80000000-0000-4000-8000-000000000006','80000000-0000-4000-8000-000000000005',1,'fixture','2','80000000-0000-4000-8000-000000000004',?,'{}',?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "UPDATE provider_connections SET current_revision_id='80000000-0000-4000-8000-000000000006' WHERE id='80000000-0000-4000-8000-000000000005'",
    },
    {
      kind: "run",
      sql: "INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,access_recipe_json,created_at_ms) VALUES('a0000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000002','hyperv','vm','amd64','linux','fixture-vm','sha256:vm',1,1,0,'{\"accessProtocols\":[\"ssh\",\"rdp\"]}',?)",
      params: [now],
    },
    {
      kind: "run",
      sql: "INSERT INTO allocations(id,purpose,machine_id,node_id,runtime_identity_id,image_artifact_id,generation,control_version,desired_state,observed_state,cleanup_status,resource_contract_json,ownership_json,created_at_ms,updated_at_ms) VALUES('a0000000-0000-4000-8000-000000000004','infrastructure','50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000007',1,1,'present',?,'pending','{}','{}',?,?)",
      params: [parentObservedState, now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO capacity_claims(id,allocation_id,pool_id,component,state,cpu_millis,memory_mib,scratch_mib,created_at_ms,updated_at_ms) VALUES('a0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000001','combined','committed',3000,4096,6000,?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO capacity_pools(id,machine_id,parent_allocation_id,total_cpu_millis,total_memory_mib,total_scratch_mib,system_cpu_millis,system_memory_mib,system_scratch_mib,created_at_ms,updated_at_ms) VALUES('90000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000004',2500,4096,5000,500,512,500,?,?)",
      params: [now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO nodes(id,machine_id,name,backend_kind,provider_connection_id,runtime_identity_id,pool_id,admission,observed_health,capabilities_json,observed_at_ms,created_at_ms,updated_at_ms) VALUES('40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','child','portainer','80000000-0000-4000-8000-000000000005','80000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000002','enabled','healthy',?,?,?,?)",
      params: [capabilities, now, now, now],
    },
    {
      kind: "run",
      sql: "UPDATE consumers SET authorization_json=json_set(authorization_json,'$.nodeIds',json_array('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002')) WHERE id='10000000-0000-4000-8000-000000000001'",
    },
  ]);
}

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map((db) => db.close().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const request = (seconds = 900) => ({
  image: { imageId: "20000000-0000-4000-8000-000000000001", alias: "stable" },
  resources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
  networkProfileId: "30000000-0000-4000-8000-000000000001",
  lease: { requestedSeconds: seconds },
});
const heavierRequest = (cpuMillis: number) => ({
  image: { imageId: "20000000-0000-4000-8000-000000000001", alias: "stable" },
  resources: { cpuMillis, memoryMiB: 1024, scratchMiB: 0 },
  networkProfileId: "30000000-0000-4000-8000-000000000001",
});

describe("independent admission review", () => {
  const consumerId = "10000000-0000-4000-8000-000000000001";
  it("keeps authorized requests queued while a machine temporarily drains", async () => {
    const { service, storage } = await fixture();
    await storage.run(
      "UPDATE machines SET admission='draining',version=version+1",
    );
    const ticket = await service.acquire(consumerId, "review-drain", request());
    expect(ticket.phase).toBe("queued");
    expect(await service.reserveNext()).toBeNull();
  });
  it("does not reserve a node without verified CPU, memory, and network enforcement", async () => {
    for (const [capability, key] of [
      ["cpuHardLimit", "cpu"],
      ["memoryHardLimit", "memory"],
      ["networkPolicyEnforcement", "network"],
    ] as const) {
      const { service, storage } = await fixture();
      await storage.run(
        `UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.${capability}','unverified'),version=version+1`,
      );
      await service.acquire(consumerId, `review-${key}`, request());
      expect(await service.reserveNext()).toBeNull();
    }
  });
  it("does not silently downgrade required scratch enforcement", async () => {
    const { service } = await fixture();
    const base = request();
    await service.acquire(consumerId, "review-scratch", {
      ...base,
      resources: {
        ...base.resources,
        scratchMiB: 1024,
        scratchEnforcement: "required",
      },
    });
    expect(await service.reserveNext()).toBeNull();
  });
  it("does not allocate a CPU-only node for an accelerator request", async () => {
    const { service } = await fixture();
    const base = request();
    await expect(
      service.acquire(consumerId, "review-accelerator", {
        ...base,
        resources: {
          ...base.resources,
          accelerators: [{ api: "cuda", requiredFeatures: [] }],
        },
      }),
    ).rejects.toThrow("Accelerator requests are not supported");
  });
  it("rejects invalid capability expiry instead of treating NaN as fresh", async () => {
    const { service, storage } = await fixture();
    await storage.run(
      "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.expiresAt','invalid-date'),version=version+1",
    );
    await service.acquire(consumerId, "review-expiry", request());
    expect(await service.reserveNext()).toBeNull();
  });
  it("keeps local-only tickets off cloud machines at admission and reservation", async () => {
    const beforeAcquire = await fixture();
    await beforeAcquire.storage.run(
      "UPDATE machines SET source='cloud',version=version+1",
    );
    await expect(
      beforeAcquire.service.acquire(consumerId, "cloud-directory", request()),
    ).rejects.toThrow("No authorized node can run this image version");

    const beforeReserve = await fixture();
    await beforeReserve.service.acquire(consumerId, "cloud-reserve", request());
    await beforeReserve.storage.run(
      "UPDATE machines SET source='cloud',version=version+1",
    );
    expect(await beforeReserve.service.reserveNext()).toBeNull();
  });
  it("requires both verified node and artifact access protocol support", async () => {
    for (const [sql, label] of [
      [
        "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.supportedAccess',json_array('rdp')),version=version+1",
        "node-access",
      ],
      [
        "UPDATE image_artifacts SET access_recipe_json=json_set(access_recipe_json,'$.accessProtocols',json_array('rdp'))",
        "artifact-access",
      ],
    ] as const) {
      const { service, storage } = await fixture();
      await storage.run(sql);
      await service.acquire(consumerId, label, request());
      expect(await service.reserveNext()).toBeNull();
    }
  });
});

describe("SQLite Ticket admission", () => {
  it("replays by consumer/key, rejects changed bodies, and isolates owners", async () => {
    const { service, storage } = await fixture();
    const first = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "same",
      request(),
    );
    expect(
      await service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "same",
        request(),
      ),
    ).toMatchObject({ ticketId: first.ticketId, replayed: true });
    await expect(
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "same",
        request(901),
      ),
    ).rejects.toThrow(/different request/);
    const other = await service.acquire(
      "10000000-0000-4000-8000-000000000002",
      "same",
      request(),
    );
    expect(other.ticketId).not.toBe(first.ticketId);
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM events WHERE aggregate_type='ticket'",
      ),
    ).toMatchObject({ n: 2n });
  });
  it("checks idempotency before alias resolution and freezes accepted TTL", async () => {
    const { service, storage } = await fixture();
    const first = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "stable-key",
      request(),
    );
    await storage.run(
      "UPDATE image_aliases SET image_version_id='20000000-0000-4000-8000-000000000003' WHERE image_id='20000000-0000-4000-8000-000000000001' AND alias='stable'",
    );
    await storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxLeaseTtlSeconds',100) WHERE id='10000000-0000-4000-8000-000000000001'",
    );
    expect(
      await service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "stable-key",
        request(),
      ),
    ).toMatchObject({ ticketId: first.ticketId, replayed: true });
    const stored = await storage.get<{
      request_json: string;
      accepted_contract_json: string;
      image_version_id: string;
    }>(
      "SELECT request_json,accepted_contract_json,image_version_id FROM tickets WHERE id=?",
      [first.ticketId],
    );
    expect(stored?.image_version_id).toBe(
      "20000000-0000-4000-8000-000000000002",
    );
    expect(
      JSON.parse(stored?.request_json ?? "{}").lease.maximumTtlSeconds,
    ).toBe(1800);
    expect(
      JSON.parse(stored?.accepted_contract_json ?? "{}").selectionHash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });
  it("freezes exact storage revision and rejects paths or modes outside its allowlist", async () => {
    const { service, storage } = await fixture();
    const good = {
      ...request(),
      storage: [
        {
          storageProfileId: "b0000000-0000-4000-8000-000000000001",
          authorizedSubpath: "project-a/work",
          mountPath: "/workspace/data",
          mode: "read_write" as const,
        },
      ],
    };
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "storage-good",
      good,
    );
    const saved = await storage.get<{ accepted_contract_json: string }>(
      "SELECT accepted_contract_json FROM tickets WHERE id=?",
      [ticket.ticketId],
    );
    expect(
      JSON.parse(saved?.accepted_contract_json ?? "{}").storage[0],
    ).toMatchObject({
      storageProfileRevisionId: "b0000000-0000-4000-8000-000000000002",
      protocol: "nfs",
      approvedSourceRef: "nas://projects",
    });
    await expect(
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "storage-bad-path",
        {
          ...good,
          storage: [{ ...good.storage[0], authorizedSubpath: "other/path" }],
        },
      ),
    ).rejects.toThrow(/authorization/);
    await expect(
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "storage-bad-mode",
        { ...good, storage: [{ ...good.storage[0], mode: "read_only" }] },
      ),
    ).rejects.toThrow(/authorization/);
  });
  it("reserves against the live SQLite capacity pool and links ticket, allocation, claim, and event atomically", async () => {
    const { service, storage } = await fixture();
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "reserve",
      request(),
    );
    const reservation = await service.reserveNext();
    expect(reservation?.ticketId).toBe(ticket.ticketId);
    expect(
      await storage.get("SELECT phase FROM tickets WHERE id=?", [
        ticket.ticketId,
      ]),
    ).toMatchObject({ phase: "reserved" });
    expect(
      await storage.get(
        "SELECT state,cpu_millis FROM capacity_claims WHERE allocation_id=?",
        [reservation?.allocationId],
      ),
    ).toMatchObject({ state: "reserved", cpu_millis: 1000n });
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM events WHERE aggregate_id=? AND event_type='ticket.reserved'",
        [ticket.ticketId],
      ),
    ).toMatchObject({ n: 1n });
  });
  it("serializes concurrent requests for the last capacity and leaves the loser queued", async () => {
    const { service, storage } = await fixture();
    const [left, right] = await Promise.all([
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "left",
        heavierRequest(2000),
      ),
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "right",
        heavierRequest(2000),
      ),
    ]);
    const outcomes = await Promise.all([
      service.reserveNext(),
      service.reserveNext(),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM allocations WHERE purpose='tenant'",
      ),
    ).toMatchObject({ n: 1n });
    expect(
      await storage.get(
        "SELECT sum(cpu_millis) AS n FROM capacity_claims WHERE state<>'released'",
      ),
    ).toMatchObject({ n: 2000n });
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM tickets WHERE phase='queued' AND id IN (?,?)",
        [left.ticketId, right.ticketId],
      ),
    ).toMatchObject({ n: 1n });
  });
  it("concurrently replays one owner-scoped idempotency key as one ticket", async () => {
    const { service, storage } = await fixture();
    const outcomes = await Promise.all([
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "parallel-key",
        request(),
      ),
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "parallel-key",
        request(),
      ),
    ]);
    expect(outcomes[0]?.ticketId).toBe(outcomes[1]?.ticketId);
    expect(outcomes.filter((x) => x.replayed)).toHaveLength(1);
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM tickets WHERE consumer_id='10000000-0000-4000-8000-000000000001'",
      ),
    ).toMatchObject({ n: 1n });
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM events WHERE event_type='ticket.queued'",
      ),
    ).toMatchObject({ n: 1n });
  });
  it("applies consumer active-ticket quota inside the reservation transaction", async () => {
    const { service, storage } = await fixture();
    await storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxActiveTickets',1) WHERE id='10000000-0000-4000-8000-000000000001'",
    );
    const [left, right] = await Promise.all([
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "q-left",
        request(),
      ),
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "q-right",
        request(),
      ),
    ]);
    const outcomes = await Promise.all([
      service.reserveNext(),
      service.reserveNext(),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM tickets WHERE phase='reserved' AND id IN (?,?)",
        [left.ticketId, right.ticketId],
      ),
    ).toMatchObject({ n: 1n });
  });
  it("applies consumer resource quota atomically across concurrent reservations", async () => {
    const { service, storage } = await fixture();
    await storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxResources.cpuMillis',2500) WHERE id='10000000-0000-4000-8000-000000000001'",
    );
    const [left, right] = await Promise.all([
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "resource-left",
        heavierRequest(2000),
      ),
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "resource-right",
        heavierRequest(2000),
      ),
    ]);
    const outcomes = await Promise.all([
      service.reserveNext(),
      service.reserveNext(),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(
      await storage.get(
        "SELECT sum(cpu_millis) AS n FROM capacity_claims c JOIN allocations a ON a.id=c.allocation_id JOIN tickets t ON t.id=a.ticket_id WHERE t.consumer_id='10000000-0000-4000-8000-000000000001' AND c.state<>'released'",
      ),
    ).toMatchObject({ n: 2000n });
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM tickets WHERE phase='queued' AND id IN (?,?)",
        [left.ticketId, right.ticketId],
      ),
    ).toMatchObject({ n: 1n });
  });
  it("rolls the full reservation back when a later event write fails", async () => {
    const { service, storage } = await fixture();
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "rollback",
      request(),
    );
    await storage.run(
      "CREATE TRIGGER fail_reserved_event BEFORE INSERT ON events WHEN NEW.event_type='ticket.reserved' BEGIN SELECT RAISE(ABORT,'forced event failure'); END",
    );
    await expect(service.reserveNext()).rejects.toThrow();
    expect(
      await storage.get("SELECT phase,version FROM tickets WHERE id=?", [
        ticket.ticketId,
      ]),
    ).toMatchObject({ phase: "queued", version: 1n });
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM allocations WHERE ticket_id=?",
        [ticket.ticketId],
      ),
    ).toMatchObject({ n: 0n });
    expect(
      await storage.get("SELECT count(*) AS n FROM leases WHERE ticket_id=?", [
        ticket.ticketId,
      ]),
    ).toMatchObject({ n: 0n });
    expect(
      await storage.get("SELECT count(*) AS n FROM capacity_claims"),
    ).toMatchObject({ n: 0n });
    expect(
      await storage.get(
        "SELECT version FROM capacity_pools WHERE id='90000000-0000-4000-8000-000000000001'",
      ),
    ).toMatchObject({ version: 1n });
  });
  it("keeps expected-off nodes queued until verified wake and healthy observations exist", async () => {
    const { service, storage } = await fixture();
    await storage.run(
      "UPDATE machines SET observed_power='unknown',power_lifecycle='off_expected',power_cycle_id='cycle-unverified',power_transition_id='transition-unverified',shutdown_accepted_at_ms=1789999880000,wake_not_before_ms=1790000000000,power_transition_deadline_ms=1790000600000,version=version+1 WHERE id='50000000-0000-4000-8000-000000000001'",
    );
    await storage.run(
      "UPDATE nodes SET observed_health='unknown',version=version+1 WHERE id='40000000-0000-4000-8000-000000000001'",
    );
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "offline-unverified",
      request(),
    );
    expect(await service.reserveNext()).toBeNull();
    expect(
      await storage.get("SELECT phase FROM tickets WHERE id=?", [
        ticket.ticketId,
      ]),
    ).toMatchObject({ phase: "queued" });
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM allocations WHERE purpose='tenant'",
      ),
    ).toMatchObject({ n: 0n });
    expect(await storage.get("SELECT count(*) AS n FROM leases")).toMatchObject(
      { n: 0n },
    );
  });
  it("reserves a cold-off node only with verified wake evidence, then binds after wake", async () => {
    const { service, storage } = await fixture();
    const now = 1_790_000_000_000;
    await storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES('70000000-0000-4000-8000-000000000003','wake','machine',?,?,?)",
        params: [
          JSON.stringify({
            enabled: true,
            dryRun: false,
            wakeOnDemand: true,
            maximumWakeAttempts: 3,
            permitForcedPhysicalPowerOff: false,
          }),
          now,
          now,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO agents(id,machine_id,kind,credential_hash) VALUES('70000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000001','host','hash')",
      },
      {
        kind: "run",
        sql: "INSERT INTO operations(id,machine_id,machine_epoch,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES('70000000-0000-4000-8000-000000000006','50000000-0000-4000-8000-000000000001',1,1,'machine.shutdown','cycle-1','shutdown-cycle-1','succeeded',?,'{}',?,?,?)",
        params: ["a".repeat(64), now, now, now],
      },
      {
        kind: "run",
        sql: "INSERT INTO agent_commands(id,agent_id,operation_id,sequence,controller_epoch,machine_epoch,kind,payload_json,request_hash,state,not_after_ms,created_at_ms) VALUES('70000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000005','70000000-0000-4000-8000-000000000006',1,1,1,'machine.shutdown','{}',?,'completed',?,?)",
        params: ["a".repeat(64), now + 60_000, now],
      },
      {
        kind: "run",
        sql: "INSERT INTO agent_receipts(id,command_id,agent_id,agent_boot_id,receipt_sequence,phase,request_hash,result_json,observed_at_ms,received_at_ms) VALUES('70000000-0000-4000-8000-000000000008','70000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000005','boot-1',0,'accepted',?,'{}',?,?)",
        params: ["a".repeat(64), now, now],
      },
      {
        kind: "run",
        sql: "UPDATE machines SET observed_power='unknown',power_lifecycle='off_expected',power_cycle_id='cycle-1',power_transition_id='shutdown-1',shutdown_operation_id='70000000-0000-4000-8000-000000000006',accepted_shutdown_receipt_id='70000000-0000-4000-8000-000000000008',shutdown_accepted_at_ms=?,wake_not_before_ms=?,power_transition_deadline_ms=?,policy_id='70000000-0000-4000-8000-000000000003',capabilities_json=?,version=version+1 WHERE id='50000000-0000-4000-8000-000000000001'",
        params: [
          now - 120_000,
          now,
          now + 600_000,
          JSON.stringify({
            coldBoot: "verified",
            wolWhilePossiblyOn: "verified",
            wakeFromSleep: "unsupported",
            wakeRouteRef: "wol-route",
            verificationReportIds: ["70000000-0000-4000-8000-000000000004"],
          }),
        ],
      },
      {
        kind: "run",
        sql: "UPDATE nodes SET observed_health='unknown',version=version+1 WHERE id='40000000-0000-4000-8000-000000000001'",
      },
    ]);
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "verified-cold-wake",
      request(),
    );
    const allocation = await service.reserveNext();
    expect(allocation?.ticketId).toBe(ticket.ticketId);
    expect(
      await storage.get(
        "SELECT state,claim_by_ms,expires_at_ms FROM leases WHERE ticket_id=?",
        [ticket.ticketId],
      ),
    ).toMatchObject({ state: "pending", expires_at_ms: null });
    const stored = await storage.get<{
      version: bigint;
      accepted_contract_json: string;
    }>("SELECT version,accepted_contract_json FROM tickets WHERE id=?", [
      ticket.ticketId,
    ]);
    const selectionHash = JSON.parse(stored?.accepted_contract_json ?? "{}")
      .selectionHash as string;
    const contractId = "a0000000-0000-4000-8000-000000000010";
    await storage.run(
      "INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json) VALUES(?,?,?,?,'30000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001',?,'[]','{}')",
      [contractId, allocation?.nodeId, selectionHash, now, "1".repeat(64)],
    );
    await storage.run(
      "UPDATE machines SET observed_power='on',power_lifecycle='idle',out_of_band_evidence_id=NULL,version=version+1 WHERE id='50000000-0000-4000-8000-000000000001'",
    );
    await storage.run(
      "UPDATE nodes SET observed_health='healthy',observed_at_ms=?,version=version+1 WHERE id='40000000-0000-4000-8000-000000000001'",
      [now],
    );
    await service.bindProvisionContract({
      allocationId: allocation?.allocationId ?? "",
      ticketVersion: Number(stored?.version),
      nodeVersion: 4,
      generation: 1,
      controlVersion: 1,
      contractId,
      selectionHash,
    });
    expect(
      await storage.get(
        "SELECT resolved_provision_contract_id FROM allocations WHERE id=?",
        [allocation?.allocationId],
      ),
    ).toMatchObject({ resolved_provision_contract_id: contractId });
  });
  it("keeps unknown claims occupied and subtracts platform reserve once per pool", async () => {
    const { service, storage } = await fixture();
    const first = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "unknown-1",
      heavierRequest(2000),
    );
    const reservation = await service.reserveNext();
    expect(reservation?.ticketId).toBe(first.ticketId);
    await storage.run(
      "UPDATE capacity_claims SET state='quarantined' WHERE allocation_id=?",
      [reservation?.allocationId],
    );
    const second = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "unknown-2",
      heavierRequest(2000),
    );
    expect(await service.reserveNext()).toBeNull();
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM allocations WHERE purpose='tenant'",
      ),
    ).toMatchObject({ n: 1n });
    expect(
      await storage.get("SELECT phase FROM tickets WHERE id=?", [
        second.ticketId,
      ]),
    ).toMatchObject({ phase: "queued" });
  });
  it("subtracts the system and human-reserved pool budget exactly once", async () => {
    const { service, storage } = await fixture();
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "reserve-after-platform",
      heavierRequest(3000),
    );
    expect((await service.reserveNext())?.ticketId).toBe(ticket.ticketId);
    expect(
      await storage.get(
        "SELECT cpu_millis FROM capacity_claims WHERE pool_id='90000000-0000-4000-8000-000000000001' AND state<>'released'",
      ),
    ).toMatchObject({ cpu_millis: 3000n });
  });
  it("does not double charge a child-pool tenant claim to its root budget", async () => {
    const { service, storage } = await fixture();
    await addChildNode(storage, 1_790_000_000_000);
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "child",
      heavierRequest(2000),
    );
    const allocation = await service.reserveNext();
    expect(allocation?.ticketId).toBe(ticket.ticketId);
    expect(allocation?.nodeId).toBe("40000000-0000-4000-8000-000000000002");
    expect(
      await storage.get(
        "SELECT sum(cpu_millis) AS n FROM capacity_claims WHERE pool_id='90000000-0000-4000-8000-000000000001' AND state<>'released'",
      ),
    ).toMatchObject({ n: 3000n });
    expect(
      await storage.get(
        "SELECT sum(cpu_millis) AS n FROM capacity_claims WHERE pool_id='90000000-0000-4000-8000-000000000002' AND state<>'released'",
      ),
    ).toMatchObject({ n: 2000n });
  });
  it("does not reserve from a child pool when its infrastructure parent is stopped", async () => {
    const { service, storage } = await fixture();
    await addChildNode(storage, 1_790_000_000_000, "stopped");
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "child-parent-stopped",
      heavierRequest(2000),
    );
    expect(await service.reserveNext()).toBeNull();
    expect(
      await storage.get("SELECT phase FROM tickets WHERE id=?", [
        ticket.ticketId,
      ]),
    ).toMatchObject({ phase: "queued" });
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM allocations WHERE purpose='tenant'",
      ),
    ).toMatchObject({ n: 0n });
  });
  it("binds the verified provision contract once with ticket, node, generation, control, and frozen-selection CAS", async () => {
    const { service, storage } = await fixture();
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "bind",
      request(),
    );
    const allocation = await service.reserveNext();
    expect(
      await storage.get(
        "SELECT resolved_provision_contract_id FROM allocations WHERE id=?",
        [allocation?.allocationId],
      ),
    ).toMatchObject({ resolved_provision_contract_id: null });
    const t = await storage.get<{
      version: bigint;
      accepted_contract_json: string;
    }>("SELECT version,accepted_contract_json FROM tickets WHERE id=?", [
      ticket.ticketId,
    ]);
    const selectionHash = JSON.parse(t?.accepted_contract_json ?? "{}")
      .selectionHash as string;
    const cid = "a0000000-0000-4000-8000-000000000002";
    await storage.run(
      "INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json) VALUES(?,?,?,?,'30000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001',?,'[]','{}')",
      [cid, allocation?.nodeId, selectionHash, 1, "b".repeat(64)],
    );
    const args = {
      allocationId: allocation?.allocationId ?? "",
      ticketVersion: Number(t?.version),
      nodeVersion: 2,
      generation: 1,
      controlVersion: 1,
      contractId: cid,
      selectionHash,
    };
    await expect(
      service.bindProvisionContract({ ...args, selectionHash: "c".repeat(64) }),
    ).rejects.toThrow();
    await service.bindProvisionContract(args);
    await expect(service.bindProvisionContract(args)).rejects.toThrow();
    expect(
      await storage.get(
        "SELECT resolved_provision_contract_id FROM allocations WHERE id=?",
        [args.allocationId],
      ),
    ).toMatchObject({ resolved_provision_contract_id: cid });
  });
  it("rejects binding until the reserved node has fresh healthy and online evidence", async () => {
    const { service, storage } = await fixture();
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "bind-health",
      request(),
    );
    const allocation = await service.reserveNext();
    const t = await storage.get<{
      version: bigint;
      accepted_contract_json: string;
    }>("SELECT version,accepted_contract_json FROM tickets WHERE id=?", [
      ticket.ticketId,
    ]);
    const selectionHash = JSON.parse(t?.accepted_contract_json ?? "{}")
      .selectionHash as string;
    const cid = "a0000000-0000-4000-8000-000000000009";
    await storage.run(
      "INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json) VALUES(?,?,?,?,'30000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001',?,'[]','{}')",
      [cid, allocation?.nodeId, selectionHash, 1, "f".repeat(64)],
    );
    await storage.run(
      "UPDATE nodes SET observed_health='unknown',version=version+1 WHERE id=?",
      [allocation?.nodeId],
    );
    await expect(
      service.bindProvisionContract({
        allocationId: allocation?.allocationId ?? "",
        ticketVersion: Number(t?.version),
        nodeVersion: 3,
        generation: 1,
        controlVersion: 1,
        contractId: cid,
        selectionHash,
      }),
    ).rejects.toThrow();
    expect(
      await storage.get(
        "SELECT resolved_provision_contract_id FROM allocations WHERE id=?",
        [allocation?.allocationId],
      ),
    ).toMatchObject({ resolved_provision_contract_id: null });
  });
  it("cancellation fences a delayed provision-contract bind and preserves its claim", async () => {
    const { service, storage } = await fixture();
    const ticket = await service.acquire(
      "10000000-0000-4000-8000-000000000001",
      "cancel-bind",
      request(),
    );
    const allocation = await service.reserveNext();
    const t = await storage.get<{
      version: bigint;
      accepted_contract_json: string;
    }>("SELECT version,accepted_contract_json FROM tickets WHERE id=?", [
      ticket.ticketId,
    ]);
    const selectionHash = JSON.parse(t?.accepted_contract_json ?? "{}")
      .selectionHash as string;
    const cid = "a0000000-0000-4000-8000-000000000003";
    await storage.run(
      "INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json) VALUES(?,?,?,?,'30000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001',?,'[]','{}')",
      [cid, allocation?.nodeId, selectionHash, 1, "d".repeat(64)],
    );
    await service.cancel(
      ticket.ticketId,
      "10000000-0000-4000-8000-000000000001",
    );
    await expect(
      service.bindProvisionContract({
        allocationId: allocation?.allocationId ?? "",
        ticketVersion: Number(t?.version),
        nodeVersion: 2,
        generation: 1,
        controlVersion: 1,
        contractId: cid,
        selectionHash,
      }),
    ).rejects.toThrow();
    expect(
      await storage.get("SELECT phase FROM tickets WHERE id=?", [
        ticket.ticketId,
      ]),
    ).toMatchObject({ phase: "releasing" });
    expect(
      await storage.get(
        "SELECT resolved_provision_contract_id,control_version FROM allocations WHERE id=?",
        [allocation?.allocationId],
      ),
    ).toMatchObject({
      resolved_provision_contract_id: null,
      control_version: 2n,
    });
    expect(
      await storage.get(
        "SELECT state FROM capacity_claims WHERE allocation_id=?",
        [allocation?.allocationId],
      ),
    ).toMatchObject({ state: "reserved" });
  });
  it("stores no ticket or event when the queued quota guard fails", async () => {
    const { service, storage } = await fixture();
    await storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxQueuedTickets',0) WHERE id='10000000-0000-4000-8000-000000000001'",
    );
    await expect(
      service.acquire(
        "10000000-0000-4000-8000-000000000001",
        "full",
        request(),
      ),
    ).rejects.toThrow();
    expect(
      await storage.get(
        "SELECT count(*) AS n FROM tickets WHERE consumer_id='10000000-0000-4000-8000-000000000001'",
      ),
    ).toMatchObject({ n: 0n });
  });
});
