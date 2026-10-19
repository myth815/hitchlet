import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIPv4 } from "node:net";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeNetworkPlan } from "@hitchlet/contracts/internal";

const execute = promisify(execFile);
const LABEL = "io.hitchlet";
type Json = Record<string, any>;

export type EngineConfig = Readonly<{
  dockerHost: string;
  nativeEngineId: string;
  /** Host /proc/sys/net/ipv6/conf, or a dedicated bind-mounted equivalent. */
  ipv6SysctlRoot: string;
}>;

/** Talks only to the configured local daemon through fixed Docker subcommands; never invokes a shell. */
export class LocalEngine {
  constructor(private readonly config: EngineConfig) {
    if (!config.dockerHost.startsWith("unix://"))
      throw new Error("Runtime Agent requires a local Unix Docker socket");
  }

  private async docker(args: readonly string[]): Promise<string> {
    const { DOCKER_CONTEXT: inheritedContext, ...environment } = process.env;
    void inheritedContext;
    const { stdout } = await execute(
      "docker",
      ["--host", this.config.dockerHost, ...args],
      {
        env: { ...environment, DOCKER_HOST: this.config.dockerHost },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return stdout.trim();
  }

  async assertEngine(): Promise<string> {
    const id = await this.docker(["info", "--format", "{{.ID}}"]);
    if (!id || id !== this.config.nativeEngineId)
      throw new Error("Native Engine identity mismatch");
    const backend = await this.firewallBackend();
    if (backend.driver !== "iptables")
      throw new Error("Docker iptables firewall backend is required");
    return id;
  }

  private async firewallBackend(): Promise<{
    driver: string;
    userlandProxy: boolean;
  }> {
    const raw = await this.docker([
      "info",
      "--format",
      "{{json .FirewallBackend}}",
    ]);
    return parseFirewallBackend(raw);
  }

  async inspectAllocation(
    plan: RuntimeNetworkPlan,
    options: {
      enforceIPv6?: boolean;
      enforceBridgeNetfilter?: boolean;
    } = {},
  ): Promise<{
    bridge: string;
    gateway: string;
    subnet: string;
    containers: readonly Json[];
  }> {
    await this.assertEngine();
    if (plan.nativeEngineId !== this.config.nativeEngineId)
      throw new Error("Plan targets another Engine");
    const networks = JSON.parse(
      await this.docker(["network", "inspect", plan.networkId]),
    ) as Json[];
    if (networks.length !== 1)
      throw new Error("Docker network query incomplete");
    const network = networks[0]!;
    const labels = network.Labels ?? {};
    this.assertLabels(labels, plan);
    if (
      network.Id !== plan.networkId ||
      network.Name !== plan.networkName ||
      network.Driver !== "bridge"
    )
      throw new Error("Allocation network identity mismatch");
    if (network.EnableIPv6 !== false)
      throw new Error("Allocation Docker network IPv6 is not disabled");
    const config = (network.IPAM?.Config ?? []).find(
      (item: Json) => item.Subnet === plan.networkSubnet,
    );
    if (!config)
      throw new Error("Allocation subnet does not match Docker network");
    const bridge =
      network.Options?.["com.docker.network.bridge.name"] ??
      `br-${String(network.Id).slice(0, 12)}`;
    if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(bridge))
      throw new Error("Invalid Docker bridge interface name");
    await access(`/sys/class/net/${bridge}/bridge`);
    const gateway = config.Gateway;
    if (
      typeof gateway !== "string" ||
      gateway !== plan.bridgeGateway ||
      bridge !== plan.bridgeInterface
    )
      throw new Error(
        "Bridge details do not match locally inspected Docker Engine values",
      );
    if ((await this.firewallBackend()).userlandProxy !== plan.userlandProxy)
      throw new Error(
        "Docker userland-proxy mode differs from the frozen network plan",
      );
    const containers: Json[] = [];
    for (const id of plan.containerIds) {
      const inspected = JSON.parse(
        await this.docker(["container", "inspect", id]),
      ) as Json[];
      if (inspected.length !== 1) throw new Error("Container query incomplete");
      const container = inspected[0]!;
      this.assertLabels(container.Config?.Labels ?? {}, plan);
      if (container.HostConfig?.NetworkMode !== plan.networkName)
        throw new Error("Container network mode does not match its allocation");
      if (
        container.HostConfig?.Sysctls?.["net.ipv6.conf.all.disable_ipv6"] !==
          "1" ||
        container.HostConfig?.Sysctls?.[
          "net.ipv6.conf.default.disable_ipv6"
        ] !== "1"
      )
        throw new Error("Container IPv6 must be disabled before start");
      const attachments = Object.values(
        container.NetworkSettings?.Networks ?? {},
      ) as Json[];
      const running = container.State?.Running === true;
      if (
        running &&
        (attachments.length !== 1 ||
          attachments[0]?.NetworkID !== plan.networkId)
      )
        throw new Error(
          "Container must be attached only to its allocation network",
        );
      if (
        !running &&
        attachments.some(
          (item) => item.NetworkID && item.NetworkID !== plan.networkId,
        )
      )
        throw new Error(
          "Stopped container has a conflicting network attachment",
        );
      if (container.HostConfig?.NetworkMode === "host")
        throw new Error("Host network mode is forbidden");
      if (container.HostConfig?.Privileged)
        throw new Error("Privileged containers are forbidden");
      containers.push(container);
    }
    if (options.enforceIPv6)
      await disableAndVerifyBridgeIPv6(this.config.ipv6SysctlRoot, bridge);
    else await verifyBridgeIPv6Disabled(this.config.ipv6SysctlRoot, bridge);
    await requireBridgeNetfilterModule();
    if (options.enforceBridgeNetfilter)
      await enableAndVerifyBridgeNetfilter(bridge);
    else await verifyBridgeNetfilter(bridge);
    await verifyBridgeNetfilterSysfs(bridge);
    this.assertPublishedPorts(plan, containers);
    return { bridge, gateway, subnet: plan.networkSubnet, containers };
  }

  async assertAllocationAbsent(plan: RuntimeNetworkPlan): Promise<void> {
    await this.assertEngine();
    const allocationFilter = `label=${LABEL}.allocation=${plan.allocationId}`;
    const [containerIds, networkIds] = await Promise.all([
      this.docker(["ps", "-aq", "--filter", allocationFilter]),
      this.docker(["network", "ls", "-q", "--filter", allocationFilter]),
    ]);
    if (containerIds || networkIds)
      throw new Error(
        "Allocation resources are still present on the verified Engine",
      );
  }

  private assertLabels(labels: Json, plan: RuntimeNetworkPlan): void {
    if (
      labels[`${LABEL}.installation`] !== plan.installationId ||
      labels[`${LABEL}.runtime`] !== plan.runtimeIdentityId ||
      labels[`${LABEL}.allocation`] !== plan.allocationId ||
      labels[`${LABEL}.generation`] !== String(plan.generation)
    ) {
      throw new Error("Docker object ownership labels do not match the plan");
    }
  }

  private assertPublishedPorts(
    plan: RuntimeNetworkPlan,
    containers: readonly Json[],
  ): void {
    const configured: string[] = [];
    const resolved: string[] = [];
    for (const container of containers) {
      const id = container.Id;
      for (const [key, bindings] of Object.entries(
        container.HostConfig?.PortBindings ?? {},
      ) as [string, any][]) {
        for (const binding of bindings ?? []) {
          const [containerPort, protocol] = key.split("/");
          configured.push(
            `${id}|${protocol}|${binding.HostIp || "0.0.0.0"}|${binding.HostPort}|${containerPort}`,
          );
        }
      }
      if (container.State?.Running) {
        for (const [key, bindings] of Object.entries(
          container.NetworkSettings?.Ports ?? {},
        ) as [string, any][]) {
          for (const binding of bindings ?? []) {
            const [containerPort, protocol] = key.split("/");
            resolved.push(
              `${id}|${protocol}|${binding.HostIp || "0.0.0.0"}|${binding.HostPort}|${containerPort}`,
            );
          }
        }
      }
    }
    const expected = plan.publishedPorts.map(
      (port) =>
        `${port.containerId}|${port.protocol}|${port.hostAddress}|${port.hostPort}|${port.containerPort}`,
    );
    if (expected.some((entry) => !isIPv4(entry.split("|")[2]!)))
      throw new Error("IPv6 or non-IP published host bindings are unsupported");
    if (
      configured.sort().join("\n") !== expected.sort().join("\n") ||
      (containers.some((container) => container.State?.Running) &&
        resolved.sort().join("\n") !== expected.sort().join("\n"))
    )
      throw new Error(
        "Published port bindings are missing, dynamic, or not fully described",
      );
  }
}

/** Disable only this verified Docker bridge, then require a successful sysctl readback. */
export async function disableAndVerifyBridgeIPv6(
  sysctlRoot: string,
  bridge: string,
): Promise<void> {
  const sysctlFile = bridgeSysctlPath(sysctlRoot, bridge);
  const before = (await readFile(sysctlFile, "utf8")).trim();
  if (before !== "1") await writeFile(sysctlFile, "1\n", "utf8");
  await verifyBridgeIPv6Disabled(sysctlRoot, bridge);
}

export async function verifyBridgeIPv6Disabled(
  sysctlRoot: string,
  bridge: string,
): Promise<void> {
  const value = await readFile(bridgeSysctlPath(sysctlRoot, bridge), "utf8");
  if (value.trim() !== "1")
    throw new Error("IPv6 remains enabled on the allocation bridge");
}

function bridgeSysctlPath(sysctlRoot: string, bridge: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(bridge))
    throw new Error("Invalid Docker bridge interface name");
  return join(sysctlRoot, bridge, "disable_ipv6");
}

export type IpCommand = (args: readonly string[]) => Promise<string>;

export async function enableAndVerifyBridgeNetfilter(
  bridge: string,
  runIp: IpCommand = async (args) => {
    const { stdout } = await execute("ip", [...args], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  },
): Promise<void> {
  assertBridgeName(bridge);
  if (!(await bridgeNetfilterEnabled(bridge, runIp)))
    await runIp([
      "link",
      "set",
      "dev",
      bridge,
      "type",
      "bridge",
      "nf_call_iptables",
      "1",
    ]);
  if (!(await bridgeNetfilterEnabled(bridge, runIp)))
    throw new Error("Allocation bridge iptables hooks are not enabled");
}

export async function verifyBridgeNetfilter(
  bridge: string,
  runIp: IpCommand = async (args) => {
    const { stdout } = await execute("ip", [...args], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  },
): Promise<void> {
  assertBridgeName(bridge);
  if (!(await bridgeNetfilterEnabled(bridge, runIp)))
    throw new Error("Allocation bridge iptables hooks are not enabled");
}

async function bridgeNetfilterEnabled(
  bridge: string,
  runIp: IpCommand,
): Promise<boolean> {
  const raw = await runIp(["-j", "-d", "link", "show", "dev", bridge]);
  return parseBridgeNetfilter(raw, bridge);
}

export function parseBridgeNetfilter(raw: string, bridge: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Cannot verify allocation bridge iptables hooks");
  }
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error("Cannot verify allocation bridge iptables hooks");
  const link = value[0] as Json | undefined;
  const info = link?.linkinfo;
  const enabled = info?.info_data?.nf_call_iptables;
  if (
    link?.ifname !== bridge ||
    info?.info_kind !== "bridge" ||
    (enabled !== 0 && enabled !== 1)
  )
    throw new Error("Cannot verify allocation bridge iptables hooks");
  return enabled === 1;
}

function assertBridgeName(bridge: string): void {
  if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(bridge))
    throw new Error("Invalid Docker bridge interface name");
}

export async function requireBridgeNetfilterModule(
  moduleRoot = "/sys/module",
): Promise<void> {
  try {
    await access(join(moduleRoot, "br_netfilter"));
  } catch {
    throw new Error("Linux br_netfilter module is not loaded");
  }
}

export async function verifyBridgeNetfilterSysfs(
  bridge: string,
  sysfsRoot = "/sys/class/net",
): Promise<void> {
  assertBridgeName(bridge);
  const path = join(sysfsRoot, bridge, "bridge", "nf_call_iptables");
  const value = await readFile(path, "utf8");
  if (value.trim() !== "1")
    throw new Error("Allocation bridge iptables hooks are not enabled");
}

/** Docker 29 serializes FirewallBackend.Info as [[key, value], ...]. */
export function parseFirewallBackend(raw: string): {
  driver: string;
  userlandProxy: boolean;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Cannot verify Docker firewall capabilities");
  }
  if (!value || typeof value !== "object")
    throw new Error("Cannot verify Docker firewall capabilities");
  const backend = value as Json;
  if (typeof backend.Driver !== "string" || !Array.isArray(backend.Info))
    throw new Error("Cannot verify Docker firewall capabilities");
  const entries = new Map<string, string>();
  for (const entry of backend.Info) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      entries.has(entry[0])
    )
      throw new Error("Cannot verify Docker firewall capabilities");
    entries.set(entry[0], entry[1]);
  }
  const userlandProxy = entries.get("EnableUserlandProxy");
  if (userlandProxy !== "true" && userlandProxy !== "false")
    throw new Error("Cannot verify Docker userland-proxy mode");
  return { driver: backend.Driver, userlandProxy: userlandProxy === "true" };
}
