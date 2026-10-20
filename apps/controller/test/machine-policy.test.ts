import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage, type Storage } from "../dist/storage/index.js";
import { SQLiteMachineNodeStore } from "../src/storage/machine-node-store.js";
import {
  loadMachineAdmission,
  machineAdmissionFence,
  prepareMachineAdmission,
} from "../src/storage/human-use-guard.js";
import { HostAgents } from "../src/application/host-agents.js";
import { TicketService } from "../src/application/tickets.js";
import { HitchletClient } from "../../../packages/sdk/src/index.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { HostHeartbeat } from "@hitchlet/contracts/internal";
import { MachineDependencyViewSchema } from "@hitchlet/contracts/admin";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-machine-policy-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const adminToken = stdout.match(
    /Initial admin bearer token \(shown once\): (\S+)/,
  )![1]!;
  const token = stdout.match(/Bearer token \(shown once\): (\S+)/)![1]!;
  const db = await openStorage(dir);
  cleanup.push(() => db.close());
  const machine = await db.get<{ id: string; version: bigint }>(
    "SELECT id,version FROM machines",
  );
  const node = await db.get<{ id: string; version: bigint }>(
    "SELECT id,version FROM nodes",
  );
  const admin = await db.get<{ id: string }>(
    "SELECT id FROM consumers WHERE role='admin'",
  );
  const consumer = await db.get<{ id: string }>(
    "SELECT id FROM consumers WHERE role='consumer'",
  );
  const installation = await db.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations",
  );
  const now = Date.now();
  const inventory = new SQLiteMachineNodeStore(db, () => now);
  const initial = (await inventory.listMachineDependencies())[0]!;
  const policy = initial.humanUsePolicy!;
  policy.attendedMaximum = {
    cpuMillis: 1000,
    memoryMiB: 2048,
    scratchMiB: 2048,
  };
  policy.unattendedMaximum = {
    cpuMillis: 2000,
    memoryMiB: 4096,
    scratchMiB: 4096,
  };
  policy.humanReserved = { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 };
  await db.run("UPDATE machines SET usage_mode='shared' WHERE id=?", [
    machine!.id,
  ]);
  await inventory.updateHumanUsePolicy({
    machineId: machine!.id,
    expectedVersion: 1,
    policy,
    operatorId: admin!.id,
    requestId: randomUUID(),
  });
  const mode = await inventory.updateNodeAdmissionMode({
    nodeId: node!.id,
    expectedVersion: 1,
    mode: "observed_host",
    reason: "Test fixture: enable authenticated observations",
    operatorId: admin!.id,
    requestId: randomUUID(),
  });
  const host = new HostAgents(db, () => now);
  const hostIdentity = randomUUID();
  const pair = await host.pair(
    { machineId: machine!.id, hostIdentity, reason: "test" },
    admin!.id,
    randomUUID(),
  );
  const enrollment = await host.enroll({
    agentId: pair.agentId,
    machineId: machine!.id,
    installationId: installation!.installation_id,
    hostIdentity,
    pairingToken: pair.pairingToken,
    hostOs: "linux",
    architecture: "amd64",
    role: "physical_host",
    protocolVersion: 1,
  });
  const authorization = `Bearer ${enrollment.credential}`,
    bootId = randomUUID();
  await host.start(pair.agentId, authorization, {
    installationId: installation!.installation_id,
    controllerEpoch: 1,
    bootId,
    expectedSessionEpoch: 0,
  });
  function heartbeat(sequence: number, cpuPercent = 1): HostHeartbeat {
    return {
      installationId: installation!.installation_id,
      controllerEpoch: 1,
      sessionEpoch: 1,
      protocolVersion: 1,
      agentVersion: "test",
      snapshot: {
        machineId: machine!.id,
        agentId: pair.agentId,
        bootId,
        sequence,
        observedAt: new Date(now).toISOString(),
        probeStatus: "partial",
        sessionsComplete: false,
        sessions: [
          {
            sessionId: "positive-session",
            principalRef: "private-person",
            type: "console",
            connection: "connected",
            locked: "unknown",
          },
        ],
        activeInteraction: true,
        resources: { cpuPercent, memoryUsedBytes: 100, memoryTotalBytes: 1000 },
        unmanagedActivityHold: null,
        errorCodes: ["WORKLOAD_ENUMERATION_UNAVAILABLE"],
      },
    };
  }
  await host.heartbeat(pair.agentId, authorization, heartbeat(0));
  return {
    dir,
    db,
    inventory,
    policy,
    machineId: machine!.id,
    nodeId: node!.id,
    nodeVersion: mode.version,
    adminId: admin!.id,
    consumerId: consumer!.id,
    installationId: installation!.installation_id,
    now,
    host,
    pair,
    authorization,
    heartbeat,
    adminToken,
    token,
  };
}
describe("Machine policies and the shared SQLite admission fence", () => {
  it("keeps partial Host evidence truthful, projects actual ownership tree, and does not expose private sessions or credentials", async () => {
    const f = await fixture();
    await f.db.run(
      "INSERT INTO holds(id,machine_id,kind,reason,created_at_ms) VALUES(?,?,'unmanaged_work','External service inventory',?)",
      [randomUUID(), f.machineId, f.now],
    );
    const view = MachineDependencyViewSchema.parse(
      (await f.inventory.listMachineDependencies())[0],
    );
    expect(view.canAdmitTenants).toBe(true);
    expect(view.nodes[0]!.admissionAssurance).toBe("bounded_partial_host");
    expect(view.hostObservation).toMatchObject({
      probeStatus: "partial",
      sessionsComplete: false,
      humanPresence: "present",
      unmanagedActivityHold: null,
      interactiveSessionCount: 1,
    });
    expect(view.shutdownDisabledReasons).toContain(
      "Hold: External service inventory",
    );
    expect(view.dependencyTree.map((n) => n.kind)).toEqual([
      "machine",
      "pool",
      "node",
    ]);
    expect(JSON.stringify(view)).not.toMatch(
      /private-person|pairingToken|credential|heartbeat|secret:/,
    );
  });
  it("rejects a heartbeat race without depending on Machine.version; old sequence cannot restore its permit", async () => {
    const f = await fixture(),
      before = await f.db.get("SELECT version FROM machines WHERE id=?", [
        f.machineId,
      ]);
    const permit = await prepareMachineAdmission(
      f.db,
      f.machineId,
      f.nodeId,
      { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      f.now,
    );
    await f.host.heartbeat(f.pair.agentId, f.authorization, f.heartbeat(1, 99));
    expect(
      await f.db.get("SELECT version FROM machines WHERE id=?", [f.machineId]),
    ).toEqual(before);
    await expect(
      f.db.batchTransaction([
        permit,
        {
          kind: "run",
          sql: "UPDATE machines SET name='escaped' WHERE id=?",
          params: [f.machineId],
        },
      ]),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    await expect(
      f.host.heartbeat(f.pair.agentId, f.authorization, f.heartbeat(0)),
    ).rejects.toBeDefined();
    await expect(
      prepareMachineAdmission(
        f.db,
        f.machineId,
        f.nodeId,
        { cpuMillis: 1, memoryMiB: 1, scratchMiB: 0 },
        f.now,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
  });
  it("fences policy-versus-claim races, permits lower ceilings without releasing active claims, and protects reserved capacity", async () => {
    const f = await fixture();
    const tickets = new TicketService({ storage: f.db, now: () => f.now });
    const version = await f.db.get<{ id: string }>(
      "SELECT id FROM image_versions",
    );
    const network = await f.db.get<{ id: string }>(
      "SELECT id FROM network_profiles",
    );
    await tickets.acquire(f.consumerId, "first", {
      image: { versionId: version!.id },
      networkProfileId: network!.id,
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
    });
    const old = await loadMachineAdmission(f.db, f.machineId, f.now);
    expect(await tickets.reserveNext()).toBeDefined();
    await expect(
      f.db.batchTransaction([machineAdmissionFence(old)]),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    const current = Number(
      (await f.db.get<{ version: bigint }>(
        "SELECT version FROM machines WHERE id=?",
        [f.machineId],
      ))!.version,
    );
    const lower = {
      ...f.policy,
      attendedMaximum: { cpuMillis: 100, memoryMiB: 100, scratchMiB: 0 },
    };
    const preview = await f.inventory.machinePolicyDryRun({
      machineId: f.machineId,
      expectedVersion: current,
      policy: lower,
    });
    expect(preview.canApply).toBe(true);
    expect(preview.machine.canAdmitTenants).toBe(false);
    await f.inventory.updateHumanUsePolicy({
      machineId: f.machineId,
      expectedVersion: current,
      policy: lower,
      operatorId: f.adminId,
      requestId: randomUUID(),
    });
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) n FROM capacity_claims WHERE state<>'released'",
        ))!.n,
      ),
    ).toBe(1);
    await expect(
      f.inventory.updateHumanUsePolicy({
        machineId: f.machineId,
        expectedVersion: current,
        policy: f.policy,
        operatorId: f.adminId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const confiscate = {
      ...f.policy,
      systemReserve: { cpuMillis: 4000, memoryMiB: 8192, scratchMiB: 12000 },
      unattendedMaximum: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
      attendedMaximum: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
    };
    expect(
      (
        await f.inventory.machinePolicyDryRun({
          machineId: f.machineId,
          expectedVersion: current + 1,
          policy: confiscate,
        })
      ).canApply,
    ).toBe(false);
  });
  it("reports controller/boot epoch invalidation as stale and only explicit Agent revocation as revoked through SQLite and API", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({ DATA_DIR: f.dir, GUI_DIR: "/no-gui", LOG_LEVEL: "silent" }),
      { storage: f.db },
    );
    cleanup.push(() => app.close());
    const view = async () => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/machines/${f.machineId}/dry-run`,
        headers: { authorization: `Bearer ${f.adminToken}` },
      });
      expect(response.statusCode).toBe(200);
      return MachineDependencyViewSchema.parse(response.json());
    };
    expect((await view()).hostObservation.state).toBe("fresh");
    const permit = await prepareMachineAdmission(
      f.db,
      f.machineId,
      f.nodeId,
      { cpuMillis: 1, memoryMiB: 1, scratchMiB: 0 },
      f.now,
    );
    await f.db.run(
      "UPDATE installations SET controller_epoch=controller_epoch+1 WHERE singleton=1",
    );
    expect(
      await f.db.get("SELECT status FROM agents WHERE id=?", [f.pair.agentId]),
    ).toMatchObject({ status: "active" });
    let current = await view();
    expect(current.hostObservation).toMatchObject({
      state: "stale",
      humanPresence: "unknown",
    });
    expect(current.nodes[0]!.admissionAssurance).toBe("unavailable_host");
    expect(current.canAdmitTenants).toBe(false);
    await expect(f.db.batchTransaction([permit])).rejects.toMatchObject({
      code: "STORAGE_CAS_FAILED",
    });
    await expect(
      prepareMachineAdmission(
        f.db,
        f.machineId,
        f.nodeId,
        { cpuMillis: 1, memoryMiB: 1, scratchMiB: 0 },
        f.now,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    const bootId = randomUUID();
    await f.host.start(f.pair.agentId, f.authorization, {
      installationId: f.installationId,
      controllerEpoch: 2,
      bootId,
      expectedSessionEpoch: 1,
    });
    current = await view();
    // Starting a new fenced boot deliberately removes the old snapshot until its first heartbeat.
    expect(current.hostObservation.state).toBe("missing");
    expect(current.canAdmitTenants).toBe(false);
    const heartbeat = f.heartbeat(0);
    heartbeat.controllerEpoch = 2;
    heartbeat.sessionEpoch = 2;
    heartbeat.snapshot.bootId = bootId;
    await f.host.heartbeat(f.pair.agentId, f.authorization, heartbeat);
    expect((await view()).canAdmitTenants).toBe(true);
    await f.host.revoke(
      f.pair.agentId,
      2,
      "Explicit revocation fixture",
      f.adminId,
      randomUUID(),
    );
    current = await view();
    expect(current.hostObservation.state).toBe("revoked");
    expect(current.nodes[0]!.admissionAssurance).toBe("unavailable_host");
    expect(current.canAdmitTenants).toBe(false);
  });
  it("uses the schema-validated SDK/API for preview, CAS updates and mode selection with full-admin enforcement", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({ DATA_DIR: f.dir, GUI_DIR: "/no-gui", LOG_LEVEL: "silent" }),
      { storage: f.db },
    );
    cleanup.push(() => app.close());
    const client = (token: string) =>
      new HitchletClient("https://controller.test", {
        auth: { kind: "bearer", token },
        fetch: async (input, init) => {
          const response = await app.inject({
            url: new URL(String(input)).pathname,
            method: init?.method as "GET" | "PUT" | "POST",
            headers: Object.fromEntries(new Headers(init?.headers)),
            ...(init?.body ? { payload: String(init.body) } : {}),
          });
          return new Response(response.body, {
            status: response.statusCode,
            headers: { "content-type": "application/json" },
          });
        },
      });
    const admin = client(f.adminToken),
      limited = client(f.token);
    const view = (await admin.admin.machines())[0]!;
    expect(view.canAdmitTenants).toBe(true);
    const body = {
      expectedVersion: view.version,
      policy: { ...f.policy, admissionDuringInteraction: "block_new" as const },
    };
    const preview = await admin.admin.previewHumanUsePolicy(f.machineId, body);
    expect(preview.machine.canAdmitTenants).toBe(false);
    expect((await admin.admin.machines())[0]!.version).toBe(view.version);
    await expect(
      limited.admin.updateHumanUsePolicy(f.machineId, body, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 403 });
    await admin.admin.updateHumanUsePolicy(f.machineId, body, randomUUID());
    await expect(
      admin.admin.updateHumanUsePolicy(f.machineId, body, randomUUID()),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      limited.admin.updateNodeAdmissionMode(
        f.nodeId,
        {
          expectedVersion: f.nodeVersion,
          mode: "constant_online_manual_inventory",
          reason: "static trial",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const mode = await admin.admin.updateNodeAdmissionMode(
      f.nodeId,
      {
        expectedVersion: f.nodeVersion,
        mode: "constant_online_manual_inventory",
        reason: "explicit frozen budget trial",
      },
      randomUUID(),
    );
    expect(mode.version).toBe(f.nodeVersion + 1);
    const stored = await f.db.get<{ capabilities_json: string }>(
      "SELECT capabilities_json FROM nodes WHERE id=?",
      [f.nodeId],
    );
    expect(JSON.parse(stored!.capabilities_json).cpuHardLimit).toBe("verified");
  });
});
