import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { trackKeeperParent } from "../src/host-wsl-keeper.js";
import {
  provenWslKeeperPids,
  type KeeperEvidence,
} from "../src/host-wsl-management.js";
import {
  wslKeeperPolicySchema,
  wslKeeperProofSchema,
  wslBindingSchema,
  wslBindingHash,
  wslWorkloadReasons,
} from "../src/host-wsl.js";
const policy = wslKeeperPolicySchema.parse({
  uid: 1000,
  nodeExecutable: "/opt/node/bin/node",
  nodeSha256: "a".repeat(64),
  helperSha256: "b".repeat(64),
  initSha256: "c".repeat(64),
});
it.each(["early-eof", "unexpected-input", "input-error"])(
  "settles parent %s before pending startup work can publish",
  async (kind) => {
    const input = new PassThrough(),
      exits: number[] = [];
    const parent = trackKeeperParent(input, (code) => exits.push(code));
    if (kind === "early-eof") input.end();
    if (kind === "unexpected-input") input.write("not a command protocol");
    if (kind === "input-error") input.destroy(Error("closed"));
    await setImmediate();
    expect(parent.open).toBe(false);
    expect(exits).toEqual([kind === "early-eof" ? 0 : 1]);
    input.destroy();
  },
);
function fixture(): KeeperEvidence {
  const handshake = wslKeeperProofSchema.parse({
    pid: 400,
    parentPid: 399,
    uid: 1000,
    startTicks: "10",
    executable: policy.nodeExecutable,
    pidNamespace: "pid:[1]",
    bootId: "1b9e0b64-a6df-4a07-85bf-3c67e9591fec",
    distributionMachineId: "d".repeat(32),
    nodeSha256: policy.nodeSha256,
    helperSha256: policy.helperSha256,
    nodeFile: { dev: 1, ino: 2, size: 30, mtimeMs: 10, ctimeMs: 10 },
  });
  const before = [
    {
      pid: 400,
      parentPid: 399,
      uid: 1000,
      startTicks: "10",
      executable: policy.nodeExecutable,
      comm: "node",
      namespace: "pid:[1]",
    },
    ...[
      { pid: 399, parentPid: 398, comm: "Relay(400)" },
      { pid: 398, parentPid: 2, comm: "SessionLeader" },
      { pid: 2, parentPid: 1, comm: "init" },
    ].map((p) => ({
      ...p,
      uid: 0,
      startTicks: String(p.pid),
      executable: "/init",
      namespace: "pid:[1]",
      sha256: policy.initSha256,
      protected: true,
    })),
  ];
  return {
    handshake,
    before,
    after: structuredClone(before),
    nodeFileMatches: true,
    helperProtected: true,
    helperHash: policy.helperSha256,
  };
}
it("accepts only the original stdio-handshaken fixed keeper and its two bridges", () => {
  expect(provenWslKeeperPids(policy, fixture())).toEqual([400, 399, 398]);
});
it.each([
  "other-sleep",
  "pid-reuse",
  "node-file",
  "node-hash",
  "helper-hash",
  "helper-writable",
  "uid",
  "boot-bridge",
  "namespace",
  "broken-chain",
  "relay",
  "leader",
  "init-hash",
  "init-writable",
  "missing",
])("keeps %s unknown or busy", (kind) => {
  const e = fixture();
  if (kind === "other-sleep")
    e.before[0]!.executable = e.after[0]!.executable = "/usr/bin/sleep";
  if (kind === "pid-reuse") e.after[0]!.startTicks = "11";
  if (kind === "node-file") e.nodeFileMatches = false;
  if (kind === "node-hash") e.handshake.nodeSha256 = "e".repeat(64);
  if (kind === "helper-hash") e.helperHash = "e".repeat(64);
  if (kind === "helper-writable") e.helperProtected = false;
  if (kind === "uid") e.handshake.uid = 0;
  if (kind === "boot-bridge") e.after[1]!.parentPid = 2;
  if (kind === "namespace") e.after[1]!.namespace = "pid:[2]";
  if (kind === "broken-chain")
    e.before[0]!.parentPid = e.after[0]!.parentPid = 30;
  if (kind === "relay") e.before[1]!.comm = e.after[1]!.comm = "Relay(401)";
  if (kind === "leader") e.before[2]!.comm = e.after[2]!.comm = "foreign";
  if (kind === "init-hash") e.after[1]!.sha256 = "e".repeat(64);
  if (kind === "init-writable") e.after[2]!.protected = false;
  if (kind === "missing") e.after.pop();
  expect(provenWslKeeperPids(policy, e)).toEqual([]);
});
it("binds keeper-only policy changes and keeps a real child task visible", () => {
  const b = wslBindingSchema.parse({
    name: "ComputeNode",
    registrationId: "217a11ed-f854-430e-b104-513b5771eee9",
    distributionMachineId: "d".repeat(32),
    engines: [
      { nativeEngineId: "engine", dockerHost: "unix:///run/docker.sock" },
    ],
    keeper: policy,
  });
  const context = {
    distributionMachineId: b.distributionMachineId,
    bootId: fixture().handshake.bootId,
    pidNamespace: "pid:[1]",
  };
  const processes = fixture().before.map((x) => ({
    pid: x.pid,
    parentPid: x.parentPid,
    uid: x.uid,
    startTicks: x.startTicks,
    executable: x.executable,
    unit: null,
  }));
  const f = {
    name: b.name,
    registrationId: b.registrationId,
    observedAt: new Date(100000).toISOString(),
    bindingHash: wslBindingHash(b),
    before: context,
    after: context,
    native: {
      complete: true,
      distributionMachineId: b.distributionMachineId,
      bootId: context.bootId,
      namespaces: { pid: "pid:[1]", user: "u", mount: "m", network: "n" },
      processes,
      backgroundPids: [2, ...provenWslKeeperPids(policy, fixture())],
      errorCodes: [],
    },
    engines: [{ nativeEngineId: "engine", complete: true, containers: [] }],
  };
  const running = [{ name: b.name, registrationId: b.registrationId }];
  expect(wslWorkloadReasons([b], running, [f], 100000)).toEqual([]);
  expect(
    wslWorkloadReasons(
      [{ ...b, keeper: { ...policy, helperSha256: "f".repeat(64) } }],
      running,
      [f],
      100000,
    ),
  ).toEqual(["wsl_background_policy_changed"]);
  f.native.processes.push({
    pid: 401,
    parentPid: 400,
    uid: 1000,
    startTicks: "11",
    executable: "/usr/bin/python3",
    unit: null,
  });
  expect(wslWorkloadReasons([b], running, [f], 100000)).toEqual([
    "wsl_unmanaged_native_work",
  ]);
});
