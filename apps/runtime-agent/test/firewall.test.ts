import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalRuntimeNetworkValue,
  runtimeNetworkRulesMaterial,
  runtimeNetworkCommandSchema,
  type RuntimeNetworkPlan,
} from "@hitchlet/contracts/internal";
import {
  compileRules,
  IptablesFirewall,
  IptablesRunner,
  normalizeIptablesRule,
} from "../src/firewall.js";

const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalRuntimeNetworkValue(value)).digest("hex")}`;

function plan(overrides: Partial<RuntimeNetworkPlan> = {}): RuntimeNetworkPlan {
  const base = {
    installationId: "i1",
    runtimeIdentityId: "r1",
    nativeEngineId: "e1",
    allocationId: "a1",
    generation: 7,
    operationId: "op1",
    controlVersion: 10,
    networkId: "n1",
    networkName: "hl-a1",
    networkSubnet: "172.30.77.0/24",
    containerIds: ["c1"],
    bridgeInterface: "br-0123456789ab",
    bridgeGateway: "172.30.77.1",
    userlandProxy: true,
    publishedPorts: [
      {
        containerId: "c1",
        protocol: "tcp" as const,
        hostPort: 24001,
        containerPort: 22,
        hostAddress: "192.0.2.10",
      },
    ],
    grantId: "g1",
    networkRevisionId: "nr1",
    frozenDenyRevisionId: "d1",
    effectiveDenyRevisionId: "d2",
    ingressSourceCidrs: ["192.0.2.0/24"],
    egress: [
      { cidr: "192.0.2.20/32", protocol: "tcp" as const, ports: [2049] },
    ],
    managementDeny: [
      { cidr: "192.0.2.30/32", protocol: "tcp" as const, ports: [443] },
    ],
  };
  const withMaterial = {
    ...base,
    ...overrides,
    expectedRulesetHash: "sha256:" + "0".repeat(64),
  };
  return {
    ...withMaterial,
    expectedRulesetHash: hash(
      runtimeNetworkRulesMaterial(withMaterial as RuntimeNetworkPlan),
    ),
  } as RuntimeNetworkPlan;
}

describe("Docker iptables rule model", () => {
  it("covers host INPUT and Docker DOCKER-USER while ordering management denies before established traffic", () => {
    const value = plan();
    const rules = compileRules(
      value,
      value.bridgeInterface,
      value.bridgeGateway,
    ).rules;
    expect(rules.INPUT).toContainEqual([
      "-i",
      value.bridgeInterface,
      "-j",
      expect.any(String),
    ]);
    expect(rules.INPUT).toContainEqual([
      "-d",
      "192.0.2.10",
      "-p",
      "tcp",
      "--dport",
      "24001",
      "-j",
      expect.any(String),
    ]);
    expect(rules["DOCKER-USER"]).toEqual([
      ["-i", value.bridgeInterface, "-j", expect.any(String)],
      ["-o", value.bridgeInterface, "-j", expect.any(String)],
    ]);
    const chain =
      rules[Object.keys(rules).find((key) => key.startsWith("HLF"))!]!;
    expect(chain[0]).toEqual([
      "-i",
      value.bridgeInterface,
      "-d",
      "192.0.2.30/32",
      "-p",
      "tcp",
      "--dport",
      "443",
      "-j",
      "DROP",
    ]);
    expect(chain).toContainEqual([
      "-i",
      value.bridgeInterface,
      "-o",
      value.bridgeInterface,
      "-j",
      "DROP",
    ]);
    expect(chain).toContainEqual([
      "-i",
      value.bridgeInterface,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "RETURN",
    ]);
    expect(chain.at(-1)).toEqual([
      "-o",
      value.bridgeInterface,
      "-d",
      value.networkSubnet,
      "-j",
      "DROP",
    ]);
    expect(
      chain.findIndex((rule) =>
        rule.some((token) => token.includes("ESTABLISHED")),
      ),
    ).toBeGreaterThan(1);
    expect(chain.some((rule) => rule.includes("2049"))).toBe(true);
  });

  it("normalizes iptables-save implicit modules, host masks, and state order", () => {
    expect(
      normalizeIptablesRule([
        "-s",
        "192.0.2.20/32",
        "-p",
        "tcp",
        "-m",
        "tcp",
        "--dport",
        "2049",
        "-m",
        "conntrack",
        "--ctstate",
        "RELATED,ESTABLISHED",
        "-j",
        "RETURN",
      ]),
    ).toEqual([
      "-s",
      "192.0.2.20",
      "-p",
      "tcp",
      "-m",
      "conntrack",
      "--dport",
      "2049",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "RETURN",
    ]);
    expect(
      normalizeIptablesRule([
        "-d",
        "172.30.77.0/24",
        "-o",
        "br-0123456789ab",
        "-p",
        "tcp",
        "--dport",
        "22",
        "-i",
        "eth0",
        "-s",
        "192.0.2.20/32",
        "-j",
        "RETURN",
      ]),
    ).toEqual(
      normalizeIptablesRule([
        "-i",
        "eth0",
        "-o",
        "br-0123456789ab",
        "-s",
        "192.0.2.20",
        "-d",
        "172.30.77.0/24",
        "-p",
        "tcp",
        "--dport",
        "22",
        "-j",
        "RETURN",
      ]),
    );
  });

  it("hashes only normalized rules, while revocation produces a distinct deny-all ruleset", () => {
    const first = plan();
    const second = plan({
      operationId: "cleanup-op",
      controlVersion: 11,
      effectiveDenyRevisionId: "deny-3",
    });
    expect(hash(runtimeNetworkRulesMaterial(first))).toBe(
      hash(runtimeNetworkRulesMaterial(second)),
    );
    expect(hash(runtimeNetworkRulesMaterial(first, true))).not.toBe(
      hash(runtimeNetworkRulesMaterial(first)),
    );
    expect(runtimeNetworkRulesMaterial(first)).toEqual(
      runtimeNetworkRulesMaterial(second),
    );
  });

  it("does not install userland proxy host listeners when the verified daemon disables the proxy", () => {
    const value = plan({ userlandProxy: false });
    const rules = compileRules(
      value,
      value.bridgeInterface,
      value.bridgeGateway,
    ).rules;
    expect(rules.INPUT).toEqual([
      ["-i", value.bridgeInterface, "-j", expect.any(String)],
    ]);
    expect(
      rules[Object.keys(rules).find((key) => key.startsWith("HLF"))!]?.some(
        (rule) => rule.includes(value.bridgeGateway),
      ),
    ).toBe(false);
  });

  it("matches wildcard userland-proxy binds only on the published protocol and port", () => {
    const value = plan({
      publishedPorts: [
        {
          containerId: "c1",
          protocol: "tcp",
          hostPort: 24001,
          containerPort: 22,
          hostAddress: "0.0.0.0",
        },
      ],
    });
    const hooks = compileRules(
      value,
      value.bridgeInterface,
      value.bridgeGateway,
    ).rules.INPUT!;
    expect(hooks).toContainEqual([
      "-p",
      "tcp",
      "--dport",
      "24001",
      "-j",
      expect.any(String),
    ]);
    expect(hooks.flat()).not.toContain("-d");
  });

  it("requires resource absence to be established locally before remove can be parsed", () => {
    const value = plan();
    const command = {
      kind: "network.remove",
      installationId: value.installationId,
      runtimeIdentityId: value.runtimeIdentityId,
      agentId: "agent",
      commandId: "cmd",
      operationId: value.operationId,
      allocationId: value.allocationId,
      generation: value.generation,
      controlVersion: value.controlVersion,
      controllerEpoch: 1,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      contentHash: "sha256:" + "0".repeat(64),
      plan: value,
    };
    expect(runtimeNetworkCommandSchema.safeParse(command).success).toBe(false);
  });

  it("removes only owned hooks and chains, verifies absence, and is idempotent", async () => {
    const value = plan();
    const set = compileRules(
      value,
      value.bridgeInterface,
      value.bridgeGateway,
      true,
    );
    class MemoryRunner extends IptablesRunner {
      lines = [
        `-N ${set.inputHost}`,
        `-N ${set.inputProxy}`,
        `-N ${set.forward}`,
        ...(set.rules.INPUT ?? []).map((rule) => `-A INPUT ${rule.join(" ")}`),
        ...(set.rules["DOCKER-USER"] ?? []).map(
          (rule) => `-A DOCKER-USER ${rule.join(" ")}`,
        ),
        "-A INPUT -p tcp --dport 8080 -j OTHER-SERVICE",
      ];
      commands: string[][] = [];

      override async listAll(): Promise<string[]> {
        return [...this.lines];
      }
      override async deleteIfPresent(chain: string, rule: readonly string[]) {
        const exact = `-A ${chain} ${rule.join(" ")}`;
        this.lines = this.lines.filter((line) => line !== exact);
      }
      override async command(args: readonly string[]): Promise<string> {
        this.commands.push([...args]);
        const [operation, chain] = args;
        if (operation === "-F")
          this.lines = this.lines.filter(
            (line) => !line.startsWith(`-A ${chain} `),
          );
        if (operation === "-X")
          this.lines = this.lines.filter((line) => line !== `-N ${chain}`);
        return "";
      }
    }
    const runner = new MemoryRunner();
    const firewall = new IptablesFirewall(runner);

    await firewall.remove(value, value.bridgeInterface, value.bridgeGateway);
    expect(runner.lines).toEqual([
      "-A INPUT -p tcp --dport 8080 -j OTHER-SERVICE",
    ]);
    const firstRemovalCommands = runner.commands.length;
    await firewall.remove(value, value.bridgeInterface, value.bridgeGateway);
    expect(runner.lines).toEqual([
      "-A INPUT -p tcp --dport 8080 -j OTHER-SERVICE",
    ]);
    expect(runner.commands.length).toBe(firstRemovalCommands);
  });

  it("refuses to remove chains with unexpected external references", async () => {
    const value = plan();
    const set = compileRules(
      value,
      value.bridgeInterface,
      value.bridgeGateway,
      true,
    );
    class MemoryRunner extends IptablesRunner {
      lines = [
        `-N ${set.inputHost}`,
        `-N ${set.inputProxy}`,
        `-N ${set.forward}`,
        ...(set.rules.INPUT ?? []).map((rule) => `-A INPUT ${rule.join(" ")}`),
        ...(set.rules["DOCKER-USER"] ?? []).map(
          (rule) => `-A DOCKER-USER ${rule.join(" ")}`,
        ),
        `-A OTHER-SERVICE -j ${set.forward}`,
      ];
      async listAll(): Promise<string[]> {
        return [...this.lines];
      }
      override async command(): Promise<string> {
        throw new Error("unexpected mutation");
      }
    }
    const runner = new MemoryRunner();
    await expect(
      new IptablesFirewall(runner).remove(
        value,
        value.bridgeInterface,
        value.bridgeGateway,
      ),
    ).rejects.toThrow("Unexpected allocation firewall references");
  });
});
