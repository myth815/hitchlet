import { expect, it } from "vitest";
import {
  wslWorkloadReasons,
  wslBindingSchema,
  wslBindingHash,
  type WslWorkload,
} from "../src/host-wsl.js";
const id = "217a11ed-f854-430e-b104-513b5771eee9",
  boot = "1b9e0b64-a6df-4a07-85bf-3c67e9591fec",
  machine = "a".repeat(32);
const b = wslBindingSchema.parse({
  name: "ComputeNode",
  registrationId: id,
  distributionMachineId: machine,
  engines: [
    { nativeEngineId: "one", dockerHost: "unix:///run/user/1000/docker.sock" },
    { nativeEngineId: "two", dockerHost: "unix:///var/run/docker.sock" },
  ],
});
const running = [{ name: b.name, registrationId: id }],
  now = 100000;
function fact() {
  const context = {
    distributionMachineId: machine,
    bootId: boot,
    pidNamespace: "pid:[1]",
  };
  return {
    name: b.name,
    registrationId: id,
    observedAt: new Date(now).toISOString(),
    before: context,
    after: { ...context },
    native: {
      complete: true,
      distributionMachineId: machine,
      bootId: boot,
      namespaces: {
        pid: "pid:[1]",
        user: "user:[1]",
        mount: "mnt:[1]",
        network: "net:[1]",
      },
      processes: [],
      backgroundPids: [],
      errorCodes: [],
    },
    engines: b.engines.map((e) => ({
      nativeEngineId: e.nativeEngineId,
      complete: true,
      containers: [],
    })),
  };
}
it("accepts only full fresh registered distro and both Engines; not a shutdown permit", () =>
  expect(wslWorkloadReasons([b], running, [fact()], now)).toEqual([]));
it("carries a finite service baseline without allowing a same-unit child job", () => {
  const binding = wslBindingSchema.parse({
    ...b,
    backgroundServices: [
      { unit: "cron.service", executable: "/usr/sbin/cron", uid: 0 },
    ],
  });
  expect(binding.backgroundServices![0]!.userService).toBe(false);
  const f = fact();
  f.native.processes.push(
    {
      pid: 42,
      parentPid: 1,
      uid: 0,
      startTicks: "100",
      executable: "/usr/sbin/cron",
      unit: "cron.service",
    } as never,
    {
      pid: 43,
      parentPid: 42,
      uid: 0,
      startTicks: "101",
      executable: "/usr/bin/python3",
      unit: "cron.service",
    } as never,
  );
  f.native.backgroundPids.push(42 as never);
  Object.assign(f, { bindingHash: wslBindingHash(binding) });
  expect(wslWorkloadReasons([binding], running, [f], now)).toEqual([
    "wsl_unmanaged_native_work",
  ]);
});
function managementFixture() {
  const id = "b".repeat(64),
    imageId = "sha256:" + "c".repeat(64);
  const binding = wslBindingSchema.parse({
    ...b,
    engines: b.engines.map((e, i) =>
      i
        ? e
        : {
            ...e,
            backgroundContainers: [
              { id, imageId, uid: 1000, executable: "/app/agent" },
            ],
          },
    ),
  });
  const f: WslWorkload = { ...fact(), bindingHash: wslBindingHash(binding) };
  f.native.processes.push({
    pid: 42,
    parentPid: 10,
    uid: 1000,
    startTicks: "100",
    executable: "/app/agent",
    unit: null,
  });
  f.engines[0]!.containers.push({
    id,
    running: true,
    paused: false,
    installationId: null,
    runtimeIdentityId: null,
    allocationId: null,
    generation: null,
  });
  f.engines[0]!.backgroundContainers = [
    { id, imageId, pid: 42, startTicks: "100", cgroupBound: true },
  ];
  return { binding, f };
}
it("recognizes only the fixed management image/init/native cgroup, not its exec children", () => {
  const { binding, f } = managementFixture();
  expect(wslWorkloadReasons([binding], running, [f], now)).toEqual([]);
  f.native.processes.push({
    pid: 43,
    parentPid: 42,
    uid: 1000,
    startTicks: "101",
    executable: "/bin/bash",
    unit: null,
  });
  expect(wslWorkloadReasons([binding], running, [f], now)).toContain(
    "wsl_unmanaged_native_work",
  );
});
it.each(["image", "pid", "start", "cgroup", "uid", "policy"])(
  "holds management identity after %s drift",
  (key) => {
    const { binding, f } = managementFixture();
    const proof = f.engines[0]!.backgroundContainers![0]!;
    if (key === "image") proof.imageId = "sha256:" + "d".repeat(64);
    if (key === "pid") proof.pid = 99;
    if (key === "start") proof.startTicks = "999";
    if (key === "cgroup") proof.cgroupBound = false;
    if (key === "uid") f.native.processes[0]!.uid = 0;
    if (key === "policy") f.bindingHash = "e".repeat(64);
    expect(wslWorkloadReasons([binding], running, [f], now)).toContain(
      key === "policy"
        ? "wsl_background_policy_changed"
        : "wsl_management_identity_unproven",
    );
  },
);
it("never hides paused/owned allocations behind a background container rule", () => {
  for (const key of ["paused", "allocationId", "installationId"] as const) {
    const { binding, f } = managementFixture();
    const c = f.engines[0]!.containers[0]!;
    if (key === "paused") c.paused = true;
    else c[key] = "owned";
    expect(wslWorkloadReasons([binding], running, [f], now)).toContain(
      "wsl_container_work",
    );
  }
});
it("preserves unknown distributions and missing or duplicated Engine coverage", () => {
  expect(wslWorkloadReasons([], running, [fact()], now)).toContain(
    "wsl_distribution_unbound",
  );
  const f = fact();
  f.engines.pop();
  expect(wslWorkloadReasons([b], running, [f], now)).toContain(
    "wsl_engine_coverage_incomplete",
  );
  f.engines = [f.engines[0]!, f.engines[0]!];
  expect(wslWorkloadReasons([b], running, [f], now)).toContain(
    "wsl_engine_coverage_incomplete",
  );
});
it("holds after distro restart, PID namespace change or registration replacement", () => {
  const f = fact();
  f.after.bootId = "147eae63-b612-40f5-82b3-3ee921df5e3d";
  expect(wslWorkloadReasons([b], running, [f], now)).toContain(
    "wsl_distribution_identity_changed",
  );
  expect(
    wslWorkloadReasons(
      [b],
      [{ ...running[0]!, registrationId: boot }],
      [fact()],
      now,
    ),
  ).toContain("wsl_distribution_unbound");
});
it("never reuses stale/future or partial native facts", () => {
  for (const at of [now - 5001, now + 1]) {
    const f = fact();
    f.observedAt = new Date(at).toISOString();
    expect(wslWorkloadReasons([b], running, [f], now)).toContain(
      "wsl_workload_evidence_stale",
    );
  }
  const f = fact();
  f.native.complete = false;
  expect(wslWorkloadReasons([b], running, [f], now)).toContain(
    "wsl_native_inventory_incomplete",
  );
});
it("does not infer OpenClaw/system service descendants or foreign containers idle", () => {
  const f = fact();
  f.native.processes.push({
    pid: 42,
    parentPid: 1,
    uid: 1000,
    startTicks: "123",
    executable: "/usr/bin/node",
    unit: "openclaw-node.service",
  } as never);
  expect(wslWorkloadReasons([b], running, [f], now)).toContain(
    "wsl_unmanaged_native_work",
  );
  const g = fact();
  g.engines[1]!.containers.push({
    id: "a".repeat(64),
    running: true,
    paused: false,
    installationId: null,
    runtimeIdentityId: null,
    allocationId: null,
    generation: null,
  } as never);
  expect(wslWorkloadReasons([b], running, [g], now)).toContain(
    "wsl_container_work",
  );
});
it("keeps retained owned allocations and inventory races held", () => {
  const f = fact();
  f.engines[0]!.complete = false;
  expect(wslWorkloadReasons([b], running, [f], now)).toContain(
    "wsl_container_inventory_incomplete",
  );
  expect(wslWorkloadReasons([b], running, undefined, now)).toContain(
    "wsl_workload_evidence_missing",
  );
});
