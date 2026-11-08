import { readFile, readlink, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RuntimeNativeWorkload } from "@hitchlet/contracts/internal";
import type {
  WslBinding,
  WslKeeperPolicy,
  WslKeeperProof,
  WslManagementBinary,
} from "./host-wsl.js";
import { runFixedCommand } from "./command-exec.js";

type Instance = {
  pid: number;
  parentPid: number;
  uid: number;
  startTicks: string;
  executable: string;
  comm: string;
  namespace: string;
  sha256?: string;
  protected?: boolean;
};
export type KeeperEvidence = {
  handshake: WslKeeperProof;
  before: Instance[];
  after: Instance[];
  nodeFileMatches: boolean;
  helperProtected: boolean;
  helperHash: string;
};
function equalInstance(a: Instance, b: Instance) {
  return [
    "pid",
    "parentPid",
    "uid",
    "startTicks",
    "executable",
    "comm",
    "namespace",
  ].every((key) => a[key as keyof Instance] === b[key as keyof Instance]);
}
/** Only the handshake-bound fixed helper and its two WSL bridges, not arbitrary sleep or descendants. */
export function provenWslKeeperPids(
  policy: WslKeeperPolicy,
  e: KeeperEvidence,
) {
  const p = e.handshake,
    chain = e.before;
  if (
    chain.length !== 4 ||
    e.after.length !== 4 ||
    new Set(chain.map((x) => x.pid)).size !== 4 ||
    !e.nodeFileMatches ||
    !e.helperProtected ||
    e.helperHash !== policy.helperSha256 ||
    p.helperSha256 !== policy.helperSha256 ||
    p.nodeSha256 !== policy.nodeSha256 ||
    p.uid !== policy.uid ||
    p.executable !== policy.nodeExecutable ||
    chain.some(
      (x, i) =>
        !equalInstance(x, e.after[i]!) || x.namespace !== p.pidNamespace,
    )
  )
    return [];
  const own = chain[0]!;
  if (
    own.pid !== p.pid ||
    own.startTicks !== p.startTicks ||
    own.parentPid !== p.parentPid ||
    own.uid !== p.uid ||
    own.executable !== p.executable
  )
    return [];
  for (let i = 1; i < 4; i++) {
    const x = chain[i]!,
      after = e.after[i]!;
    if (
      chain[i - 1]!.parentPid !== x.pid ||
      x.uid !== 0 ||
      x.executable !== "/init" ||
      x.sha256 !== policy.initSha256 ||
      after.sha256 !== policy.initSha256 ||
      !x.protected ||
      !after.protected
    )
      return [];
  }
  if (
    chain[1]!.comm !== `Relay(${p.pid})` ||
    chain[2]!.comm !== "SessionLeader" ||
    chain[3]!.parentPid !== 1
  )
    return [];
  return chain.slice(0, 3).map((x) => x.pid);
}
async function instance(pid: number): Promise<Instance> {
  const base = `/proc/${pid}`,
    s = await readFile(base + "/stat", "utf8");
  const fields = s
    .slice(s.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  const status = await readFile(base + "/status", "utf8");
  return {
    pid,
    parentPid: Number(fields[1]),
    uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]),
    startTicks: fields[19]!,
    executable: await readlink(base + "/exe"),
    comm: (await readFile(base + "/comm", "utf8")).trim(),
    namespace: await readlink(base + "/ns/pid"),
  };
}
async function protectedHash(path: string, max = 256 * 1024) {
  const a = await stat(path);
  if (!a.isFile() || a.size > max || a.uid !== 0 || a.mode & 0o022)
    throw Error("management_file_unprotected");
  const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    b = await stat(path);
  if (
    ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(
      (k) => a[k as keyof typeof a] !== b[k as keyof typeof b],
    )
  )
    throw Error("management_file_changed");
  return { sha256, protected: true };
}
export async function beginWslKeeperObservation(
  policy: WslKeeperPolicy,
  handshake: WslKeeperProof,
  helperPath: string,
) {
  const chain = async () => {
    const rows: Instance[] = [];
    let pid = handshake.pid;
    for (let i = 0; i < 4; i++) {
      const p = await instance(pid);
      rows.push({
        ...p,
        ...(i ? await protectedHash(`/proc/${pid}/exe`, 16 * 1024 * 1024) : {}),
      });
      pid = p.parentPid;
    }
    return rows;
  };
  const before = await chain().catch(() => []);
  const files = async () => {
    const node = await stat(`/proc/${handshake.pid}/exe`);
    const fileMatches =
      node.isFile() &&
      [0, policy.uid].includes(node.uid) &&
      node.size <= 256 * 1024 * 1024 &&
      !(node.mode & 0o022) &&
      Object.entries(handshake.nodeFile).every(
        ([k, v]) => node[k as keyof typeof node] === v,
      );
    const helper = await protectedHash(helperPath);
    if (!fileMatches) throw Error("keeper_node_identity_changed");
    // The original observer already trusts this same-owner Node. Keep the startup
    // provenance hash and bind its unchanged file instance; do not rehash 123MB each tick.
    const after = await stat(`/proc/${handshake.pid}/exe`);
    if (
      !["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(
        (k) => node[k as keyof typeof node] === after[k as keyof typeof after],
      )
    )
      throw Error("keeper_node_changed_during_hash");
    const argv = (await readFile(`/proc/${handshake.pid}/cmdline`))
      .toString()
      .split("\0")
      .filter(Boolean);
    return {
      nodeFileMatches:
        fileMatches &&
        argv.length === 2 &&
        argv[0] === policy.nodeExecutable &&
        argv[1] === helperPath,
      helperProtected: helper.protected,
      helperHash: helper.sha256,
    };
  };
  const initialFiles = await files().catch(() => null);
  return async (native: RuntimeNativeWorkload): Promise<number[]> => {
    if (
      !native.complete ||
      native.errorCodes.length ||
      native.bootId !== handshake.bootId ||
      native.distributionMachineId !== handshake.distributionMachineId ||
      native.namespaces?.pid !== handshake.pidNamespace ||
      !initialFiles?.nodeFileMatches ||
      !initialFiles.helperProtected ||
      initialFiles.helperHash !== policy.helperSha256
    )
      return [];
    try {
      const currentFiles = await files(),
        after = await chain();
      const approved = provenWslKeeperPids(policy, {
        handshake,
        before,
        after,
        ...currentFiles,
      });
      return approved.every((pid) => {
        const a = before.find((p) => p.pid === pid)!,
          n = native.processes.find((p) => p.pid === pid);
        return (
          n?.startTicks === a.startTicks &&
          n.parentPid === a.parentPid &&
          n.uid === a.uid &&
          n.executable === a.executable
        );
      })
        ? approved
        : [];
    } catch {
      return [];
    }
  };
}

export type ManagementView = Instance & {
  unit: string | null;
  session: number;
  cgroup: string;
  networkNamespace: string;
  argv: string[];
  binaryMatch: boolean;
};
export type ManagementContainer = {
  id: string;
  imageId: string;
  pid: number;
  execIds: string[] | null;
  ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  networks: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
};

/** Fixed platform roles only. Every other PID, including children in the same unit, remains work. */
export function provenWslManagementPids(
  binding: WslBinding,
  views: readonly ManagementView[],
  backgroundPids: readonly number[],
  containers: readonly ManagementContainer[],
  unattendedMainPid?: number,
) {
  const policy = binding.management;
  if (!policy) return [];
  const approved = new Set<number>();
  const main = (unit: string, uid: number, exe?: string) =>
    views.find(
      (p) =>
        backgroundPids.includes(p.pid) &&
        p.unit === unit &&
        p.uid === uid &&
        (!exe || p.executable === exe),
    );
  const sameGroup = (p: ManagementView, m: ManagementView) =>
    p.uid === m.uid && p.cgroup === m.cgroup && p.namespace === m.namespace;
  if (policy.wslBase?.executable === "/init") {
    const base = views.filter(
      (p) =>
        p.parentPid === 1 &&
        p.uid === 0 &&
        p.executable === policy.wslBase!.executable &&
        p.binaryMatch &&
        p.comm === ("init-systemd(" + binding.name + ")").slice(0, 15),
    );
    if (base.length === 1) {
      const b = base[0]!;
      approved.add(b.pid);
      for (const p of views.filter(
        (p) =>
          p.parentPid === b.pid &&
          p.uid === 0 &&
          p.executable === b.executable &&
          p.binaryMatch &&
          p.namespace === b.namespace,
      )) {
        const plan9 =
          p.comm === "init" &&
          p.argv.length === 10 &&
          p.argv[0] === "plan9" &&
          p.argv[1] === "--control-socket" &&
          /^\d+$/.test(p.argv[2]!) &&
          p.argv[3] === "--log-level" &&
          /^\d+$/.test(p.argv[4]!) &&
          p.argv[5] === "--server-fd" &&
          /^\d+$/.test(p.argv[6]!) &&
          p.argv[7] === "--pipe-fd" &&
          /^\d+$/.test(p.argv[8]!) &&
          p.argv[9] === "--log-truncate";
        if (
          (p.comm === "init-watcher" &&
            p.argv.length === 1 &&
            p.argv[0] === "init-watcher") ||
          plan9
        )
          approved.add(p.pid);
      }
    }
  }
  for (const p of views) {
    if (
      policy.systemdPam &&
      p.executable === policy.systemdPam.executable &&
      p.binaryMatch &&
      p.comm === "(sd-pam)"
    ) {
      const m = main(
        `user@${p.uid}.service`,
        p.uid,
        "/usr/lib/systemd/systemd",
      );
      if (
        m &&
        p.parentPid === m.pid &&
        sameGroup(p, m) &&
        p.cgroup.endsWith("/init.scope")
      )
        approved.add(p.pid);
    }
    if (
      policy.udevWorkers &&
      p.executable === policy.udevWorkers.executable &&
      p.binaryMatch &&
      p.comm === "(udev-worker)"
    ) {
      const m = main("systemd-udevd.service", 0, policy.udevWorkers.executable);
      if (m && p.parentPid === m.pid && sameGroup(p, m)) approved.add(p.pid);
    }
    if (
      policy.unattendedShutdown &&
      p.pid === unattendedMainPid &&
      p.uid === 0 &&
      p.unit === "unattended-upgrades.service" &&
      p.binaryMatch &&
      p.executable === policy.unattendedShutdown.python.executable &&
      p.argv.length === 3 &&
      /^\/usr\/bin\/python3(?:\.\d+)?$/.test(p.argv[0]!) &&
      p.argv[1] === policy.unattendedShutdown.script.executable &&
      p.argv[2] === "--wait-for-signal"
    )
      approved.add(p.pid);
  }
  const d = policy.rootlessDocker;
  if (!d) return [...approved];
  const root = main(d.unit, d.uid, d.rootlesskit.executable);
  if (!root || !root.binaryMatch) return [...approved];
  const child = (parent: number, b: WslManagementBinary, comm?: string) => {
    const list = views.filter(
      (p) =>
        p.parentPid === parent &&
        p.executable === b.executable &&
        p.binaryMatch &&
        sameGroup(p, root) &&
        (!comm || p.comm === comm),
    );
    return list.length === 1 ? list[0] : undefined;
  };
  const inner = child(root.pid, d.rootlesskit, "exe"),
    slirp = child(root.pid, d.slirp, "slirp4netns");
  if (inner) approved.add(inner.pid);
  if (slirp) approved.add(slirp.pid);
  const daemon = inner && child(inner.pid, d.dockerd, "dockerd");
  if (!daemon) return [...approved];
  approved.add(daemon.pid);
  const containerd = child(daemon.pid, d.containerd, "containerd");
  if (containerd) approved.add(containerd.pid);
  const registered = binding.engines.flatMap(
    (e) => e.backgroundContainers ?? [],
  );
  for (const c of containers) {
    if (
      !registered.some((r) => r.id === c.id && r.imageId === c.imageId) ||
      c.execIds?.length
    )
      continue; // retained ExecIDs are conservatively held, not asserted to be active.
    const init = views.find((p) => p.pid === c.pid && p.uid === d.uid);
    if (!init) continue;
    if (d.shim && containerd) {
      const shim = views.find(
        (p) =>
          p.pid === init.parentPid &&
          p.executable === d.shim!.executable &&
          p.binaryMatch &&
          sameGroup(p, root) &&
          p.session === containerd.pid &&
          (p.parentPid === containerd.pid || p.parentPid === root.parentPid) &&
          p.argv.length === 7 &&
          p.argv[0] === d.shim!.executable &&
          p.argv[1] === "-namespace" &&
          p.argv[2] === "moby" &&
          p.argv[3] === "-id" &&
          p.argv[4] === c.id &&
          p.argv[5] === "-address" &&
          p.argv[6] === d.containerdAddress,
      );
      if (shim) approved.add(shim.pid);
    }
    if (d.proxy)
      for (const p of views.filter(
        (p) =>
          p.parentPid === daemon.pid &&
          p.executable === d.proxy!.executable &&
          p.binaryMatch &&
          sameGroup(p, root) &&
          // rootlesskit --detach-netns keeps the proxy in the registered inner
          // namespace even when dockerd itself uses the parent network namespace.
          p.networkNamespace === inner?.networkNamespace,
      )) {
        const options = new Map<string, string>();
        let valid = p.argv[0] === d.proxy.executable;
        for (let i = 1; i < p.argv.length; i++) {
          const key = p.argv[i]!;
          if (key === "-use-listen-fd") {
            if (i !== p.argv.length - 1) valid = false;
            continue;
          }
          if (
            ![
              "-proto",
              "-host-ip",
              "-host-port",
              "-container-ip",
              "-container-port",
            ].includes(key) ||
            options.has(key) ||
            i + 1 >= p.argv.length
          ) {
            valid = false;
            break;
          }
          options.set(key, p.argv[++i]!);
        }
        if (!valid || options.size !== 5) continue;
        const port =
          c.ports[options.get("-container-port") + "/" + options.get("-proto")];
        const ip = options.get("-container-ip");
        if (
          Object.values(c.networks).some(
            (n) => n.IPAddress === ip || n.GlobalIPv6Address === ip,
          ) &&
          port?.some(
            (h) =>
              h.HostPort === options.get("-host-port") &&
              (h.HostIp === options.get("-host-ip") ||
                (h.HostIp === "0.0.0.0" &&
                  options.get("-host-ip") === "127.0.0.1") ||
                (h.HostIp === "::" && options.get("-host-ip") === "::1")),
          )
        )
          approved.add(p.pid);
      }
  }
  return [...approved];
}

/** Binary hashes are verified once at normal policy registration; stat identities detect any later replacement. */
export async function collectWslManagementBackground(
  binding: WslBinding,
  native: RuntimeNativeWorkload,
  containers: ManagementContainer[],
) {
  const policy = binding.management;
  if (!policy || !native.complete || native.errorCodes.length) return [];
  const binaries = [
    policy.wslBase,
    policy.systemdPam,
    policy.udevWorkers,
    policy.unattendedShutdown?.python,
    policy.unattendedShutdown?.script,
    ...Object.values(policy.rootlessDocker ?? {}).filter(
      (x) => x && typeof x === "object" && "executable" in x,
    ),
  ].filter((x): x is WslManagementBinary => !!x);
  const match = async (path: string) => {
    const b = binaries.find((b) => b.executable === path);
    if (!b) return false;
    const s = await stat(path);
    return (
      s.isFile() &&
      !(s.mode & 0o022) &&
      Object.entries(b.file).every(
        ([k, v]) =>
          (k === "mode" ? s.mode & 0o7777 : s[k as keyof typeof s]) === v,
      )
    );
  };
  const views: ManagementView[] = [];
  for (const p of native.processes) {
    if (
      !p.executable ||
      (!binaries.some((b) => b.executable === p.executable) &&
        !native.backgroundPids.includes(p.pid) &&
        !containers.some((c) => c.pid === p.pid))
    )
      continue;
    try {
      const live = await instance(p.pid);
      if (
        live.startTicks !== p.startTicks ||
        live.parentPid !== p.parentPid ||
        live.uid !== p.uid ||
        live.executable !== p.executable
      )
        continue;
      const text = await readFile(`/proc/${p.pid}/stat`, "utf8"),
        f = text
          .slice(text.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/);
      const args = await readFile(`/proc/${p.pid}/cmdline`);
      if (args.length > 8192) continue;
      views.push({
        ...live,
        unit: p.unit,
        session: Number(f[3]),
        networkNamespace: await readlink(`/proc/${p.pid}/ns/net`),
        cgroup: (await readFile(`/proc/${p.pid}/cgroup`, "utf8")).trim(),
        argv: args.toString().split("\0").filter(Boolean),
        binaryMatch: await match(live.executable),
      });
    } catch {
      /* changed/exited candidates remain work, not an invented idle. */
    }
  }
  let unattendedMain: number | undefined;
  if (policy.unattendedShutdown)
    try {
      if (await match(policy.unattendedShutdown.script.executable)) {
        const { stdout } = await runFixedCommand(
          "systemctl",
          [
            "show",
            "unattended-upgrades.service",
            "--property=MainPID,ActiveState",
          ],
          { maxBuffer: 4096 },
        );
        if (/^ActiveState=active$/m.test(stdout))
          unattendedMain = Number(stdout.match(/^MainPID=(\d+)$/m)?.[1]);
      }
    } catch {
      /* Cannot prove this helper. */
    }
  const proposed = provenWslManagementPids(
      binding,
      views,
      native.backgroundPids,
      containers,
      unattendedMain,
    ),
    approved: number[] = [];
  // A helper is valid only while its exact parent/service anchor is still the sampled instance.
  for (const before of views)
    try {
      const after = await instance(before.pid);
      if (
        !equalInstance(before, after) ||
        (await readFile(`/proc/${before.pid}/cgroup`, "utf8")).trim() !==
          before.cgroup ||
        (await readlink(`/proc/${before.pid}/ns/net`)) !==
          before.networkNamespace ||
        (await readFile(`/proc/${before.pid}/cmdline`))
          .toString()
          .split("\0")
          .filter(Boolean)
          .join("\0") !== before.argv.join("\0")
      )
        return [];
    } catch {
      return [];
    }
  if (
    policy.unattendedShutdown &&
    proposed.includes(unattendedMain!) &&
    !(await match(policy.unattendedShutdown.script.executable))
  )
    return [];
  for (const pid of proposed) {
    const before = views.find((v) => v.pid === pid)!;
    try {
      const after = await instance(pid);
      if (
        equalInstance(before, after) &&
        (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim() ===
          before.cgroup &&
        (await match(after.executable))
      )
        approved.push(pid);
    } catch {
      /* PID reuse/change stays held. */
    }
  }
  return approved;
}
