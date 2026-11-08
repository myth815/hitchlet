import { expect, it } from "vitest";
import { validateWslReceipt } from "../src/host-wsl-receipt.js";
const owner = "S-1-5-21-1-2-3-1002",
  ticks = "638000000000000001",
  now = 10000;
const policy = {
  file: "C:\\Users\\owner\\receipt.json",
  producerTask: "\\New30-ComputeNode-Autostart",
  definitionSha256: "a".repeat(64),
  ownerSid: owner,
};
const binary = { executable: "E:\\Hitchlet\\node.exe", sha256: "b".repeat(64) };
function inventory() {
  return {
    processes: [
      {
        pid: 42,
        parentPid: 1,
        ownerSid: owner,
        creationTicks: "638000000000000000",
        path: binary.executable,
        sha256: binary.sha256,
      },
      {
        pid: 43,
        parentPid: 1,
        ownerSid: owner,
        creationTicks: "638000000000000000",
        path: "C:\\Program Files\\WSL\\wslhost.exe",
        sha256: "c".repeat(64),
      },
    ],
    runningTasks: [
      {
        path: policy.producerTask,
        definitionSha256: policy.definitionSha256,
        principalId: owner,
        enginePid: 42,
        loadedActionVerified: false,
      },
    ],
  };
}
function receipt() {
  return {
    observedAt: new Date(now).toISOString(),
    producerPid: 42,
    producerStartedTicks: ticks,
    ownerSid: owner,
    runningDistributions: [],
    workloads: [],
    keeper: { pid: 44, startedTicks: ticks },
  };
}
it("accepts only the exact live S4U task producer; observation completeness is checked separately", () =>
  expect(
    validateWslReceipt(receipt(), policy, inventory(), binary, now).producerPid,
  ).toBe(42));
it("rejects same-name tasks or publisher PID reuse and foreign owner contexts", () => {
  for (const change of ["owner", "pid", "task", "definition"]) {
    const i = inventory();
    if (change === "owner") i.processes[0]!.ownerSid = "S-1-5-18";
    if (change === "pid") i.processes[0]!.creationTicks = "638000000000001000";
    if (change === "task") i.runningTasks[0]!.enginePid = 99;
    if (change === "definition")
      i.runningTasks[0]!.definitionSha256 = "d".repeat(64);
    expect(() =>
      validateWslReceipt(receipt(), policy, i, binary, now),
    ).toThrow();
  }
});
it("does not accept a stale/future file or omit another Windows WSL owner", () => {
  for (const n of [now - 5001, now + 1])
    expect(() =>
      validateWslReceipt(
        { ...receipt(), observedAt: new Date(n).toISOString() },
        policy,
        inventory(),
        binary,
        now,
      ),
    ).toThrow();
  const i = inventory();
  i.processes[1]!.ownerSid = "S-1-5-21-4-5-6-1003";
  expect(() => validateWslReceipt(receipt(), policy, i, binary, now)).toThrow(
    "coverage",
  );
});
