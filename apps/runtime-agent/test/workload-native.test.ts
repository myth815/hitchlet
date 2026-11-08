import { beforeEach, expect, it, vi } from "vitest";
import { collectLinuxWorkloads } from "../src/workloads.js";
const context = {
  distributionMachineId: "a".repeat(32),
  bootId: "147eae63-b612-40f5-82b3-3ee921df5e3d",
  pidNamespace: "pid:[1]",
};
const state = vi.hoisted(() => ({
  reused: false,
  statReads: 0,
  partialNamespace: false,
  procReads: 0,
  startedLate: false,
  exeReads: 0,
  execChanged: false,
  serviceChanged: false,
}));
beforeEach(() =>
  Object.assign(state, {
    reused: false,
    statReads: 0,
    partialNamespace: false,
    procReads: 0,
    startedLate: false,
    exeReads: 0,
    execChanged: false,
    serviceChanged: false,
  }),
);
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(async (path: string) => {
      if (path !== "/proc") return actual.readdir(path);
      const pids = ["1", "42", "90", "91", "self"];
      if (++state.procReads > 1 && state.startedLate) pids.push("99");
      return pids;
    }),
    readlink: vi.fn(async (path: string) => {
      if (path.startsWith("/proc/self/ns/"))
        return path.split("/").at(-1) + ":[1]";
      const pid = Number(path.split("/")[2]);
      if (pid === 90 && path.endsWith("/exe")) {
        state.exeReads++;
        if (
          (state.execChanged && state.exeReads >= 2) ||
          (state.serviceChanged && state.exeReads >= 3)
        )
          return "/bin/bash";
      }
      if (path.endsWith("/exe"))
        return pid === 1
          ? state.partialNamespace
            ? "/usr/bin/node"
            : "/usr/lib/systemd/systemd"
          : pid === 42
            ? "/usr/bin/node"
            : pid === 90
              ? "/usr/sbin/sshd"
              : "/bin/bash";
      return actual.readlink(path);
    }),
    readFile: vi.fn(async (path: string, encoding: "utf8") => {
      if (path === "/etc/machine-id") return "a".repeat(32);
      if (path === "/proc/sys/kernel/random/boot_id")
        return "147eae63-b612-40f5-82b3-3ee921df5e3d";
      if (path.startsWith("/proc/")) {
        const pid = Number(path.split("/")[2]);
        if (path.endsWith("/status"))
          return `Uid:\t${pid === 1 || pid === 90 ? 0 : 1000}\nNSpid:\t${pid}\n`;
        if (path.endsWith("/cgroup")) return "0::/system.slice/sshd.service\n";
        if (path.endsWith("/stat"))
          return (
            `${pid} (fixture) ` +
            [
              "S",
              pid === 91 ? "90" : "1",
              ...Array(17).fill("0"),
              state.reused && pid === 90 && ++state.statReads > 1
                ? "999"
                : "100",
            ].join(" ")
          );
      }
      return actual.readFile(path, encoding);
    }),
  };
});
vi.mock("../src/command-exec.js", () => ({
  runFixedCommand: vi.fn(async () => ({
    stdout: "MainPID=90\nActiveState=active\n",
    stderr: "",
  })),
  withCommandDeadline: (_deadline: number, work: () => Promise<unknown>) =>
    work(),
}));
it("recognizes only the exact configured service MainPID, preserving its interactive child", async () => {
  state.reused = false;
  state.partialNamespace = false;
  state.statReads = 0;
  const result = await collectLinuxWorkloads(
    [
      {
        unit: "sshd.service",
        executable: "/usr/sbin/sshd",
        uid: 0,
        userService: false,
      },
    ],
    Date.now() + 5000,
    context,
  );
  expect(result.complete).toBe(true);
  expect(result.backgroundPids).toContain(90);
  expect(result.backgroundPids).not.toContain(91);
});
it("does not attest native work after PID reuse or from a container-local init", async () => {
  state.reused = true;
  state.partialNamespace = true;
  state.statReads = 0;
  const result = await collectLinuxWorkloads();
  expect(result.complete).toBe(false);
  expect(result.errorCodes).toContain("native_process_unverifiable");
  expect(result.errorCodes).toContain("distribution_pid_view_unproven");
});

it("does not trust a systemd-looking container or a different host binding as full distro evidence", async () => {
  state.reused = false;
  state.partialNamespace = false;
  state.statReads = 0;
  expect((await collectLinuxWorkloads()).errorCodes).toContain(
    "distribution_context_unbound",
  );
  const changed = await collectLinuxWorkloads([], Date.now() + 5000, {
    ...context,
    pidNamespace: "pid:[2]",
  });
  expect(changed.complete).toBe(false);
  expect(changed.errorCodes).toContain("distribution_context_changed");
});
it("does not call an enumeration complete when new work starts during the walk", async () => {
  state.startedLate = true;
  const result = await collectLinuxWorkloads([], Date.now() + 5000, context);
  expect(result.complete).toBe(false);
  expect(result.errorCodes).toContain("native_process_set_changed");
});
it("does not accept an exec change within the same PID/start time", async () => {
  state.execChanged = true;
  const result = await collectLinuxWorkloads([], Date.now() + 5000, context);
  expect(result.complete).toBe(false);
  expect(result.errorCodes).toContain("native_process_unverifiable");
});
it("rechecks the service process after resolving its MainPID", async () => {
  state.serviceChanged = true;
  const result = await collectLinuxWorkloads(
    [
      {
        unit: "sshd.service",
        executable: "/usr/sbin/sshd",
        uid: 0,
        userService: false,
      },
    ],
    Date.now() + 5000,
    context,
  );
  expect(result.complete).toBe(false);
  expect(result.backgroundPids).not.toContain(90);
  expect(result.errorCodes).toContain("native_service_identity_changed");
});
it("queries the exact existing user's manager instead of root's unrelated user bus", async () => {
  const uid = vi.spyOn(process, "getuid").mockReturnValue(0);
  try {
    const { runFixedCommand } = await import("../src/command-exec.js");
    const result = await collectLinuxWorkloads(
      [
        {
          unit: "sshd.service",
          executable: "/usr/sbin/sshd",
          uid: 1000,
          userService: true,
        },
      ],
      Date.now() + 5000,
      context,
    );
    expect(vi.mocked(runFixedCommand).mock.calls.at(-1)![1]).toContain(
      "--machine=1000@.host",
    );
    // The returned process has uid0, so even a successful user-bus query cannot approve it.
    expect(result.backgroundPids).not.toContain(90);
  } finally {
    uid.mockRestore();
  }
});
it("preserves the ordinary user-bus command when already running as that exact user", async () => {
  const uid = vi.spyOn(process, "getuid").mockReturnValue(0);
  try {
    const { runFixedCommand } = await import("../src/command-exec.js");
    await collectLinuxWorkloads(
      [
        {
          unit: "sshd.service",
          executable: "/usr/sbin/sshd",
          uid: 0,
          userService: true,
        },
      ],
      Date.now() + 5000,
      context,
    );
    expect(vi.mocked(runFixedCommand).mock.calls.at(-1)![1]).toEqual([
      "--user",
      "show",
      "sshd.service",
      "--property=MainPID,ActiveState",
    ]);
  } finally {
    uid.mockRestore();
  }
});
