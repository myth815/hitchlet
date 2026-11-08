import { expect, it } from "vitest";
import {
  provenWslManagementPids,
  type ManagementView,
  type ManagementContainer,
} from "../src/host-wsl-management.js";
import {
  wslBindingSchema,
  wslBindingHash,
  wslWorkloadReasons,
} from "../src/host-wsl.js";
const binary = (executable: string) => ({
  executable,
  sha256: "a".repeat(64),
  file: {
    dev: 1,
    ino: 2,
    size: 30,
    mtimeMs: 10,
    ctimeMs: 10,
    uid: 0,
    mode: 0o755,
  },
});
const cid = "b".repeat(64),
  image = "sha256:" + "c".repeat(64);
function fixture() {
  const policy = {
    wslBase: binary("/init"),
    systemdPam: binary("/usr/lib/systemd/systemd-executor"),
    udevWorkers: binary("/usr/bin/udevadm"),
    unattendedShutdown: {
      python: binary("/usr/bin/python3.12"),
      script: binary(
        "/usr/share/unattended-upgrades/unattended-upgrade-shutdown",
      ),
    },
    rootlessDocker: {
      uid: 1000,
      unit: "docker.service",
      rootlesskit: binary("/home/openclaw/bin/rootlesskit"),
      slirp: binary("/usr/bin/slirp4netns"),
      dockerd: binary("/home/openclaw/bin/dockerd"),
      containerd: binary("/home/openclaw/bin/containerd"),
      shim: binary("/home/openclaw/bin/containerd-shim-runc-v2"),
      proxy: binary("/home/openclaw/bin/docker-proxy"),
      containerdAddress: "/run/user/1000/docker/containerd/containerd.sock",
    },
  };
  const binding = wslBindingSchema.parse({
    name: "ComputeNode",
    registrationId: "217a11ed-f854-430e-b104-513b5771eee9",
    distributionMachineId: "d".repeat(32),
    management: policy,
    engines: [
      {
        nativeEngineId: "engine",
        dockerHost: "unix:///run/user/1000/docker.sock",
        backgroundContainers: [
          { id: cid, imageId: image, uid: 1000, executable: "/app/agent" },
        ],
      },
    ],
  });
  const p = (
    pid: number,
    parentPid: number,
    executable: string,
    extra: Partial<ManagementView> = {},
  ): ManagementView => ({
    pid,
    parentPid,
    uid: 0,
    startTicks: String(pid),
    executable,
    comm: "",
    namespace: "pid:[1]",
    unit: null,
    session: 0,
    cgroup: "/base",
    networkNamespace: "net:[1]",
    argv: [],
    binaryMatch: true,
    ...extra,
  });
  const views = [
    p(2, 1, "/init", { comm: "init-systemd(Co" }),
    p(3, 2, "/init", { comm: "init-watcher", argv: ["init-watcher"] }),
    p(5, 2, "/init", {
      comm: "init",
      argv: [
        "plan9",
        "--control-socket",
        "7",
        "--log-level",
        "4",
        "--server-fd",
        "8",
        "--pipe-fd",
        "10",
        "--log-truncate",
      ],
    }),
    p(10, 1, "/usr/lib/systemd/systemd", {
      uid: 1000,
      unit: "user@1000.service",
      cgroup: "/user.slice/user-1000.slice/user@1000.service/init.scope",
    }),
    p(11, 10, policy.systemdPam.executable, {
      uid: 1000,
      unit: "user@1000.service",
      cgroup: "/user.slice/user-1000.slice/user@1000.service/init.scope",
      comm: "(sd-pam)",
    }),
    p(20, 1, policy.udevWorkers.executable, { unit: "systemd-udevd.service" }),
    p(21, 20, policy.udevWorkers.executable, {
      unit: "systemd-udevd.service",
      comm: "(udev-worker)",
    }),
    p(30, 1, policy.unattendedShutdown.python.executable, {
      unit: "unattended-upgrades.service",
      argv: [
        "/usr/bin/python3",
        policy.unattendedShutdown.script.executable,
        "--wait-for-signal",
      ],
    }),
  ];
  const docker = (
    pid: number,
    parent: number,
    path: string,
    extra: Partial<ManagementView> = {},
  ) =>
    p(pid, parent, path, {
      uid: 1000,
      unit: "docker.service",
      cgroup: "/docker.service",
      ...extra,
    });
  views.push(
    docker(40, 10, policy.rootlessDocker.rootlesskit.executable),
    docker(41, 40, policy.rootlessDocker.rootlesskit.executable, {
      comm: "exe",
      networkNamespace: "net:[rootless-inner]",
    }),
    docker(42, 40, policy.rootlessDocker.slirp.executable, {
      comm: "slirp4netns",
    }),
    docker(43, 41, policy.rootlessDocker.dockerd.executable, {
      comm: "dockerd",
    }),
    docker(44, 43, policy.rootlessDocker.containerd.executable, {
      comm: "containerd",
    }),
    docker(45, 10, policy.rootlessDocker.shim.executable, {
      session: 44,
      argv: [
        policy.rootlessDocker.shim.executable,
        "-namespace",
        "moby",
        "-id",
        cid,
        "-address",
        policy.rootlessDocker.containerdAddress,
      ],
    }),
    docker(46, 43, policy.rootlessDocker.proxy.executable, {
      networkNamespace: "net:[rootless-inner]",
      argv: [
        policy.rootlessDocker.proxy.executable,
        "-proto",
        "tcp",
        "-host-ip",
        "127.0.0.1",
        "-host-port",
        "5202",
        "-container-ip",
        "172.17.0.2",
        "-container-port",
        "9001",
        "-use-listen-fd",
      ],
    }),
    p(47, 45, "/app/agent", { uid: 1000 }),
  );
  const containers: ManagementContainer[] = [
    {
      id: cid,
      imageId: image,
      pid: 47,
      execIds: null,
      ports: { "9001/tcp": [{ HostIp: "0.0.0.0", HostPort: "5202" }] },
      networks: { bridge: { IPAddress: "172.17.0.2" } },
    },
  ];
  return { binding, views, background: [10, 20, 40], containers };
}
it("recognizes only registered fixed infrastructure helpers and exact management container plumbing", () => {
  const f = fixture();
  expect(
    provenWslManagementPids(
      f.binding,
      f.views,
      f.background,
      f.containers,
      30,
    ).sort((a, b) => a - b),
  ).toEqual([2, 3, 5, 11, 21, 30, 41, 42, 43, 44, 45, 46]);
});
it.each([
  "unregistered-parent",
  "foreign-uid",
  "changed-binary",
  "foreign-watcher",
  "other-plan9",
  "pam-exec",
  "udev-script",
  "python-task",
  "wrong-shim-id",
  "wrong-shim-session",
  "wrong-proxy-port",
  "wrong-proxy-net",
  "wrong-container-image",
  "exec-id-retained",
  "real-child",
])("preserves work for %s", (kind) => {
  const f = fixture(),
    v = (id: number) => f.views.find((x) => x.pid === id)!;
  let refused: number[] = [];
  if (kind === "unregistered-parent") {
    f.background = [];
    refused = [11, 21, 41, 42, 43, 44, 45, 46];
  }
  if (kind === "foreign-uid") {
    v(11).uid = 0;
    refused = [11];
  }
  if (kind === "changed-binary") {
    v(21).binaryMatch = false;
    refused = [21];
  }
  if (kind === "foreign-watcher") {
    v(3).parentPid = 4;
    refused = [3];
  }
  if (kind === "other-plan9") {
    v(5).argv = ["plan9", "work"];
    refused = [5];
  }
  if (kind === "pam-exec") {
    v(11).comm = "task";
    refused = [11];
  }
  if (kind === "udev-script") {
    v(21).executable = "/bin/sh";
    refused = [21];
  }
  if (kind === "python-task") {
    v(30).argv = ["/usr/bin/python3", "/work/job.py"];
    refused = [30];
  }
  if (kind === "wrong-shim-id") {
    v(45).argv[4] = "f".repeat(64);
    refused = [45];
  }
  if (kind === "wrong-shim-session") {
    v(45).session = 999;
    refused = [45];
  }
  if (kind === "wrong-proxy-port") {
    v(46).argv[6] = "9999";
    refused = [46];
  }
  if (kind === "wrong-proxy-net") {
    v(46).networkNamespace = "net:[2]";
    refused = [46];
  }
  if (kind === "wrong-container-image") {
    f.containers[0]!.imageId = "sha256:" + "f".repeat(64);
    refused = [45, 46];
  }
  if (kind === "exec-id-retained") {
    f.containers[0]!.execIds = ["e".repeat(64)];
    refused = [45, 46];
  }
  if (kind === "real-child") {
    f.views.push({
      ...v(21),
      pid: 22,
      parentPid: 21,
      executable: "/usr/bin/python3",
    });
    refused = [22];
  }
  const result = provenWslManagementPids(
    f.binding,
    f.views,
    f.background,
    f.containers,
    30,
  );
  for (const pid of refused) expect(result).not.toContain(pid);
  expect(result).not.toContain(47); // Approved init remains under the existing separate container proof.
});
it("retains the old no-management behavior", () => {
  const f = fixture();
  delete f.binding.management;
  expect(
    provenWslManagementPids(f.binding, f.views, f.background, f.containers, 30),
  ).toEqual([]);
});
it("does not turn a configured arbitrary executable into WSL base init", () => {
  const f = fixture();
  f.binding.management!.wslBase!.executable = "/work/fake-init";
  for (const p of f.views.filter((p) => [2, 3, 5].includes(p.pid)))
    p.executable = "/work/fake-init";
  const result = provenWslManagementPids(
    f.binding,
    f.views,
    f.background,
    f.containers,
    30,
  );
  expect(result).not.toContain(2);
  expect(result).not.toContain(3);
  expect(result).not.toContain(5);
});
it("rejects an old fact after a management-only policy change", () => {
  const f = fixture(),
    b = f.binding,
    context = {
      distributionMachineId: b.distributionMachineId,
      bootId: "1b9e0b64-a6df-4a07-85bf-3c67e9591fec",
      pidNamespace: "pid:[1]",
    };
  const fact = {
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
      processes: [],
      backgroundPids: [],
      errorCodes: [],
    },
    engines: [{ nativeEngineId: "engine", complete: true, containers: [] }],
  };
  const running = [{ name: b.name, registrationId: b.registrationId }];
  expect(wslWorkloadReasons([b], running, [fact], 100000)).toEqual([]);
  b.management!.wslBase!.sha256 = "f".repeat(64);
  expect(wslWorkloadReasons([b], running, [fact], 100000)).toEqual([
    "wsl_background_policy_changed",
  ]);
});
