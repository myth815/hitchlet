import { z } from "zod";

const id = z.string().min(1).max(200);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cidr = z.string().min(3).max(64);
const ports = z.union([
  z.literal("any"),
  z.array(z.number().int().min(1).max(65535)).min(1),
]);
const networkRule = z
  .object({
    cidr,
    protocol: z.enum(["any", "tcp", "udp"]),
    ports,
  })
  .strict();
const destination = z
  .object({
    cidr,
    protocol: z.enum(["tcp", "udp"]),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
  })
  .strict();
const publishedPort = z
  .object({
    containerId: id,
    protocol: z.enum(["tcp", "udp"]),
    hostPort: z.number().int().min(1).max(65535),
    containerPort: z.number().int().min(1).max(65535),
    hostAddress: z.string().min(2).max(64),
  })
  .strict();

/** Small, internal protocol for the fixed Linux Docker iptables executor. */
export const runtimeNetworkPlanSchema = z
  .object({
    installationId: id,
    runtimeIdentityId: id,
    nativeEngineId: id,
    allocationId: id,
    generation: z.number().int().positive(),
    operationId: id,
    controlVersion: z.number().int().positive(),
    networkId: id,
    networkName: id,
    networkSubnet: cidr,
    containerIds: z.array(id),
    bridgeInterface: z.string().regex(/^[a-zA-Z0-9_.-]{1,15}$/),
    bridgeGateway: z.string().min(2).max(64),
    userlandProxy: z.boolean(),
    publishedPorts: z.array(publishedPort),
    grantId: id,
    networkRevisionId: id,
    frozenDenyRevisionId: id,
    effectiveDenyRevisionId: id,
    ingressSourceCidrs: z.array(cidr),
    egress: z.array(destination),
    managementDeny: z.array(networkRule),
    expectedRulesetHash: sha256,
  })
  .strict();

const envelope = z.object({
  installationId: id,
  runtimeIdentityId: id,
  agentId: id,
  commandId: id,
  operationId: id,
  allocationId: id,
  generation: z.number().int().positive(),
  controlVersion: z.number().int().positive(),
  controllerEpoch: z.number().int().positive(),
  deadline: z.string().datetime({ offset: true }),
  contentHash: sha256,
});

const commandBase = envelope
  .extend({ plan: runtimeNetworkPlanSchema })
  .strict();

export const runtimeNetworkCommandSchema = z.discriminatedUnion("kind", [
  commandBase
    .extend({ kind: z.literal("network.ensure") })
    .refine(
      (value) => value.plan.containerIds.length > 0,
      "ensure needs container evidence",
    ),
  commandBase
    .extend({ kind: z.literal("network.inspect") })
    .refine(
      (value) => value.plan.containerIds.length > 0,
      "inspect needs container evidence",
    ),
  commandBase.extend({ kind: z.literal("network.revoke") }),
  commandBase
    .extend({ kind: z.literal("network.remove") })
    .refine(
      (value) => value.plan.containerIds.length === 0,
      "remove requires empty container list",
    ),
]);

export const runtimeNetworkResultSchema = z
  .object({
    commandId: id,
    operationId: id,
    allocationId: id,
    generation: z.number().int().positive(),
    nativeEngineId: id.nullable(),
    status: z.enum([
      "installed",
      "revoked",
      "removed",
      "present",
      "absent",
      "unknown",
    ]),
    rulesetHash: sha256.nullable(),
    verifiedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RuntimeNetworkPlan = z.infer<typeof runtimeNetworkPlanSchema>;
export type RuntimeNetworkCommand = z.infer<typeof runtimeNetworkCommandSchema>;
export type RuntimeNetworkResult = z.infer<typeof runtimeNetworkResultSchema>;

/** Canonical JSON shared by the controller signer and the Linux executor. */
export function canonicalRuntimeNetworkValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalRuntimeNetworkValue).join(",") + "]";
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) + ":" + canonicalRuntimeNetworkValue(record[key]),
      )
      .join(",") +
    "}"
  );
}

export type RuntimeNetworkRuleSet = Readonly<{
  inputHost: string;
  inputProxy: string;
  forward: string;
  rules: Readonly<Record<string, readonly (readonly string[])[]>>;
}>;

/** Compile the exact owned iptables argv lines. Hashing these lines binds expectedRulesetHash to readback. */
export function runtimeNetworkRulesMaterial(
  plan: RuntimeNetworkPlan,
  revoked = false,
): RuntimeNetworkRuleSet {
  const suffix = chainSuffix(
    `${plan.installationId}/${plan.allocationId}/${plan.generation}`,
  );
  const inputHost = `HLI${suffix}`;
  const inputProxy = `HLP${suffix}`;
  const forward = `HLF${suffix}`;
  const inputProxyHooks: string[][] = [];
  if (plan.userlandProxy)
    for (const port of plan.publishedPorts)
      inputProxyHooks.push([
        ...(port.hostAddress === "0.0.0.0" ? [] : ["-d", port.hostAddress]),
        "-p",
        port.protocol,
        "--dport",
        String(port.hostPort),
        "-j",
        inputProxy,
      ]);
  const inputHooks: string[][] = [
    ["-i", plan.bridgeInterface, "-j", inputHost],
    ...inputProxyHooks,
  ];
  const hostRules: string[][] = [];
  for (const deny of plan.managementDeny) {
    if (deny.protocol === "any")
      hostRules.push(["-d", deny.cidr, "-j", "DROP"]);
    else if (deny.ports === "any")
      hostRules.push(["-d", deny.cidr, "-p", deny.protocol, "-j", "DROP"]);
    else
      for (const port of deny.ports)
        hostRules.push([
          "-d",
          deny.cidr,
          "-p",
          deny.protocol,
          "--dport",
          String(port),
          "-j",
          "DROP",
        ]);
  }
  hostRules.push([
    "-i",
    plan.bridgeInterface,
    "-s",
    plan.networkSubnet,
    "-d",
    plan.bridgeGateway,
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-j",
    "ACCEPT",
  ]);
  hostRules.push(["-j", "DROP"]);
  const proxyRules: string[][] = [];
  for (const deny of plan.managementDeny) {
    if (deny.protocol === "any")
      proxyRules.push(["-d", deny.cidr, "-j", "DROP"]);
    else if (deny.ports === "any")
      proxyRules.push(["-d", deny.cidr, "-p", deny.protocol, "-j", "DROP"]);
    else
      for (const port of deny.ports)
        proxyRules.push([
          "-d",
          deny.cidr,
          "-p",
          deny.protocol,
          "--dport",
          String(port),
          "-j",
          "DROP",
        ]);
  }
  if (!revoked)
    for (const source of plan.ingressSourceCidrs)
      proxyRules.push(["-s", source, "-j", "RETURN"]);
  proxyRules.push(["-j", "DROP"]);
  const forwardHooks: string[][] = [
    ["-i", plan.bridgeInterface, "-j", forward],
    ["-o", plan.bridgeInterface, "-j", forward],
  ];
  const forwardRules: string[][] = [];
  for (const deny of plan.managementDeny) {
    if (deny.protocol === "any") {
      forwardRules.push([
        "-i",
        plan.bridgeInterface,
        "-d",
        deny.cidr,
        "-j",
        "DROP",
      ]);
      forwardRules.push([
        "-o",
        plan.bridgeInterface,
        "-s",
        deny.cidr,
        "-j",
        "DROP",
      ]);
    } else if (deny.ports === "any") {
      forwardRules.push([
        "-i",
        plan.bridgeInterface,
        "-d",
        deny.cidr,
        "-p",
        deny.protocol,
        "-j",
        "DROP",
      ]);
      forwardRules.push([
        "-o",
        plan.bridgeInterface,
        "-s",
        deny.cidr,
        "-p",
        deny.protocol,
        "-j",
        "DROP",
      ]);
    } else {
      for (const port of deny.ports) {
        forwardRules.push([
          "-i",
          plan.bridgeInterface,
          "-d",
          deny.cidr,
          "-p",
          deny.protocol,
          "--dport",
          String(port),
          "-j",
          "DROP",
        ]);
        forwardRules.push([
          "-o",
          plan.bridgeInterface,
          "-s",
          deny.cidr,
          "-p",
          deny.protocol,
          "--sport",
          String(port),
          "-j",
          "DROP",
        ]);
      }
    }
  }
  if (!revoked) {
    forwardRules.push([
      "-i",
      plan.bridgeInterface,
      "-o",
      plan.bridgeInterface,
      "-j",
      "DROP",
    ]);
    forwardRules.push([
      "-o",
      plan.bridgeInterface,
      "-d",
      plan.networkSubnet,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "RETURN",
    ]);
    forwardRules.push([
      "-i",
      plan.bridgeInterface,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "RETURN",
    ]);
    for (const port of plan.publishedPorts) {
      for (const source of plan.ingressSourceCidrs)
        forwardRules.push([
          "-o",
          plan.bridgeInterface,
          "-d",
          plan.networkSubnet,
          "-s",
          source,
          "-p",
          port.protocol,
          "--dport",
          String(port.containerPort),
          "-j",
          "RETURN",
        ]);
      if (plan.userlandProxy)
        forwardRules.push([
          "-o",
          plan.bridgeInterface,
          "-d",
          plan.networkSubnet,
          "-s",
          plan.bridgeGateway,
          "-p",
          port.protocol,
          "--dport",
          String(port.containerPort),
          "-j",
          "RETURN",
        ]);
    }
    for (const destination of plan.egress)
      for (const port of destination.ports) {
        forwardRules.push([
          "-i",
          plan.bridgeInterface,
          "!",
          "-o",
          plan.bridgeInterface,
          "-d",
          destination.cidr,
          "-p",
          destination.protocol,
          "--dport",
          String(port),
          "-j",
          "RETURN",
        ]);
      }
  }
  if (revoked)
    forwardRules.push([
      "-i",
      plan.bridgeInterface,
      "-o",
      plan.bridgeInterface,
      "-j",
      "DROP",
    ]);
  forwardRules.push(["-i", plan.bridgeInterface, "-j", "DROP"]);
  forwardRules.push([
    "-o",
    plan.bridgeInterface,
    "-d",
    plan.networkSubnet,
    "-j",
    "DROP",
  ]);
  return {
    inputHost,
    inputProxy,
    forward,
    rules: {
      [inputHost]: hostRules,
      [inputProxy]: proxyRules,
      [forward]: forwardRules,
      INPUT: inputHooks,
      "DOCKER-USER": forwardHooks,
    },
  };
}

function chainSuffix(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return (
    first.toString(16).padStart(8, "0").toUpperCase() +
    second.toString(16).padStart(8, "0").toUpperCase()
  );
}
