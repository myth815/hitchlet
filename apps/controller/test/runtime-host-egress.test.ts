// Synthetic packet/Engine/iptables transports only. Real Controller command
// builder, Runtime schema, Worker, journal and firewall installation/readback.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  runtimeNetworkCommandSchema,
  type RuntimeNetworkPlan,
  type RuntimeNetworkCommand,
} from "@hitchlet/contracts/internal";
import {
  buildRuntimeNetworkPlan,
  buildRuntimeNetworkCommand,
  assertRuntimeNetworkResponse,
  hashRuntimeNetworkRules,
} from "../src/providers/runtime-network-client.js";
import {
  compileRules,
  IptablesFirewall,
  IptablesRunner,
} from "../../runtime-agent/src/firewall.js";
import { NetworkWorker } from "../../runtime-agent/src/worker.js";
import { FileJournal } from "../../runtime-agent/src/journal.js";
import type { LocalEngine } from "../../runtime-agent/src/engine.js";

const endpoints = [
  { cidr: "203.0.113.10/32", protocol: "tcp" as const, ports: [8443] },
  { cidr: "203.0.113.11/32", protocol: "tcp" as const, ports: [22] },
];
function plan(
  egress: RuntimeNetworkPlan["egress"] = endpoints,
): RuntimeNetworkPlan {
  return buildRuntimeNetworkPlan({
    installationId: "fixture-installation",
    runtimeIdentityId: "fixture-runtime",
    nativeEngineId: "fixture-engine",
    allocationId: "fixture-allocation",
    generation: 1,
    operationId: "fixture-operation",
    controlVersion: 1,
    networkId: "fixture-network",
    networkName: "fixture-owned-bridge",
    networkSubnet: "172.30.77.0/24",
    containerIds: ["fixture-container"],
    bridgeInterface: "br-0123456789ab",
    bridgeGateway: "172.30.77.1",
    userlandProxy: false,
    publishedPorts: [],
    grantId: "fixture-grant",
    networkRevisionId: "fixture-revision",
    frozenDenyRevisionId: "fixture-deny",
    effectiveDenyRevisionId: "fixture-deny",
    ingressSourceCidrs: [],
    egress,
    managementDeny: [],
  });
}
const hostPlan = () =>
  plan(endpoints.map((p) => ({ ...p, destinationScope: "host" })));
function command(p: RuntimeNetworkPlan, kind: RuntimeNetworkCommand["kind"]) {
  return buildRuntimeNetworkCommand({
    kind,
    installationId: p.installationId,
    runtimeIdentityId: p.runtimeIdentityId,
    agentId: "fixture-agent",
    commandId: randomUUID(),
    operationId: p.operationId,
    allocationId: p.allocationId,
    generation: p.generation,
    controlVersion: p.controlVersion,
    controllerEpoch: 1,
    deadline: new Date(Date.now() + 60000).toISOString(),
    plan: p,
  });
}

type Packet = {
  input: string;
  output: string;
  source: string;
  destination: string;
  protocol: string;
  port: number;
  sourcePort?: number;
  state: string;
};
const packet = (destination = "203.0.113.10", port = 8443): Packet => ({
  input: "br-0123456789ab",
  output: "eth0",
  source: "172.30.77.2",
  destination,
  protocol: "tcp",
  port,
  state: "NEW",
});
function ip(address: string) {
  return address
    .split(".")
    .reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
}
function contains(cidr: string, address: string) {
  const [network, bits = "32"] = cidr.split("/");
  const mask =
    Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return (ip(network!) & mask) >>> 0 === (ip(address) & mask) >>> 0;
}
/** Evaluate only the fixed generated argv subset; never runs a network command. */
function verdict(rules: readonly (readonly string[])[], p: Packet) {
  for (const rule of rules) {
    let matches = true,
      negate = false,
      result = "NO_MATCH";
    for (let n = 0; n < rule.length; n++) {
      const token = rule[n];
      if (token === "!") {
        negate = true;
        continue;
      }
      const value = rule[++n]!;
      if (token === "-j") {
        result = value;
        continue;
      }
      let match: boolean;
      switch (token) {
        case "-i":
          match = p.input === value;
          break;
        case "-o":
          match = p.output === value;
          break;
        case "-s":
          match = contains(value, p.source);
          break;
        case "-d":
          match = contains(value, p.destination);
          break;
        case "-p":
          match = p.protocol === value;
          break;
        case "--dport":
          match = p.port === Number(value);
          break;
        case "--sport":
          match = p.sourcePort === Number(value);
          break;
        case "--ctstate":
          match = value.split(",").includes(p.state);
          break;
        case "-m":
          match = true;
          break;
        default:
          throw new Error("Unexpected generated token " + token);
      }
      matches &&= negate ? !match : match;
      negate = false;
    }
    if (matches) return result;
  }
  return "NO_MATCH";
}

it("preserves legacy and empty-profile rule hashes exactly", () => {
  const legacy = plan(),
    empty = plan([]);
  // Captured from unchanged 9d6d4d60 before implementing host scope.
  expect(legacy.expectedRulesetHash).toBe(
    "sha256:8ea353c8c08f48603def8a30e924a5358dd33b0155570d5146b65cb583e3145c",
  );
  expect(hashRuntimeNetworkRules(legacy, true)).toBe(
    "sha256:61e4d8a815832c0c1349c426de36533c14521a1c2598945f4ab6add22b734c12",
  );
  expect(empty.expectedRulesetHash).toBe(
    "sha256:9fd65a2da0ced5cee49060ea005b6f5751dba468dec9a05d649f02d9617610fc",
  );
  expect(hashRuntimeNetworkRules(empty, true)).toBe(
    hashRuntimeNetworkRules(legacy, true),
  );
  expect(
    plan(endpoints.map((e) => ({ ...e, destinationScope: "forward" })))
      .expectedRulesetHash,
  ).toBe(legacy.expectedRulesetHash);
  const set = compileRules(
    legacy,
    legacy.bridgeInterface,
    legacy.bridgeGateway,
  );
  expect(verdict(set.rules[set.inputHost]!, packet())).toBe("DROP");
  expect(verdict(set.rules[set.forward]!, packet())).toBe("RETURN");
});

it("allows only explicitly scoped host endpoints from this allocation", () => {
  const p = hostPlan(),
    set = compileRules(p, p.bridgeInterface, p.bridgeGateway);
  for (const [address, port] of [
    ["203.0.113.10", 8443],
    ["203.0.113.11", 22],
  ] as const) {
    expect(verdict(set.rules[set.inputHost]!, packet(address, port))).toBe(
      "ACCEPT",
    );
    expect(verdict(set.rules[set.forward]!, packet(address, port))).toBe(
      "DROP",
    );
  }
  for (const changed of [
    { port: 8444 },
    { destination: "203.0.113.12" },
    { protocol: "udp" },
    { input: "br-other" },
    { source: "172.30.78.2" },
  ])
    expect(
      verdict(set.rules[set.inputHost]!, { ...packet(), ...changed }),
    ).toBe("DROP");
  const other = buildRuntimeNetworkPlan({
    ...p,
    allocationId: "other-allocation",
    egress: [],
  });
  const otherSet = compileRules(
    other,
    other.bridgeInterface,
    other.bridgeGateway,
  );
  expect(otherSet.inputHost).not.toBe(set.inputHost);
  expect(verdict(otherSet.rules[otherSet.inputHost]!, packet())).toBe("DROP");
  expect(set.rules.INPUT).toEqual([
    ["-i", p.bridgeInterface, "-j", set.inputHost],
  ]);
});

it("keeps management denies and revoke ahead of all new and established host access", () => {
  const p = hostPlan();
  for (const protocol of ["tcp", "any"] as const) {
    const denied = buildRuntimeNetworkPlan({
      ...p,
      managementDeny: [
        {
          cidr: "203.0.113.10/32",
          protocol,
          ports: protocol === "any" ? "any" : [8443],
        },
      ],
    });
    const set = compileRules(
      denied,
      denied.bridgeInterface,
      denied.bridgeGateway,
    );
    expect(verdict(set.rules[set.inputHost]!, packet())).toBe("DROP");
    expect(
      verdict(set.rules[set.inputHost]!, { ...packet(), state: "ESTABLISHED" }),
    ).toBe("DROP");
  }
  const gateway = buildRuntimeNetworkPlan({
    ...p,
    egress: [
      {
        ...endpoints[0]!,
        cidr: p.bridgeGateway + "/32",
        destinationScope: "host",
      },
    ],
  });
  const active = compileRules(
    gateway,
    gateway.bridgeInterface,
    gateway.bridgeGateway,
  );
  const revoked = compileRules(
    gateway,
    gateway.bridgeInterface,
    gateway.bridgeGateway,
    true,
  );
  const connected = { ...packet(p.bridgeGateway), state: "ESTABLISHED" };
  expect(verdict(active.rules[active.inputHost]!, connected)).toBe("ACCEPT");
  expect(verdict(revoked.rules[revoked.inputHost]!, connected)).toBe("DROP");
  expect(
    verdict(revoked.rules[revoked.inputHost]!, packet(p.bridgeGateway)),
  ).toBe("DROP");
});

it("rejects wildcard or non-TCP host grants at the Runtime command boundary", () => {
  const sent = command(hostPlan(), "network.ensure");
  for (const change of [
    { cidr: "0.0.0.0/0" },
    { protocol: "udp" },
    { ports: [] },
    { ports: "any" },
  ]) {
    expect(
      runtimeNetworkCommandSchema.safeParse({
        ...sent,
        plan: { ...sent.plan, egress: [{ ...sent.plan.egress[0], ...change }] },
      }).success,
    ).toBe(false);
  }
});

/** Only this in-memory runner can be called. No iptables/conntrack binaries. */
class MemoryRunner extends IptablesRunner {
  chains = new Map<string, string[][]>([
    ["INPUT", []],
    ["DOCKER-USER", []],
  ]);
  flushed: string[] = [];
  override async command(
    args: readonly string[],
    allowFailure = false,
  ): Promise<string> {
    const [op, chain, ...tail] = args;
    try {
      if (op === "-S") {
        if (chain && !this.chains.has(chain)) throw new Error("Missing chain");
        return [
          ...(chain
            ? [[chain, this.chains.get(chain)!] as const]
            : this.chains),
        ]
          .flatMap(([name, rules]) => [
            `-N ${name}`,
            ...rules.map((r) => `-A ${name} ${r.join(" ")}`),
          ])
          .join("\n");
      }
      if (!chain) throw new Error("Missing chain argument");
      if (op === "-N") {
        this.chains.set(chain, []);
        return "";
      }
      const rules = this.chains.get(chain);
      if (!rules) throw new Error("Missing chain");
      if (op === "-I") rules.splice(Number(tail[0]) - 1, 0, tail.slice(1));
      else if (op === "-F") rules.length = 0;
      else if (op === "-X") this.chains.delete(chain);
      else if (op === "-C" || op === "-D") {
        const index = rules.findIndex(
          (r) => JSON.stringify(r) === JSON.stringify(tail),
        );
        if (index < 0) throw new Error("Missing rule");
        if (op === "-D") rules.splice(index, 1);
      } else throw new Error("Unexpected iptables operation");
      return "";
    } catch (error) {
      if (allowFailure) return "";
      throw error;
    }
  }
  override async requireConntrack() {}
  override async flushConntrack(source: string, destination: string) {
    this.flushed.push(source + ":" + destination);
  }
  override async flushConntrackDestination(destination: string) {
    this.flushed.push("destination:" + destination);
  }
}

it.each([false, true])(
  "pairs Controller commands with Runtime ensure/readback/restart/revoke/remove and rejects changed grants (group=%s)",
  async (group) => {
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-host-egress-"));
    try {
      const base = hostPlan();
      const p = group
        ? buildRuntimeNetworkPlan({
            ...base,
            containerIds: ["workload", "gateway"],
            memberLinks: [
              {
                fromContainerId: "gateway",
                toContainerId: "workload",
                fromIpv4: "172.30.77.3",
                toIpv4: "172.30.77.2",
                protocol: "tcp",
                ports: [3000],
              },
              {
                fromContainerId: "workload",
                toContainerId: "gateway",
                fromIpv4: "172.30.77.2",
                toIpv4: "172.30.77.3",
                protocol: "tcp",
                ports: [18080],
              },
            ],
          })
        : base;
      const runner = new MemoryRunner(),
        firewall = new IptablesFirewall(runner);
      const unrelated = ["-p", "tcp", "--dport", "8080", "-j", "UNRELATED"];
      runner.chains.set("UNRELATED", []);
      runner.chains.get("INPUT")!.push(unrelated);
      const engine = {
        assertEngine: async () => p.nativeEngineId,
        inspectAllocation: async () => ({
          bridge: p.bridgeInterface,
          gateway: p.bridgeGateway,
          subnet: p.networkSubnet,
          containers: [],
        }),
        assertAllocationAbsent: async () => {},
      } as unknown as LocalEngine;
      const path = join(dir, "journal.json");
      const worker = () =>
        new NetworkWorker(
          {
            installationId: p.installationId,
            runtimeIdentityId: p.runtimeIdentityId,
            agentId: "fixture-agent",
          },
          new FileJournal(path),
          engine,
          firewall,
        );
      const execute = async (
        kind: RuntimeNetworkCommand["kind"],
        material = p,
      ) => {
        const sent = command(material, kind);
        const received = runtimeNetworkCommandSchema.parse(
          JSON.parse(JSON.stringify(sent)),
        );
        const result = await worker().execute(received);
        assertRuntimeNetworkResponse(sent, result);
        return result;
      };
      expect((await execute("network.ensure")).status).toBe("installed");
      expect((await execute("network.inspect")).status).toBe("present");
      const set = compileRules(p, p.bridgeInterface, p.bridgeGateway);
      expect(verdict(runner.chains.get(set.inputHost)!, packet())).toBe(
        "ACCEPT",
      );
      const changed = command(p, "network.ensure");
      const changedScope = { ...p, egress: endpoints };
      expect(hashRuntimeNetworkRules(changedScope)).not.toBe(
        p.expectedRulesetHash,
      );
      await expect(
        worker().execute({ ...changed, plan: changedScope }),
      ).rejects.toThrow("content hash mismatch");
      await expect(
        worker().execute(command(changedScope, "network.ensure")),
      ).rejects.toThrow("Expected ruleset hash mismatch");
      expect((await execute("network.revoke")).status).toBe("revoked");
      expect(verdict(runner.chains.get(set.inputHost)!, packet())).toBe("DROP");
      await expect(
        worker().execute(command(p, "network.ensure")),
      ).rejects.toThrow("cannot be re-enabled");
      expect(
        (await execute("network.remove", { ...p, containerIds: [] })).status,
      ).toBe("removed");
      expect(runner.chains.has(set.inputHost)).toBe(false);
      expect(runner.chains.get("INPUT")).toEqual([unrelated]);
      expect(runner.flushed).toContain(p.networkSubnet + ":0.0.0.0/0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("binds member links to exact same-lease addresses and TCP ports, with stateful replies only", () => {
  const base = hostPlan();
  const memberLinks = [
    {
      fromContainerId: "gateway",
      toContainerId: "workload",
      fromIpv4: "172.30.77.3",
      toIpv4: "172.30.77.2",
      protocol: "tcp" as const,
      ports: [3000],
    },
    {
      fromContainerId: "workload",
      toContainerId: "gateway",
      fromIpv4: "172.30.77.2",
      toIpv4: "172.30.77.3",
      protocol: "tcp" as const,
      ports: [18080],
    },
  ];
  const p = buildRuntimeNetworkPlan({
    ...base,
    containerIds: ["workload", "gateway"],
    memberLinks,
  });
  expect(
    runtimeNetworkCommandSchema.safeParse(command(p, "network.ensure")).success,
  ).toBe(true);
  const compiled = compileRules(p, p.bridgeInterface, p.bridgeGateway);
  const rules = compiled.rules[compiled.forward]!;
  for (const link of memberLinks) {
    const request = {
      ...packet(link.toIpv4, link.ports[0]),
      source: link.fromIpv4,
      output: p.bridgeInterface,
    };
    expect(verdict(rules, request)).toBe("RETURN");
    const reply = {
      ...request,
      source: request.destination,
      destination: request.source,
      port: 50000,
      sourcePort: request.port,
      state: "ESTABLISHED",
    };
    expect(verdict(rules, reply)).toBe("RETURN");
    expect(verdict(rules, { ...reply, state: "NEW" })).toBe("DROP");
    for (const change of [
      { port: request.port + 1 },
      { source: "172.30.77.4" },
      { protocol: "udp" },
    ])
      expect(verdict(rules, { ...request, ...change })).toBe("DROP");
    expect(verdict(rules, { ...request, source: "172.30.78.2" })).toBe("DROP");
    const revoked = compileRules(p, p.bridgeInterface, p.bridgeGateway, true);
    expect(verdict(revoked.rules[revoked.forward]!, request)).toBe("DROP");
    expect(verdict(revoked.rules[revoked.forward]!, reply)).toBe("DROP");
  }
  expect(verdict(compiled.rules[compiled.inputHost]!, packet())).toBe("ACCEPT");
  expect(verdict(rules, packet())).toBe("DROP");
  const denied = buildRuntimeNetworkPlan({
    ...p,
    managementDeny: [
      { cidr: "172.30.77.2/32", protocol: "tcp", ports: [3000] },
    ],
  });
  const deniedSet = compileRules(
    denied,
    denied.bridgeInterface,
    denied.bridgeGateway,
  );
  expect(
    verdict(deniedSet.rules[deniedSet.forward]!, {
      ...packet("172.30.77.2", 3000),
      source: "172.30.77.3",
      output: p.bridgeInterface,
    }),
  ).toBe("DROP");
  const altered = {
    ...p,
    memberLinks: [
      { ...memberLinks[0]!, toIpv4: "172.30.77.4" },
      memberLinks[1]!,
    ],
  };
  expect(hashRuntimeNetworkRules(altered)).not.toBe(p.expectedRulesetHash);
  expect(() =>
    command({ ...p, containerIds: ["workload"] }, "network.ensure"),
  ).toThrow(/all member link containers/);
});
