import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import {
  canonicalTartNetworkPlan,
  tartNetworkPlanSchema,
  type TartNetworkPlan,
} from "@hitchlet/contracts/internal";
import { currentCommandDeadlineMs } from "../command-exec.js";

const MAX_SOFTNET_RULES = 4096;
const MAX_SOFTNET_ARGUMENT_BYTES = 32_000;
const CONTROL_TIMEOUT_MS = 5_000;
const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

export type CompiledTartNetworkPolicy = Readonly<{
  allow: readonly string[];
  block: readonly string[];
  policyHash: string;
}>;

export type SoftnetPolicyReadback = Readonly<{
  allow: string[];
  block: string[];
  ruleCount: number;
}>;
export type TartNetworkProcessExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type TartNetworkSession = Readonly<{
  child: ChildProcess;
  exit: Promise<TartNetworkProcessExit>;
  startedAt: string;
  getPolicy(): Promise<SoftnetPolicyReadback>;
  setPolicy(
    allow: readonly string[],
    block: readonly string[],
  ): Promise<SoftnetPolicyReadback>;
}>;

export type TartNetworkAdapter = Readonly<{
  launch(input: {
    executable: string;
    home: string;
    env: NodeJS.ProcessEnv;
    vmName: string;
    policy: CompiledTartNetworkPolicy;
  }): Promise<TartNetworkSession>;
}>;

/**
 * Compile a frozen source/access contract to Softnet's directional IPv4 rules.
 * Management-deny CIDRs are subtracted from each egress allow so Softnet's
 * port-first precedence cannot let a service allow outrank an admin deny.
 */
export function compileTartNetworkPolicy(
  rawPlan: TartNetworkPlan,
): CompiledTartNetworkPolicy {
  const plan = tartNetworkPlanSchema.parse(rawPlan);
  if (plan.mode !== "isolated_vm" || plan.enforcement !== "tart_agent")
    throw new Error("tart_network_mode_unsupported");
  if (plan.ipv6 !== "disabled")
    throw new Error("tart_network_ipv6_unsupported");
  if (plan.accessPorts.length !== 1 || plan.accessPorts[0] !== 22)
    throw new Error("tart_network_access_port_unsupported");

  const allow = new Set<string>();
  const block = new Set<string>(["in 0.0.0.0/0", "out 0.0.0.0/0"]);
  const egressByService = new Map<string, Set<string>>();
  const accessNetworks = intersectCidrs(
    plan.allowedIngressSourceCidrs,
    plan.accessSourceCidrs,
  );
  for (const cidr of accessNetworks) allow.add(`in proto tcp ${cidr} port 22`);

  const egressRules = plan.allowedEgress.flatMap((rule) => {
    const cidr = normalizeCidr(rule.cidr);
    const deny = plan.managementDenyRules
      .filter(
        (item) => item.protocol === "any" || item.protocol === rule.protocol,
      )
      .map((item) => ({
        cidr: normalizeCidr(item.cidr),
        ports: item.ports,
      }));
    return [...new Set(rule.ports)].flatMap((port) => {
      let allowed = [cidr];
      for (const item of deny) {
        if (item.ports !== "any" && !item.ports.includes(port)) continue;
        allowed = allowed.flatMap((prefix) => subtractCidr(prefix, item.cidr));
      }
      const service = `${rule.protocol}:${port}`;
      const prefixes = egressByService.get(service) ?? new Set<string>();
      const rules = allowed.map(
        (prefix) => `out proto ${rule.protocol} ${prefix} port ${port}`,
      );
      for (const prefix of allowed) prefixes.add(prefix);
      egressByService.set(service, prefixes);
      return rules;
    });
  });
  for (const rule of egressRules) allow.add(rule);
  for (const [service, prefixes] of egressByService) {
    if (prefixes.has("0.0.0.0/0")) continue;
    const [protocol, port] = service.split(":");
    block.add(`out proto ${protocol} 0.0.0.0/0 port ${port}`);
  }

  const canonicalAllow = [...allow].sort();
  const canonicalBlock = [...block].sort();
  if (
    canonicalAllow.length + canonicalBlock.length > MAX_SOFTNET_RULES ||
    Buffer.byteLength(canonicalAllow.join(",")) > MAX_SOFTNET_ARGUMENT_BYTES ||
    Buffer.byteLength(canonicalBlock.join(",")) > MAX_SOFTNET_ARGUMENT_BYTES
  )
    throw new Error("tart_network_rule_limit_exceeded");

  const policyHash = hashSoftnetPolicy(canonicalAllow, canonicalBlock);
  const planHash =
    "sha256:" +
    createHash("sha256").update(canonicalTartNetworkPlan(plan)).digest("hex");
  if (plan.contractHash !== planHash)
    throw new Error("tart_network_contract_hash_mismatch");
  return { allow: canonicalAllow, block: canonicalBlock, policyHash };
}

export function hashSoftnetPolicy(
  allow: readonly string[],
  block: readonly string[],
): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          allow: [...allow].sort(),
          block: [...block].sort(),
        }),
      )
      .digest("hex")
  );
}

/** Tart 2.41.1 resolves Softnet from PATH and inherits fd 3 as its control socket. */
export class TartSoftnetNetworkAdapter implements TartNetworkAdapter {
  constructor(private readonly softnetExecutable: string) {
    if (
      !isAbsolute(softnetExecutable) ||
      softnetExecutable.split("/").at(-1) !== "softnet"
    )
      throw new Error("tart_softnet_executable_must_be_absolute");
  }

  async launch(input: {
    executable: string;
    home: string;
    env: NodeJS.ProcessEnv;
    vmName: string;
    policy: CompiledTartNetworkPolicy;
  }): Promise<TartNetworkSession> {
    const softnetStat = await stat(this.softnetExecutable);
    await access(this.softnetExecutable, constants.X_OK);
    if (!softnetStat.isFile()) throw new Error("tart_softnet_binary_invalid");
    const args = [
      "run",
      "--no-graphics",
      "--net-softnet-allow=" + input.policy.allow.join(","),
      "--net-softnet-block=" + input.policy.block.join(","),
      "--net-softnet-control-fd=3",
      input.vmName,
    ];
    const env = {
      ...input.env,
      PATH: `${dirname(this.softnetExecutable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    const child = spawn(input.executable, args, {
      cwd: input.home,
      env,
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const startedAt = new Date().toISOString();
    let resolveExit!: (value: TartNetworkProcessExit) => void;
    const exit = new Promise<TartNetworkProcessExit>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    child.once("error", () => resolveExit({ code: null, signal: null }));
    child.once("close", (code, signal) => resolveExit({ code, signal }));
    await waitForSpawn(child);
    const controlStream = child.stdio[3];
    if (
      !controlStream ||
      typeof (controlStream as Duplex).write !== "function"
    ) {
      child.kill("SIGINT");
      throw new Error("tart_softnet_control_fd_unavailable");
    }
    const control = new SoftnetControlChannel(controlStream as Duplex);
    return {
      child,
      exit,
      startedAt,
      getPolicy: () => control.getPolicy(),
      setPolicy: (allow, block) => control.setPolicy(allow, block),
    };
  }
}

/** Small JSON-RPC 2.0 client for Softnet's one inherited Unix-stream fd. */
export class SoftnetControlChannel {
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: SoftnetPolicyReadback): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly stream: Duplex) {
    stream.on("data", (chunk: Buffer | string) => this.onData(String(chunk)));
    stream.on("error", () => this.failAll("tart_softnet_control_disconnected"));
    stream.on("close", () => this.failAll("tart_softnet_control_disconnected"));
  }

  getPolicy(): Promise<SoftnetPolicyReadback> {
    return this.request("softnet.policy.get", null);
  }

  setPolicy(
    allow: readonly string[],
    block: readonly string[],
  ): Promise<SoftnetPolicyReadback> {
    return this.request("softnet.policy.set", { allow, block });
  }

  close(): void {
    this.failAll("tart_softnet_control_disconnected");
    this.stream.end();
  }

  private request(
    method: string,
    params: unknown,
  ): Promise<SoftnetPolicyReadback> {
    const id = ++this.nextId;
    return new Promise((resolvePromise, rejectPromise) => {
      const deadline = currentCommandDeadlineMs();
      const timeout = Math.floor(
        Math.min(
          CONTROL_TIMEOUT_MS,
          deadline === undefined ? CONTROL_TIMEOUT_MS : deadline - Date.now(),
        ),
      );
      if (timeout <= 0) {
        rejectPromise(new Error("tart_command_deadline_expired"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error("tart_softnet_control_timeout"));
      }, timeout);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      this.stream.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new Error("tart_softnet_control_disconnected"));
        },
      );
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_CONTROL_FRAME_BYTES) {
      this.failAll("tart_softnet_control_frame_too_large");
      this.stream.destroy();
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let response: unknown;
      try {
        response = JSON.parse(line);
      } catch {
        this.failAll("tart_softnet_control_response_invalid");
        this.stream.destroy();
        return;
      }
      this.resolveResponse(response);
    }
  }

  private resolveResponse(raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      this.failAll("tart_softnet_control_response_invalid");
      return;
    }
    const value = raw as Record<string, unknown>;
    if (value.jsonrpc !== "2.0" || typeof value.id !== "number") {
      this.failAll("tart_softnet_control_response_invalid");
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.error || !isPolicyReadback(value.result)) {
      pending.reject(new Error("tart_softnet_policy_rpc_failed"));
      return;
    }
    pending.resolve(value.result);
  }

  private failAll(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}

export function sameSoftnetPolicy(
  actual: SoftnetPolicyReadback,
  expected: CompiledTartNetworkPolicy,
): boolean {
  return (
    actual.allow.slice().sort().join("\n") === expected.allow.join("\n") &&
    actual.block.slice().sort().join("\n") === expected.block.join("\n")
  );
}

export function isPolicyReadback(
  value: unknown,
): value is SoftnetPolicyReadback {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.allow) &&
    candidate.allow.every((item) => typeof item === "string") &&
    Array.isArray(candidate.block) &&
    candidate.block.every((item) => typeof item === "string") &&
    typeof candidate.ruleCount === "number" &&
    Number.isInteger(candidate.ruleCount) &&
    candidate.ruleCount >= 0 &&
    candidate.ruleCount <= MAX_SOFTNET_RULES * 2
  );
}

function intersectCidrs(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const intersections = new Set<string>();
  for (const a of left) {
    const aRange = parseCidr(a);
    for (const b of right) {
      const bRange = parseCidr(b);
      const start = aRange.start > bRange.start ? aRange.start : bRange.start;
      const end = aRange.end < bRange.end ? aRange.end : bRange.end;
      if (start <= end) intersections.add(rangeToCidr(start, end));
    }
  }
  return [...intersections].sort();
}

function subtractCidr(baseText: string, deniedText: string): string[] {
  const base = parseCidr(baseText);
  const denied = parseCidr(deniedText);
  const output: string[] = [];
  const visit = (start: bigint, prefix: number): void => {
    const size = 1n << BigInt(32 - prefix);
    const end = start + size - 1n;
    if (denied.end < start || denied.start > end) {
      output.push(formatCidr(start, prefix));
      return;
    }
    if (denied.start <= start && denied.end >= end) return;
    if (prefix >= 32) return;
    visit(start, prefix + 1);
    visit(start + (1n << BigInt(31 - prefix)), prefix + 1);
  };
  visit(base.start, base.prefix);
  return output;
}

function normalizeCidr(value: string): string {
  const parsed = parseCidr(value);
  return formatCidr(parsed.start, parsed.prefix);
}

function parseCidr(value: string): {
  start: bigint;
  end: bigint;
  prefix: number;
} {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !/^\d{1,2}$/.test(parts[1]!))
    throw new Error("tart_network_ipv4_cidr_required");
  const octets = parts[0].split(".");
  const prefix = Number(parts[1]);
  if (
    octets.length !== 4 ||
    octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255) ||
    prefix < 0 ||
    prefix > 32
  )
    throw new Error("tart_network_ipv4_cidr_invalid");
  const address = octets.reduce(
    (result, part) => (result << 8n) | BigInt(Number(part)),
    0n,
  );
  const size = 1n << BigInt(32 - prefix);
  const start = (address / size) * size;
  return { start, end: start + size - 1n, prefix };
}

function rangeToCidr(start: bigint, end: bigint): string {
  for (let prefix = 32; prefix >= 0; prefix--) {
    const size = 1n << BigInt(32 - prefix);
    const base = (start / size) * size;
    if (base === start && base + size - 1n === end)
      return formatCidr(start, prefix);
  }
  throw new Error("tart_network_cidr_intersection_invalid");
}

function formatCidr(address: bigint, prefix: number): string {
  const octets = [24n, 16n, 8n, 0n].map((shift) =>
    Number((address >> shift) & 255n),
  );
  return `${octets.join(".")}/${prefix}`;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const remaining = currentCommandDeadlineMs();
    const timeout = Math.floor(
      Math.min(
        CONTROL_TIMEOUT_MS,
        remaining === undefined ? CONTROL_TIMEOUT_MS : remaining - Date.now(),
      ),
    );
    if (timeout <= 0) {
      child.kill("SIGINT");
      rejectPromise(new Error("tart_command_deadline_expired"));
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGINT");
      rejectPromise(new Error("tart_softnet_process_start_timeout"));
    }, timeout);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.once("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("tart_softnet_process_start_failed"));
    });
  });
}
