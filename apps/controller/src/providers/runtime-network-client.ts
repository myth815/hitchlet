import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import {
  canonicalRuntimeNetworkValue,
  runtimeNetworkCommandSchema,
  runtimeNetworkPlanSchema,
  runtimeNetworkResultSchema,
  runtimeNetworkRulesMaterial,
  type RuntimeNetworkCommand,
  type RuntimeNetworkPlan,
  type RuntimeNetworkResult,
} from "@hitchlet/contracts/internal";
import type { RuntimeNetworkPort } from "./runtime-network-port.js";

type PlanInput = Omit<RuntimeNetworkPlan, "expectedRulesetHash">;
type CommandInput = Omit<RuntimeNetworkCommand, "contentHash">;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalRuntimeNetworkValue(value)).digest("hex")}`;
}

export function hashRuntimeNetworkRules(
  plan: RuntimeNetworkPlan,
  revoked = false,
): string {
  return digest(runtimeNetworkRulesMaterial(plan, revoked));
}

export function buildRuntimeNetworkPlan(input: PlanInput): RuntimeNetworkPlan {
  const unhashed = {
    ...input,
    expectedRulesetHash: "sha256:" + "0".repeat(64),
  };
  const expectedRulesetHash = hashRuntimeNetworkRules(
    unhashed as RuntimeNetworkPlan,
  );
  return runtimeNetworkPlanSchema.parse({ ...input, expectedRulesetHash });
}

/** Content hash covers the complete command except the hash field itself. */
export function buildRuntimeNetworkCommand(
  input: CommandInput,
): RuntimeNetworkCommand {
  return runtimeNetworkCommandSchema.parse({
    ...input,
    contentHash: digest(input),
  });
}

export type RuntimeNetworkClientConfig = Readonly<{
  baseUrl: string;
  loadCredentials: () => Promise<RuntimeNetworkCredentials>;
  timeoutMs?: number;
}>;
export type RuntimeNetworkCredentials = Readonly<{
  token: string;
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
}>;
export type RuntimeNetworkCredentialFiles = Readonly<{
  tokenFile: string;
  caFile: string;
  clientCertFile: string;
  clientKeyFile: string;
}>;

/** Optional deployment loader. Application callers should load versioned secrets in memory. */
export function readRuntimeNetworkCredentialFiles(
  files: RuntimeNetworkCredentialFiles,
): () => Promise<RuntimeNetworkCredentials> {
  return async () => {
    const [tokenFile, ca, cert, key] = await Promise.all([
      readFile(files.tokenFile, "utf8"),
      readFile(files.caFile),
      readFile(files.clientCertFile),
      readFile(files.clientKeyFile),
    ]);
    const token = tokenFile.trim();
    if (!token || token.includes("\n"))
      throw new Error("Invalid Runtime Agent token credential");
    return { token, ca, cert, key };
  };
}

/** HTTPS/mTLS adapter. Credentials are read from mounted files and never placed in URLs or logs. */
export class RuntimeNetworkHttpClient implements RuntimeNetworkPort {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(config: RuntimeNetworkClientConfig) {
    this.baseUrl = new URL(config.baseUrl);
    if (this.baseUrl.protocol !== "https:")
      throw new Error("Runtime Agent URL must use HTTPS");
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.loadCredentials = config.loadCredentials;
  }

  private readonly loadCredentials: () => Promise<RuntimeNetworkCredentials>;

  ensure(
    command: Extract<RuntimeNetworkCommand, { kind: "network.ensure" }>,
  ): Promise<RuntimeNetworkResult> {
    return this.send(command, "network.ensure");
  }
  inspect(
    command: Extract<RuntimeNetworkCommand, { kind: "network.inspect" }>,
  ): Promise<RuntimeNetworkResult> {
    return this.send(command, "network.inspect");
  }
  revoke(
    command: Extract<RuntimeNetworkCommand, { kind: "network.revoke" }>,
  ): Promise<RuntimeNetworkResult> {
    return this.send(command, "network.revoke");
  }
  remove(
    command: Extract<RuntimeNetworkCommand, { kind: "network.remove" }>,
  ): Promise<RuntimeNetworkResult> {
    return this.send(command, "network.remove");
  }

  private async send(
    command: RuntimeNetworkCommand,
    kind: RuntimeNetworkCommand["kind"],
  ): Promise<RuntimeNetworkResult> {
    const parsed = runtimeNetworkCommandSchema.parse(command);
    if (parsed.kind !== kind)
      throw new Error("Runtime Agent command/action mismatch");
    const credentials = await this.loadCredentials();
    const body = Buffer.from(JSON.stringify(parsed));
    const target = new URL("/v1/network-actions", this.baseUrl);
    const response = await new Promise<{ status: number; body: Buffer }>(
      (resolve, reject) => {
        const request = https.request(
          target,
          {
            method: "POST",
            ca: credentials.ca,
            cert: credentials.cert,
            key: credentials.key,
            headers: {
              authorization: `Bearer ${credentials.token}`,
              "content-type": "application/json",
              "content-length": body.byteLength,
            },
            timeout: this.timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.byteLength;
              if (size > 256 * 1024)
                request.destroy(new Error("Runtime Agent response too large"));
              else chunks.push(chunk);
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        request.on("timeout", () =>
          request.destroy(new Error("Runtime Agent request timed out")),
        );
        request.on("error", () =>
          reject(new Error("Runtime Agent request failed")),
        );
        request.end(body);
      },
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Runtime Agent returned HTTP ${response.status}`);
    let json: unknown;
    try {
      json = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new Error("Runtime Agent returned invalid JSON");
    }
    const result = runtimeNetworkResultSchema.parse(json);
    assertRuntimeNetworkResponse(parsed, result);
    return result;
  }
}

export function assertRuntimeNetworkResponse(
  command: RuntimeNetworkCommand,
  result: RuntimeNetworkResult,
): void {
  if (
    result.commandId !== command.commandId ||
    result.operationId !== command.operationId ||
    result.allocationId !== command.allocationId ||
    result.generation !== command.generation
  )
    throw new Error("Runtime Agent response does not match the command");

  if (command.kind === "network.inspect" && result.status === "unknown") {
    if (result.nativeEngineId !== null || result.rulesetHash !== null)
      throw new Error("Unverified Runtime Agent response included evidence");
    return;
  }

  if (result.nativeEngineId !== command.plan.nativeEngineId)
    throw new Error("Runtime Agent response Engine identity mismatch");
  const expected =
    command.kind === "network.ensure"
      ? { status: "installed", rulesetHash: command.plan.expectedRulesetHash }
      : command.kind === "network.inspect"
        ? { status: "present", rulesetHash: command.plan.expectedRulesetHash }
        : command.kind === "network.revoke"
          ? {
              status: "revoked",
              rulesetHash: hashRuntimeNetworkRules(command.plan, true),
            }
          : { status: "removed", rulesetHash: null };
  if (
    result.status !== expected.status ||
    result.rulesetHash !== expected.rulesetHash
  )
    throw new Error("Runtime Agent response status or ruleset hash mismatch");
}
