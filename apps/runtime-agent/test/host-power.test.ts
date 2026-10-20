import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ChildProcess as WatchChild } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NativePowerExecutor,
  WorkloadGuardSchema,
  workloadReasons,
  type PowerJournal,
  type NativeOwnedWatchProcess,
  runNativePowerLifecycle,
  nativePowerCommandFailure,
  nativePowerDiagnostic,
  isTransientNativeSamplingFailure,
  cancelBeforeNativePowerRetry,
  isFreshNativeSafetySample,
} from "../src/host-power.js";
import {
  HostRequestError,
  HostTransientError,
  hostConnectionFailure,
  isTransientHostFailure,
} from "../src/host-client.js";
import {
  nativeBootId,
  acquirePowerLock,
  saveNativePowerFailure,
  NativeBootRecordSchema,
  saveNativeShutdownAttemptFailure,
  type NativeShutdownAttemptFailure,
} from "../src/host-power-storage.js";
function watchChild() {
  const child = new WatchChild();
  Object.defineProperty(child, "pid", { value: 1111, configurable: true });
  return child;
}
function watchReady(child: WatchChild) {
  return (
    JSON.stringify({
      event: "ready",
      launcherPid: child.pid,
      launcherStartedTicks: "638000000000000001",
      watchPid: 2222,
      watchStartedTicks: "638000000000000002",
    }) + "\n"
  );
}
const bootId = nativeBootId("1", "2026-10-20T10:00:00.0000000Z"),
  cycleId = randomUUID();
function executor(initial: PowerJournal | null = null) {
  let journal = initial,
    now = 1000,
    uptime = 1000;
  const check = vi.fn(async () => true),
    shutdown = vi.fn(async () => {}),
    abort = vi.fn(async () => {}),
    save = vi.fn(async (j: PowerJournal) => {
      journal = structuredClone(j);
    });
  const e = new NativePowerExecutor({
    load: async () => journal,
    save,
    bootId,
    now: () => now,
    uptimeMs: () => uptime,
    check,
    shutdown,
    abort,
  });
  return {
    e,
    check,
    shutdown,
    abort,
    save,
    get journal() {
      return journal;
    },
    advance: (ms: number) => {
      now += ms;
      uptime += ms;
    },
    shiftWall: (ms: number) => {
      now += ms;
    },
    uptime: () => uptime,
    now: () => now,
  };
}
const prepare = (expiresAtMs = 6000) => ({
  action: "prepare" as const,
  cycleId,
  machineEpoch: 2,
  token: null,
  expiresAtMs,
});
describe("immutable native startup event identity", () => {
  const start = "2026-10-20T10:00:00.1234567Z";
  it("keeps the same OS identity and lock while the current clock is corrected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-clock-lock-")),
      file = join(dir, "journal");
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-10-20T10:01:03Z"));
    const original = nativeBootId("123", start),
      release = await acquirePowerLock(file, original);
    try {
      clock.mockReturnValue(Date.parse("2026-10-20T10:01:00Z"));
      const corrected = nativeBootId("123", start);
      expect(corrected).toBe(original);
      await expect(acquirePowerLock(file, corrected)).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      clock.mockRestore();
      await release();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("changes identity for a new startup event, including record IDs reused after log reset", () => {
    const original = nativeBootId("123", start);
    expect(nativeBootId("124", start)).not.toBe(original);
    expect(nativeBootId("123", "2026-10-21T10:00:00.1234567Z")).not.toBe(
      original,
    );
  });
  it.each([
    {},
    { bootTime: start },
    { bootRecordId: "123" },
    { bootRecordId: "0", bootTime: start },
    { bootRecordId: "-1", bootTime: start },
    { bootRecordId: "1.5", bootTime: start },
    { bootRecordId: "9223372036854775808", bootTime: start },
    { bootRecordId: "1", bootTime: "invalid" },
    { bootRecordId: "1", bootTime: "2026-02-30T10:00:00.0000000Z" },
    { bootRecordId: "1", bootTime: "2026-10-20T10:00:00.123Z" },
    { bootRecordId: "1", bootTime: "2026-10-20T10:00:00.1234567+00:00" },
  ])(
    "does not invent a boot from missing/invalid immutable evidence %j",
    (raw) => {
      expect(NativeBootRecordSchema.safeParse(raw).success).toBe(false);
      const invalid = raw as { bootRecordId: string; bootTime: string };
      expect(() =>
        nativeBootId(invalid.bootRecordId, invalid.bootTime),
      ).toThrow();
    },
  );
});
describe("native normal power safety", () => {
  it("does not extend a prepared token when the wall clock moves backwards", async () => {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    f.advance(5001);
    f.shiftWall(-100000);
    expect(
      (
        await f.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 999999,
        })
      )?.event,
    ).toBe("rejected");
    expect(f.shutdown).not.toHaveBeenCalled();
  });
  it("keeps the offer's original remaining time when the clock rolls back during its check", async () => {
    const f = executor();
    f.check.mockImplementation(async () => {
      f.advance(5001);
      f.shiftWall(-100000);
      return true;
    });
    expect((await f.e.directive(prepare()))?.event).toBe("rejected");
    expect(f.journal).toBeNull();
  });
  it("keeps a stricter commit remaining time despite a rollback during its check", async () => {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    f.check.mockImplementationOnce(async () => {
      f.advance(2000);
      f.shiftWall(-100000);
      return true;
    });
    expect(
      (
        await f.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 2500,
        })
      )?.event,
    ).toBe("rejected");
    expect(f.shutdown).not.toHaveBeenCalled();
  });
  it("still enforces the absolute controller deadline when the clock advances", async () => {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    f.check.mockImplementationOnce(async () => {
      f.shiftWall(10000);
      return true;
    });
    expect(
      (
        await f.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 6000,
        })
      )?.event,
    ).toBe("rejected");
    expect(f.shutdown).not.toHaveBeenCalled();
  });
  it("does not extend the accepted local upper bound by rolling the clock backwards", async () => {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: 6000,
    });
    f.advance(90001);
    f.shiftWall(-1000000);
    await f.e.watchdog({ safe: true, startedAtMonotonicMs: f.uptime() });
    expect(f.abort).toHaveBeenCalledOnce();
  });
  it("starts token lifetime after the first check, keeping offer and token windows separate", async () => {
    const f = executor();
    await f.e.initialize();
    f.check
      .mockImplementationOnce(async () => {
        f.advance(3000);
        return true;
      })
      .mockImplementationOnce(async () => {
        f.advance(2000);
        return true;
      });
    const prepared = await f.e.directive(prepare());
    expect(prepared?.event).toBe("prepared");
    expect(f.journal?.expiresAtUptimeMs).toBe(9000);
    const result = await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: 9000,
    });
    expect(result?.event).toBe("accepted");
    expect(f.now()).toBe(6000);
    expect(f.shutdown).toHaveBeenCalledWith({
      notAfterUptimeMs: 9000,
      controllerNotAfterMs: 9000,
      cycleId,
    });
  });
  it("cannot extend a prepared token by returning a later controller commit expiry", async () => {
    const f = executor();
    const prepared = await f.e.directive(prepare());
    f.advance(5001);
    expect(
      (
        await f.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 999999,
        })
      )?.event,
    ).toBe("rejected");
    expect(f.shutdown).not.toHaveBeenCalled();
  });
  it("rechecks an earlier controller deadline after commit's local check", async () => {
    const f = executor();
    const prepared = await f.e.directive(prepare());
    f.check.mockImplementationOnce(async () => {
      f.advance(2000);
      return true;
    });
    expect(
      (
        await f.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 2500,
        })
      )?.event,
    ).toBe("rejected");
    expect(f.shutdown).not.toHaveBeenCalled();
  });
  it("passes the stricter controller deadline to the final OS guard", async () => {
    const f = executor();
    const prepared = await f.e.directive(prepare());
    expect(
      (
        await f.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 2500,
        })
      )?.event,
    ).toBe("accepted");
    expect(f.shutdown).toHaveBeenCalledWith({
      notAfterUptimeMs: 2500,
      controllerNotAfterMs: 2500,
      cycleId,
    });
  });
  it("checks twice, journals before OS acceptance, never replays the token", async () => {
    const f = executor();
    await f.e.initialize();
    const r = await f.e.directive(prepare());
    expect(r?.event).toBe("prepared");
    const d = {
      action: "commit" as const,
      cycleId,
      machineEpoch: 2,
      token: r!.token!,
      expiresAtMs: 6000,
    };
    expect((await f.e.directive(d))?.event).toBe("accepted");
    expect(f.check).toHaveBeenCalledTimes(2);
    expect(f.save.mock.invocationCallOrder[1]).toBeLessThan(
      f.shutdown.mock.invocationCallOrder[0]!,
    );
    expect((await f.e.directive(d))?.event).toBe("rejected");
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });
  it.each(["login", "expiry", "epoch"])(
    "blocks a %s race between prepared and commit",
    async (kind) => {
      const f = executor();
      await f.e.initialize();
      const r = await f.e.directive(prepare());
      if (kind === "login") f.check.mockResolvedValue(false);
      if (kind === "expiry") f.advance(5001);
      const d = {
        action: "commit" as const,
        cycleId,
        machineEpoch: kind === "epoch" ? 3 : 2,
        token: r!.token!,
        expiresAtMs: 6000,
      };
      expect((await f.e.directive(d))?.event).toBe("rejected");
      expect(f.shutdown).not.toHaveBeenCalled();
    },
  );
  it("rejects preparation if a slow check consumes its five-second window", async () => {
    const f = executor();
    f.check.mockImplementation(async () => {
      f.advance(5001);
      return true;
    });
    expect((await f.e.directive(prepare()))?.event).toBe("rejected");
    expect(f.journal).toBeNull();
  });
  it("invalidates a recovered prepared token even on the same OS boot", async () => {
    const original = executor();
    const prepared = await original.e.directive(prepare());
    const recovered = executor(original.journal);
    await recovered.e.initialize();
    expect(recovered.journal).toMatchObject({
      state: "cancelled",
      token: null,
      bootId,
    });
    expect(
      (
        await recovered.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 6000,
        })
      )?.event,
    ).toBe("rejected");
    expect(recovered.shutdown).not.toHaveBeenCalled();
  });
  it("aborts on post-acceptance login and recovered unknown execution", async () => {
    const f = executor();
    const r = await f.e.directive(prepare());
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: r!.token!,
      expiresAtMs: 6000,
    });
    await f.e.watchdog({ safe: false, startedAtMonotonicMs: f.now() });
    expect(f.abort).toHaveBeenCalledOnce();
    const recovered = executor({ ...f.journal!, state: "executing" });
    await recovered.e.initialize();
    expect(recovered.shutdown).not.toHaveBeenCalled();
    expect(recovered.abort).toHaveBeenCalledOnce();
  });
  it("a new OS boot invalidates journal without aborting someone else's shutdown", async () => {
    const f = executor({
      bootEvidence: "system-event-v1",
      bootId: randomUUID(),
      cycleId,
      token: null,
      state: "accepted",
      machineEpoch: 2,
      expiresAtUptimeMs: 99999,
    });
    await f.e.initialize();
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.journal?.state).toBe("cancelled");
  });
  it("does not treat a legacy clock-derived journal as proof of a new boot", async () => {
    const legacy = {
      bootId: randomUUID(),
      cycleId,
      token: null,
      state: "accepted",
      machineEpoch: 2,
      expiresAtUptimeMs: 99999,
    } as PowerJournal;
    const f = executor(legacy);
    await expect(f.e.initialize()).rejects.toThrow(
      "native_boot_evidence_legacy",
    );
    expect(f.save).not.toHaveBeenCalled();
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.shutdown).not.toHaveBeenCalled();
    expect(f.journal).toEqual(legacy);
  });
  it("same OS boot lock prevents another executor; a new OS boot acquires its own lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-lock-")),
      file = join(dir, "journal.json");
    try {
      const release = await acquirePowerLock(file, bootId);
      await expect(acquirePowerLock(file, bootId)).rejects.toMatchObject({
        code: "EEXIST",
      });
      const releaseNew = await acquirePowerLock(
        file,
        nativeBootId("2", "2026-10-21T10:00:00.0000000Z"),
      );
      await releaseNew();
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
const sha = "a".repeat(64),
  thumb = "b".repeat(40);
const guard = WorkloadGuardSchema.parse({
  version: 1,
  acknowledgement:
    "Only reviewed Windows system services run; all other work is stopped",
  systemExecutables: [{ name: "svchost.exe", sha256: sha }],
  systemServices: ["SystemService"],
  reviewedServices: [
    {
      serviceName: "CoolingService",
      path: "C:\\Program Files\\Vendor\\Cooling.exe",
      sha256: sha,
      signerThumbprint: thumb,
    },
  ],
  agentTask: {
    path: "\\HitchletPower",
    executable: "C:\\Node\\node.exe",
    arguments: "C:\\Hitchlet\\host-power-main.js run C:\\Hitchlet\\power.json",
  },
});
const inventory = () => ({
  bootRecordId: "1",
  bootTime: "2026-10-20T10:00:00.0000000Z",
  complete: true,
  wslRunning: false,
  runningTasks: [],
  services: [
    { name: "CoolingService", pid: 50 },
    { name: "SystemService", pid: 60 },
  ],
  processes: [
    {
      pid: 50,
      parentPid: 4,
      name: "Cooling.exe",
      path: "C:\\Program Files\\Vendor\\Cooling.exe",
      sha256: sha,
      microsoftSigned: false,
      signerThumbprint: thumb,
    },
    {
      pid: 60,
      parentPid: 4,
      name: "svchost.exe",
      path: "C:\\Windows\\System32\\svchost.exe",
      sha256: sha,
      microsoftSigned: true,
      signerThumbprint: thumb,
    },
  ],
});
describe("bounded local workload guard", () => {
  it("exempts exactly the two owned live watch identities, including a launcher outside the system volume", () => {
    const owned: NativeOwnedWatchProcess[] = [
      {
        pid: 1111,
        parentPid: 100,
        path: "E:\\Trusted\\node.exe",
        creationTicks: "638000000000000001",
      },
      {
        pid: 2222,
        parentPid: 1111,
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        creationTicks: "638000000000000002",
      },
    ];
    const i = inventory();
    i.processes.push(
      ...owned.map((p) => ({
        pid: p.pid,
        parentPid: p.parentPid,
        path: p.path,
        name: p.pid === 1111 ? "node.exe" : "powershell.exe",
        creationTicks: "638000000000000000",
        sha256: "",
        microsoftSigned: false,
        signerThumbprint: "",
      })),
    );
    expect(workloadReasons(guard, i, 100, 101, owned)).toEqual([]);
    const missing = structuredClone(i);
    missing.processes.pop();
    expect(workloadReasons(guard, missing, 100, 101, owned)).toContain(
      "owned_watch_identity_unproven",
    );
    for (const field of ["parent", "creation", "path"] as const) {
      const changed = structuredClone(i);
      const target = changed.processes.at(-1)!;
      if (field === "parent") target.parentPid = 9999;
      if (field === "creation")
        Object.assign(target, { creationTicks: "638000000000000010" });
      if (field === "path") target.path = "C:\\Other\\powershell.exe";
      expect(workloadReasons(guard, changed, 100, 101, owned)).toContain(
        "unapproved_native_process",
      );
    }
    i.processes.push({
      pid: 3333,
      parentPid: 2222,
      path: "E:\\Trusted\\node.exe",
      name: "node.exe",
      sha256: "",
      microsoftSigned: false,
      signerThumbprint: "",
    });
    expect(workloadReasons(guard, i, 100, 101, owned)).toContain(
      "unapproved_native_process",
    );
  });
  it("never infers an empty executable path from an otherwise approved name/hash/signature", () => {
    const i = inventory();
    i.complete = false;
    i.processes[1]!.path = "";
    expect(workloadReasons(guard, i, 100, 101)).toEqual(
      expect.arrayContaining([
        "workload_inventory_incomplete",
        "unapproved_native_process",
      ]),
    );
  });
  it("accepts service names with spaces while preserving exact service/PID approval", () => {
    const reviewed = WorkloadGuardSchema.parse({
      ...guard,
      systemServices: ["System Service"],
      reviewedServices: [
        { ...guard.reviewedServices[0]!, serviceName: "Cooling Service" },
      ],
    });
    const i = inventory();
    i.services[0]!.name = "Cooling Service";
    i.services[1]!.name = "System Service";
    expect(workloadReasons(reviewed, i, 100, 101)).toEqual([]);
    i.services[0]!.name = "Cooling  Service";
    expect(workloadReasons(reviewed, i, 100, 101)).toEqual(
      expect.arrayContaining([
        "unapproved_native_process",
        "unapproved_running_service",
      ]),
    );
  });
  it.each(["Service (v2)", "系统 服务", "A".repeat(256)])(
    "treats a bounded service name as comparison data: %s",
    (name) => {
      expect(
        WorkloadGuardSchema.safeParse({
          ...guard,
          systemServices: [name],
          reviewedServices: [
            { ...guard.reviewedServices[0]!, serviceName: name },
          ],
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    "",
    "   ",
    "Service/Name",
    "Service\\Name",
    "Service\nName",
    "Service\0Name",
    "A".repeat(257),
  ])("rejects blank, path/control, or overlong service names: %j", (name) => {
    expect(
      WorkloadGuardSchema.safeParse({ ...guard, systemServices: [name] })
        .success,
    ).toBe(false);
    expect(
      WorkloadGuardSchema.safeParse({
        ...guard,
        reviewedServices: [
          { ...guard.reviewedServices[0]!, serviceName: name },
        ],
      }).success,
    ).toBe(false);
  });
  it("allows an individually reviewed cooling service without arbitrary binary approval", () => {
    expect(workloadReasons(guard, inventory(), 100, 101)).toEqual([]);
    const i = inventory();
    i.processes[0]!.pid = 51;
    i.processes[0]!.parentPid = 4;
    expect(workloadReasons(guard, i, 100, 101)).toContain(
      "unapproved_native_process",
    );
  });
  it("blocks unknown work, WSL and any other running scheduled task", () => {
    const i = {
      ...inventory(),
      wslRunning: true,
      runningTasks: [
        {
          path: "\\Other",
          executable: "C:\\Node\\node.exe",
          arguments: "work.js",
        },
      ],
    };
    expect(workloadReasons(guard, i, 100, 101)).toEqual(
      expect.arrayContaining([
        "running_wsl_workload",
        "running_scheduled_task",
      ]),
    );
    expect(
      workloadReasons(guard, { ...inventory(), complete: false }, 100, 101),
    ).toContain("workload_inventory_incomplete");
  });
  it("allows exactly its own installed scheduled action and rejects argument changes", () => {
    expect(
      workloadReasons(
        guard,
        { ...inventory(), runningTasks: [guard.agentTask] },
        100,
        101,
      ),
    ).toEqual([]);
    expect(
      workloadReasons(
        guard,
        {
          ...inventory(),
          runningTasks: [{ ...guard.agentTask, arguments: "other.js" }],
        },
        100,
        101,
      ),
    ).toContain("running_scheduled_task");
  });
  it("never accepts an interpreter masquerading as a reviewed service", () => {
    const i = inventory();
    i.processes[0]!.name = "powershell.exe";
    expect(workloadReasons(guard, i, 100, 101)).toContain(
      "unapproved_native_process",
    );
  });
});

describe("independent shutdown watchdog lease", () => {
  it("keeps a five-second lease through repeated 2.7-second observation rounds without a second collection", async () => {
    const { ChildProcess } = await import("node:child_process"),
      { PassThrough } = await import("node:stream"),
      { NativeShutdownWatchdog } = await import(
        "../src/host-power-watchdog.js"
      );
    const f = executor();
    f.check.mockImplementation(async () => {
      f.advance(2700);
      return true;
    });
    const prepared = await f.e.directive(prepare());
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: f.journal!.expiresAtUptimeMs,
    });
    expect(f.journal?.state).toBe("accepted");
    const dir = await mkdtemp(join(tmpdir(), "power-steady-lease-")),
      child = watchChild(),
      stdout = new PassThrough();
    Object.defineProperty(child, "stdout", { value: stdout });
    const watchdog = new NativeShutdownWatchdog(
      join(dir, "lease"),
      () => {
        setTimeout(() => stdout.write(watchReady(child)), 1);
        return child;
      },
      f.uptime,
    );
    try {
      await watchdog.arm(cycleId);
      for (let round = 0; round < 8; round++) {
        const startedAtMonotonicMs = f.now();
        f.advance(2700);
        await f.e.watchdog({ safe: true, startedAtMonotonicMs });
        await watchdog.refresh();
        f.advance(1000);
      }
      expect(f.check).toHaveBeenCalledTimes(2);
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.journal?.state).toBe("accepted");
      child.exitCode = 0;
      await watchdog.disarm("638000000000000000", async () => {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("uses the independently collected commit sample after acceptance instead of an older observation", async () => {
    const f = executor(),
      oldObservation = { safe: true, startedAtMonotonicMs: f.now() };
    f.check.mockImplementation(async () => {
      f.advance(2700);
      return true;
    });
    const prepared = await f.e.directive(prepare()),
      commitStarted = f.now();
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: f.journal!.expiresAtUptimeMs,
    });
    expect(isFreshNativeSafetySample(oldObservation, f.now())).toBe(false);
    await f.e.watchdog({ safe: true, startedAtMonotonicMs: commitStarted });
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.check).toHaveBeenCalledTimes(2);
  });
  it.each(["stale", "unsafe", "missing", "invalid", "future"])(
    "aborts accepted power on %s sample without collecting again",
    async (kind) => {
      const f = executor(),
        prepared = await f.e.directive(prepare());
      await f.e.directive({
        action: "commit",
        cycleId,
        machineEpoch: 2,
        token: prepared!.token!,
        expiresAtMs: 6000,
      });
      const startedAtMonotonicMs =
        kind === "stale"
          ? f.now() - 5000
          : kind === "future"
            ? f.now() + 1
            : kind === "invalid"
              ? NaN
              : f.now();
      await f.e.watchdog(
        kind === "missing"
          ? null
          : { safe: kind !== "unsafe", startedAtMonotonicMs },
      );
      expect(f.abort).toHaveBeenCalledOnce();
      expect(f.check).toHaveBeenCalledTimes(2);
      expect(f.journal?.state).toBe("cancelled");
    },
  );
  it("retains unknown cancellation responsibility when a stale sample cannot abort the OS request", async () => {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: 6000,
    });
    f.abort.mockRejectedValue(new Error("unavailable"));
    await expect(f.e.watchdog(null)).rejects.toThrow(
      "native_shutdown_cancellation_unknown",
    );
    expect(f.journal).toMatchObject({ state: "unknown", token: null });
  });
  it("does not renew an expired lease even before the helper reports failure", async () => {
    const { ChildProcess } = await import("node:child_process"),
      { PassThrough } = await import("node:stream"),
      { readFile } = await import("node:fs/promises"),
      { NativeShutdownWatchdog } = await import(
        "../src/host-power-watchdog.js"
      );
    const dir = await mkdtemp(join(tmpdir(), "power-lease-")),
      child = watchChild(),
      stdout = new PassThrough();
    Object.defineProperty(child, "stdout", { value: stdout });
    let uptime = 1000;
    try {
      const watchdog = new NativeShutdownWatchdog(
        join(dir, "lease"),
        () => {
          setTimeout(() => stdout.write(watchReady(child)), 1);
          return child;
        },
        () => uptime,
      );
      await watchdog.arm(cycleId);
      const before = await readFile(watchdog.leaseFile, "utf8");
      uptime = 6001;
      await expect(watchdog.refresh()).rejects.toThrow(
        "native_watchdog_lease_failed",
      );
      uptime = 1001;
      await expect(watchdog.refresh()).rejects.toThrow(
        "native_watchdog_lease_failed",
      );
      expect(await readFile(watchdog.leaseFile, "utf8")).toBe(before);
      child.exitCode = 0;
      await watchdog.disarm("638000000000000000", async () => {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("bounds the initial lease by the original permit and cannot extend it after a wall-clock rollback", async () => {
    const { ChildProcess } = await import("node:child_process"),
      { PassThrough } = await import("node:stream"),
      { NativeShutdownWatchdog } = await import(
        "../src/host-power-watchdog.js"
      );
    const dir = await mkdtemp(join(tmpdir(), "power-rollback-lease-")),
      child = watchChild(),
      stdout = new PassThrough();
    Object.defineProperty(child, "stdout", { value: stdout });
    let uptime = 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000000);
    const watchdog = new NativeShutdownWatchdog(
      join(dir, "lease"),
      () => {
        setTimeout(() => stdout.write(watchReady(child)), 1);
        return child;
      },
      () => uptime,
    );
    try {
      await watchdog.arm(cycleId, 1600);
      const before = await readFile(watchdog.leaseFile, "utf8");
      expect(JSON.parse(before)).toMatchObject({ expiresAtUptimeMs: 1600 });
      clock.mockReturnValue(1);
      uptime = 1600;
      await expect(watchdog.refresh()).rejects.toThrow(
        "native_watchdog_lease_failed",
      );
      expect(await readFile(watchdog.leaseFile, "utf8")).toBe(before);
      child.exitCode = 0;
      await watchdog.disarm("638000000000000000", async () => {});
    } finally {
      clock.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("arms before side effects and fails closed on helper loss/abort, with no lease refresh after failure", async () => {
    const { ChildProcess } = await import("node:child_process"),
      { PassThrough } = await import("node:stream"),
      { readFile } = await import("node:fs/promises"),
      { NativeShutdownWatchdog } = await import(
        "../src/host-power-watchdog.js"
      );
    const dir = await mkdtemp(join(tmpdir(), "power-watchdog-")),
      file = join(dir, "lease.json"),
      child = watchChild(),
      stdout = new PassThrough();
    Object.defineProperty(child, "stdout", { value: stdout });
    Object.defineProperty(child, "pid", { value: 1234 });
    try {
      const watchdog = new NativeShutdownWatchdog(
        file,
        () => {
          setTimeout(() => stdout.write(watchReady(child)), 1);
          return child;
        },
        () => 1000,
      );
      await watchdog.arm(cycleId);
      expect(
        JSON.parse(await readFile(watchdog.leaseFile, "utf8")),
      ).toMatchObject({
        state: "armed",
        cycleId,
      });
      expect(watchdog.pid).toBe(2222);
      stdout.write(JSON.stringify({ event: "aborting" }) + "\n");
      await expect(watchdog.refresh()).rejects.toThrow(
        "native_watchdog_lease_failed",
      );
      setTimeout(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }, 20);
      await watchdog.disarm("638000000000000000", async () => {});
      expect(
        JSON.parse(await readFile(watchdog.leaseFile, "utf8")),
      ).toMatchObject({
        state: "settled_cancelled",
        cycleId,
        executorPid: process.pid,
        executorStartedTicks: "638000000000000000",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("native startup/cleanup lifecycle", () => {
  it("keeps its lock while initial networking is unavailable, then initializes without executing power", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-startup-")),
      file = join(dir, "journal"),
      unlock = await acquirePowerLock(file, bootId),
      release = vi.fn(unlock),
      f = executor(),
      cleanup = vi.spyOn(f.e, "abort");
    const initialize = vi
        .fn()
        .mockRejectedValueOnce(
          hostConnectionFailure(
            Object.assign(new Error(), { code: "ECONNREFUSED" }),
          ),
        )
        .mockResolvedValue(undefined),
      run = vi.fn(async () => {}),
      wait = vi.fn(async () => {
        await expect(acquirePowerLock(file, bootId)).rejects.toMatchObject({
          code: "EEXIST",
        });
      });
    try {
      await runNativePowerLifecycle({
        executor: f.e,
        observation: { initialize },
        releaseLock: release,
        stopped: () => false,
        wait,
        onTransient: () => {},
        run,
      });
      expect(initialize).toHaveBeenCalledTimes(2);
      expect(wait).toHaveBeenCalledExactlyOnceWith(5000);
      expect(run).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
        release.mock.invocationCallOrder[0]!,
      );
      expect(f.shutdown).not.toHaveBeenCalled();
      const releaseNew = await acquirePowerLock(file, bootId);
      await releaseNew();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([401, 403])(
    "does not loop on permanent Host HTTP %i; aborts safely before releasing",
    async (status) => {
      const f = executor(),
        release = vi.fn(async () => {}),
        initialize = vi.fn(async () => {
          throw new HostRequestError(status);
        }),
        wait = vi.fn(async () => {}),
        run = vi.fn(async () => {});
      await expect(
        runNativePowerLifecycle({
          executor: f.e,
          observation: { initialize },
          releaseLock: release,
          stopped: () => false,
          wait,
          onTransient: () => {},
          run,
        }),
      ).rejects.toMatchObject({ status });
      expect(initialize).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(f.shutdown).not.toHaveBeenCalled();
    },
  );
  it("retains the real lock and unknown journal if final OS cancellation cannot be confirmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-unknown-cleanup-")),
      file = join(dir, "journal"),
      unlock = await acquirePowerLock(file, bootId),
      release = vi.fn(unlock),
      f = executor();
    try {
      await expect(
        runNativePowerLifecycle({
          executor: f.e,
          observation: { initialize: async () => {} },
          releaseLock: release,
          stopped: () => false,
          wait: async () => {},
          onTransient: () => {},
          run: async () => {
            const prepared = await f.e.directive(prepare());
            await f.e.directive({
              action: "commit",
              cycleId,
              machineEpoch: 2,
              token: prepared!.token!,
              expiresAtMs: 6000,
            });
            f.abort.mockRejectedValue(new Error("OS abort unavailable"));
          },
        }),
      ).rejects.toThrow("native_shutdown_cancellation_unknown");
      expect(f.journal?.state).toBe("unknown");
      expect(release).not.toHaveBeenCalled();
      await expect(acquirePowerLock(file, bootId)).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      await unlock();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not certify safe release when journal initialization failed", async () => {
    const release = vi.fn(async () => {}),
      abort = vi.fn(async () => {}),
      initializeObservation = vi.fn(async () => {});
    await expect(
      runNativePowerLifecycle({
        executor: {
          initialize: async () => {
            throw new Error("invalid journal");
          },
          abort,
        },
        observation: { initialize: initializeObservation },
        releaseLock: release,
        stopped: () => false,
        wait: async () => {},
        onTransient: () => {},
        run: async () => {},
      }),
    ).rejects.toThrow("invalid journal");
    expect(abort).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(initializeObservation).not.toHaveBeenCalled();
  });
  it("stops while waiting for the network and releases only after safe cleanup", async () => {
    let stopped = false;
    const f = executor(),
      release = vi.fn(async () => {}),
      run = vi.fn(async () => {});
    await runNativePowerLifecycle({
      executor: f.e,
      observation: {
        initialize: async () => {
          throw new HostTransientError();
        },
      },
      releaseLock: release,
      stopped: () => stopped,
      wait: async () => {
        stopped = true;
      },
      onTransient: () => {},
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(f.shutdown).not.toHaveBeenCalled();
  });
  it.each([
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ENOTFOUND",
    "UNKNOWN_FAILURE",
  ])(
    "does not classify permanent/unknown transport %s as temporary availability",
    (code) => {
      expect(
        isTransientHostFailure(
          hostConnectionFailure(Object.assign(new Error(), { code })),
        ),
      ).toBe(false);
    },
  );
  it("does not loop on permanent TLS/configuration bootstrap failure", async () => {
    const error = hostConnectionFailure(
        Object.assign(new Error(), { code: "CERT_HAS_EXPIRED" }),
      ),
      f = executor(),
      release = vi.fn(async () => {}),
      wait = vi.fn(async () => {});
    await expect(
      runNativePowerLifecycle({
        executor: f.e,
        observation: {
          initialize: async () => {
            throw error;
          },
        },
        releaseLock: release,
        stopped: () => false,
        wait,
        onTransient: () => {},
        run: async () => {},
      }),
    ).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("native sampling failure recovery and bounded diagnostics", () => {
  it.each([
    [73, "shutdown_permit_expired_or_parent_lost"],
    [74, "shutdown_watchdog_lease_invalid"],
    [75, "shutdown_privilege_unavailable"],
    [76, "shutdown_os_rejected"],
  ] as const)(
    "preserves fixed shutdown helper exit %i without making it retryable",
    (status, code) => {
      const failure = nativePowerCommandFailure("shutdown", { code: status });
      expect(nativePowerDiagnostic("power", failure)).toEqual({
        phase: "shutdown",
        code,
      });
      expect(isTransientNativeSamplingFailure(failure)).toBe(false);
      expect(
        nativePowerDiagnostic(
          "observation",
          nativePowerCommandFailure("inventory", { code: status }),
        ),
      ).toEqual({ phase: "inventory", code: "native_command_failed" });
    },
  );
  it("keeps the original failed shutdown stage separate from a later abort failure, with bounded fields only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-attempt-record-")),
      journal = join(dir, "journal");
    const checkpoint = {
      phase: "watch_arm" as const,
      elapsedMs: 600,
      remainingUptimeMs: 1700,
      controllerRemainingMs: 1800,
    };
    const attempt: NativeShutdownAttemptFailure = {
      at: new Date().toISOString(),
      cycleId,
      phase: "native_shutdown",
      code: "shutdown_watchdog_lease_invalid",
      elapsedMs: 2500,
      remainingUptimeMs: -200,
      controllerRemainingMs: -100,
      checkpoints: [checkpoint],
    };
    try {
      await saveNativeShutdownAttemptFailure(
        journal,
        Object.assign({}, attempt, {
          rawError: "secret argv",
          stderr: "secret stderr",
          checkpoints: Array.from({ length: 20 }, () =>
            Object.assign({}, checkpoint, { path: "secret path" }),
          ),
        }),
      );
      await saveNativePowerFailure(journal, {
        phase: "abort",
        code: "abort_unconfirmed",
      });
      const text = await readFile(`${journal}.shutdown-attempt.json`, "utf8"),
        saved = JSON.parse(text) as NativeShutdownAttemptFailure;
      expect(saved).toEqual({
        ...attempt,
        checkpoints: [checkpoint, checkpoint, checkpoint],
      });
      expect(text).not.toContain("secret");
      expect(text.length).toBeLessThan(1500);
      expect(
        JSON.parse(await readFile(`${journal}.failure.json`, "utf8")),
      ).toMatchObject({ phase: "abort", code: "abort_unconfirmed" });
      expect((await readdir(dir)).sort()).toEqual([
        "journal.failure.json",
        "journal.shutdown-attempt.json",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([
    [{ code: 70 }, true, "inventory_unavailable"],
    [
      { code: null, killed: true, signal: "SIGTERM" },
      true,
      "inventory_timeout",
    ],
    [{ code: 1 }, false, "native_command_failed"],
    [{ code: 71 }, false, "inventory_permission_denied"],
    [{ code: 72 }, false, "inventory_cache_failed"],
    [{ code: "ENOENT" }, false, "native_executable_missing"],
    [{ code: "EACCES" }, false, "native_execution_denied"],
    [
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true,
        signal: "SIGTERM",
      },
      false,
      "native_output_limit",
    ],
  ])(
    "classifies inventory callback %j without making ordinary PowerShell failures retryable",
    (raw, retry, code) => {
      const error = nativePowerCommandFailure("inventory", raw);
      expect(isTransientNativeSamplingFailure(error)).toBe(retry);
      expect(nativePowerDiagnostic("observation", error)).toEqual({
        phase: "inventory",
        code,
      });
    },
  );
  it("does not treat another native action's reserved exit or timeout as a sampling retry", () => {
    for (const action of [
      "permissions",
      "boot",
      "shutdown",
      "abort",
    ] as const) {
      for (const raw of [
        { code: 70 },
        { code: null, killed: true, signal: "SIGTERM" },
      ])
        expect(
          isTransientNativeSamplingFailure(
            nativePowerCommandFailure(action, raw),
          ),
        ).toBe(false);
    }
  });
  it("cancels an accepted OS permit before allowing a new observation after sampling recovers", async () => {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: 6000,
    });
    const failure = nativePowerCommandFailure("inventory", { code: 70 });
    await cancelBeforeNativePowerRetry(failure, () => f.e.abort());
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.journal).toMatchObject({ state: "cancelled", token: null });
    expect(
      (
        await f.e.directive({
          action: "commit",
          cycleId,
          machineEpoch: 2,
          token: prepared!.token!,
          expiresAtMs: 6000,
        })
      )?.event,
    ).toBe("rejected");
    // A later healthy sample cannot replace an unacknowledged cancellation fact with a new permit.
    expect(
      (await f.e.directive({ ...prepare(), cycleId: randomUUID() }))?.event,
    ).toBe("rejected");
    await f.e.acknowledgeCancellation(cycleId, {
      action: "none",
      cycleId: null,
      machineEpoch: null,
      token: null,
      expiresAtMs: null,
    });
    expect(
      (await f.e.directive({ ...prepare(), cycleId: randomUUID() }))?.event,
    ).toBe("prepared");
    expect(f.shutdown).toHaveBeenCalledOnce();
  });
  it("does not continue a retry when local OS cancellation is unknown", async () => {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: 6000,
    });
    f.abort.mockRejectedValue(new Error("private OS details"));
    await expect(
      cancelBeforeNativePowerRetry(
        nativePowerCommandFailure("inventory", { code: 70 }),
        () => f.e.abort(),
      ),
    ).rejects.toThrow("native_shutdown_cancellation_unknown");
    expect(f.journal).toMatchObject({ state: "unknown", token: null });
  });
  it.each([
    new HostRequestError(401),
    hostConnectionFailure(
      Object.assign(new Error(), { code: "CERT_HAS_EXPIRED" }),
    ),
    new SyntaxError("secret JSON"),
    nativePowerCommandFailure("inventory", { code: 1 }),
  ])("still cancels before propagating permanent failure %s", async (error) => {
    const abort = vi.fn(async () => {});
    await expect(cancelBeforeNativePowerRetry(error, abort)).rejects.toBe(
      error,
    );
    expect(abort).toHaveBeenCalledOnce();
  });
  it("never includes raw Error details/argv/stdout in its fixed diagnostic", () => {
    const secret = "fixture-private-credential/path/argument";
    const failures = [
      nativePowerCommandFailure(
        "inventory",
        Object.assign(new Error(secret), {
          code: 1,
          cmd: secret,
          stdout: secret,
          stderr: secret,
        }),
      ),
      Object.assign(new Error(secret), { code: secret }),
      new SyntaxError(secret),
      new HostRequestError(401),
      new Error("native_shutdown_cancellation_unknown"),
    ];
    expect(
      failures.map((e) => nativePowerDiagnostic("observation", e)),
    ).toEqual([
      { phase: "inventory", code: "native_command_failed" },
      { phase: "observation", code: "unexpected_failure" },
      { phase: "observation", code: "json_invalid" },
      { phase: "observation", code: "host_auth_rejected" },
      { phase: "abort", code: "abort_unconfirmed" },
    ]);
    for (const error of failures)
      expect(
        JSON.stringify(nativePowerDiagnostic("observation", error)),
      ).not.toContain(secret);
  });
  it("atomically keeps only the latest fixed failure record beside the protected journal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "power-failure-record-")),
      journal = join(dir, "journal");
    try {
      await saveNativePowerFailure(journal, {
        phase: "bootstrap",
        code: "host_auth_rejected",
      });
      await saveNativePowerFailure(journal, {
        phase: "inventory",
        code: "native_command_failed",
      });
      const record = JSON.parse(
        await readFile(`${journal}.failure.json`, "utf8"),
      ) as Record<string, unknown>;
      expect(record).toEqual({
        at: expect.any(String),
        phase: "inventory",
        code: "native_command_failed",
      });
      expect(Number.isFinite(Date.parse(String(record.at)))).toBe(true);
      expect(await readdir(dir)).toEqual(["journal.failure.json"]);
      expect((await readFile(`${journal}.failure.json`)).length).toBeLessThan(
        256,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("settled native shutdown cancellation", () => {
  const parentTicks = "638000000000000000";
  async function fixture() {
    const { PassThrough } = await import("node:stream"),
      { NativeShutdownWatchdog } = await import(
        "../src/host-power-watchdog.js"
      );
    const dir = await mkdtemp(join(tmpdir(), "power-settled-cancel-")),
      child = watchChild(),
      stdout = new PassThrough();
    Object.defineProperty(child, "stdout", { value: stdout });
    const w = new NativeShutdownWatchdog(
      join(dir, "lease"),
      () => {
        setTimeout(() => stdout.write(watchReady(child)), 1);
        return child;
      },
      () => 1000,
    );
    await w.arm(cycleId);
    const lease = async () =>
      JSON.parse(await readFile(w.leaseFile, "utf8")) as { state: string };
    const exit = () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    };
    return {
      w,
      child,
      stdout,
      lease,
      exit,
      clean: () => rm(dir, { recursive: true, force: true }),
    };
  }
  it("recovers an accepted cycle after communication loss with closed submission and confirmed Abort", async () => {
    const f = executor(),
      w = await fixture(),
      submission = watchChild(),
      abort = vi.fn(async () => {});
    try {
      f.shutdown.mockImplementation(async () => {
        w.w.beginSubmission(cycleId)(submission);
        submission.emit("close", 0, null);
      });
      f.abort.mockImplementation(() => w.w.disarm(parentTicks, abort));
      const prepared = await f.e.directive(prepare());
      await f.e.directive({
        action: "commit",
        cycleId,
        machineEpoch: 2,
        token: prepared!.token!,
        expiresAtMs: 6000,
      });
      expect(f.journal?.state).toBe("accepted");
      w.stdout.write('{"event":"aborting"}\n');
      await expect(w.w.refresh()).rejects.toThrow(
        "native_watchdog_lease_failed",
      );
      const cancelled = f.e.abort();
      await vi.waitFor(async () =>
        expect(await w.lease()).toMatchObject({
          state: "settled_cancelled",
          cycleId,
          executorPid: process.pid,
          executorStartedTicks: parentTicks,
        }),
      );
      expect(abort).toHaveBeenCalledOnce();
      w.exit();
      await cancelled;
      await expect(w.w.arm(cycleId)).rejects.toThrow(
        "native_watchdog_already_armed",
      );
      expect(f.journal).toMatchObject({ state: "cancelled", token: null });
      // A healthy controller can resume observation; no old armed lease or token is renewed.
      await w.w.refresh();
      expect((await w.lease()).state).toBe("settled_cancelled");
      const replay = await f.e.directive({
        action: "commit",
        cycleId,
        machineEpoch: 2,
        token: prepared!.token!,
        expiresAtMs: 6000,
      });
      expect(replay?.event).toBe("rejected");
      expect(f.shutdown).toHaveBeenCalledOnce();
    } finally {
      await w.clean();
    }
  });
  it.each(["error", "exit", "timeout"])(
    "does not treat %s before close as proof that a submitter cannot run late",
    async (event) => {
      const w = await fixture(),
        submission = watchChild(),
        abort = vi.fn(async () => {});
      try {
        w.w.beginSubmission(cycleId)(submission);
        // These are all insufficient, including a callback invoked early by execFile's error path.
        if (event === "error") {
          submission.once("error", () => {});
          submission.emit("error", new Error("fixture_spawn_or_kill"));
        }
        if (event === "exit") {
          submission.exitCode = 0;
          submission.emit("exit", 0, null);
        }
        if (event === "timeout") {
          Object.defineProperty(submission, "killed", { value: true });
          submission.signalCode = "SIGTERM";
        }
        vi.useFakeTimers();
        const result = expect(w.w.disarm(parentTicks, abort)).rejects.toThrow(
          "native_abort_unconfirmed",
        );
        await vi.advanceTimersByTimeAsync(2000);
        await result;
        expect(abort).toHaveBeenCalledOnce(); // Still attempt cancellation, but retain the 120s helper.
        expect((await w.lease()).state).toBe("armed");
        await expect(w.w.refresh()).rejects.toThrow(
          "native_watchdog_lease_failed",
        );
      } finally {
        vi.useRealTimers();
        await w.clean();
      }
    },
  );
  it("does not mistake a real execFile early error callback for shutdown child close", async () => {
    const { execFile } = await import("node:child_process");
    const w = await fixture(),
      order: string[] = [];
    try {
      let child: WatchChild;
      const callback = new Promise<void>((resolve) => {
        child = execFile(
          process.execPath,
          ["-e", "setTimeout(() => {}, 300)"],
          { timeout: 30 },
          (error) => {
            expect(error).toBeTruthy();
            order.push("callback");
            resolve();
          },
        );
        // Exercise Node's actual kill-exception -> exithandler callback, before process close.
        child.kill = () => {
          throw new Error("fixture_kill_failure");
        };
        child.once("close", () => order.push("close"));
        w.w.beginSubmission(cycleId)(child);
      });
      await callback;
      expect(order).toEqual(["callback"]);
      const abort = vi.fn(async () => {
        order.push("abort");
      });
      const pending = w.w.disarm(parentTicks, abort);
      expect(abort).not.toHaveBeenCalled();
      await vi.waitFor(async () =>
        expect((await w.lease()).state).toBe("settled_cancelled"),
      );
      expect(order).toEqual(["callback", "close", "abort"]);
      w.exit();
      await pending;
    } finally {
      await w.clean();
    }
  });
  it("waits for close before Abort, even if the original callback has already failed", async () => {
    const w = await fixture(),
      submission = watchChild(),
      order: string[] = [];
    try {
      w.w.beginSubmission(cycleId)(submission);
      const abort = vi.fn(async () => {
        order.push("abort");
      });
      const pending = w.w.disarm(parentTicks, abort);
      await Promise.resolve();
      expect(abort).not.toHaveBeenCalled();
      order.push("close");
      submission.emit("close", 1, null);
      await vi.waitFor(async () =>
        expect((await w.lease()).state).toBe("settled_cancelled"),
      );
      expect(order).toEqual(["close", "abort"]);
      expect(() => w.w.beginSubmission(cycleId)).toThrow(
        "native_shutdown_submission_invalid",
      );
      w.exit();
      await pending;
    } finally {
      await w.clean();
    }
  });
  it("does not certify an attempted spawn that failed before returning a ChildProcess", async () => {
    const w = await fixture(),
      abort = vi.fn(async () => {});
    try {
      w.w.beginSubmission(cycleId); // No returned ChildProcess, so no proven close.
      await expect(w.w.disarm(parentTicks, abort)).rejects.toThrow(
        "native_abort_unconfirmed",
      );
      expect(abort).toHaveBeenCalledOnce();
      expect((await w.lease()).state).toBe("armed");
    } finally {
      await w.clean();
    }
  });
  it("retains protection when Abort is unconfirmed despite a closed submitter", async () => {
    const w = await fixture(),
      submission = watchChild();
    try {
      w.w.beginSubmission(cycleId)(submission);
      submission.emit("close", 0, null);
      await expect(
        w.w.disarm(parentTicks, async () => {
          throw new Error("fixture_abort_denied");
        }),
      ).rejects.toThrow("fixture_abort_denied");
      expect((await w.lease()).state).toBe("armed");
    } finally {
      await w.clean();
    }
  });
  it("binds a submission to its armed cycle and permits confirmed cancellation before any OS call", async () => {
    const w = await fixture(),
      abort = vi.fn(async () => {});
    try {
      expect(() => w.w.beginSubmission(randomUUID())).toThrow(
        "native_shutdown_submission_invalid",
      );
      w.stdout.write('{"event":"aborting"}\n');
      const pending = w.w.disarm(parentTicks, abort);
      await vi.waitFor(async () =>
        expect((await w.lease()).state).toBe("settled_cancelled"),
      );
      expect(abort).toHaveBeenCalledOnce();
      w.exit();
      await pending;
    } finally {
      await w.clean();
    }
  });
});

describe("durable same-boot cancellation report", () => {
  const none = {
    action: "none" as const,
    cycleId: null,
    machineEpoch: null,
    token: null,
    expiresAtMs: null,
  };
  async function accepted() {
    const f = executor(),
      prepared = await f.e.directive(prepare());
    await f.e.directive({
      action: "commit",
      cycleId,
      machineEpoch: 2,
      token: prepared!.token!,
      expiresAtMs: 6000,
    });
    return f;
  }
  it("persists confirmed Abort before reporting, retries a lost ACK across process restart, then resumes poll", async () => {
    const f = await accepted();
    await f.e.abort();
    expect(f.journal).toMatchObject({
      state: "cancelled",
      token: null,
      cancelReportPending: true,
    });
    expect(f.e.pendingCancellation()).toEqual({ event: "cancelled", cycleId });
    // Controller committed cancellation but its response was lost. No ACK means no local mutation.
    const restarted = executor(structuredClone(f.journal));
    await restarted.e.initialize();
    expect(restarted.abort).not.toHaveBeenCalled();
    expect(restarted.e.pendingCancellation()).toEqual({
      event: "cancelled",
      cycleId,
    });
    await restarted.e.acknowledgeCancellation(cycleId, none);
    expect(restarted.journal?.cancelReportPending).toBe(false);
    expect(restarted.e.pendingCancellation()).toBeNull();
    const saves = restarted.save.mock.calls.length;
    await restarted.e.abort();
    await restarted.e.abort();
    expect(restarted.save).toHaveBeenCalledTimes(saves);
    expect(restarted.abort).not.toHaveBeenCalled();
    expect(restarted.e.pendingCancellation()).toBeNull();
    // A future cycle is unaffected by the previous cancellation event.
    const nextCycle = randomUUID();
    expect(
      (await restarted.e.directive({ ...prepare(), cycleId: nextCycle }))
        ?.event,
    ).toBe("prepared");
    await restarted.e.acknowledgeCancellation(cycleId, none);
    expect(restarted.journal).toMatchObject({
      cycleId: nextCycle,
      state: "prepared",
      cancelReportPending: false,
    });
  });
  it("does not clear the fact on another directive, another cycle ACK, or failed ACK persistence", async () => {
    const f = await accepted();
    await f.e.abort();
    await f.e.acknowledgeCancellation(cycleId, {
      action: "cancel",
      cycleId,
      machineEpoch: 2,
      token: null,
      expiresAtMs: null,
    });
    await f.e.acknowledgeCancellation(randomUUID(), none);
    expect(
      (await f.e.directive({ ...prepare(), cycleId: randomUUID() }))?.event,
    ).toBe("rejected");
    expect(f.e.pendingCancellation()).toEqual({ event: "cancelled", cycleId });
    f.save.mockRejectedValueOnce(new Error("fixture_disk_unavailable"));
    await expect(f.e.acknowledgeCancellation(cycleId, none)).rejects.toThrow(
      "fixture_disk_unavailable",
    );
    await f.e.abort(); // Already cancelled; this cannot silently clear/recreate the pending fact.
    expect(f.e.pendingCancellation()).toEqual({ event: "cancelled", cycleId });
    await f.e.acknowledgeCancellation(cycleId, none);
    expect(f.e.pendingCancellation()).toBeNull();
  });
  it("never reports cancellation when Abort is unknown", async () => {
    const f = await accepted();
    f.abort.mockRejectedValue(new Error("fixture_abort_unknown"));
    await expect(f.e.abort()).rejects.toThrow(
      "native_shutdown_cancellation_unknown",
    );
    expect(f.journal).toMatchObject({
      state: "unknown",
      cancelReportPending: false,
    });
    expect(f.e.pendingCancellation()).toBeNull();
  });
  it("a new OS boot invalidates a previously pending fact without aborting or cancelling new recovery", async () => {
    const f = await accepted();
    await f.e.abort();
    const nextBoot = executor({ ...f.journal!, bootId: randomUUID() });
    expect(nextBoot.e.pendingCancellation()).toBeNull();
    await nextBoot.e.initialize();
    expect(nextBoot.journal).toMatchObject({
      state: "cancelled",
      cancelReportPending: false,
    });
    expect(nextBoot.abort).not.toHaveBeenCalled();
    expect(nextBoot.e.pendingCancellation()).toBeNull();
  });
  it("does not invent an Abort fact for an old missing field or an invalidated prepared token", async () => {
    const f = await accepted();
    await f.e.abort();
    const { cancelReportPending: _old, ...legacy } = f.journal!;
    const old = executor(legacy);
    await old.e.initialize();
    await old.e.abort();
    expect(old.e.pendingCancellation()).toBeNull();
    expect(old.abort).not.toHaveBeenCalled();
    const prepared = executor();
    await prepared.e.directive(prepare());
    const recovered = executor(prepared.journal);
    await recovered.e.initialize();
    expect(recovered.e.pendingCancellation()).toBeNull();
    expect(recovered.abort).not.toHaveBeenCalled();
  });
});
