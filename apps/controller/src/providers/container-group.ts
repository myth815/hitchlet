import type {
  ContainerMemberName,
  RuntimeNetworkPlan,
} from "@hitchlet/contracts/internal";
import type { OwnedResource, ProvisionPlan } from "./port.js";

export function containerMembers(plan: ProvisionPlan) {
  if (!plan.containerGroup) return [{ name: "workload" as const, plan }];
  const { containerGroup, ...base } = plan;
  const gateway = containerGroup.gateway;
  const cpu = gateway.resources.cpuMillis,
    memory = gateway.resources.memoryMiB;
  if (
    plan.accessProtocol !== "none" ||
    plan.resources.accelerators.length ||
    plan.resources.request.cpuMillis <= cpu ||
    plan.resources.request.memoryMiB <= memory ||
    plan.resources.limit.cpuMillis <= cpu ||
    plan.resources.limit.memoryMiB <= memory ||
    plan.resources.request.scratchMiB < gateway.resources.scratchMiB ||
    plan.resources.limit.scratchMiB < gateway.resources.scratchMiB
  )
    throw new Error(
      "Container group members must fit within the lease resource budget",
    );
  for (const path of gateway.mountPaths)
    if (
      !plan.resolved.mounts.some(
        (m) => m.target === path && m.mode === "read_only",
      )
    )
      throw new Error(
        "Gateway mount must reference an existing lease storage binding",
      );
  const bootstrap = {
    mechanism: "hitchlet-container-entrypoint-v1",
    contractVersion: "1",
    identityReset: true as const,
  };
  const workload: ProvisionPlan = {
    ...base,
    containerRole: "workload",
    bootstrap,
    resources: {
      ...plan.resources,
      request: {
        ...plan.resources.request,
        cpuMillis: plan.resources.request.cpuMillis - cpu,
        memoryMiB: plan.resources.request.memoryMiB - memory,
        scratchMiB:
          plan.resources.request.scratchMiB - gateway.resources.scratchMiB,
      },
      limit: {
        ...plan.resources.limit,
        cpuMillis: plan.resources.limit.cpuMillis - cpu,
        memoryMiB: plan.resources.limit.memoryMiB - memory,
        scratchMiB:
          plan.resources.limit.scratchMiB - gateway.resources.scratchMiB,
      },
    },
    resolved: {
      ...plan.resolved,
      mounts: plan.resolved.mounts.filter(
        (m) => !gateway.mountPaths.includes(m.target),
      ),
    },
  };
  const gatewayPlan: ProvisionPlan = {
    ...base,
    containerRole: "gateway",
    ownedVolumeTarget: gateway.stateMountPath,
    gatewayIpv4Forwarding: gateway.ipv4Forwarding,
    bootstrap,
    artifact: {
      ...plan.artifact,
      ref: gateway.artifactRef,
      digest: gateway.digest,
    },
    resources: {
      ...plan.resources,
      request: {
        cpuMillis: cpu,
        memoryMiB: memory,
        scratchMiB: gateway.resources.scratchMiB,
      },
      limit: {
        cpuMillis: cpu,
        memoryMiB: memory,
        scratchMiB: gateway.resources.scratchMiB,
      },
    },
    resolved: {
      ...plan.resolved,
      mounts: plan.resolved.mounts.filter((m) =>
        gateway.mountPaths.includes(m.target),
      ),
    },
  };
  return [
    { name: "workload" as const, plan: workload },
    { name: "gateway" as const, plan: gatewayPlan },
  ];
}
export function memberNativeName(base: string, member: ContainerMemberName) {
  return member === "workload" ? base : `${base}-gateway`;
}
const number = (address: string) =>
  address.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const address = (value: number) =>
  [24, 16, 8, 0].map((s) => (value >>> s) & 255).join(".");
export function groupAddresses(
  subnet: string,
  gateway: string,
): Record<ContainerMemberName, string> {
  const [network, prefix] = subnet.split("/");
  const bits = Number(prefix);
  if (!network || !Number.isInteger(bits) || bits < 1 || bits > 29)
    throw new Error(
      "Allocation subnet has no room for the fixed two-member group",
    );
  const base = number(network) - (number(network) % 2 ** (32 - bits));
  const ips = [2, 3, 4]
    .map((n) => address(base + n))
    .filter((ip) => ip !== gateway);
  return { workload: ips[0]!, gateway: ips[1]! };
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function containerIpv4(
  detail: Record<string, unknown>,
  network: string,
): string {
  const endpoint = record(
    record(record(detail.NetworkSettings).Networks)[network],
  );
  const assigned = endpoint.IPAddress,
    reserved = record(endpoint.IPAMConfig).IPv4Address;
  const ip = typeof assigned === "string" && assigned ? assigned : reserved;
  if (
    typeof ip !== "string" ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(ip) ||
    (typeof assigned === "string" &&
      assigned &&
      typeof reserved === "string" &&
      reserved &&
      assigned !== reserved)
  )
    throw new Error(
      "Member IPv4 reservation/readback is unavailable or changed",
    );
  return ip;
}
export function runtimeLinksForResources(
  plan: ProvisionPlan,
  resources: readonly OwnedResource[],
): RuntimeNetworkPlan["memberLinks"] {
  if (!plan.containerGroup) return undefined;
  const bindings = new Map(
    resources
      .filter(
        (r) =>
          r.kind === "container" &&
          typeof r.details?.memberName === "string" &&
          typeof r.details?.ipv4 === "string",
      )
      .map((r) => [r.details!.memberName, r]),
  );
  if (!bindings.has("workload") || !bindings.has("gateway")) return undefined;
  return plan.containerGroup.links.map((l) => {
    const from = bindings.get(l.from)!,
      to = bindings.get(l.to)!;
    return {
      fromContainerId: from.id,
      toContainerId: to.id,
      fromIpv4: String(from.details!.ipv4),
      toIpv4: String(to.details!.ipv4),
      protocol: l.protocol,
      ports: [...l.ports],
    };
  });
}
export function groupContainerBody(
  plan: ProvisionPlan,
  network: string,
  volume: string,
  name: ContainerMemberName,
  ipv4: string,
  labels: Record<string, string>,
  environment?: Readonly<Record<string, string>>,
) {
  const gateway = name === "gateway";
  return {
    Image: plan.artifact.ref,
    Cmd: [],
    User: gateway ? "0" : "1000:1000",
    ...(environment === undefined
      ? {}
      : { Env: Object.entries(environment).map(([k, v]) => `${k}=${v}`) }),
    Labels: labels,
    Hostname: `h-${plan.identity.allocationId.slice(0, 12)}-${name}`,
    ExposedPorts: {},
    HostConfig: {
      NetworkMode: network,
      PortBindings: {},
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      ReadonlyRootfs: false,
      Privileged: false,
      PublishAllPorts: false,
      Binds: [],
      CapDrop: ["ALL"],
      CapAdd: gateway
        ? ["NET_ADMIN", "NET_RAW"]
        : [
            "CHOWN",
            "DAC_OVERRIDE",
            "FOWNER",
            "SETGID",
            "SETUID",
            "SYS_CHROOT",
            "NET_BIND_SERVICE",
          ],
      ...(gateway
        ? {
            Devices: [
              {
                PathOnHost: "/dev/net/tun",
                PathInContainer: "/dev/net/tun",
                CgroupPermissions: "rw",
              },
            ],
          }
        : {}),
      SecurityOpt: ["no-new-privileges:true"],
      CpuQuota: Math.floor(plan.resources.limit.cpuMillis * 100),
      CpuPeriod: 100000,
      Memory: plan.resources.limit.memoryMiB * 1024 * 1024,
      MemorySwap: plan.resources.limit.memoryMiB * 1024 * 1024,
      PidsLimit: 512,
      Sysctls: {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
        ...(gateway && plan.gatewayIpv4Forwarding
          ? { "net.ipv4.ip_forward": "1" }
          : {}),
      },
      Mounts: [
        ...plan.resolved.mounts.map((m) => ({
          Type: "bind",
          Source: m.resolvedSourceRef,
          Target: m.target,
          ReadOnly: m.mode === "read_only",
          BindOptions: { Propagation: "rprivate", NonRecursive: true },
        })),
        {
          Type: "volume",
          Source: volume,
          Target: plan.ownedVolumeTarget ?? "/workspace",
          ReadOnly: false,
        },
      ],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [network]: { Aliases: [name], IPAMConfig: { IPv4Address: ipv4 } },
      },
    },
  };
}
