import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { TicketService } from "../dist/application/tickets.js";
import { TicketQueries } from "../dist/application/queries.js";
import { LeaseService } from "../dist/application/leases.js";
import { OperationWorker } from "../dist/application/operations.js";
import { PersistentSimulator } from "../dist/providers/simulator.js";
import { buildApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { LocalSecretStore } from "../dist/storage/secret-store.js";
import ssh2 from "ssh2";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-d05-review-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "db");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    {
      env: { ...process.env, DATA_DIR: dataDir },
    },
  );
  const token = stdout.match(/Bearer token \(shown once\): (\S+)/)?.[1];
  const consumerId = stdout.match(/Consumer ID: (\S+)/)?.[1];
  const versionId = stdout.match(/Image version: (\S+)/)?.[1];
  const networkProfileId = stdout.match(/Network profile: (\S+)/)?.[1];
  if (!token || !consumerId || !versionId || !networkProfileId)
    throw new Error("Incomplete Simulator fixture");
  const storage = await openStorage(dataDir);
  cleanup.push(() => storage.close());
  const installation = await storage.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations WHERE singleton=1",
  );
  if (!installation) throw new Error("Fixture has no installation");
  let current = Date.now();
  const now = () => current;
  const tickets = new TicketService({
    storage,
    installationId: installation.installation_id,
    now,
  });
  const worker = new OperationWorker({
    storage,
    installationId: installation.installation_id,
    execution: new PersistentSimulator(join(dir, "external")),
    now,
  });
  const leases = new LeaseService(storage, now);
  const queries = new TicketQueries(storage, now);
  const accepted = await tickets.acquire(consumerId, "fixture-acquire", {
    image: { versionId },
    resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
    networkProfileId,
    lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
  });
  await tickets.reserveNext();
  await worker.reconcileBeforeScheduling();
  const ready = await queries.get(consumerId, accepted.ticketId);
  if (ready?.phase !== "ready" || !ready.lease)
    throw new Error("Fixture did not become ready");
  const request = {
    generation: ready.lease.generation,
    expectedLeaseVersion: ready.lease.version,
  };
  return {
    storage,
    dataDir,
    dir,
    token,
    consumerId,
    versionId,
    networkProfileId,
    tickets,
    worker,
    leases,
    queries,
    ready,
    request,
    now,
    setTime(value: number) {
      current = value;
    },
  };
}

async function addPortainerAuditIntent(f: Awaited<ReturnType<typeof fixture>>) {
  const allocation = await f.storage.get<{ allocation_id: string }>(
    "SELECT allocation_id FROM leases WHERE ticket_id=?",
    [f.ready.id],
  );
  if (!allocation) throw new Error("Ready fixture has no allocation");
  const provision = await f.storage.get<{ id: string }>(
    "SELECT id FROM operations WHERE allocation_id=? AND kind='allocation.provision' ORDER BY created_at_ms LIMIT 1",
    [allocation.allocation_id],
  );
  if (!provision) throw new Error("Ready fixture has no provision operation");
  const id = randomUUID();
  await f.storage.run(
    `INSERT INTO operations(id,installation_id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,result_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms)
     SELECT ?,installation_id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,'allocation.provision','integrity-audit-fixture',?,'succeeded',request_hash,json_set(intent_json,'$.executionMode','portainer'),result_json,?,?,?,? FROM operations WHERE id=?`,
    [
      id,
      `${allocation.allocation_id}:integrity-audit-fixture`,
      f.now(),
      f.now() + 30_000,
      f.now(),
      f.now(),
      provision.id,
    ],
  );
  await f.storage.run(
    "UPDATE operations SET kind='allocation.provision.fixture' WHERE id=?",
    [provision.id],
  );
  return { allocationId: allocation.allocation_id, provisionId: id };
}

describe("independent D05 protocol and lease review", () => {
  it("audits ready Portainer allocations without recreating them and retains claims on unknown inspection", async () => {
    const f = await fixture();
    const allocation = await addPortainerAuditIntent(f);
    const external = new PersistentSimulator(join(f.dir, "external"));
    const execution = {
      create: external.create.bind(external),
      ready: external.ready.bind(external),
      revokeStop: external.revokeStop.bind(external),
      destroy: external.destroy.bind(external),
      inspect: async (plan: Parameters<typeof external.inspect>[0]) => {
        if (plan.executionPhase === "observe")
          return {
            presence: "unknown" as const,
            reason: "inventory_incomplete" as const,
          };
        return external.inspect(plan);
      },
    };
    await f.storage.run(
      "UPDATE installations SET controller_epoch=controller_epoch+1 WHERE singleton=1",
    );
    f.setTime(f.now() + 31_000);
    const restarted = new OperationWorker({
      storage: f.storage,
      execution,
      installationId: (await f.storage.get<{ installation_id: string }>(
        "SELECT installation_id FROM installations WHERE singleton=1",
      ))!.installation_id,
      controllerEpoch: Number(
        (await f.storage.get<{ controller_epoch: bigint }>(
          "SELECT controller_epoch FROM installations WHERE singleton=1",
        ))!.controller_epoch,
      ),
      now: f.now,
    });
    await restarted.reconcile();
    expect(
      await f.storage.get<{ phase: string; terminal_reason: string | null }>(
        "SELECT phase,terminal_reason FROM tickets WHERE id=?",
        [f.ready.id],
      ),
    ).toMatchObject({ phase: "ready", terminal_reason: null });
    expect(
      await f.storage.get<{ state: string }>(
        "SELECT state FROM capacity_claims WHERE allocation_id=?",
        [allocation.allocationId],
      ),
    ).toMatchObject({ state: "committed" });
    expect(
      await f.storage.get<{
        state: string;
        diagnostic: string;
        controller_epoch: bigint;
      }>(
        "SELECT json_extract(result_json,'$.integrity.state') AS state,json_extract(result_json,'$.integrity.reason') AS diagnostic,controller_epoch FROM operations WHERE id=?",
        [allocation.provisionId],
      ),
    ).toMatchObject({
      state: "unknown",
      diagnostic: "inventory_incomplete",
      controller_epoch: 2n,
    });
  });

  it("terminates a ready allocation as resource_lost only after confirmed integrity loss", async () => {
    const f = await fixture();
    const allocation = await addPortainerAuditIntent(f);
    const external = new PersistentSimulator(join(f.dir, "external"));
    const execution = {
      create: external.create.bind(external),
      ready: external.ready.bind(external),
      revokeStop: external.revokeStop.bind(external),
      destroy: external.destroy.bind(external),
      inspect: async (plan: Parameters<typeof external.inspect>[0]) => {
        if (plan.executionPhase === "observe")
          return {
            presence: "present" as const,
            evidence: {
              completeness: "complete" as const,
              runtime: {
                runtimeIdentityId: plan.identity.runtimeIdentityId,
                connectionRevisionId: plan.identity.connectionRevisionId,
              },
              identity: plan.identity,
              objects: [],
            },
            integrity: {
              state: "lost" as const,
              reason: "NETWORK_GUARANTEE_LOST",
            },
          };
        return external.inspect(plan);
      },
    };
    const installation = await f.storage.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    const worker = new OperationWorker({
      storage: f.storage,
      execution,
      installationId: installation!.installation_id,
      controllerEpoch: Number(installation!.controller_epoch),
      now: f.now,
    });
    await worker.reconcile();
    expect(
      await f.storage.get<{
        phase: string;
        terminal_reason: string;
        cleanup_status: string;
      }>(
        "SELECT phase,terminal_reason,cleanup_status FROM tickets WHERE id=?",
        [f.ready.id],
      ),
    ).toMatchObject({
      phase: "releasing",
      terminal_reason: "resource_lost",
      cleanup_status: "pending",
    });
    expect(
      await f.storage.get<{ state: string }>(
        "SELECT state FROM capacity_claims WHERE allocation_id=?",
        [allocation.allocationId],
      ),
    ).toMatchObject({ state: "committed" });
    expect(
      await f.storage.get<{ diagnostic: string }>(
        "SELECT json_extract(payload_json,'$.detail') AS diagnostic FROM events WHERE aggregate_type='ticket' AND aggregate_id=? AND event_type='ticket.terminated' ORDER BY occurred_at_ms DESC LIMIT 1",
        [f.ready.id],
      ),
    ).toMatchObject({ diagnostic: "NETWORK_GUARANTEE_LOST" });
    expect(
      await f.storage.get<{ state: string }>(
        "SELECT state FROM operations WHERE allocation_id=? AND kind='allocation.cleanup'",
        [allocation.allocationId],
      ),
    ).toMatchObject({ state: "planned" });
  });

  it("does not let a stale lost-resource observation overwrite a concurrent release", async () => {
    const f = await fixture();
    await addPortainerAuditIntent(f);
    const external = new PersistentSimulator(join(f.dir, "external"));
    let released = false;
    const execution = {
      create: external.create.bind(external),
      ready: external.ready.bind(external),
      revokeStop: external.revokeStop.bind(external),
      destroy: external.destroy.bind(external),
      inspect: async (plan: Parameters<typeof external.inspect>[0]) => {
        if (plan.executionPhase === "observe") {
          if (!released) {
            released = true;
            await f.tickets.cancel(f.ready.id, f.consumerId);
          }
          return {
            presence: "absent" as const,
            evidence: {
              completeness: "complete" as const,
              runtime: {
                runtimeIdentityId: plan.identity.runtimeIdentityId,
                connectionRevisionId: plan.identity.connectionRevisionId,
              },
              identity: plan.identity,
            },
          };
        }
        return external.inspect(plan);
      },
    };
    const installation = await f.storage.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    await new OperationWorker({
      storage: f.storage,
      execution,
      installationId: installation!.installation_id,
      controllerEpoch: Number(installation!.controller_epoch),
      now: f.now,
    }).reconcile();
    expect(released).toBe(true);
    expect(
      await f.storage.get<{ phase: string; terminal_reason: string }>(
        "SELECT phase,terminal_reason FROM tickets WHERE id=?",
        [f.ready.id],
      ),
    ).toMatchObject({ phase: "releasing", terminal_reason: "consumer_cancel" });
  });

  it("confirms Portainer claim and renewal across a storage restart before serving private access", async () => {
    const f = await fixture();
    const keyFile = join(f.dir, "secret-master-key");
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    const secrets = await LocalSecretStore.open(f.dataDir, keyFile);
    const privateKey = ssh2.utils.generateKeyPairSync("ed25519").private;
    const secretRef = await secrets.put(privateKey);
    const accessReceipt = JSON.stringify({
      receipt: {
        access: {
          host: "127.0.0.1",
          port: 22022,
          username: "workspace",
          hostKeyFingerprint: "SHA256:fixture-host-key-fingerprint",
        },
      },
    });
    const allocation = await f.storage.get<{ allocation_id: string }>(
      "SELECT allocation_id FROM leases WHERE ticket_id=?",
      [f.ready.id],
    );
    if (!allocation) throw new Error("Ready fixture has no allocation");
    await f.storage.run(
      `INSERT INTO operations(id,installation_id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms)
       SELECT ?,installation_id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,'allocation.provision','access-fixture',?,'succeeded',request_hash,json_set(intent_json,'$.executionMode','portainer'),?,?,?,?
       FROM operations WHERE allocation_id=? AND kind='allocation.provision' ORDER BY created_at_ms DESC LIMIT 1`,
      [
        randomUUID(),
        `${allocation.allocation_id}:access-fixture`,
        f.now() + 5_000,
        f.now() + 30_000,
        f.now() + 5_000,
        f.now() + 5_000,
        allocation.allocation_id,
      ],
    );
    await f.storage.run(
      "UPDATE allocations SET access_secret_ref=?,actual_resources_json=? WHERE id=?",
      [secretRef, accessReceipt, allocation.allocation_id],
    );

    const initialPortainerApp = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        GUI_DIR: join(f.dir, "no-gui"),
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "portainer",
        HITCHLET_SECRET_KEY_FILE: keyFile,
      }),
      { storage: f.storage, secrets },
    );
    cleanup.push(() => initialPortainerApp.close());
    const headers = (key: string) => ({
      authorization: `Bearer ${f.token}`,
      "idempotency-key": key,
    });
    const claimDeadline = await f.storage.get<{ claim_by_ms: bigint }>(
      "SELECT claim_by_ms FROM leases WHERE ticket_id=?",
      [f.ready.id],
    );
    await f.storage.run("UPDATE leases SET claim_by_ms=? WHERE ticket_id=?", [
      Date.now() - 1,
      f.ready.id,
    ]);
    const lateClaim = await initialPortainerApp.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/renew`,
      headers: headers("portainer-late-first-claim"),
      payload: f.request,
    });
    expect(lateClaim.statusCode).toBe(409);
    expect(lateClaim.json().error.code).toBe("claim_deadline_expired");
    await f.storage.run("UPDATE leases SET claim_by_ms=? WHERE ticket_id=?", [
      claimDeadline!.claim_by_ms,
      f.ready.id,
    ]);
    const claim = await initialPortainerApp.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/renew`,
      headers: headers("portainer-first-claim"),
      payload: f.request,
    });
    expect(claim.statusCode).toBe(202);
    const denied = await initialPortainerApp.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/access`,
      headers: headers("unclaimed-portainer-access"),
      payload: { generation: f.request.generation },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe("lease_not_accessible");

    await initialPortainerApp.close();
    await f.storage.close();
    const storage = await openStorage(f.dataDir);
    cleanup.push(() => storage.close());
    await new LeaseService(storage).reconcilePending();
    const portainerApp = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        GUI_DIR: join(f.dir, "no-gui"),
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "portainer",
        HITCHLET_SECRET_KEY_FILE: keyFile,
      }),
      { storage, secrets },
    );
    cleanup.push(() => portainerApp.close());
    const claimedReplay = await portainerApp.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/renew`,
      headers: headers("portainer-first-claim"),
      payload: f.request,
    });
    expect(claimedReplay.statusCode).toBe(200);
    expect(claimedReplay.json().leaseVersion).toBe(
      f.request.expectedLeaseVersion + 1,
    );
    const nextRequest = {
      generation: f.request.generation,
      expectedLeaseVersion: f.request.expectedLeaseVersion + 1,
    };
    const renewal = await portainerApp.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/renew`,
      headers: headers("portainer-following-renewal"),
      payload: nextRequest,
    });
    expect(renewal.statusCode).toBe(202);
    await new LeaseService(storage).reconcilePending();
    const renewalReplay = await portainerApp.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/renew`,
      headers: headers("portainer-following-renewal"),
      payload: nextRequest,
    });
    expect(renewalReplay.statusCode).toBe(200);
    expect(renewalReplay.json().leaseVersion).toBe(
      nextRequest.expectedLeaseVersion + 1,
    );

    const granted = await portainerApp.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/access`,
      headers: headers("claimed-portainer-access"),
      payload: { generation: f.request.generation },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.headers["cache-control"]).toBe("no-store");
    expect(granted.headers.pragma).toBe("no-cache");
    expect(granted.json().authentication).toEqual({
      kind: "ephemeral_private_key",
      privateKey,
    });
  });

  it("hides another consumer's Ticket and renewal across every owner route", async () => {
    const f = await fixture();
    const pending = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "owner-renewal",
      f.request,
    );
    expect(pending.outcome).toBe("pending");
    if (pending.outcome !== "pending")
      throw new Error("Expected a pending renewal");
    const other = randomUUID();
    const token = `hcl_${randomBytes(32).toString("base64url")}`;
    await f.storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) SELECT ?,?,'agent','consumer',authorization_json,quota_json,?,? FROM consumers WHERE id=?",
        params: [other, other, f.now(), f.now(), f.consumerId],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          randomUUID(),
          other,
          token.slice(0, 12),
          createHash("sha256").update(token).digest("hex"),
          JSON.stringify([
            "tickets:read",
            "tickets:write",
            "events:read",
            "images:read",
          ]),
          f.now(),
        ],
      },
    ]);
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        GUI_DIR: join(f.dir, "no-gui"),
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const headers = {
      authorization: `Bearer ${token}`,
      "idempotency-key": "foreign-command",
    };
    for (const [method, suffix, payload] of [
      ["GET", "", undefined],
      ["GET", "/events", undefined],
      ["GET", `/renewals/${pending.renewal.id}`, undefined],
      ["POST", "/renew", f.request],
      ["POST", "/cancel", {}],
      [
        "POST",
        "/release",
        { generation: f.request.generation, reclaimable: true },
      ],
      ["POST", "/access", { generation: f.request.generation }],
    ] as const) {
      const result = await app.inject({
        method,
        url: `/v1/tickets/${f.ready.id}${suffix}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(result.statusCode, `${method} ${suffix}`).toBe(404);
    }
  });

  it("rejects first claim exactly at claimBy even before the expiry sweeper runs", async () => {
    const f = await fixture();
    f.setTime(Date.parse(f.ready.lease!.claimBy!));
    await expect(
      f.leases.renew(f.consumerId, f.ready.id, "late-claim", f.request),
    ).rejects.toMatchObject({ code: "claim_deadline_expired" });
    expect(
      (
        await f.storage.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM lease_renewals",
        )
      )?.n,
    ).toBe(0n);
  });

  it("rejects a pending decision at its exact deadline and retains capacity until cleanup", async () => {
    const f = await fixture();
    const pending = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "deadline-renewal",
      f.request,
    );
    if (pending.outcome !== "pending")
      throw new Error("Expected a pending renewal");
    f.setTime(Date.parse(pending.renewal.decisionDeadline));
    await f.leases.reconcilePending();
    expect(
      (await f.leases.get(f.consumerId, f.ready.id, pending.renewal.id))?.state,
    ).toBe("rejected");
    const ticket = await f.queries.get(f.consumerId, f.ready.id);
    expect(ticket?.phase).toBe("releasing");
    expect(
      (
        await f.storage.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
        )
      )?.n,
    ).toBeGreaterThan(0n);
  });

  it("cancels a pending renewal with termination and never revives the lease", async () => {
    const f = await fixture();
    const duplicate = await Promise.allSettled([
      f.leases.renew(f.consumerId, f.ready.id, "cancel-renewal", f.request),
      f.leases.renew(f.consumerId, f.ready.id, "cancel-renewal", f.request),
    ]);
    expect(duplicate.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    if (
      duplicate[0]?.status !== "fulfilled" ||
      duplicate[1]?.status !== "fulfilled"
    )
      throw new Error(
        "Same-key concurrent renewal must recover the original proposal",
      );
    const pending = duplicate[0].value;
    expect(duplicate[1].value).toEqual(pending);
    await expect(
      f.leases.renew(f.consumerId, f.ready.id, "competing-renewal", f.request),
    ).rejects.toMatchObject({ code: "renewal_in_progress" });
    if (pending.outcome !== "pending")
      throw new Error("Expected a pending renewal");
    await f.tickets.cancel(f.ready.id, f.consumerId);
    await f.leases.reconcilePending();
    expect(
      (await f.leases.get(f.consumerId, f.ready.id, pending.renewal.id))?.state,
    ).toBe("cancelled");
    expect((await f.queries.get(f.consumerId, f.ready.id))?.phase).toBe(
      "releasing",
    );
    await f.worker.reconcile();
    expect((await f.queries.get(f.consumerId, f.ready.id))?.phase).toBe(
      "released",
    );
  });

  it("keeps frozen TTL bounds and replays the same confirmed receipt after termination", async () => {
    const f = await fixture();
    await f.storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxLeaseTtlSeconds',120),version=version+1 WHERE id=?",
      [f.consumerId],
    );
    const pending = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "frozen-renewal",
      { ...f.request, requestedTtlSec: 900 },
    );
    expect(pending.outcome).toBe("pending");
    await f.leases.reconcilePending();
    const receipt = await f.leases.renew(
      f.consumerId,
      f.ready.id,
      "frozen-renewal",
      { ...f.request, requestedTtlSec: 900 },
    );
    expect(receipt.outcome).toBe("confirmed");
    await f.tickets.cancel(f.ready.id, f.consumerId);
    expect(
      await f.leases.renew(f.consumerId, f.ready.id, "frozen-renewal", {
        ...f.request,
        requestedTtlSec: 900,
      }),
    ).toEqual(receipt);
    expect((await f.queries.get(f.consumerId, f.ready.id))?.phase).toBe(
      "releasing",
    );
  });

  it("resumes termination after its idempotency reservation survived a controller crash", async () => {
    const f = await fixture();
    const key = "reserved-before-crash";
    const hash = createHash("sha256")
      .update(JSON.stringify({ body: {}, ticketId: f.ready.id }))
      .digest("hex");
    await f.storage.run(
      "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,created_at_ms,retain_until_ms) VALUES(?,'tickets.cancel',?,?,?,?,?)",
      [f.consumerId, key, hash, f.ready.id, f.now(), f.now() + 86400000],
    );
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/cancel`,
      headers: { authorization: `Bearer ${f.token}`, "idempotency-key": key },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().phase).toBe("releasing");
    const conflict = await app.inject({
      method: "POST",
      url: `/v1/tickets/${f.ready.id}/cancel`,
      headers: { authorization: `Bearer ${f.token}`, "idempotency-key": key },
      payload: { reason: "a different command" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("replays a queued cancellation whose atomic completion survived a lost reply", async () => {
    const f = await fixture();
    const queued = await f.tickets.acquire(
      f.consumerId,
      "queued-cancel-target",
      {
        image: { versionId: f.versionId },
        resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
        networkProfileId: f.networkProfileId,
        lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
      },
    );
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const originalRun = f.storage.run.bind(f.storage);
    let completionInterrupted = false;
    const write = vi
      .spyOn(f.storage, "run")
      .mockImplementation(async (sql, params) => {
        if (
          !completionInterrupted &&
          sql.startsWith("UPDATE idempotency_keys SET response_status")
        ) {
          completionInterrupted = true;
          throw new Error("Injected loss before idempotency completion");
        }
        return originalRun(sql, params);
      });
    const first = await app.inject({
      method: "POST",
      url: `/v1/tickets/${queued.ticketId}/cancel`,
      headers: {
        authorization: `Bearer ${f.token}`,
        "idempotency-key": "queued-cancel-commit",
      },
      payload: {},
    });
    write.mockRestore();
    expect(completionInterrupted).toBe(true);
    expect(first.statusCode).toBe(500);
    const replay = await app.inject({
      method: "POST",
      url: `/v1/tickets/${queued.ticketId}/cancel`,
      headers: {
        authorization: `Bearer ${f.token}`,
        "idempotency-key": "queued-cancel-commit",
      },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      id: queued.ticketId,
      phase: "released",
    });
  });

  it("accepts numeric HTTP page limits while keeping invalid query values rejected", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    for (const path of [
      "/v1/tickets",
      "/v1/images",
      `/v1/tickets/${f.ready.id}/events`,
    ]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `${path}?limit=1`,
            headers: { authorization: `Bearer ${f.token}` },
          })
        ).statusCode,
        path,
      ).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/tickets?limit=1.5",
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).statusCode,
    ).toBe(422);
  });

  it("maps stale generations, unavailable contracts and queued quota to deliberate HTTP errors", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const headers = {
      authorization: `Bearer ${f.token}`,
      "idempotency-key": "stale-release",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/tickets/${f.ready.id}/release`,
          headers,
          payload: { generation: f.request.generation + 1, reclaimable: true },
        })
      ).statusCode,
    ).toBe(412);
    const request = {
      image: { versionId: f.versionId },
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      networkProfileId: f.ready.acceptedRequest.networkProfileId,
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers: { ...headers, "idempotency-key": "unavailable-image" },
          payload: { ...request, image: { versionId: randomUUID() } },
        })
      ).statusCode,
    ).toBe(422);
    await f.storage.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxQueuedTickets',1),version=version+1 WHERE id=?",
      [f.consumerId],
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers: { ...headers, "idempotency-key": "last-queue-slot" },
          payload: request,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers: { ...headers, "idempotency-key": "queue-full" },
          payload: request,
        })
      ).statusCode,
    ).toBe(429);
    await f.storage.run("DROP TRIGGER ticket_request_no_update");
    await f.storage.run("UPDATE tickets SET request_json='{}' WHERE id=?", [
      f.ready.id,
    ]);
    const projectionFailure = await app.inject({
      method: "GET",
      url: `/v1/tickets/${f.ready.id}`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(projectionFailure.statusCode).toBe(500);
    expect(projectionFailure.json().error.code).toBe("internal_error");
  });

  it("maps acquire idempotency conflicts and profile authorization failures", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());
    const headers = {
      authorization: `Bearer ${f.token}`,
      "idempotency-key": "http-acquire-body",
    };
    const request = {
      image: { versionId: f.versionId },
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      networkProfileId: f.networkProfileId,
      lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/tickets",
          headers,
          payload: request,
        })
      ).statusCode,
    ).toBe(202);
    const reused = await app.inject({
      method: "POST",
      url: "/v1/tickets",
      headers,
      payload: {
        ...request,
        lease: { ...request.lease, requestedSeconds: 901 },
      },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("idempotency_key_reused");

    const unauthorizedNetwork = await app.inject({
      method: "POST",
      url: "/v1/tickets",
      headers: { ...headers, "idempotency-key": "unauthorized-network" },
      payload: { ...request, networkProfileId: randomUUID() },
    });
    expect(unauthorizedNetwork.statusCode).toBe(422);
    expect(unauthorizedNetwork.json().error.code).toBe("invalid_request");

    const unauthorizedStorage = await app.inject({
      method: "POST",
      url: "/v1/tickets",
      headers: { ...headers, "idempotency-key": "unauthorized-storage" },
      payload: {
        ...request,
        storage: [
          {
            storageProfileId: randomUUID(),
            authorizedSubpath: "documents",
            mountPath: "/data",
            mode: "read_only",
          },
        ],
      },
    });
    expect(unauthorizedStorage.statusCode).toBe(422);
    expect(unauthorizedStorage.json().error.code).toBe("invalid_request");
  });

  it("limits operator revoke to its authorized image and node scope", async () => {
    const f = await fixture();
    const allocation = await f.storage.get<{ node_id: string }>(
      "SELECT node_id FROM allocations WHERE ticket_id=?",
      [f.ready.id],
    );
    const image = await f.storage.get<{ image_id: string }>(
      "SELECT image_id FROM image_versions WHERE id=?",
      [f.versionId],
    );
    if (!allocation || !image)
      throw new Error("Missing fixture authorization targets");
    const mintOperator = async (nodeId: string) => {
      const consumerId = randomUUID();
      const token = `hcl_${randomBytes(32).toString("base64url")}`;
      await f.storage.batchTransaction([
        {
          kind: "run",
          sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) SELECT ?,?,'human','operator',json_object('imageIds',json_array(?),'nodeIds',json_array(?),'networkProfileIds','all','storageProfileIds',json_array()),quota_json,?,? FROM consumers WHERE id=?",
          params: [
            consumerId,
            consumerId,
            image.image_id,
            nodeId,
            f.now(),
            f.now(),
            f.consumerId,
          ],
        },
        {
          kind: "run",
          sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
          params: [
            randomUUID(),
            consumerId,
            token.slice(0, 12),
            createHash("sha256").update(token).digest("hex"),
            JSON.stringify(["tickets:revoke"]),
            f.now(),
          ],
        },
      ]);
      return token;
    };
    const authorized = await mintOperator(allocation.node_id);
    const outside = await mintOperator(randomUUID());
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    try {
      const snapshot = await app.inject({
        method: "GET",
        url: `/v1/tickets/${f.ready.id}`,
        headers: { authorization: `Bearer ${f.token}` },
      });
      expect(snapshot.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/tickets/${f.ready.id}`,
            headers: {
              authorization: `Bearer ${f.token}`,
              "if-none-match": snapshot.headers.etag,
            },
          })
        ).statusCode,
      ).toBe(304);
      const payload = {
        generation: f.request.generation,
        expectedTicketVersion: f.ready.version,
        reason: "scoped review revoke",
      };
      const denied = await app.inject({
        method: "POST",
        url: `/v1/tickets/${f.ready.id}/revoke`,
        headers: {
          authorization: `Bearer ${outside}`,
          "idempotency-key": "out-of-scope",
        },
        payload,
      });
      expect(denied.statusCode).toBe(404);
      // Interrupt only the separate completion write. If completion is already
      // part of the domain transaction there is no such crash boundary.
      const originalRun = f.storage.run.bind(f.storage);
      let completionInterrupted = false;
      const write = vi
        .spyOn(f.storage, "run")
        .mockImplementation(async (sql, params) => {
          if (
            !completionInterrupted &&
            sql.startsWith("UPDATE idempotency_keys SET response_status")
          ) {
            completionInterrupted = true;
            throw new Error("Injected loss before idempotency completion");
          }
          return originalRun(sql, params);
        });
      const allowed = await app.inject({
        method: "POST",
        url: `/v1/tickets/${f.ready.id}/revoke`,
        headers: {
          authorization: `Bearer ${authorized}`,
          "idempotency-key": "in-scope",
        },
        payload,
      });
      write.mockRestore();
      expect(allowed.statusCode).toBe(completionInterrupted ? 500 : 202);
      const replayed = await app.inject({
        method: "POST",
        url: `/v1/tickets/${f.ready.id}/revoke`,
        headers: {
          authorization: `Bearer ${authorized}`,
          "idempotency-key": "in-scope",
        },
        payload,
      });
      expect(replayed.statusCode).toBe(202);
      expect(replayed.json()).toMatchObject({ phase: "releasing" });
      for (const key of ["outside-new-key", "in-scope"]) {
        const deniedReplay = await app.inject({
          method: "POST",
          url: `/v1/tickets/${f.ready.id}/revoke`,
          headers: {
            authorization: `Bearer ${outside}`,
            "idempotency-key": key,
          },
          payload,
        });
        expect(deniedReplay.statusCode).toBe(404);
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/tickets/${f.ready.id}/revoke`,
            headers: {
              authorization: `Bearer ${authorized}`,
              "idempotency-key": "stale-version",
            },
            payload: { ...payload, expectedTicketVersion: f.ready.version - 1 },
          })
        ).statusCode,
      ).toBe(412);
      const audit = await f.storage.get<{ safe_details_json: string }>(
        "SELECT safe_details_json FROM audit_entries WHERE action='ticket.revoke' AND target_id=?",
        [f.ready.id],
      );
      expect(audit?.safe_details_json).toContain("scoped review revoke");
    } finally {
      await app.close();
    }
  });

  it("exchanges a full-scope bearer for a CSRF-protected HttpOnly session and revokes it", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { authorization: `Bearer ${f.token}` },
      });
      expect(login.statusCode).toBe(201);
      expect(login.headers["cache-control"]).toBe("no-store");
      const csrf = String(login.headers["x-csrf-token"]);
      const cookies = login.headers["set-cookie"] as string[];
      const sessionCookie = cookies
        .find((cookie) => cookie.startsWith("hitchlet_session="))
        ?.split(";")[0];
      const csrfCookie = cookies
        .find((cookie) => cookie.startsWith("hitchlet_csrf="))
        ?.split(";")[0];
      if (!sessionCookie || !csrfCookie)
        throw new Error("Session cookies are missing");
      const cookie = `${sessionCookie}; ${csrfCookie}`;
      const me = await app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { cookie },
      });
      expect(me.headers["cache-control"]).toBe("no-store");
      expect(me.json()).toMatchObject({ source: "session", role: "consumer" });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/v1/tickets/${f.ready.id}/cancel`,
            headers: { cookie, "idempotency-key": "csrf-missing" },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const logout = await app.inject({
        method: "DELETE",
        url: "/v1/auth/session",
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(logout.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/auth/me",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("does not elevate scoped tokens, and invalidates sessions when their source credential is revoked", async () => {
    const f = await fixture();
    const limited = `hcl_${randomBytes(32).toString("base64url")}`;
    const limitedCredential = randomUUID();
    const viewer = randomUUID();
    const viewerToken = `hcl_${randomBytes(32).toString("base64url")}`;
    await f.storage.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          limitedCredential,
          f.consumerId,
          limited.slice(0, 12),
          createHash("sha256").update(limited).digest("hex"),
          JSON.stringify(["images:read"]),
          f.now(),
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) SELECT ?,?,'human','viewer','{}',quota_json,?,? FROM consumers WHERE id=?",
        params: [viewer, viewer, f.now(), f.now(), f.consumerId],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          randomUUID(),
          viewer,
          viewerToken.slice(0, 12),
          createHash("sha256").update(viewerToken).digest("hex"),
          JSON.stringify([]),
          f.now(),
        ],
      },
    ]);
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    try {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/tickets",
            headers: { authorization: `Bearer ${viewerToken}` },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/auth/session",
            headers: { authorization: `Bearer ${limited}` },
          })
        ).statusCode,
      ).toBe(403);
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { authorization: `Bearer ${f.token}` },
      });
      const sessionCookies = login.headers["set-cookie"] as string[];
      const cookie = sessionCookies
        .map((item) => item.split(";")[0])
        .join("; ");
      let last = 0;
      for (let i = 0; i < 6; i++)
        last = (
          await app.inject({
            method: "POST",
            url: "/v1/auth/session",
            headers: { authorization: "Bearer invalid-token" },
          })
        ).statusCode;
      expect(last).toBe(429);
      await f.storage.run(
        "UPDATE consumer_credentials SET revoked_at_ms=? WHERE consumer_id=? AND token_prefix=?",
        [f.now(), f.consumerId, f.token.slice(0, 12)],
      );
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/auth/me",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("uses the shared API error envelope when real static assets are enabled", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "index.html"), "<main>GUI</main>");
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        GUI_DIR: f.dir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    cleanup.push(() => app.close());

    expect((await app.inject({ url: "/" })).statusCode).toBe(200);
    const responses = [
      await app.inject({ url: "/v1/auth/me" }),
      await app.inject({
        url: "/v1/tickets?limit=invalid",
        headers: { authorization: `Bearer ${f.token}` },
      }),
      await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { "content-type": "application/json" },
        payload: '{"invalid"',
      }),
    ];
    await f.storage.run("DROP TRIGGER ticket_request_no_update");
    await f.storage.run("UPDATE tickets SET request_json='{}' WHERE id=?", [
      f.ready.id,
    ]);
    responses.push(
      await app.inject({
        url: `/v1/tickets/${f.ready.id}`,
        headers: { authorization: `Bearer ${f.token}` },
      }),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 422, 400, 500,
    ]);
    expect(responses[2]?.json().error.code).toBe("invalid_request");
    for (const response of responses) {
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toMatchObject({
        error: {
          requestId: expect.any(String),
          code: expect.any(String),
          message: expect.any(String),
          details: {},
          retryable: expect.any(Boolean),
        },
      });
      expect(response.json().statusCode).toBeUndefined();
    }
  });

  it("refreshes only the installation-bound Simulator fixture after expiry", async () => {
    const f = await fixture();
    const future = f.now() + 3_700_000;
    f.setTime(future);
    const queued = await f.tickets.acquire(
      f.consumerId,
      "after-simulator-expiry",
      {
        image: { versionId: f.versionId },
        resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
        networkProfileId: f.networkProfileId,
        lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
      },
    );
    expect(await f.tickets.reserveNext()).toBeNull();
    await f.tickets.refreshSimulatorFixtureObservation();
    expect(await f.tickets.reserveNext()).toMatchObject({
      ticketId: queued.ticketId,
    });
    await f.worker.reconcileBeforeScheduling();
    await f.leases.reconcilePending();
    await f.worker.reconcile();
    expect((await f.queries.get(f.consumerId, queued.ticketId))?.phase).toBe(
      "ready",
    );
  });

  it("does not refresh stale observations for a non-Simulator node", async () => {
    const f = await fixture();
    const node = await f.storage.get<{ id: string }>(
      "SELECT id FROM nodes LIMIT 1",
    );
    if (!node) throw new Error("Missing fixture node");
    await f.storage.run(
      "UPDATE nodes SET config_json=json_object('executionMode','portainer'),observed_at_ms=0,capabilities_json=json_set(capabilities_json,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE id=?",
      [node.id],
    );
    f.setTime(f.now() + 3_700_000);
    await f.tickets.refreshSimulatorFixtureObservation();
    const unchanged = await f.storage.get<{
      observed_at_ms: number | bigint;
      expires_at: string;
    }>(
      "SELECT observed_at_ms,json_extract(capabilities_json,'$.expiresAt') AS expires_at FROM nodes WHERE id=?",
      [node.id],
    );
    expect(Number(unchanged?.observed_at_ms)).toBe(0);
    expect(unchanged?.expires_at).toBe("2000-01-01T00:00:00.000Z");
  });

  it("closes a loopback SSE stream on logout and on server shutdown", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage: f.storage },
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${f.token}` },
    });
    const cookies = login.headers["set-cookie"] as string[];
    const cookie = cookies.map((item) => item.split(";")[0]).join("; ");
    const csrf = String(login.headers["x-csrf-token"]);
    const stream = await fetch(`${address}/v1/events/stream?after=0`, {
      headers: { cookie },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    let frame = "";
    const decoder = new TextDecoder();
    const untilEvent = (async () => {
      while (!/\nid: [0-9]+\nevent:/.test(frame)) {
        const next = await reader.read();
        if (next.done) break;
        frame += decoder.decode(next.value);
      }
      return frame;
    })();
    await Promise.race([
      untilEvent,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("SSE did not send a stored event")),
          3000,
        ),
      ),
    ]);
    expect(frame).toMatch(/\nid: [0-9]+\nevent:/);
    const id = frame.match(/\nid: ([0-9]+)\nevent:/)?.[1];
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    const logout = await fetch(`${address}/v1/auth/session`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(logout.status).toBe(204);
    const ended = await Promise.race([
      (async () => {
        let result = await reader.read();
        while (!result.done) result = await reader.read();
        return result;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("SSE did not close after logout")),
          2500,
        ),
      ),
    ]);
    expect(ended.done).toBe(true);

    const bearerStream = await fetch(`${address}/v1/events/stream?after=0`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    const bearerReader = bearerStream.body!.getReader();
    await bearerReader.read();
    const closed = app.close();
    await closed;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ended = await Promise.race([
        (async () => {
          let result = await bearerReader.read();
          while (!result.done) result = await bearerReader.read();
          return result;
        })(),
        new Promise<never>((_, reject) => {
          shutdownTimer = setTimeout(
            () => reject(new Error("SSE did not close after server shutdown")),
            2500,
          );
        }),
      ]);
      expect(ended.done).toBe(true);
    } finally {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      await bearerReader.cancel().catch(() => undefined);
    }
  }, 10000);

  it("rejects an SSE request whose authentication finishes during shutdown", async () => {
    const f = await fixture();
    let releaseAuthentication!: () => void;
    let authenticationEntered!: () => void;
    let preCloseStarted!: () => void;
    const authenticationGate = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    const enteredGate = new Promise<void>((resolve) => {
      authenticationEntered = resolve;
    });
    const preCloseGate = new Promise<void>((resolve) => {
      preCloseStarted = resolve;
    });
    const storage = new Proxy(f.storage, {
      get(target, property) {
        if (property === "get")
          return async (...args: Parameters<typeof target.get>) => {
            if (String(args[0]).includes("FROM consumer_credentials cc")) {
              authenticationEntered();
              await authenticationGate;
            }
            return target.get(...args);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dataDir,
        EXECUTION_MODE: "simulator",
        SIMULATOR_DATA_DIR: join(f.dir, "external"),
      }),
      { storage },
    );
    app.addHook("preClose", () => preCloseStarted());
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    let closePromise: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const responsePromise = fetch(`${address}/v1/events/stream?after=0`, {
        headers: { authorization: `Bearer ${f.token}` },
        signal: controller.signal,
      });
      await enteredGate;

      closePromise = app.close();
      await preCloseGate;
      releaseAuthentication();
      const [response] = await Promise.all([
        responsePromise,
        Promise.race([
          closePromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error("Server close waited on a late SSE stream")),
              2500,
            );
          }),
        ]),
      ]);
      expect(response.status).toBe(503);
      expect(response.headers.get("connection")).toBe("close");
      expect(await response.json()).toMatchObject({
        error: { code: "service_unavailable" },
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseAuthentication();
      controller.abort();
      closePromise ??= app.close();
      await closePromise?.catch(() => undefined);
    }
  }, 10000);
});
