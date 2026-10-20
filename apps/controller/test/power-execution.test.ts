import { afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openStorage } from "../dist/storage/index.js";
import { SQLiteMachineNodeStore } from "../src/storage/machine-node-store.js";
import { TicketService } from "../src/application/tickets.js";
import { HostAgents } from "../src/application/host-agents.js";
import { PowerExecutionService } from "../src/application/power-execution.js";
import { PowerInstallationSchema } from "@hitchlet/contracts/admin";
import {
  hostHeartbeatSchema,
  type HostSnapshot,
} from "@hitchlet/contracts/internal";
import {
  NativePowerExecutor,
  type PowerJournal,
} from "../../runtime-agent/src/host-power.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-real-power-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const db = await openStorage(dir);
  cleanup.push(() => db.close());
  const machineId = (await db.get<{ id: string }>("SELECT id FROM machines"))!
      .id,
    nodeId = (await db.get<{ id: string }>("SELECT id FROM nodes"))!.id,
    adminId = (await db.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='admin'",
    ))!.id;
  const installationId = (await db.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations",
  ))!.installation_id;
  let now = Date.now(),
    bootId = randomUUID(),
    osBootId = randomUUID(),
    sessionEpoch = 0,
    sequence = 0;
  const clock = () => now;
  const inventory = new SQLiteMachineNodeStore(db, clock),
    initial = (await inventory.listMachineDependencies())[0]!;
  await inventory.updateHumanUsePolicy({
    machineId,
    expectedVersion: 1,
    policy: initial.humanUsePolicy!,
    operatorId: adminId,
    requestId: randomUUID(),
  });
  await db.run(
    "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.admissionMode','observed_host') WHERE id=?",
    [nodeId],
  );
  const hosts = new HostAgents(db, clock),
    hostIdentity = randomUUID(),
    pair = await hosts.pair(
      {
        machineId,
        hostIdentity,
        reason: "synthetic fixed power qualification",
      },
      adminId,
      randomUUID(),
    );
  const enroll = await hosts.enroll({
    agentId: pair.agentId,
    machineId,
    installationId,
    hostIdentity,
    pairingToken: pair.pairingToken,
    hostOs: "linux",
    architecture: "amd64",
    protocolVersion: 1,
    role: "physical_host",
  });
  const authorization = `Bearer ${enroll.credential}`;
  async function boot(newOsBoot = true) {
    bootId = randomUUID();
    if (newOsBoot) osBootId = randomUUID();
    await hosts.start(pair.agentId, authorization, {
      installationId,
      controllerEpoch: 1,
      expectedSessionEpoch: sessionEpoch,
      bootId,
    });
    sessionEpoch++;
    sequence = 0;
  }
  await boot();
  async function heartbeat(
    present = false,
    evidence: Partial<HostSnapshot> = {},
  ) {
    await hosts.heartbeat(
      pair.agentId,
      authorization,
      hostHeartbeatSchema.parse({
        installationId,
        controllerEpoch: 1,
        sessionEpoch,
        protocolVersion: 1,
        agentVersion: "power-test",
        snapshot: {
          agentId: pair.agentId,
          machineId,
          bootId,
          osBootId,
          sequence: sequence++,
          observedAt: new Date(now).toISOString(),
          probeStatus: "complete",
          sessionsComplete: true,
          sessions: [],
          activeInteraction: present,
          unmanagedActivityHold: false,
          resources: {
            cpuPercent: 1,
            memoryUsedBytes: 1,
            memoryTotalBytes: 100,
          },
          errorCodes: [],
          ...evidence,
        },
      }),
    );
    await db.run("UPDATE nodes SET observed_at_ms=? WHERE id=?", [now, nodeId]);
  }
  await heartbeat();
  const config = PowerInstallationSchema.parse({
      machines: [
        {
          machineId,
          agentId: pair.agentId,
          enabled: true,
          automatic: false,
          idleSeconds: 1,
          guardHash: "a".repeat(64),
          executorHash: "c".repeat(64),
          route: {
            id: randomUUID(),
            kind: "local_lan",
            interfaceAddress: "192.168.99.2",
            broadcastAddress: "192.168.99.255",
            macAddress: "02:00:00:00:00:01",
          },
        },
      ],
    }),
    wol = vi.fn(async () => {});
  let service = new PowerExecutionService(db, config, clock, wol);
  const get = async () => (await service.store.list(machineId))[0]!;
  async function drain(qualification = true) {
    await service.start(machineId, qualification);
    await service.tick();
    now += 1;
    await heartbeat();
    await service.tick();
    now += 1001;
    await heartbeat();
    await service.tick();
    expect((await get()).phase).toBe("draining");
  }
  async function demand() {
    const consumer = (await db.get<{ id: string }>(
        "SELECT id FROM consumers WHERE role='consumer'",
      ))!.id,
      image = (await db.get<{ id: string }>("SELECT id FROM image_versions"))!
        .id,
      network = (await db.get<{ id: string }>(
        "SELECT id FROM network_profiles",
      ))!.id;
    const tickets = new TicketService({ storage: db, now: clock });
    return tickets.acquire(consumer, randomUUID(), {
      image: { versionId: image },
      networkProfileId: network,
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
    });
  }
  const event = (
    kind: "poll" | "prepared" | "accepted" | "cancelled" | "rejected",
    cycleId?: string,
    token?: string,
  ) => ({
    event: kind,
    powerProtocolVersion: 1 as const,
    bootId,
    osBootId,
    controllerEpoch: 1,
    sessionEpoch,
    guardHash: "a".repeat(64),
    executorHash: "c".repeat(64),
    ...(cycleId ? { cycleId } : {}),
    ...(token ? { token } : {}),
  });
  async function accepted(qualification = true) {
    await drain(qualification);
    const p = await get();
    expect((await service.hostEvent(pair.agentId, event("poll"))).action).toBe(
      "prepare",
    );
    const token = randomUUID(),
      commit = await service.hostEvent(
        pair.agentId,
        event("prepared", p.id, token),
      );
    expect(commit.action).toBe("commit");
    await service.hostEvent(pair.agentId, event("accepted", p.id, token));
    expect((await get()).phase).toBe("shutdown_requested");
  }
  return {
    db,
    config,
    wol,
    machineId,
    nodeId,
    adminId,
    hosts,
    heartbeat,
    boot,
    drain,
    accepted,
    event,
    get,
    demand,
    agentId: pair.agentId,
    get service() {
      return service;
    },
    restart: () => {
      service = new PowerExecutionService(db, config, clock, wol);
    },
    advance: (ms: number) => {
      now += ms;
    },
    clock,
  };
}
describe("persisted native power qualification (synthetic OS/WOL ports)", () => {
  it.each(["paused=1", "disk_state='low'", "recovery_json='{}'"])(
    "does not initiate shutdown while controller maintenance closes admission: %s",
    async (change) => {
      const f = await fixture();
      await f.db.run(
        `UPDATE system_maintenance SET ${change} WHERE singleton=1`,
      );
      await expect(f.service.start(f.machineId, true)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(await f.service.store.active()).toHaveLength(0);
    },
  );
  it("fences a maintenance pause between final read and prepared commit", async () => {
    const f = await fixture();
    await f.drain();
    const p = await f.get(),
      write = f.service.store.write.bind(f.service.store);
    vi.spyOn(f.service.store, "write").mockImplementationOnce(
      async (...args) => {
        await f.db.run(
          "UPDATE system_maintenance SET paused=1 WHERE singleton=1",
        );
        return write(...args);
      },
    );
    await expect(
      f.service.hostEvent(f.agentId, f.event("prepared", p.id, randomUUID())),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await f.get()).phase).toBe("draining");
    expect((await f.service.hostEvent(f.agentId, f.event("poll"))).action).toBe(
      "cancel",
    );
    expect((await f.get()).acceptedReceiptId).toBeNull();
  });
  it("retains the referenced qualification beyond the GUI history window", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(120000);
    await f.service.tick();
    let p = await f.get();
    await f.service.command(f.machineId, p.id, p.version, "wake");
    await f.service.tick();
    await f.boot();
    await f.heartbeat();
    await f.service.tick();
    p = await f.get();
    expect(p.phase).toBe("ready");
    f.config.machines[0]!.qualificationId = p.id;
    for (let i = 0; i < 101; i++) {
      const id = randomUUID(),
        time = f.clock() + i + 1;
      await f.db.run(
        "INSERT INTO operations(id,machine_id,machine_epoch,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,result_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'power.execution',?,?,'cancelled',?,'{}',?,?,?,?)",
        [
          id,
          f.machineId,
          p.machineEpoch,
          p.controllerEpoch,
          id,
          `power.execution:${id}`,
          p.bindingHash,
          JSON.stringify({
            ...p,
            id,
            phase: "cancelled",
            createdAtMs: time,
            updatedAtMs: time,
          }),
          time,
          time,
          time,
        ],
      );
    }
    expect(
      (await f.service.store.list(f.machineId)).some((v) => v.id === p.id),
    ).toBe(false);
    expect((await f.service.view(f.machineId)).verified).toBe(true);
  });
  it("keeps dry-run isolated and rejects unmanaged configuration verification", async () => {
    const f = await fixture();
    const disabled = new PowerExecutionService(f.db);
    await expect(disabled.start(f.machineId, true)).rejects.toMatchObject({
      code: "execution_mode_unsupported",
    });
    await expect(f.service.start(f.machineId, false)).rejects.toMatchObject({
      code: "execution_mode_unsupported",
    });
    expect((await f.service.view(f.machineId)).verified).toBe(false);
  });
  it("drains with epoch CAS, accepts authenticated receipt, infers unknown expected-off, bounds retries, requires new OS boot", async () => {
    const f = await fixture();
    await f.accepted();
    const a = await f.get();
    expect(a.observedPower).toBe("unknown");
    expect(
      await f.db.get("SELECT phase FROM agent_receipts WHERE id=?", [
        a.acceptedReceiptId,
      ]),
    ).toMatchObject({ phase: "accepted" });
    f.advance(119999);
    await f.service.tick();
    expect((await f.get()).phase).toBe("shutdown_requested");
    f.advance(1);
    await f.service.tick();
    let p = await f.get();
    expect(p.phase).toBe("off_expected");
    expect(p.observedPower).toBe("unknown");
    await f.service.command(
      f.machineId,
      p.id,
      p.version,
      "wake",
      f.clock() + 300000,
    );
    await f.service.tick();
    expect(f.wol).toHaveBeenCalledTimes(2);
    await f.service.tick();
    expect(f.wol).toHaveBeenCalledTimes(2);
    f.restart();
    f.advance(30000);
    await f.service.tick();
    expect(f.wol).toHaveBeenCalledTimes(3);
    await f.boot();
    await f.heartbeat();
    await f.service.tick();
    p = await f.get();
    expect(p.phase).toBe("ready");
    expect(p.recoveredBootId).not.toBe(p.bootId);
    f.config.machines[0]!.qualificationId = p.id;
    expect((await f.service.view(f.machineId)).verified).toBe(true);
    f.config.machines[0]!.guardHash = "b".repeat(64);
    expect((await f.service.view(f.machineId)).verified).toBe(false);
  });
  it("never upgrades a Host process restart on the same OS boot to cold-boot evidence", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(120000);
    await f.service.tick();
    const p = await f.get();
    await f.service.command(f.machineId, p.id, p.version, "wake");
    await f.service.tick();
    await f.boot(false);
    await f.heartbeat();
    await f.service.tick();
    expect((await f.get()).phase).toBe("cancel_pending");
    expect((await f.service.view(f.machineId)).verified).toBe(false);
  });
  it("new login after prepare cancels and cannot be promoted by old token", async () => {
    const f = await fixture();
    await f.drain();
    const p = await f.get(),
      token = randomUUID();
    await f.service.hostEvent(f.agentId, f.event("prepared", p.id, token));
    await f.heartbeat(true);
    await f.service.hostEvent(f.agentId, f.event("accepted", p.id, token));
    expect((await f.get()).phase).toBe("cancel_pending");
    expect((await f.get()).acceptedReceiptId).toBeNull();
  });
  it("administrator disablement is never hidden or restored by the owned drain", async () => {
    const f = await fixture();
    await f.drain();
    await f.db.run(
      "UPDATE machines SET admission='disabled',version=version+1 WHERE id=?",
      [f.machineId],
    );
    await f.service.tick();
    expect((await f.get()).phase).toBe("cancelled");
    expect(
      await f.db.get("SELECT admission FROM machines WHERE id=?", [
        f.machineId,
      ]),
    ).toMatchObject({ admission: "disabled" });
  });
  it("new Hold and policy mutation invalidate final commit; restart cannot redeliver commit", async () => {
    const f = await fixture();
    await f.drain();
    const p = await f.get(),
      token = randomUUID();
    await f.service.hostEvent(f.agentId, f.event("prepared", p.id, token));
    f.restart();
    expect((await f.service.hostEvent(f.agentId, f.event("poll"))).action).toBe(
      "none",
    );
    await f.db.run(
      "INSERT INTO holds(id,machine_id,kind,reason,created_by_consumer_id,created_at_ms) VALUES(?,?,'manual','test activity',?,?)",
      [randomUUID(), f.machineId, f.adminId, f.clock()],
    );
    await f.service.hostEvent(f.agentId, f.event("accepted", p.id, token));
    expect((await f.get()).acceptedReceiptId).toBeNull();
    expect((await f.get()).phase).toBe("cancel_pending");
  });
  it("never resets the original wake deadline or exceeds three sends across recovery", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(120000);
    await f.service.tick();
    let p = await f.get();
    const original = p.deadlineMs!;
    await f.service.command(
      f.machineId,
      p.id,
      p.version,
      "wake",
      original + 999999,
    );
    for (let i = 0; i < 3; i++) {
      f.restart();
      await f.service.tick();
      f.advance(30000);
    }
    p = await f.get();
    expect(p.wakeAttempts).toBe(3);
    expect(p.deadlineMs).toBe(original);
    expect(f.wol).toHaveBeenCalledTimes(4);
    f.advance(original - f.clock());
    await f.service.tick();
    expect((await f.get()).phase).toBe("manual");
    expect(f.wol).toHaveBeenCalledTimes(4);
  });
  it("a real queued Ticket cancels idle/drain and fences the commit transaction", async () => {
    const f = await fixture();
    await f.drain();
    const snapshot = await f.service.store.safety.load(f.machineId, f.clock()),
      p = await f.get();
    await f.demand();
    expect(
      (await f.service.store.safety.load(f.machineId, f.clock())).data.demands,
    ).toHaveLength(1);
    await expect(
      f.db.batchTransaction(f.service.store.safety.fences(snapshot)),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    await f.service.hostEvent(
      f.agentId,
      f.event("prepared", p.id, randomUUID()),
    );
    expect((await f.get()).acceptedReceiptId).toBeNull();
    expect((await f.get()).phase).toBe("cancelled");
  });
  it("a matching queued Ticket wakes an already-qualified expected-off machine without reserving unknown capacity", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(120000);
    await f.service.tick();
    let p = await f.get();
    await f.service.command(f.machineId, p.id, p.version, "wake");
    await f.service.tick();
    await f.boot();
    await f.heartbeat();
    await f.service.tick();
    p = await f.get();
    f.config.machines[0]!.qualificationId = p.id;
    await f.accepted(false);
    f.advance(120000);
    await f.service.tick();
    expect((await f.get()).phase).toBe("off_expected");
    f.config.machines[0]!.automatic = true;
    await f.demand();
    await f.service.tick();
    expect((await f.get()).phase).toBe("waking");
    const before = f.wol.mock.calls.length;
    await f.service.tick();
    expect(f.wol).toHaveBeenCalledTimes(before + 1);
    expect(
      await f.db.get(
        "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
      ),
    ).toMatchObject({ n: 0n });
  });
  it("late demand after OS acceptance either resumes its owned verified wake or reaches the original manual deadline", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(60001);
    await f.demand();
    await f.service.tick();
    expect((await f.get()).phase).toBe("cancel_pending");
    expect((await f.get()).resumeWakeOnDemand).toBe(true);
    f.advance(240000);
    await f.service.tick();
    expect((await f.get()).phase).toBe("manual");
    expect(f.wol).toHaveBeenCalledTimes(1);
  });
  it("a new authenticated OS boot with a person present completes recovery and preserves human-use admission", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(120000);
    await f.service.tick();
    const p = await f.get();
    await f.service.command(f.machineId, p.id, p.version, "wake");
    await f.service.tick();
    await f.boot();
    await f.heartbeat(true);
    await f.service.tick();
    expect((await f.get()).phase).toBe("ready");
    expect(
      await f.db.get("SELECT observed_power FROM machines WHERE id=?", [
        f.machineId,
      ]),
    ).toMatchObject({ observed_power: "on" });
    const s = await f.service.store.safety.load(f.machineId, f.clock());
    expect(s.context.admission.observation?.snapshot.activeInteraction).toBe(
      true,
    );
    const { evaluateMachineAdmission } = await import(
      "../src/domain/human-use.js"
    );
    expect(
      evaluateMachineAdmission(
        {
          ...s.context.admission,
          policy: {
            ...s.context.admission.policy!,
            admissionDuringInteraction: "block_new",
          },
        },
        f.clock(),
      ).reasons.join(" "),
    ).toContain("Interactive session");
  });
  it("normal public Machine registration can represent physical Host qualification without a fake Node", async () => {
    const f = await fixture();
    const store = new SQLiteMachineNodeStore(f.db, f.clock);
    const created = await store.createMachine({
      name: "power-only-test",
      powerOnly: true,
      hostOs: "windows",
      architecture: "amd64",
      capacity: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
      operatorId: f.adminId,
    });
    expect(
      await f.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM holds WHERE machine_id=?",
        [created.id],
      ),
    ).toMatchObject({ n: 0n });
    expect(
      await f.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM nodes WHERE machine_id=?",
        [created.id],
      ),
    ).toMatchObject({ n: 0n });
    expect(created.powerEnabled).toBe(false);
  });
});

describe("same-controller confirmed local cancellation", () => {
  it.each(["draining", "committing", "shutdown_requested", "cancel_pending"])(
    "consumes same-OS-boot cancellation in %s, clears token and preserves accepted evidence",
    async (phase) => {
      const f = await fixture();
      if (phase === "draining" || phase === "committing") {
        await f.drain();
        if (phase === "committing")
          await f.service.hostEvent(
            f.agentId,
            f.event("prepared", (await f.get()).id, randomUUID()),
          );
      } else {
        await f.accepted();
        if (phase === "cancel_pending") {
          const p = await f.get();
          await f.service.command(f.machineId, p.id, p.version, "cancel");
        }
      }
      const before = await f.get();
      expect(before.phase).toBe(phase);
      const response = await f.service.hostEvent(
        f.agentId,
        f.event("cancelled", before.id),
      );
      expect(response.action).toBe("none");
      expect(await f.get()).toMatchObject({
        phase: "cancelled",
        token: null,
        tokenExpiresAtMs: null,
        observedPower: "on",
        acceptedReceiptId: before.acceptedReceiptId,
        acceptedAtMs: before.acceptedAtMs,
      });
      expect(
        await f.db.get(
          "SELECT admission,machine_epoch,power_lifecycle FROM machines WHERE id=?",
          [f.machineId],
        ),
      ).toMatchObject({
        admission: "enabled",
        machine_epoch: BigInt(before.machineEpoch + 1),
        power_lifecycle: "idle",
      });
      if (before.acceptedReceiptId)
        expect(
          await f.db.get("SELECT phase FROM agent_receipts WHERE id=?", [
            before.acceptedReceiptId,
          ]),
        ).toMatchObject({ phase: "accepted" });
      const finished = await f.get();
      // An ACK lost after commit is idempotent; neither machine epoch nor operation version advances twice.
      expect(
        (await f.service.hostEvent(f.agentId, f.event("cancelled", before.id)))
          .action,
      ).toBe("none");
      expect(await f.get()).toEqual(finished);
    },
  );
  it("recovers a brief same-epoch outage through durable Runtime fact, lost ACK and process restart, without blocking a new cycle", async () => {
    const f = await fixture();
    let journal: PowerJournal | null = null;
    const abort = vi.fn(async () => {}),
      shutdown = vi.fn(async () => {});
    const native = () =>
      new NativePowerExecutor({
        bootId: f.event("poll").osBootId,
        load: async () => journal,
        save: async (j) => {
          journal = structuredClone(j);
        },
        check: async () => true,
        shutdown,
        abort,
        now: f.clock,
        uptimeMs: f.clock,
      });
    let executor = native();
    await executor.initialize();
    await f.drain();
    const offer = await f.service.hostEvent(f.agentId, f.event("poll"));
    const prepared = (await executor.directive(offer))!;
    const commit = await f.service.hostEvent(f.agentId, {
      ...f.event("poll"),
      ...prepared,
    });
    const accepted = (await executor.directive(commit))!;
    await f.service.hostEvent(f.agentId, { ...f.event("poll"), ...accepted });
    const before = await f.get();
    expect(before.phase).toBe("shutdown_requested");
    // Pause/unpause equivalent: no controller restart or epoch mutation. Native cancellation is confirmed.
    f.advance(20000);
    await executor.abort();
    expect(abort).toHaveBeenCalledOnce();
    expect(journal).toMatchObject({
      state: "cancelled",
      cancelReportPending: true,
    });
    await f.heartbeat();
    const fact = executor.pendingCancellation()!;
    await f.service.hostEvent(f.agentId, { ...f.event("poll"), ...fact }); // Simulate lost HTTP response.
    expect((await f.get()).phase).toBe("cancelled");
    const epochAfter = await f.db.get(
      "SELECT machine_epoch FROM machines WHERE id=?",
      [f.machineId],
    );
    await f.boot(false);
    await f.heartbeat(); // New authenticated Agent process, same real OS boot.
    executor = native();
    await executor.initialize();
    expect(executor.pendingCancellation()).toEqual(fact);
    const ack = await f.service.hostEvent(f.agentId, {
      ...f.event("poll"),
      ...executor.pendingCancellation()!,
    });
    await executor.acknowledgeCancellation(before.id, ack);
    await executor.abort(); // Ordinary retry cannot resurrect an already-ACKed report.
    expect(executor.pendingCancellation()).toBeNull();
    expect(
      await f.db.get("SELECT machine_epoch FROM machines WHERE id=?", [
        f.machineId,
      ]),
    ).toEqual(epochAfter);
    expect((await f.get()).controllerEpoch).toBe(before.controllerEpoch);
    expect((await f.get()).acceptedReceiptId).toBe(before.acceptedReceiptId);
    expect(shutdown).toHaveBeenCalledOnce();
    await f.drain();
    const next = await f.get();
    expect(next.id).not.toBe(before.id);
    expect(
      (await f.service.hostEvent(f.agentId, { ...f.event("poll"), ...fact }))
        .action,
    ).toBe("none");
    expect((await f.get()).phase).toBe("draining");
    expect((await f.service.hostEvent(f.agentId, f.event("poll"))).action).toBe(
      "prepare",
    );
  });
  it("does not consume an unspecified/wrong cycle or a new OS boot's cancellation as the original shutdown", async () => {
    const f = await fixture();
    await f.accepted();
    const p = await f.get();
    await f.service.hostEvent(f.agentId, f.event("cancelled"));
    await f.service.hostEvent(f.agentId, f.event("cancelled", randomUUID()));
    expect(await f.get()).toEqual(p);
    await f.boot();
    await f.heartbeat();
    await f.service.hostEvent(f.agentId, f.event("cancelled", p.id));
    expect(await f.get()).toEqual(p);
  });
  it("preserves a new live OS boot's ACK of an explicit controller cancel_pending directive", async () => {
    const f = await fixture();
    await f.accepted();
    const p = await f.get();
    await f.service.command(f.machineId, p.id, p.version, "cancel");
    await f.boot();
    await f.heartbeat();
    expect((await f.service.hostEvent(f.agentId, f.event("poll"))).action).toBe(
      "cancel",
    );
    expect(
      (await f.service.hostEvent(f.agentId, f.event("cancelled", p.id))).action,
    ).toBe("none");
    expect((await f.get()).phase).toBe("cancelled");
    expect(
      await f.db.get("SELECT admission FROM machines WHERE id=?", [
        f.machineId,
      ]),
    ).toMatchObject({ admission: "enabled" });
  });
  it.each(["off_expected", "waking"])(
    "does not let an old cancellation fact interrupt new OS boot recovery in %s",
    async (phase) => {
      const f = await fixture();
      await f.accepted();
      f.advance(120000);
      await f.service.tick();
      let p = await f.get();
      if (phase === "waking") {
        await f.service.command(f.machineId, p.id, p.version, "wake");
        await f.service.tick();
        p = await f.get();
      }
      await f.boot();
      await f.heartbeat();
      await f.service.hostEvent(f.agentId, f.event("cancelled", p.id));
      expect((await f.get()).phase).toBe(phase);
      if (phase === "waking") {
        await f.service.tick();
        expect((await f.get()).phase).toBe("ready");
      }
    },
  );
  it("records confirmed cancellation without restoring another administrator's admission fence", async () => {
    const f = await fixture();
    await f.accepted();
    const p = await f.get();
    await f.db.run(
      "UPDATE machines SET admission='disabled',machine_epoch=machine_epoch+1,version=version+1 WHERE id=?",
      [f.machineId],
    );
    const fenced = await f.db.get(
      "SELECT admission,machine_epoch,version,power_lifecycle FROM machines WHERE id=?",
      [f.machineId],
    );
    await f.service.hostEvent(f.agentId, f.event("cancelled", p.id));
    expect((await f.get()).phase).toBe("cancelled");
    expect(
      await f.db.get(
        "SELECT admission,machine_epoch,version,power_lifecycle FROM machines WHERE id=?",
        [f.machineId],
      ),
    ).toEqual(fenced);
  });
  it("fences cancellation completion and admission restoration in the same transaction", async () => {
    const f = await fixture();
    await f.accepted();
    const p = await f.get();
    const write = f.service.store.write.bind(f.service.store);
    vi.spyOn(f.service.store, "write").mockImplementationOnce(
      async (...args) => {
        await f.db.run(
          "UPDATE machines SET admission='disabled',machine_epoch=machine_epoch+1,version=version+1 WHERE id=?",
          [f.machineId],
        );
        return write(...args);
      },
    );
    await expect(
      f.service.hostEvent(f.agentId, f.event("cancelled", p.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await f.get()).phase).toBe("shutdown_requested");
    expect(
      await f.db.get("SELECT admission FROM machines WHERE id=?", [
        f.machineId,
      ]),
    ).toMatchObject({ admission: "disabled" });
    await f.service.hostEvent(f.agentId, f.event("cancelled", p.id));
    expect((await f.get()).phase).toBe("cancelled");
    expect(
      await f.db.get("SELECT admission FROM machines WHERE id=?", [
        f.machineId,
      ]),
    ).toMatchObject({ admission: "disabled" });
  });
});

describe("post-acceptance Host evidence freshness", () => {
  it("does not reinterpret a newer safe heartbeat as unsafe after it expires, and completes product demand WOL recovery", async () => {
    const f = await fixture();
    // Establish qualification before the product cycle; WOL ports are synthetic in this SQLite test.
    await f.accepted();
    f.advance(120000);
    await f.service.tick();
    let p = await f.get();
    await f.service.command(f.machineId, p.id, p.version, "wake");
    await f.service.tick();
    await f.boot();
    await f.heartbeat();
    await f.service.tick();
    p = await f.get();
    expect(p.phase).toBe("ready");
    f.config.machines[0]!.qualificationId = p.id;
    await f.accepted(false);
    const accepted = await f.get();
    expect(accepted.qualification).toBe(false);
    f.advance(1000);
    await f.heartbeat();
    await f.service.tick();
    expect((await f.get()).phase).toBe("shutdown_requested");
    f.advance(30001);
    await f.service.tick(); // Host has expired, but OS acceptance is only 31s old.
    expect((await f.get()).phase).toBe("shutdown_requested");
    f.advance(54999);
    await f.service.tick(); // Reproduce the real +86s interval with no new heartbeat.
    expect((await f.get()).phase).toBe("shutdown_requested");
    f.advance(33999);
    await f.service.tick();
    expect((await f.get()).phase).toBe("shutdown_requested");
    f.advance(1);
    await f.service.tick();
    p = await f.get();
    expect(p.phase).toBe("off_expected");
    expect(p.observedPower).toBe("unknown");
    expect(p.acceptedReceiptId).toBe(accepted.acceptedReceiptId);
    expect(p.deadlineMs).toBe(accepted.deadlineMs);
    f.config.machines[0]!.automatic = true;
    await f.demand();
    await f.service.tick();
    expect((await f.get()).phase).toBe("waking");
    const sends = f.wol.mock.calls.length;
    await f.service.tick();
    expect(f.wol).toHaveBeenCalledTimes(sends + 1);
    await f.boot();
    await f.heartbeat();
    await f.service.tick();
    p = await f.get();
    expect(p.phase).toBe("ready");
    expect(p.recoveredBootId).not.toBe(accepted.bootId);
  });
  it.each(["present", "unknown", "incomplete"])(
    "still cancels immediately on a new fresh %s Host observation",
    async (kind) => {
      const f = await fixture();
      await f.accepted();
      f.advance(1);
      await f.heartbeat(
        kind === "present",
        kind === "unknown"
          ? {
              probeStatus: "partial",
              activeInteraction: "unknown",
              unmanagedActivityHold: null,
            }
          : kind === "incomplete"
            ? { probeStatus: "partial", sessionsComplete: false }
            : {},
      );
      await f.service.tick();
      expect((await f.get()).phase).toBe("cancel_pending");
      expect((await f.get()).reasons).toContain(
        "New online safety evidence invalidated shutdown",
      );
    },
  );
  it("does not treat a recent receipt of an already old observation as fresh unsafe evidence", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(40000);
    await f.heartbeat(true, {
      observedAt: new Date(f.clock() - 31000).toISOString(),
    });
    const snapshot = await f.service.store.safety.load(f.machineId, f.clock());
    expect(snapshot.context.admission.observation!.receivedAtMs).toBe(
      f.clock(),
    );
    await f.service.tick();
    expect((await f.get()).phase).toBe("shutdown_requested");
  });
  it("does not turn future-dated cached evidence after clock rollback into a new online cancellation", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(1000);
    await f.heartbeat(true);
    f.advance(-1);
    await f.service.tick();
    expect((await f.get()).phase).toBe("shutdown_requested");
  });
  it.each(["old_observed", "future_received"])(
    "requires full Host freshness for the expected-off same-boot gate: %s",
    async (kind) => {
      const f = await fixture();
      await f.accepted();
      f.advance(120000);
      await f.service.tick();
      expect((await f.get()).phase).toBe("off_expected");
      await f.heartbeat(
        false,
        kind === "old_observed"
          ? { observedAt: new Date(f.clock() - 31000).toISOString() }
          : {},
      );
      if (kind === "future_received") f.advance(-1);
      await f.service.tick();
      expect((await f.get()).phase).toBe("off_expected");
    },
  );
  it("still invalidates expected-off when genuine fresh same-boot evidence returns", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(120000);
    await f.service.tick();
    await f.heartbeat();
    await f.service.tick();
    expect((await f.get()).phase).toBe("cancel_pending");
    expect((await f.get()).reasons).toContain(
      "Fresh same-boot online evidence invalidated expected-off",
    );
  });
  it("new ledger Holds cancel even when Host heartbeat has expired", async () => {
    const f = await fixture();
    await f.accepted();
    f.advance(40000);
    await f.db.run(
      "INSERT INTO holds(id,machine_id,kind,reason,created_by_consumer_id,created_at_ms) VALUES(?,?,'manual','post-acceptance activity',?,?)",
      [randomUUID(), f.machineId, f.adminId, f.clock()],
    );
    await f.service.tick();
    expect((await f.get()).phase).toBe("cancel_pending");
    expect((await f.get()).reasons).toContain(
      "New claim, Hold or unresolved operation cancelled power cycle",
    );
  });
});
