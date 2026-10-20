import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import {
  runtimeStorageRequestSchema,
  runtimeStorageResultSchema,
  type RuntimeStorageRequest,
  type RuntimeStorageResult,
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
/** Authenticated, nonce-bound response plus a local receipt clock. The remote
 * observedAtMs is diagnostic only; capacity age is measured from receivedAtMs. */
export type ReceivedRuntimeStorageFacts = RuntimeStorageResult &
  Readonly<{ receivedAtMs: number }>;
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
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30_000
    )
      throw new RangeError(
        "Runtime Agent timeout must be between 1 and 30000ms",
      );
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

  async storageFacts(
    request: Omit<RuntimeStorageRequest, "inventory"> & { inventory?: boolean },
  ): Promise<ReceivedRuntimeStorageFacts> {
    const parsed = runtimeStorageRequestSchema.parse(request);
    const result = runtimeStorageResultSchema.parse(
      await this.exchange("/v1/storage-facts", parsed),
    );
    if (
      result.requestId !== parsed.requestId ||
      result.installationId !== parsed.installationId ||
      result.runtimeIdentityId !== parsed.runtimeIdentityId ||
      result.nativeEngineId !== parsed.nativeEngineId
    )
      throw new Error("Runtime storage facts identity mismatch");
    if (
      result.mounts.length !== parsed.mounts.length ||
      parsed.mounts.some(
        (m) =>
          result.mounts.filter((r) => r.grantId === m.grantId).length !== 1,
      )
    )
      throw new Error("Runtime storage facts incomplete");
    // TLS/bearer authentication, the request nonce and a bounded complete HTTP
    // exchange prove this live sample. Agent wall-clock skew cannot age/future
    // date a controller admission record. Preserve its timestamp for diagnosis.
    return { ...result, receivedAtMs: Date.now() };
  }
  private async exchange(path: string, payload: unknown): Promise<unknown> {
    const credentials = await this.loadCredentials();
    const body = Buffer.from(JSON.stringify(payload));
    const target = new URL(path, this.baseUrl);
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
        // Socket inactivity alone does not bound a peer that drips body bytes.
        const deadline = setTimeout(
          () => request.destroy(new Error("Runtime Agent request timed out")),
          this.timeoutMs,
        );
        request.once("close", () => clearTimeout(deadline));
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
    return json;
  }

  private async send(
    command: RuntimeNetworkCommand,
    kind: RuntimeNetworkCommand["kind"],
  ): Promise<RuntimeNetworkResult> {
    const parsed = runtimeNetworkCommandSchema.parse(command);
    if (parsed.kind !== kind)
      throw new Error("Runtime Agent command/action mismatch");
    const json = await this.exchange("/v1/network-actions", parsed);
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
