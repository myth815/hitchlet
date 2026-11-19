// Synthetic local Engine/sysfs facts only; no Docker, TUN or host commands run.
import { beforeEach, expect, it, vi } from "vitest";
import { runtimeNetworkPlanSchema } from "@hitchlet/contracts/internal";
import { LocalEngine } from "../src/engine.js";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/command-exec.js", () => ({
  runFixedCommand: command,
  isFixedCommandTimeout: () => false,
}));
vi.mock("node:fs/promises", () => ({
  access: vi.fn(async () => {}),
  readFile: vi.fn(async () => "1\n"),
  writeFile: vi.fn(),
}));

const plan = runtimeNetworkPlanSchema.parse({
  installationId: "install",
  runtimeIdentityId: "runtime",
  nativeEngineId: "engine",
  allocationId: "allocation",
  generation: 1,
  operationId: "operation",
  controlVersion: 1,
  networkId: "network",
  networkName: "owned-bridge",
  networkSubnet: "172.30.77.0/24",
  containerIds: ["workload", "gateway"],
  bridgeInterface: "br-fixture",
  bridgeGateway: "172.30.77.1",
  userlandProxy: false,
  publishedPorts: [],
  grantId: "grant",
  networkRevisionId: "revision",
  frozenDenyRevisionId: "deny",
  effectiveDenyRevisionId: "deny",
  ingressSourceCidrs: [],
  egress: [],
  managementDeny: [],
  expectedRulesetHash: "sha256:" + "a".repeat(64),
  memberLinks: [
    {
      fromContainerId: "gateway",
      toContainerId: "workload",
      fromIpv4: "172.30.77.3",
      toIpv4: "172.30.77.2",
      protocol: "tcp",
      ports: [3000],
    },
  ],
});
const labels = {
  "io.hitchlet.installation": "install",
  "io.hitchlet.runtime": "runtime",
  "io.hitchlet.allocation": "allocation",
  "io.hitchlet.generation": "1",
};
let containers: Record<string, any>;
const engine = () =>
  new LocalEngine({
    dockerHost: "unix:///run/docker.sock",
    nativeEngineId: "engine",
    ipv6SysctlRoot: "/synthetic-ipv6",
  });
beforeEach(() => {
  containers = Object.fromEntries(
    ["workload", "gateway"].map((name, n) => [
      name,
      {
        Id: name,
        Config: { Labels: labels },
        State: { Running: true },
        HostConfig: {
          NetworkMode: plan.networkName,
          Privileged: false,
          PortBindings: {},
          Sysctls: {
            "net.ipv6.conf.all.disable_ipv6": "1",
            "net.ipv6.conf.default.disable_ipv6": "1",
          },
        },
        NetworkSettings: {
          Ports: {},
          Networks: {
            [plan.networkName]: {
              NetworkID: plan.networkId,
              IPAddress: `172.30.77.${n + 2}`,
              IPAMConfig: { IPv4Address: `172.30.77.${n + 2}` },
            },
          },
        },
      },
    ]),
  );
  // Both initial info and frozen firewall readback use fixed Docker info argv.
  command.mockImplementation(async (bin: string, args: string[]) => {
    if (bin === "ip")
      return {
        stdout: JSON.stringify([
          {
            ifname: plan.bridgeInterface,
            linkinfo: {
              info_kind: "bridge",
              info_data: { nf_call_iptables: 1 },
            },
          },
        ]),
      };
    const [, , kind, , id] = args;
    if (kind === "info")
      return {
        stdout: JSON.stringify(
          args.at(-1) === "{{json .FirewallBackend}}"
            ? { Driver: "iptables", Info: [["EnableUserlandProxy", "false"]] }
            : {
                ID: "engine",
                SecurityOptions: ["name=seccomp"],
                FirewallBackend: {
                  Driver: "iptables",
                  Info: [["EnableUserlandProxy", "false"]],
                },
              },
        ),
      };
    if (kind === "network")
      return {
        stdout: JSON.stringify([
          {
            Id: plan.networkId,
            Name: plan.networkName,
            Driver: "bridge",
            Labels: labels,
            EnableIPv6: false,
            IPAM: {
              Config: [
                { Subnet: plan.networkSubnet, Gateway: plan.bridgeGateway },
              ],
            },
            Options: { "com.docker.network.bridge.name": plan.bridgeInterface },
          },
        ]),
      };
    if (kind === "container")
      return { stdout: JSON.stringify([containers[id!]]) };
    throw new Error("Unexpected synthetic command");
  });
});

it("binds each member link to actual running IP or its pre-start Engine reservation", async () => {
  await expect(engine().inspectAllocation(plan)).resolves.toMatchObject({
    bridge: plan.bridgeInterface,
  });
  for (const c of Object.values(containers)) {
    c.State.Running = false;
    c.NetworkSettings.Networks[plan.networkName].IPAddress = "";
  }
  await expect(engine().inspectAllocation(plan)).resolves.toMatchObject({
    containers: expect.any(Array),
  });
});

it("rejects changed IPs, foreign attachments and unknown ownership", async () => {
  const original = structuredClone(containers);
  for (const mutate of [
    () => {
      containers.gateway.NetworkSettings.Networks[plan.networkName].IPAddress =
        "172.30.77.4";
    },
    () => {
      containers.gateway.NetworkSettings.Networks.other = {
        NetworkID: "foreign",
      };
    },
    () => {
      containers.gateway.Config.Labels = {
        ...labels,
        "io.hitchlet.allocation": "other",
      };
    },
    () => {
      containers.gateway.HostConfig.Privileged = true;
    },
  ]) {
    containers = structuredClone(original);
    mutate();
    await expect(engine().inspectAllocation(plan)).rejects.toThrow();
  }
  const outside = {
    ...plan,
    memberLinks: [{ ...plan.memberLinks![0]!, fromIpv4: "172.30.78.3" }],
  };
  containers = structuredClone(original);
  containers.gateway.NetworkSettings.Networks[plan.networkName].IPAddress =
    "172.30.78.3";
  await expect(engine().inspectAllocation(outside)).rejects.toThrow(
    /address differs/,
  );
});
