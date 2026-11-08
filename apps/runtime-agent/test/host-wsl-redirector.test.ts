import { expect, it } from "vitest";
import {
  WorkloadGuardSchema,
  WorkloadInventorySchema,
  workloadReasons,
} from "../src/host-power.js";
import { wslBindingHash, wslBindingSchema } from "../src/host-wsl.js";

const now = 100_000,
  owner = "S-1-5-21-1-2-3-1002",
  ticks = "638000000000000001",
  hash = "a".repeat(64);

function fixture() {
  const binding = wslBindingSchema.parse({
    name: "ComputeNode",
    registrationId: "217a11ed-f854-430e-b104-513b5771eee9",
    distributionMachineId: "b".repeat(32),
    engines: [
      { nativeEngineId: "engine", dockerHost: "unix:///run/docker.sock" },
    ],
  });
  const policy = {
    file: "C:\\Users\\owner\\receipt.json",
    producerTask: "\\ComputeNode-Autostart",
    definitionSha256: "c".repeat(64),
    ownerSid: owner,
  };
  const runtime = { executable: "E:\\Hitchlet\\node.exe", sha256: hash };
  const guard = WorkloadGuardSchema.parse({
    version: 1,
    acknowledgement:
      "Only reviewed Windows system services run; all other work is stopped",
    systemExecutables: [
      { name: "wsl.exe", sha256: hash },
      { name: "wslhost.exe", sha256: hash },
    ],
    systemServices: [],
    ownedRuntime: runtime,
    agentTask: {
      path: "\\Power",
      executable: runtime.executable,
      arguments: "",
    },
    wslObservation: policy,
    wslDistributions: [binding],
  });
  const process = (
    pid: number,
    parentPid: number,
    name: string,
    path: string,
  ) => ({
    pid,
    parentPid,
    ownerSid: owner,
    creationTicks: "638000000000000000",
    name,
    path,
    sha256: hash,
    microsoftSigned: true,
    signerThumbprint: "d".repeat(40),
  });
  const inventory = WorkloadInventorySchema.parse({
    bootRecordId: "1",
    bootTime: "2026-10-20T10:00:00.0000000Z",
    complete: true,
    wslRunning: true,
    runningTasks: [
      {
        path: policy.producerTask,
        executable: runtime.executable,
        arguments: "",
        definitionSha256: policy.definitionSha256,
        principalId: owner,
        enginePid: 42,
      },
    ],
    services: [],
    processes: [
      process(42, 1, "node.exe", runtime.executable),
      process(43, 1, "wslhost.exe", "C:\\Program Files\\WSL\\wslhost.exe"),
      process(44, 42, "wsl.exe", "C:\\Windows\\System32\\wsl.exe"),
      process(45, 44, "wsl.exe", "C:\\Program Files\\WSL\\wsl.exe"),
    ],
  });
  const context = {
    distributionMachineId: binding.distributionMachineId,
    bootId: "1b9e0b64-a6df-4a07-85bf-3c67e9591fec",
    pidNamespace: "pid:[1]",
  };
  const receipt = {
    observedAt: new Date(now).toISOString(),
    producerPid: 42,
    producerStartedTicks: ticks,
    ownerSid: owner,
    runningDistributions: [
      { name: binding.name, registrationId: binding.registrationId },
    ],
    workloads: [
      {
        name: binding.name,
        registrationId: binding.registrationId,
        observedAt: new Date(now).toISOString(),
        bindingHash: wslBindingHash(binding),
        before: context,
        after: context,
        native: {
          complete: true,
          distributionMachineId: context.distributionMachineId,
          bootId: context.bootId,
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
        engines: [{ nativeEngineId: "engine", complete: true, containers: [] }],
      },
    ],
    keeper: { pid: 44, startedTicks: ticks },
  };
  return { guard, inventory, receipt };
}

it("recognizes only the registered direct WSL redirector of the receipt keeper", () => {
  const f = fixture();
  expect(
    workloadReasons(f.guard, f.inventory, 100, 101, [], f.receipt, now),
  ).toEqual([]);
});

it.each([
  "parent",
  "owner",
  "hash",
  "path",
  "signature",
  "keeper-reuse",
  "stale",
])("keeps a WSL redirector with changed %s protected", (change) => {
  const f = fixture(),
    alias = f.inventory.processes.find((p) => p.pid === 45)!;
  if (change === "parent") alias.parentPid = 43;
  if (change === "owner") alias.ownerSid = "S-1-5-18";
  if (change === "hash") alias.sha256 = "e".repeat(64);
  if (change === "path") alias.path = "C:\\Users\\owner\\wsl.exe";
  if (change === "signature") alias.microsoftSigned = false;
  if (change === "keeper-reuse")
    f.inventory.processes.find((p) => p.pid === 44)!.creationTicks =
      "638000000000001000";
  if (change === "stale")
    f.receipt.observedAt = new Date(now - 5001).toISOString();
  expect(
    workloadReasons(f.guard, f.inventory, 100, 101, [], f.receipt, now),
  ).toContain("unapproved_native_process");
});

it("does not exempt a real command descended from the recognized redirector", () => {
  const f = fixture();
  f.inventory.processes.push({
    ...f.inventory.processes.find((p) => p.pid === 45)!,
    pid: 46,
    parentPid: 45,
    name: "cmd.exe",
    path: "C:\\Windows\\System32\\cmd.exe",
  });
  expect(
    workloadReasons(f.guard, f.inventory, 100, 101, [], f.receipt, now),
  ).toContain("unapproved_native_process");
});

it("requires complete clear WSL facts before treating its redirector as background", () => {
  const f = fixture();
  f.receipt.workloads[0]!.native.complete = false;
  expect(
    workloadReasons(f.guard, f.inventory, 100, 101, [], f.receipt, now),
  ).toEqual(
    expect.arrayContaining([
      "wsl_native_inventory_incomplete",
      "unapproved_native_process",
    ]),
  );
});
