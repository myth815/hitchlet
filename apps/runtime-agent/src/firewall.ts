import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { RuntimeNetworkPlan } from "@hitchlet/contracts/internal";
import {
  canonicalRuntimeNetworkValue,
  runtimeNetworkRulesMaterial,
  type RuntimeNetworkRuleSet,
} from "@hitchlet/contracts/internal";

const execute = promisify(execFile);
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalRuntimeNetworkValue(value)).digest("hex")}`;
export type Rule = readonly string[];
export type RuleSet = RuntimeNetworkRuleSet;

/** The rules are explicit argv, never shell fragments or caller supplied commands. */
export function compileRules(
  plan: RuntimeNetworkPlan,
  bridge: string,
  gateway: string,
  revoked = false,
): RuleSet {
  if (bridge !== plan.bridgeInterface || gateway !== plan.bridgeGateway)
    throw new Error("Resolved bridge details differ from plan");
  return runtimeNetworkRulesMaterial(plan, revoked);
}

export interface Firewall {
  apply(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<string>;
  inspect(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<string | null>;
  revoke(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<string>;
  remove(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<void>;
}

export class IptablesFirewall implements Firewall {
  constructor(private readonly runner = new IptablesRunner()) {}

  async apply(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<string> {
    const expected = this.expectedHash(plan);
    if (expected !== plan.expectedRulesetHash)
      throw new Error("Ruleset hash does not match normalized policy material");
    const rules = compileRules(plan, bridge, gateway);
    await this.requireConntrack();
    await this.install(rules);
    await this.flushConntrack(plan, bridge);
    const actual = await this.readRules(rules);
    if (
      canonicalRuntimeNetworkValue(actual) !==
      canonicalRuntimeNetworkValue(normalizeRuleSet(rules.rules))
    )
      throw new Error("iptables rules readback mismatch");
    return expected;
  }

  async inspect(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<string | null> {
    const expected = this.expectedHash(plan);
    if (expected !== plan.expectedRulesetHash) return null;
    const rules = compileRules(plan, bridge, gateway);
    try {
      const actual = await this.readRules(rules);
      return canonicalRuntimeNetworkValue(actual) ===
        canonicalRuntimeNetworkValue(normalizeRuleSet(rules.rules))
        ? expected
        : null;
    } catch {
      return null;
    }
  }

  async revoke(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<string> {
    const rules = compileRules(plan, bridge, gateway, true);
    await this.requireConntrack();
    await this.install(rules);
    await this.flushConntrack(plan, bridge);
    const actual = await this.readRules(rules);
    if (
      canonicalRuntimeNetworkValue(actual) !==
      canonicalRuntimeNetworkValue(normalizeRuleSet(rules.rules))
    )
      throw new Error("Revocation rules readback mismatch");
    return digest(runtimeNetworkRulesMaterial(plan, true));
  }

  async remove(
    plan: RuntimeNetworkPlan,
    bridge: string,
    gateway: string,
  ): Promise<void> {
    const rules = compileRules(plan, bridge, gateway, true);
    await this.runner.removeOwned(rules);
  }

  private expectedHash(plan: RuntimeNetworkPlan): string {
    return digest(runtimeNetworkRulesMaterial(plan));
  }

  private async install(set: RuleSet): Promise<void> {
    await this.runner.requireChain("DOCKER-USER");
    for (const chain of [set.inputHost, set.inputProxy, set.forward])
      await this.runner.ensureChain(chain);
    const privateChains = [set.inputHost, set.inputProxy, set.forward];
    // Quarantine every owned chain before rewriting any policy, closing the update window.
    for (const chain of privateChains)
      await this.runner.ensureQuarantine(chain);
    for (const chain of privateChains)
      await this.runner.clearBehindQuarantine(chain);
    for (const chain of privateChains)
      await this.runner.writeBehindQuarantine(chain, set.rules[chain] ?? []);
    for (const rule of [...(set.rules.INPUT ?? [])].reverse())
      await this.runner.insertIfAbsent("INPUT", rule);
    for (const rule of [...(set.rules["DOCKER-USER"] ?? [])].reverse())
      await this.runner.insertIfAbsent("DOCKER-USER", rule);
    for (const chain of privateChains)
      await this.runner.command(["-D", chain, "-j", "DROP"]);
  }

  private async readRules(set: RuleSet): Promise<Record<string, string[][]>> {
    const output: Record<string, string[][]> = {};
    for (const chain of [set.inputHost, set.inputProxy, set.forward]) {
      const lines = await this.runner.list(chain);
      output[chain] = lines.map((line) =>
        normalizeIptablesRule(
          line
            .replace(/^-A\s+\S+\s*/, "")
            .trim()
            .split(/\s+/)
            .filter(Boolean),
        ),
      );
    }
    for (const [chain, expected] of [
      ["INPUT", set.rules.INPUT ?? []],
      ["DOCKER-USER", set.rules["DOCKER-USER"] ?? []],
    ] as const) {
      const ownedNames = new Set([set.inputHost, set.inputProxy, set.forward]);
      const lines = await this.runner.list(chain);
      output[chain] = lines
        .filter((line) =>
          [...ownedNames].some((name) => line.includes(`-j ${name}`)),
        )
        .map((line) =>
          normalizeIptablesRule(
            line
              .replace(/^-A\s+\S+\s*/, "")
              .trim()
              .split(/\s+/)
              .filter(Boolean),
          ),
        );
      if (output[chain].length !== expected.length)
        throw new Error("iptables jump readback mismatch");
    }
    return output;
  }

  private async flushConntrack(
    plan: RuntimeNetworkPlan,
    _bridge: string,
  ): Promise<void> {
    const subnet = plan.networkSubnet;
    for (const deny of plan.managementDeny) {
      await this.runner.flushConntrack(subnet, deny.cidr);
    }
    await this.runner.flushConntrack(subnet, "0.0.0.0/0");
    // Incoming published-port sessions have an external original source and tenant destination.
    await this.runner.flushConntrackDestination(plan.networkSubnet);
  }

  private async requireConntrack(): Promise<void> {
    await this.runner.requireConntrack();
  }
}

export function normalizeIptablesRule(tokens: readonly string[]): string[] {
  const groups: { rank: number; order: number; value: string[] }[] = [];
  const rank: Record<string, number> = {
    "-i": 0,
    "-o": 1,
    "-s": 2,
    "-d": 3,
    "-p": 4,
    "-m": 5,
    "--sport": 6,
    "--dport": 7,
    "--ctstate": 8,
    "-j": 9,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const order = index;
    const negated = tokens[index] === "!";
    if (negated) index += 1;
    const token = tokens[index]!;
    const value = tokens[index + 1];
    if (token === "-m" && (value === "tcp" || value === "udp")) {
      index += 1;
      continue;
    }
    if (rank[token] !== undefined && value !== undefined) {
      const normalizedValue =
        (token === "-s" || token === "-d") && value.endsWith("/32")
          ? value.slice(0, -3)
          : token === "--ctstate"
            ? value.split(",").sort().join(",")
            : value;
      groups.push({
        rank: rank[token]!,
        order,
        value: [...(negated ? ["!"] : []), token, normalizedValue],
      });
      index += 1;
      continue;
    }
    groups.push({
      rank: 100,
      order,
      value: [...(negated ? ["!"] : []), token],
    });
  }
  return groups
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .flatMap((group) => group.value);
}

function normalizeRuleSet(
  rules: Readonly<Record<string, readonly (readonly string[])[]>>,
): Record<string, string[][]> {
  return Object.fromEntries(
    Object.entries(rules).map(([chain, entries]) => [
      chain,
      entries.map(normalizeIptablesRule),
    ]),
  );
}

export class IptablesRunner {
  private async run(
    binary: string,
    args: readonly string[],
    allowFailure = false,
  ): Promise<string> {
    try {
      const result = await execute(binary, [...args], {
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    } catch (error) {
      if (allowFailure) return "";
      throw new Error(`${binary} operation failed`);
    }
  }
  async command(
    args: readonly string[],
    allowFailure = false,
  ): Promise<string> {
    return this.run("iptables", args, allowFailure);
  }
  async requireChain(chain: string): Promise<void> {
    await this.command(["-S", chain]);
  }
  async ensureChain(chain: string): Promise<void> {
    try {
      await this.command(["-S", chain]);
    } catch {
      await this.command(["-N", chain]);
    }
  }
  async clearBehindQuarantine(chain: string): Promise<void> {
    const lines = await this.list(chain);
    for (const line of lines.slice(1).reverse()) {
      const tokens = line
        .replace(/^-A\s+\S+\s*/, "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      await this.command(["-D", chain, ...tokens]);
    }
  }
  async ensureQuarantine(chain: string): Promise<void> {
    const lines = await this.list(chain);
    const first = lines[0]?.replace(/^-A\s+\S+\s*/, "").trim();
    if (first !== "-j DROP")
      await this.command(["-I", chain, "1", "-j", "DROP"]);
  }
  async writeBehindQuarantine(
    chain: string,
    rules: readonly Rule[],
  ): Promise<void> {
    for (let index = 0; index < rules.length; index += 1)
      await this.command(["-I", chain, String(index + 2), ...rules[index]!]);
  }
  async list(chain: string): Promise<string[]> {
    return (await this.command(["-S", chain]))
      .split("\n")
      .filter((line) => line.startsWith("-A "));
  }
  async listAll(): Promise<string[]> {
    return (await this.command(["-S"]))
      .split("\n")
      .filter((line) => line.startsWith("-A ") || line.startsWith("-N "));
  }
  async removeOwned(set: RuleSet): Promise<void> {
    const chains = [set.inputHost, set.inputProxy, set.forward];
    const current = await this.listAll();
    const expectedReferences = [
      ...(set.rules.INPUT ?? []).map((rule) => ["INPUT", rule] as const),
      ...(set.rules["DOCKER-USER"] ?? []).map(
        (rule) => ["DOCKER-USER", rule] as const,
      ),
    ].map(([parent, rule]) =>
      normalizeIptablesRule([...rule])
        .join(" ")
        .replace(/^/, `-A ${parent} `),
    );
    const references = current.filter((line) => {
      const tokens = line.trim().split(/\s+/);
      return ["-j", "-g"].some((option) => {
        const target = tokens[tokens.indexOf(option) + 1];
        return target !== undefined && chains.includes(target);
      });
    });
    const normalizeReference = (line: string): string => {
      const match = line.match(/^-A\s+(\S+)\s+(.*)$/);
      if (!match) return line;
      return `-A ${match[1]} ${normalizeIptablesRule(match[2]!.split(/\s+/)).join(" ")}`;
    };
    const expected = expectedReferences.sort();
    const actual = references.map(normalizeReference).sort();
    const expectedCounts = new Map<string, number>();
    for (const line of expected)
      expectedCounts.set(line, (expectedCounts.get(line) ?? 0) + 1);
    const actualCounts = new Map<string, number>();
    for (const line of actual)
      actualCounts.set(line, (actualCounts.get(line) ?? 0) + 1);
    if (
      [...actualCounts].some(
        ([line, count]) => count > (expectedCounts.get(line) ?? 0),
      )
    )
      throw new Error("Unexpected allocation firewall references");

    for (const [parent, rules] of [
      ["INPUT", set.rules.INPUT ?? []],
      ["DOCKER-USER", set.rules["DOCKER-USER"] ?? []],
    ] as const) {
      for (const rule of rules) await this.deleteIfPresent(parent, rule);
    }
    const existing = new Set(
      current
        .filter((line) => line.startsWith("-N "))
        .map((line) => line.slice(3)),
    );
    for (const chain of chains) {
      if (!existing.has(chain)) continue;
      await this.command(["-F", chain]);
      await this.command(["-X", chain]);
    }
    const remaining = await this.listAll();
    if (
      remaining.some((line) => {
        if (
          line === `-N ${set.inputHost}` ||
          line === `-N ${set.inputProxy}` ||
          line === `-N ${set.forward}`
        )
          return true;
        const tokens = line.trim().split(/\s+/);
        return ["-j", "-g"].some((option) => {
          const target = tokens[tokens.indexOf(option) + 1];
          return target !== undefined && chains.includes(target);
        });
      })
    )
      throw new Error("Allocation firewall rules remain after removal");
  }
  async insertIfAbsent(chain: string, rule: Rule): Promise<void> {
    const check = ["-C", chain, ...rule];
    try {
      await this.command(check);
    } catch {
      await this.command(["-I", chain, "1", ...rule]);
    }
  }
  async deleteIfPresent(chain: string, rule: Rule): Promise<void> {
    await this.command(["-D", chain, ...rule], true);
  }
  async requireConntrack(): Promise<void> {
    try {
      await this.run("conntrack", ["-V"]);
    } catch {
      throw new Error(
        "conntrack-tools is required to revoke existing connections",
      );
    }
  }
  async flushConntrack(source: string, destination: string): Promise<void> {
    await this.deleteConntrack(["-s", source, "-d", destination]);
  }
  async flushConntrackDestination(destination: string): Promise<void> {
    await this.deleteConntrack(["-d", destination]);
  }
  private async deleteConntrack(filter: readonly string[]): Promise<void> {
    try {
      await execute("conntrack", ["-D", "-f", "ipv4", ...filter], {
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const processError = error as {
        code?: number | string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      const output = `${processError.stdout ?? ""}\n${processError.stderr ?? ""}`;
      if (
        processError.code === 1 &&
        /0 flow entries have been deleted\.?/i.test(output)
      )
        return;
      throw new Error("conntrack flow deletion failed");
    }
  }
}
