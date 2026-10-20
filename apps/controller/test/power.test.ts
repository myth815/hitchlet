import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage, type Storage } from "../dist/storage/index.js";
import { SQLitePowerStore } from "../src/storage/power-store.js";
import { PowerService, startPowerRecovery } from "../src/application/power.js";
import { SQLiteMachineNodeStore } from "../src/storage/machine-node-store.js";
import { TicketService } from "../src/application/tickets.js";
import { HostAgents } from "../src/application/host-agents.js";
import {
  PowerPolicySchema,
  PowerConfigurationSchema,
  type SmartPlugBindingUpdate,
} from "@hitchlet/contracts/admin";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HitchletClient } from "../../../packages/sdk/src/index.js";
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-power-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const adminToken = stdout.match(
      /Initial admin bearer token \(shown once\): (\S+)/,
    )![1]!,
    token = stdout.match(/Bearer token \(shown once\): (\S+)/)![1]!;
  let db = await openStorage(dir);
  clean.push(() => db.close());
  const machineId = (await db.get<{ id: string }>("SELECT id FROM machines"))!
    .id;
  const nodeId = (await db.get<{ id: string }>("SELECT id FROM nodes"))!.id;
  const adminId = (await db.get<{ id: string }>(
    "SELECT id FROM consumers WHERE role='admin'",
  ))!.id;
  const installation = (await db.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations",
  ))!.installation_id;
  let now = Date.now(),
    sequence = 0;
  const clock = () => now,
    actor = { operatorId: adminId, requestId: randomUUID() };
  const inventory = new SQLiteMachineNodeStore(db, clock);
  const initial = (await inventory.listMachineDependencies())[0]!;
  await inventory.updateHumanUsePolicy({
    machineId,
    expectedVersion: 1,
    policy: initial.humanUsePolicy!,
    ...actor,
  });
  await inventory.updateNodeAdmissionMode({
    nodeId,
    expectedVersion: 1,
    mode: "observed_host",
    reason: "complete synthetic Host for power rule test",
    ...actor,
  });
  const host = new HostAgents(db, clock),
    hostIdentity = randomUUID(),
    bootId = randomUUID();
  const pair = await host.pair(
    { machineId, hostIdentity, reason: "synthetic test" },
    adminId,
    randomUUID(),
  );
  const enrollment = await host.enroll({
    agentId: pair.agentId,
    machineId,
    installationId: installation,
    hostIdentity,
    pairingToken: pair.pairingToken,
    hostOs: "linux",
    architecture: "amd64",
    role: "physical_host",
    protocolVersion: 1,
  });
  const authorization = `Bearer ${enrollment.credential}`;
  await host.start(pair.agentId, authorization, {
    installationId: installation,
    controllerEpoch: 1,
    bootId,
    expectedSessionEpoch: 0,
  });
  async function heartbeat(present = false) {
    await host.heartbeat(pair.agentId, authorization, {
      installationId: installation,
      controllerEpoch: 1,
      sessionEpoch: 1,
      protocolVersion: 1,
      agentVersion: "test",
      snapshot: {
        machineId,
        agentId: pair.agentId,
        bootId,
        sequence: sequence++,
        observedAt: new Date(now).toISOString(),
        probeStatus: "complete",
        sessionsComplete: true,
        sessions: [],
        activeInteraction: present,
        resources: { cpuPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 100 },
        unmanagedActivityHold: false,
        errorCodes: [],
      },
    });
    await db.run("UPDATE nodes SET observed_at_ms=? WHERE id=?", [now, nodeId]);
  }
  await heartbeat();
  let service = new PowerService(db, clock);
  return {
    dir,
    get db() {
      return db;
    },
    machineId,
    nodeId,
    adminId,
    adminToken,
    token,
    actor,
    clock,
    heartbeat,
    get service() {
      return service;
    },
    advanceTime: (ms: number) => {
      now += ms;
    },
    upgradeFrom5: async () => {
      await db.close();
      const legacy = new Database(join(dir, "hitchlet.sqlite"));
      legacy.exec(
        "DROP INDEX machine_plug_binding_id; DROP INDEX machine_plug_device_id; DROP INDEX machine_plug_mac; DROP INDEX machine_active_power_intent; DELETE FROM schema_migrations WHERE version=6; PRAGMA user_version=5;",
      );
      legacy.close();
      db = await openStorage(dir);
      service = new PowerService(db, clock);
    },
    restart: async () => {
      await db.close();
      db = await openStorage(dir);
      service = new PowerService(db, clock);
    },
  };
}
function binding(machineId: string): SmartPlugBindingUpdate["binding"] {
  return {
    id: randomUUID(),
    machineId,
    adapter: "xiaomi_miio_lan",
    device: {
      model: "cuco.plug.v3",
      deviceId: "123456789",
      macAddress: "AA:BB:CC:DD:EE:FF",
    },
    endpointRef: "endpoint:power-test",
    credentialVersionRef: `secret:${"a".repeat(32)}`,
    dedicatedSupply: "unverified",
    acPowerOn: "unverified",
    verificationReportIds: [],
  };
}
async function configure(f: Awaited<ReturnType<typeof fixture>>) {
  return f.service.configure(
    f.machineId,
    {
      expectedVersion: 0,
      policy: PowerPolicySchema.parse({
        enabled: true,
        idleAction: "shutdown",
        idleSeconds: 10,
      }),
    },
    f.actor,
  );
}
describe("persistent isolated power previews", () => {
  it("defaults disabled; rejects executable policy and config-sourced verification; consumer projections stay separate", async () => {
    const f = await fixture();
    const c = PowerConfigurationSchema.parse(
      await f.service.configuration(f.machineId),
    );
    expect(c.policy).toMatchObject({ enabled: false, dryRun: true });
    expect(c.version).toBe(0);
    expect(c.executionAllowed).toBe(false);
    await expect(
      f.service.configure(
        f.machineId,
        { expectedVersion: 0, policy: { ...c.policy, dryRun: false } },
        f.actor,
      ),
    ).rejects.toThrow();
    await f.db.run("UPDATE machines SET capabilities_json=? WHERE id=?", [
      JSON.stringify({
        power: {
          sleep: "verified",
          normalShutdown: "verified",
          wakeFromSleep: "verified",
          coldBoot: "verified",
          wolWhilePossiblyOn: "verified",
          wakeRouteRef: randomUUID(),
          verificationReportIds: [randomUUID()],
        },
      }),
      f.machineId,
    ]);
    const view = await f.service.configuration(f.machineId);
    expect(view.capabilities.normalShutdown).toBe("unverified");
    expect(view.capabilities.verificationReportIds).toEqual([]);
    expect(view.executionDisabledReasons.join(" ")).toContain("D22b");
    await f.service.configure(
      f.machineId,
      { expectedVersion: 0, policy: { ...view.policy, idleAction: "sleep" } },
      f.actor,
    );
    await expect(
      f.service.start(
        f.machineId,
        { expectedPolicyVersion: 1, mode: "idle_shutdown" },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "execution_mode_unsupported" });
    const conclusions = {
      sleep: "unsupported",
      normalShutdown: "unverified",
      wakeFromSleep: "unverified",
      coldBoot: "unverified",
      wolWhilePossiblyOn: "unverified",
      wakeRouteRef: null,
    };
    await expect(
      f.service.capabilities(
        f.machineId,
        {
          expectedMachineVersion: view.machineVersion,
          conclusions: { ...conclusions, coldBoot: "verified" },
        },
        f.actor,
      ),
    ).rejects.toThrow();
    expect(
      (
        await f.service.capabilities(
          f.machineId,
          { expectedMachineVersion: view.machineVersion, conclusions },
          f.actor,
        )
      ).capabilities.sleep,
    ).toBe("unsupported");
  });
  it("upgrades v5 JSON policies/bindings and isolated operations without losing state or deadlines", async () => {
    const f = await fixture(),
      b = binding(f.machineId)!;
    let c = await f.service.configuration(f.machineId);
    c = await f.service.bind(
      f.machineId,
      { expectedMachineVersion: c.machineVersion, binding: b },
      f.actor,
    );
    c = await f.service.configure(
      f.machineId,
      {
        expectedVersion: 0,
        policy: {
          ...c.policy,
          faultRecovery: {
            mode: "smart_plug_cycle",
            plugBindingId: b.id,
            authorization: "operator",
            minimumOffSeconds: 600,
            maximumCyclesPerIncident: 1,
          },
        },
      },
      f.actor,
    );
    let p = await f.service.start(
      f.machineId,
      {
        expectedPolicyVersion: 1,
        mode: "fault_recovery",
        incidentId: randomUUID(),
      },
      f.actor,
    );
    for (const state of ["on", "off"] as const)
      p = await f.service.advance(
        f.machineId,
        p.id,
        {
          expectedVersion: p.version,
          event: {
            kind: "plug_readback",
            deviceId: b.device.deviceId,
            macAddress: b.device.macAddress,
            state,
          },
        },
        f.actor,
      );
    await f.upgradeFrom5();
    expect(await f.service.get(f.machineId, p.id)).toEqual(p);
    expect((await f.service.configuration(f.machineId)).binding).toEqual(
      c.binding,
    );
    expect(
      await f.db.get("SELECT max(version) AS version FROM schema_migrations"),
    ).toEqual({ version: 6n });
    expect(await f.db.get("PRAGMA integrity_check")).toEqual({
      integrity_check: "ok",
    });
  });
  it("virtual drain/accepted never changes real power/admission/epoch or writes an Agent receipt; new login defeats final check", async () => {
    const f = await fixture();
    await configure(f);
    const before = await f.db.get(
      "SELECT admission,observed_power,power_lifecycle,machine_epoch,accepted_shutdown_receipt_id FROM machines WHERE id=?",
      [f.machineId],
    );
    let p = await f.service.start(
      f.machineId,
      { expectedPolicyVersion: 1, mode: "idle_shutdown" },
      f.actor,
    );
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      f.actor,
    );
    f.advanceTime(10000);
    await f.heartbeat();
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      f.actor,
    );
    expect(p.phase).toBe("draining");
    expect(
      await f.db.get(
        "SELECT admission,observed_power,power_lifecycle,machine_epoch,accepted_shutdown_receipt_id FROM machines WHERE id=?",
        [f.machineId],
      ),
    ).toEqual(before);
    f.advanceTime(1);
    await f.heartbeat(true);
    p = await f.service.advance(
      f.machineId,
      p.id,
      {
        expectedVersion: p.version,
        event: {
          kind: "accept_shutdown",
          simulatedLocalCheck: "complete_absent_clear",
        },
      },
      f.actor,
    );
    expect(p.phase).toBe("idle");
    expect(p.acceptedReceiptId).toBeNull();
    await f.heartbeat(false);
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      f.actor,
    );
    f.advanceTime(10000);
    await f.heartbeat();
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      f.actor,
    );
    p = await f.service.advance(
      f.machineId,
      p.id,
      {
        expectedVersion: p.version,
        event: {
          kind: "accept_shutdown",
          simulatedLocalCheck: "complete_absent_clear",
        },
      },
      f.actor,
    );
    expect(p.phase).toBe("shutdown_requested");
    f.advanceTime(120000);
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      f.actor,
    );
    expect(p.phase).toBe("off_expected");
    expect(p.observedPower).toBe("unknown");
    expect(
      await f.db.get("SELECT count(*) AS count FROM agent_receipts"),
    ).toEqual({ count: 0n });
    expect(
      await f.db.get(
        "SELECT admission,observed_power,power_lifecycle,machine_epoch,accepted_shutdown_receipt_id FROM machines WHERE id=?",
        [f.machineId],
      ),
    ).toEqual(before);
  });
  it("uses full-input CAS against heartbeat/hold/epoch/policy races, including operation without Claim", async () => {
    const f = await fixture();
    await configure(f);
    const store = new SQLitePowerStore(f.db);
    let snapshot = await store.load(f.machineId, f.clock());
    f.advanceTime(1);
    await f.heartbeat(true);
    await expect(
      f.db.batchTransaction(store.fences(snapshot)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    snapshot = await store.load(f.machineId, f.clock());
    await f.db.run(
      "INSERT INTO holds(id,machine_id,kind,reason,created_at_ms) VALUES(?,?,'infrastructure','controller dependency',?)",
      [randomUUID(), f.machineId, f.clock()],
    );
    await expect(
      f.db.batchTransaction(store.fences(snapshot)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    snapshot = await store.load(f.machineId, f.clock());
    await f.db.run(
      "UPDATE machines SET machine_epoch=machine_epoch+1 WHERE id=?",
      [f.machineId],
    );
    await expect(
      f.db.batchTransaction(store.fences(snapshot)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    snapshot = await store.load(f.machineId, f.clock());
    await f.db.run(
      "INSERT INTO operations(id,node_id,controller_epoch,kind,step_key,dedup_key,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,1,'network.pending',?,?,?,'{}',?,?,?)",
      [
        randomUUID(),
        f.nodeId,
        randomUUID(),
        randomUUID(),
        "a".repeat(64),
        f.clock(),
        f.clock(),
        f.clock(),
      ],
    );
    await expect(
      f.db.batchTransaction(store.fences(snapshot)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    const c = await f.service.configuration(f.machineId);
    expect(c.shutdownDisabledReasons.join(" ")).toContain(
      "Unresolved operation",
    );
  });
  it("virtual drain does not block a real Ticket; a concurrent reservation invalidates final review", async () => {
    const f = await fixture();
    await configure(f);
    let p = await f.service.start(
      f.machineId,
      { expectedPolicyVersion: 1, mode: "idle_shutdown" },
      f.actor,
    );
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      f.actor,
    );
    f.advanceTime(10000);
    await f.heartbeat();
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      f.actor,
    );
    expect(p.phase).toBe("draining");
    const store = new SQLitePowerStore(f.db),
      before = await store.load(f.machineId, f.clock());
    const consumer = (await f.db.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='consumer'",
    ))!.id;
    const image = (await f.db.get<{ id: string }>(
      "SELECT id FROM image_versions",
    ))!.id;
    const network = (await f.db.get<{ id: string }>(
      "SELECT id FROM network_profiles",
    ))!.id;
    const tickets = new TicketService({ storage: f.db, now: f.clock });
    await tickets.acquire(consumer, randomUUID(), {
      image: { versionId: image },
      networkProfileId: network,
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
    });
    expect(await tickets.reserveNext()).toBeDefined();
    await expect(
      f.db.batchTransaction(store.fences(before)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    p = await f.service.advance(
      f.machineId,
      p.id,
      {
        expectedVersion: p.version,
        event: {
          kind: "accept_shutdown",
          simulatedLocalCheck: "complete_absent_clear",
        },
      },
      f.actor,
    );
    expect(p.phase).toBe("idle");
    expect(p.acceptedReceiptId).toBeNull();
    expect(p.reasons.join(" ")).toContain("Claim");
  });
  it("background continuation after early restart reaches the original restore deadline without a GUI and stops cleanly", async () => {
    const f = await fixture(),
      b = binding(f.machineId)!;
    let c = await f.service.configuration(f.machineId);
    c = await f.service.bind(
      f.machineId,
      { expectedMachineVersion: c.machineVersion, binding: b },
      f.actor,
    );
    await f.service.configure(
      f.machineId,
      {
        expectedVersion: 0,
        policy: {
          ...c.policy,
          faultRecovery: {
            mode: "smart_plug_cycle",
            plugBindingId: b.id,
            authorization: "operator",
            minimumOffSeconds: 600,
            maximumCyclesPerIncident: 1,
          },
        },
      },
      f.actor,
    );
    let p = await f.service.start(
      f.machineId,
      {
        expectedPolicyVersion: 1,
        mode: "fault_recovery",
        incidentId: randomUUID(),
      },
      f.actor,
    );
    for (const state of ["on", "off"] as const)
      p = await f.service.advance(
        f.machineId,
        p.id,
        {
          expectedVersion: p.version,
          event: {
            kind: "plug_readback",
            deviceId: b.device.deviceId,
            macAddress: b.device.macAddress,
            state,
          },
        },
        f.actor,
      );
    const deadline = p.restoreNotBeforeMs;
    f.advanceTime(100000);
    await f.restart();
    await f.service.recover();
    expect((await f.service.get(f.machineId, p.id)).phase).toBe("off_wait");
    const errors: unknown[] = [],
      stop = startPowerRecovery(
        f.service,
        (e) => {
          errors.push(e);
        },
        10,
      );
    clean.push(stop);
    f.advanceTime(500000);
    await vi.waitFor(async () =>
      expect((await f.service.get(f.machineId, p.id)).phase).toBe("on_pending"),
    );
    expect((await f.service.get(f.machineId, p.id)).restoreNotBeforeMs).toBe(
      deadline,
    );
    expect(errors).toEqual([]);
    await stop();
  });
  it("exclusive plug device ID/MAC and binding target are enforced across machines; token and verified assertions rejected", async () => {
    const f = await fixture(),
      b = binding(f.machineId)!;
    let c = await f.service.configuration(f.machineId);
    c = await f.service.bind(
      f.machineId,
      { expectedMachineVersion: c.machineVersion, binding: b },
      f.actor,
    );
    expect(c.binding!.device.macAddress).toBe("aa:bb:cc:dd:ee:ff");
    const second = await new SQLiteMachineNodeStore(
      f.db,
      f.clock,
    ).createMachine({
      name: "second",
      hostOs: "linux",
      architecture: "amd64",
      capacity: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 0 },
      operatorId: f.adminId,
    });
    for (const other of [
      { ...b, id: randomUUID(), machineId: second.id },
      {
        ...b,
        id: randomUUID(),
        machineId: second.id,
        device: { ...b.device, deviceId: "987654321" },
      },
    ])
      await expect(
        f.service.bind(
          second.id,
          { expectedMachineVersion: 1, binding: other },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.service.bind(
        second.id,
        { expectedMachineVersion: 1, binding: b },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      f.service.bind(
        f.machineId,
        {
          expectedMachineVersion: c.machineVersion,
          binding: { ...b, token: "secret" },
        },
        f.actor,
      ),
    ).rejects.toThrow();
    await expect(
      f.service.bind(
        f.machineId,
        {
          expectedMachineVersion: c.machineVersion,
          binding: { ...b, dedicatedSupply: "verified" },
        },
        f.actor,
      ),
    ).rejects.toThrow();
  });
  it("one recovery per incident, exact identity, off-unknown inspect, immutable wait and restart restore even after policy disable/epoch changes/cancel", async () => {
    const f = await fixture(),
      b = binding(f.machineId)!;
    let c = await f.service.configuration(f.machineId);
    c = await f.service.bind(
      f.machineId,
      { expectedMachineVersion: c.machineVersion, binding: b },
      f.actor,
    );
    c = await f.service.configure(
      f.machineId,
      {
        expectedVersion: 0,
        policy: {
          ...c.policy,
          faultRecovery: {
            mode: "smart_plug_cycle",
            plugBindingId: b.id,
            authorization: "operator",
            minimumOffSeconds: 600,
            maximumCyclesPerIncident: 1,
          },
        },
      },
      f.actor,
    );
    const incidentId = randomUUID();
    let p = await f.service.start(
      f.machineId,
      { expectedPolicyVersion: 1, mode: "fault_recovery", incidentId },
      f.actor,
    );
    await expect(
      f.service.start(
        f.machineId,
        { expectedPolicyVersion: 1, mode: "idle_shutdown" },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.service.bind(
        f.machineId,
        { expectedMachineVersion: c.machineVersion, binding: null },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const read = (
      state: "on" | "off" | "unknown",
      deviceId = b.device.deviceId,
    ) => ({
      kind: "plug_readback",
      state,
      deviceId,
      macAddress: b.device.macAddress,
    });
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: read("on", "11111") },
      f.actor,
    );
    expect(p.phase).toBe("inspect");
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: read("on") },
      f.actor,
    );
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "off_result_unknown" } },
      f.actor,
    );
    expect(p.phase).toBe("inspect_off");
    await f.restart();
    await f.service.recover();
    p = await f.service.get(f.machineId, p.id);
    expect(p.phase).toBe("inspect_off");
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: read("off") },
      f.actor,
    );
    const deadline = p.restoreNotBeforeMs!;
    f.advanceTime(300000);
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: read("off") },
      f.actor,
    );
    expect(p.restoreNotBeforeMs).toBe(deadline);
    await f.service.configure(
      f.machineId,
      { expectedVersion: 1, policy: PowerPolicySchema.parse({}) },
      f.actor,
    );
    await f.db.run(
      "UPDATE installations SET controller_epoch=controller_epoch+1",
    );
    await f.db.run(
      "UPDATE machines SET machine_epoch=machine_epoch+1 WHERE id=?",
      [f.machineId],
    );
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "cancel" } },
      f.actor,
    );
    expect(p.restoreRequired).toBe(true);
    await f.restart();
    f.advanceTime(300000);
    await f.service.recover();
    p = await f.service.get(f.machineId, p.id);
    expect(p.phase).toBe("on_pending");
    expect(p.restoreNotBeforeMs).toBe(deadline);
    expect(p.binding!.credentialVersionRef).toBe(b.credentialVersionRef);
    p = await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: read("on") },
      f.actor,
    );
    expect(p.phase).toBe("verifying");
    expect(p.restoreRequired).toBe(false);
    expect(
      await f.db.get("SELECT count(*) AS count FROM agent_receipts"),
    ).toEqual({ count: 0n });
    await f.service.advance(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "cancel" } },
      f.actor,
    );
    await f.service.configure(
      f.machineId,
      { expectedVersion: 2, policy: c.policy },
      f.actor,
    );
    await expect(
      f.service.start(
        f.machineId,
        {
          expectedPolicyVersion: 3,
          mode: "fault_recovery",
          incidentId,
          riskAcknowledgement: "New epoch test remains a simulation",
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("API and SDK reuse strict schemas, full administrator auth, and CAS without real power side effects", async () => {
    const f = await fixture();
    const app = await buildApp(
      loadConfig({ DATA_DIR: f.dir, GUI_DIR: "/no-gui", LOG_LEVEL: "silent" }),
      { storage: f.db },
    );
    clean.push(() => app.close());
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
            headers: response.headers as Record<string, string>,
          });
        },
      });
    const sdk = client(f.adminToken),
      consumer = client(f.token);
    await expect(
      consumer.admin.powerConfiguration(f.machineId),
    ).rejects.toMatchObject({ code: "forbidden" });
    let c = await sdk.admin.powerConfiguration(f.machineId);
    const preview = await sdk.admin.previewPowerPolicy(f.machineId, {
      expectedVersion: 0,
      policy: {
        ...c.policy,
        enabled: true,
        idleAction: "shutdown",
        idleSeconds: 10,
      },
    });
    expect(preview.canSave).toBe(true);
    expect((await sdk.admin.powerConfiguration(f.machineId)).version).toBe(0);
    c = await sdk.admin.updatePowerPolicy(
      f.machineId,
      { expectedVersion: 0, policy: preview.configuration.policy },
      randomUUID(),
    );
    expect(c.version).toBe(1);
    await expect(
      sdk.admin.updatePowerPolicy(
        f.machineId,
        { expectedVersion: 0, policy: c.policy },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    let p = await sdk.admin.startPowerPreview(
      f.machineId,
      { expectedPolicyVersion: 1, mode: "idle_shutdown" },
      randomUUID(),
    );
    p = await sdk.admin.advancePowerPreview(
      f.machineId,
      p.id,
      { expectedVersion: p.version, event: { kind: "evaluate" } },
      randomUUID(),
    );
    expect(p.dryRun).toBe(true);
    expect(p.executable).toBe(false);
    expect((await sdk.admin.powerPreview(f.machineId, p.id)).version).toBe(
      p.version,
    );
    expect(await sdk.admin.powerPreviews(f.machineId)).toHaveLength(1);
    const doc = (await app.inject({ url: "/v1/openapi.json" })).json();
    expect(JSON.stringify(doc)).toContain("power-previews");
    const hidden = await app.inject({
      url: `/v1/machines/${f.machineId}/power`,
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(hidden.statusCode).toBe(403);
  });
});
