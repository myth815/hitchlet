import { expect, it } from "vitest";
import {
  provenWslObserverBridgePids,
  type WslObserverBridgeProof,
} from "../src/host-wsl-platform.js";
const hash = "a".repeat(64);
function proof(): WslObserverBridgeProof {
  const rows = [
    { pid: 400, parentPid: 399, executable: "/usr/local/bin/node" },
    { pid: 399, parentPid: 398, executable: "/init" },
    { pid: 398, parentPid: 2, executable: "/init" },
    { pid: 2, parentPid: 1, executable: "/init" },
  ].map((p, i) => ({
    ...p,
    comm: i === 1 ? "Relay(400)" : i === 2 ? "SessionLeader" : "node",
    uid: 0,
    startTicks: String(p.pid),
    session: 0,
    state: "S",
    pidNamespace: "pid:[4026532212]",
    sha256: hash,
    protectedFile: true,
  }));
  return { collectorPid: 400, before: rows, after: structuredClone(rows) };
}
it("omits only the exact two observer bridge parents, never base init or child work", () => {
  expect(provenWslObserverBridgePids(hash, proof())).toEqual([399, 398]);
});
it.each([
  "collector",
  "pid-reuse",
  "parent-change",
  "foreign-bridge",
  "broken-chain",
  "namespace",
  "hash",
  "writable",
  "missing",
  "foreign-relay",
  "foreign-leader",
])("keeps the bridge held with %s evidence", (kind) => {
  const p = proof();
  if (kind === "collector") p.collectorPid = 401;
  if (kind === "pid-reuse") p.after[1]!.startTicks += "1";
  if (kind === "parent-change") p.after[2]!.parentPid = 3;
  if (kind === "foreign-bridge") p.before[1]!.uid = p.after[1]!.uid = 1000;
  if (kind === "broken-chain")
    p.before[1]!.parentPid = p.after[1]!.parentPid = 3;
  if (kind === "namespace")
    p.before[1]!.pidNamespace = p.after[1]!.pidNamespace = "pid:[other]";
  if (kind === "hash") p.after[1]!.sha256 = "b".repeat(64);
  if (kind === "writable") p.after[2]!.protectedFile = false;
  if (kind === "missing") p.after.pop();
  if (kind === "foreign-relay")
    p.before[1]!.comm = p.after[1]!.comm = "Relay(401)";
  if (kind === "foreign-leader")
    p.before[2]!.comm = p.after[2]!.comm = "foreign";
  expect(provenWslObserverBridgePids(hash, p)).toEqual([]);
});
