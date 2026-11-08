import { createHash } from "node:crypto";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import type { RuntimeNativeWorkload } from "@hitchlet/contracts/internal";
import type { WslSystemdSessionPolicy } from "./host-wsl.js";

type ProcessIdentity = {
  pid: number;
  parentPid: number;
  uid: number;
  startTicks: string;
  executable: string;
  session: number;
  state: string;
};
export type WslSystemdSessionProof = {
  init: ProcessIdentity & { sha256: string; protectedFile: boolean };
  login: ProcessIdentity & { sha256: string; protectedFile: boolean };
  shell: ProcessIdentity & { sha256: string; protectedFile: boolean };
  uid: number;
  ttyIndex: number;
  masterOwnerPid: number;
  samePrivateTty: boolean;
  sameUserSession: boolean;
  waitingForStdin: boolean;
  stable: boolean;
};

/** Keep only scalar wait facts; never retain register addresses or inspect process memory. */
export function isPrivateTtyInputWait(
  architecture: string,
  state: string,
  syscall: string,
) {
  if (architecture !== "x64" || state !== "S") return false;
  try {
    const fields = syscall.trim().split(/\s+/);
    return (
      fields.length === 9 &&
      fields[0] === "270" && // Linux x86_64 pselect6
      BigInt(fields[1]!) === 1n && // only fd0 can be in the read set
      BigInt(fields[2]!) !== 0n &&
      BigInt(fields[3]!) === 0n &&
      BigInt(fields[4]!) === 0n &&
      BigInt(fields[5]!) === 0n // no timer/builtin polling loop
    );
  } catch {
    return false;
  }
}

function sameInstance(before: ProcessIdentity, after: ProcessIdentity) {
  return (
    before.pid === after.pid &&
    before.parentPid === after.parentPid &&
    before.uid === after.uid &&
    before.startTicks === after.startTicks &&
    before.executable === after.executable &&
    before.session === after.session
  );
}

/** WSL 3.0.3's init keeps each systemd login PTY master privately, without an input writer. */
export function provenWslSystemdSessionPids(
  policy: WslSystemdSessionPolicy,
  proofs: readonly WslSystemdSessionProof[],
) {
  const approved: number[] = [];
  for (const p of proofs) {
    const user = policy.users.find((u) => u.uid === p.uid);
    if (
      !user ||
      proofs.filter((other) => other.uid === p.uid).length !== 1 ||
      !p.stable ||
      !p.init.protectedFile ||
      p.init.uid !== 0 ||
      p.init.parentPid !== 1 ||
      p.init.executable !== "/init" ||
      p.init.sha256 !== policy.initSha256 ||
      !p.login.protectedFile ||
      p.login.uid !== 0 ||
      p.login.parentPid !== p.init.pid ||
      p.login.executable !== policy.loginExecutable ||
      p.login.sha256 !== policy.loginSha256 ||
      !p.shell.protectedFile ||
      p.shell.state !== "S" ||
      p.shell.parentPid !== p.login.pid ||
      p.shell.uid !== user.uid ||
      p.shell.executable !== user.shellExecutable ||
      p.shell.sha256 !== user.shellSha256 ||
      p.login.session !== p.login.pid ||
      p.shell.session !== p.login.pid ||
      p.masterOwnerPid !== p.init.pid ||
      !Number.isSafeInteger(p.ttyIndex) ||
      p.ttyIndex < 0 ||
      !p.samePrivateTty ||
      !p.sameUserSession ||
      !p.waitingForStdin
    )
      continue;
    approved.push(p.login.pid, p.shell.pid);
  }
  return approved;
}

async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const base = `/proc/${pid}`;
  const text = await readFile(`${base}/stat`, "utf8");
  const fields = text
    .slice(text.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  const status = await readFile(`${base}/status`, "utf8");
  return {
    pid,
    parentPid: Number(fields[1]),
    uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]),
    startTicks: fields[19]!,
    executable: await readlink(`${base}/exe`),
    session: Number(fields[3]),
    state: fields[0]!,
  };
}

async function binaryIdentity(pid: number) {
  const path = `/proc/${pid}/exe`,
    before = await stat(path);
  if (!before.isFile() || before.size > 16 * 1024 * 1024)
    throw Error("platform_binary_unbounded");
  const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    after = await stat(path);
  return {
    sha256,
    protectedFile:
      before.uid === 0 &&
      (before.mode & 0o022) === 0 &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.mode === after.mode &&
      before.uid === after.uid,
  };
}

type BridgeIdentity = ProcessIdentity & {
  comm: string;
  pidNamespace: string;
  sha256?: string;
  protectedFile?: boolean;
};
export type WslObserverBridgeProof = {
  collectorPid: number;
  before: BridgeIdentity[];
  after: BridgeIdentity[];
};

/** Only the two private /init parents of this invocation; never the base init or children. */
export function provenWslObserverBridgePids(
  initSha256: string,
  proof: WslObserverBridgeProof,
) {
  const { before, after } = proof;
  if (before.length !== 4 || after.length !== 4) return [];
  const self = before[0]!;
  if (
    self.pid !== proof.collectorPid ||
    self.uid !== 0 ||
    new Set(before.map((p) => p.pid)).size !== 4 ||
    before.some(
      (p, i) =>
        !sameInstance(p, after[i]!) ||
        p.comm !== after[i]!.comm ||
        p.pidNamespace !== self.pidNamespace ||
        p.pidNamespace !== after[i]!.pidNamespace,
    )
  )
    return [];
  if (
    before[1]!.comm !== `Relay(${self.pid})` ||
    before[2]!.comm !== "SessionLeader"
  )
    return [];
  for (let i = 1; i < 4; i++) {
    const p = before[i]!,
      a = after[i]!;
    if (
      before[i - 1]!.parentPid !== p.pid ||
      p.uid !== 0 ||
      p.executable !== "/init" ||
      !p.protectedFile ||
      !a.protectedFile ||
      p.sha256 !== initSha256 ||
      a.sha256 !== initSha256
    )
      return [];
  }
  if (before[3]!.parentPid !== 1) return [];
  return [before[1]!.pid, before[2]!.pid];
}

/** Bind before sampling and recheck after all engine reads; any race leaves the bridge held. */
export async function beginWslObserverBridgeObservation(initSha256: string) {
  const collectorPid = process.pid;
  const chain = async () => {
    const result: BridgeIdentity[] = [];
    let pid = collectorPid;
    for (let i = 0; i < 4; i++) {
      const identity = await processIdentity(pid);
      result.push({
        ...identity,
        comm: (await readFile(`/proc/${pid}/comm`, "utf8")).trim(),
        pidNamespace: await readlink(`/proc/${pid}/ns/pid`),
        ...(i ? await binaryIdentity(pid) : {}),
      });
      pid = identity.parentPid;
    }
    return result;
  };
  const before = await chain().catch(() => []);
  return async (native: RuntimeNativeWorkload): Promise<number[]> => {
    if (!native.complete || native.errorCodes.length) return [];
    const after = await chain().catch(() => []);
    const approved = provenWslObserverBridgePids(initSha256, {
      collectorPid,
      before,
      after,
    });
    return approved.every((pid) => {
      const proof = before.find((p) => p.pid === pid)!;
      const observed = native.processes.find((p) => p.pid === pid);
      return (
        observed?.startTicks === proof.startTicks &&
        observed.parentPid === proof.parentPid &&
        observed.uid === proof.uid &&
        observed.executable === proof.executable &&
        native.namespaces?.pid === proof.pidNamespace
      );
    })
      ? approved
      : [];
  };
}

async function masterIndex(pid: number, fd: string) {
  const path = `/proc/${pid}/fd/${fd}`,
    target = await readlink(path);
  if (!["/dev/ptmx", "/dev/pts/ptmx"].includes(target)) return null;
  const info = await readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8");
  const index = info.match(/^tty-index:\s+(\d+)$/m)?.[1];
  return index === undefined ? null : Number(index);
}

/** Opt-in sampler for exact platform login/shell instances. No descendants are omitted. */
export async function collectWslSystemdSessionBackground(
  policy: WslSystemdSessionPolicy,
  native: RuntimeNativeWorkload,
) {
  if (!native.complete || native.errorCodes.length || process.arch !== "x64")
    return [];
  const inits = native.processes.filter(
    (p) => p.executable === "/init" && p.uid === 0 && p.parentPid === 1,
  );
  if (inits.length !== 1) return [];
  const initPid = inits[0]!.pid,
    proofs: WslSystemdSessionProof[] = [],
    deadline = Date.now() + 1500;
  try {
    const init = {
      ...(await processIdentity(initPid)),
      ...(await binaryIdentity(initPid)),
    };
    const fds = await readdir(`/proc/${initPid}/fdinfo`);
    if (fds.length > 512) return [];
    const masters = new Map<number, string>();
    for (const fd of fds) {
      if (Date.now() >= deadline) return [];
      const index = await masterIndex(initPid, fd).catch(() => null);
      if (index !== null) masters.set(index, fd);
    }
    for (const candidate of native.processes.filter(
      (p) => p.parentPid === initPid && p.executable === policy.loginExecutable,
    )) {
      if (Date.now() >= deadline) return [];
      try {
        const login = {
          ...(await processIdentity(candidate.pid)),
          ...(await binaryIdentity(candidate.pid)),
        };
        const children = native.processes.filter(
          (p) =>
            p.parentPid === login.pid &&
            policy.users.some(
              (u) => u.uid === p.uid && u.shellExecutable === p.executable,
            ),
        );
        if (children.length !== 1) continue;
        const shell = {
          ...(await processIdentity(children[0]!.pid)),
          ...(await binaryIdentity(children[0]!.pid)),
        };
        const tty = await readlink(`/proc/${login.pid}/fd/0`),
          match = tty.match(/^\/dev\/pts\/(\d+)$/);
        if (!match) continue;
        const ttyIndex = Number(match[1]),
          master = masters.get(ttyIndex);
        if (!master) continue;
        let samePrivateTty = true;
        for (const p of [login, shell])
          for (const fd of ["0", "1", "2"])
            samePrivateTty &&=
              (await readlink(`/proc/${p.pid}/fd/${fd}`)) === tty;
        const loginGroup = await readFile(`/proc/${login.pid}/cgroup`, "utf8"),
          shellGroup = await readFile(`/proc/${shell.pid}/cgroup`, "utf8"),
          sameUserSession =
            loginGroup === shellGroup &&
            new RegExp(
              `/user\\.slice/user-${shell.uid}\\.slice/session-[A-Za-z0-9]+\\.scope(?:/|$)`,
              "m",
            ).test(loginGroup);
        const waiting = async () =>
          isPrivateTtyInputWait(
            process.arch,
            (await processIdentity(shell.pid)).state,
            await readFile(`/proc/${shell.pid}/syscall`, "utf8"),
          );
        const waitingForStdin = await waiting();
        const stable =
          [init, login, shell].every(
            (p) =>
              native.processes.find((n) => n.pid === p.pid)?.startTicks ===
              p.startTicks,
          ) &&
          sameInstance(init, await processIdentity(initPid)) &&
          sameInstance(login, await processIdentity(login.pid)) &&
          sameInstance(shell, await processIdentity(shell.pid)) &&
          (await masterIndex(initPid, master)) === ttyIndex &&
          (await waiting());
        proofs.push({
          init,
          login,
          shell,
          uid: shell.uid,
          ttyIndex,
          masterOwnerPid: initPid,
          samePrivateTty,
          sameUserSession,
          waitingForStdin,
          stable,
        });
      } catch {
        // A running/changed/unreadable shell remains visible work, never background.
      }
    }
  } catch {
    return [];
  }
  return provenWslSystemdSessionPids(policy, proofs);
}
