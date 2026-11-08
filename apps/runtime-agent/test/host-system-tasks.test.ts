import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  WorkloadGuardSchema,
  workloadReasons,
  guardHash,
} from "../src/host-power.js";
const reviewed = {
  path: "\\Microsoft\\Windows\\Multimedia\\SystemSoundsService",
  definitionSha256: "d".repeat(64),
  principalId: "S-1-5-18",
  actionKind: "com",
  executable: "C:\\Windows\\System32\\PlaySndSrv.dll",
  sha256: "a".repeat(64),
  signerThumbprint: "F".repeat(40),
};
function guard() {
  return WorkloadGuardSchema.parse({
    version: 1,
    acknowledgement:
      "Only reviewed Windows system services run; all other work is stopped",
    systemExecutables: [{ name: "system.exe", sha256: "1".repeat(64) }],
    systemServices: [],
    reviewedTasks: [reviewed],
  });
}
function inventory() {
  return {
    bootRecordId: "1",
    bootTime: "2026-10-20T10:00:00.0000000Z",
    complete: true,
    wslRunning: false,
    runningTasks: [
      {
        path: reviewed.path,
        executable: "",
        arguments: "",
        definitionSha256: reviewed.definitionSha256,
        principalId: reviewed.principalId,
        actionKind: "com",
        actionPath: reviewed.executable,
        actionSha256: reviewed.sha256,
        actionSignerThumbprint: reviewed.signerThumbprint,
        enginePid: 42,
        loadedActionVerified: true,
      },
    ],
    processes: [
      {
        pid: 42,
        parentPid: 1,
        name: "taskhostw.exe",
        path: "C:\\Windows\\System32\\taskhostw.exe",
        sha256: "b".repeat(64),
        microsoftSigned: true,
        signerThumbprint: "E".repeat(40),
      },
    ],
    services: [],
  };
}
it("accepts an exact reviewed COM task only with its real loaded action and engine", () =>
  expect(workloadReasons(guard(), inventory(), 100, 101)).toEqual([]));
it("keeps same publisher/task name insufficient after definition/principal/image/engine drift", () => {
  for (const key of [
    "definitionSha256",
    "principalId",
    "actionPath",
    "actionSha256",
    "actionSignerThumbprint",
  ]) {
    const x = inventory();
    (x.runningTasks[0] as any)[key] = "changed";
    expect(workloadReasons(guard(), x, 100, 101)).toContain(
      "running_scheduled_task",
    );
  }
  for (const key of ["enginePid", "loadedActionVerified"]) {
    const x = inventory();
    (x.runningTasks[0] as any)[key] = key === "enginePid" ? 0 : false;
    expect(workloadReasons(guard(), x, 100, 101)).toContain(
      "running_scheduled_task",
    );
  }
});
it("does not exempt a child interpreter or an unreviewed co-hosted task", () => {
  const x = inventory();
  x.processes.push({
    ...x.processes[0]!,
    pid: 43,
    parentPid: 42,
    name: "powershell.exe",
    path: "C:\\Windows\\System32\\powershell.exe",
  });
  expect(workloadReasons(guard(), x, 100, 101)).toContain(
    "unapproved_native_process",
  );
  x.runningTasks.push({ ...x.runningTasks[0]!, path: "\\Other" });
  expect(workloadReasons(guard(), x, 100, 101)).toContain(
    "running_scheduled_task",
  );
});
it("preserves the prior guard fingerprint for default-empty new bindings", () => {
  const g = guard();
  g.reviewedTasks = [];
  const { reviewedTasks, wslDistributions, ...old } = g;
  expect(guardHash(g)).toBe(
    createHash("sha256").update(JSON.stringify(old)).digest("hex"),
  );
});
