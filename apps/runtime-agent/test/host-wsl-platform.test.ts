import { expect, it } from "vitest";
import {
  isPrivateTtyInputWait,
  provenWslSystemdSessionPids,
  type WslSystemdSessionProof,
} from "../src/host-wsl-platform.js";
import {
  wslBindingHash,
  wslBindingSchema,
  wslSystemdSessionPolicySchema,
  wslWorkloadReasons,
} from "../src/host-wsl.js";

const policy = wslSystemdSessionPolicySchema.parse({
  initSha256: "a".repeat(64),
  loginExecutable: "/usr/bin/login",
  loginSha256: "b".repeat(64),
  users: [
    {
      uid: 1000,
      shellExecutable: "/usr/bin/bash",
      shellSha256: "c".repeat(64),
    },
  ],
});
function proof(): WslSystemdSessionProof {
  return {
    init: {
      pid: 2,
      parentPid: 1,
      uid: 0,
      startTicks: "20",
      executable: "/init",
      session: 0,
      state: "S",
      sha256: policy.initSha256,
      protectedFile: true,
    },
    login: {
      pid: 832,
      parentPid: 2,
      uid: 0,
      startTicks: "419",
      executable: policy.loginExecutable,
      session: 832,
      state: "S",
      sha256: policy.loginSha256,
      protectedFile: true,
    },
    shell: {
      pid: 983,
      parentPid: 832,
      uid: 1000,
      startTicks: "461",
      executable: "/usr/bin/bash",
      session: 832,
      state: "S",
      sha256: policy.users[0]!.shellSha256,
      protectedFile: true,
    },
    uid: 1000,
    ttyIndex: 1,
    masterOwnerPid: 2,
    samePrivateTty: true,
    sameUserSession: true,
    waitingForStdin: true,
    stable: true,
  };
}

it("recognizes only the proven login and waiting shell, not their process tree", () => {
  expect(provenWslSystemdSessionPids(policy, [proof()])).toEqual([832, 983]);
});

it.each([
  "init-hash",
  "login-hash",
  "shell-hash",
  "writable",
  "foreign-init",
  "foreign-login",
  "foreign-shell",
  "uid",
  "tty",
  "session",
  "master",
  "changed",
  "builtin",
  "running-builtin",
  "duplicate",
])(
  "does not classify a platform session with %s evidence as background",
  (kind) => {
    const p = proof(),
      proofs = [p];
    if (kind === "init-hash") p.init.sha256 = "d".repeat(64);
    if (kind === "login-hash") p.login.sha256 = "d".repeat(64);
    if (kind === "shell-hash") p.shell.sha256 = "d".repeat(64);
    if (kind === "writable") p.shell.protectedFile = false;
    if (kind === "foreign-init") p.init.parentPid = 100;
    if (kind === "foreign-login") p.login.parentPid = 100;
    if (kind === "foreign-shell") p.shell.parentPid = 100;
    if (kind === "uid") p.shell.uid = 1001;
    if (kind === "tty") p.samePrivateTty = false;
    if (kind === "session") p.shell.session = 44;
    if (kind === "master") p.masterOwnerPid = 44;
    if (kind === "changed") p.stable = false;
    if (kind === "builtin") p.waitingForStdin = false;
    if (kind === "running-builtin") p.shell.state = "R";
    if (kind === "duplicate") proofs.push(structuredClone(p));
    expect(provenWslSystemdSessionPids(policy, proofs)).toEqual([]);
  },
);

it("requires an indefinite read-only fd0 wait, not running/timed/builtin activity", () => {
  const wait = "270 0x1 0x100 0x0 0x0 0x0 0x200 0x300 0x400";
  expect(isPrivateTtyInputWait("x64", "S", wait)).toBe(true);
  for (const [arch, state, text] of [
    ["arm64", "S", wait],
    ["x64", "R", wait],
    ["x64", "S", "running"],
    ["x64", "S", wait.replace("270", "0")],
    ["x64", "S", wait.replace("0x1 ", "0x2 ")],
    ["x64", "S", "270 1 0 0 0 0 0 0 0"],
    ["x64", "S", "270 1 1 1 0 0 0 0 0"],
    ["x64", "S", "270 1 1 0 1 0 0 0 0"],
    ["x64", "S", "270 1 1 0 0 1 0 0 0"],
    ["x64", "S", "270 1 1 0 0 0"],
  ])
    expect(isPrivateTtyInputWait(arch!, state!, text!)).toBe(false);
});

it("keeps the role opt-in and real child jobs visible to the existing work guard", () => {
  const base = {
    name: "ComputeNode",
    registrationId: "217a11ed-f854-430e-b104-513b5771eee9",
    distributionMachineId: "e".repeat(32),
    engines: [
      { nativeEngineId: "engine", dockerHost: "unix:///run/docker.sock" },
    ],
  };
  expect(wslBindingSchema.parse(base).systemdUserSessions).toBeUndefined();
  const binding = wslBindingSchema.parse({
      ...base,
      systemdUserSessions: policy,
    }),
    p = proof(),
    now = 100_000,
    context = {
      distributionMachineId: base.distributionMachineId,
      bootId: "1b9e0b64-a6df-4a07-85bf-3c67e9591fec",
      pidNamespace: "pid:[1]",
    };
  const process = (pid: number, parentPid: number, executable: string) => ({
    pid,
    parentPid,
    uid: 1000,
    executable,
    startTicks: "461",
    unit: null,
  });
  const fact = {
    name: base.name,
    registrationId: base.registrationId,
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
      processes: [
        process(p.login.pid, p.init.pid, p.login.executable),
        process(p.shell.pid, p.login.pid, p.shell.executable),
      ],
      backgroundPids: provenWslSystemdSessionPids(policy, [p]),
      errorCodes: [],
    },
    engines: [{ nativeEngineId: "engine", complete: true, containers: [] }],
  };
  const running = [{ name: base.name, registrationId: base.registrationId }];
  expect(wslWorkloadReasons([binding], running, [fact], now)).toEqual([]);
  const changedPolicyBinding = {
    ...binding,
    systemdUserSessions: { ...policy, initSha256: "d".repeat(64) },
  };
  expect(
    wslWorkloadReasons([changedPolicyBinding], running, [fact], now),
  ).toEqual(["wsl_background_policy_changed"]);
  fact.native.processes.push(process(984, p.shell.pid, "/usr/bin/python3"));
  expect(wslWorkloadReasons([binding], running, [fact], now)).toEqual([
    "wsl_unmanaged_native_work",
  ]);
});
