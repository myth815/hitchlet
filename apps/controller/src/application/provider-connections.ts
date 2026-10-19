import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PortainerProbe } from "../providers/port.js";
import { SQLiteProviderConnectionStore } from "../storage/admin-stores.js";

const DiscoveryIntentSchema = z
  .object({
    type: z.literal("portainer.discovery"),
    endpointUrl: z.string().url(),
    environmentId: z.string().regex(/^\d+$/),
    secretVersionRef: z.string().regex(/^secret:[a-f0-9]{32}$/),
  })
  .strict();
const ConnectionRevisionIntentSchema = z
  .object({
    type: z.literal("portainer.connection_revision"),
    connectionId: z.string().uuid(),
    endpointUrl: z.string().url(),
    environmentId: z.string().regex(/^\d+$/),
    secretVersionRef: z.string().regex(/^secret:[a-f0-9]{32}$/),
    expectedRuntimeIdentityId: z.string().uuid(),
  })
  .strict();

/** Read-only Portainer discovery and same-Engine revision use cases. Persistence stays behind the adapter. */
export class PortainerConnectionService {
  constructor(
    private readonly store: SQLiteProviderConnectionStore,
    private readonly probe: PortainerProbe,
    private readonly now = Date.now,
    private readonly allowLoopbackHttp = false,
    private readonly readSecret?: (versionRef: string) => Promise<string>,
  ) {}
  async discover(input: {
    endpointUrl: string;
    environmentId: string;
    secretVersionRef: string;
    apiKey?: string;
    operationId?: string;
  }) {
    const target = normalizeTarget(input, this.allowLoopbackHttp),
      operationId = input.operationId ?? randomUUID();
    const started = await this.store.beginDiscovery(operationId, {
      ...target,
      secretVersionRef: input.secretVersionRef,
    });
    if (started.complete) return this.discoveryReceipt(operationId);
    try {
      const apiKey = await this.resolveSecret(
        input.secretVersionRef,
        input.apiKey,
      );
      const evidence = await this.probe({ ...target, apiKey });
      if (
        !evidence.engineId.trim() ||
        !evidence.dockerVersion ||
        !evidence.apiVersion ||
        !evidence.minimumApiVersion ||
        !evidence.portainerVersion
      )
        throw new Error(
          "Incomplete Portainer and Docker Engine identity/version evidence",
        );
      await this.store.completeDiscovery(
        operationId,
        { ...target, secretVersionRef: input.secretVersionRef },
        evidence,
      );
      return this.discoveryReceipt(operationId);
    } catch (error) {
      await this.store.markUnknown(operationId, "probe_failed");
      return this.discoveryReceipt(operationId);
    }
  }
  async proposeConnectionRevision(input: {
    connectionId: string;
    endpointUrl: string;
    environmentId: string;
    secretVersionRef: string;
    apiKey?: string;
    operationId?: string;
  }) {
    const target = normalizeTarget(input, this.allowLoopbackHttp),
      operationId = input.operationId ?? randomUUID();
    if (!/^secret:[a-f0-9]{32}$/.test(input.secretVersionRef))
      throw new RangeError("Invalid secret version reference");
    const started = await this.store.beginRevision(operationId, {
      connectionId: input.connectionId,
      ...target,
      secretVersionRef: input.secretVersionRef,
    });
    if (started.complete) return this.connectionRevisionReceipt(operationId);
    try {
      const apiKey = await this.resolveSecret(
        input.secretVersionRef,
        input.apiKey,
      );
      const evidence = await this.probe({ ...target, apiKey });
      if (
        !evidence.engineId.trim() ||
        !evidence.dockerVersion ||
        !evidence.apiVersion ||
        !evidence.minimumApiVersion ||
        !evidence.portainerVersion
      )
        throw new Error(
          "Incomplete Portainer and Docker Engine identity/version evidence",
        );
      const identity = await this.store.runtimeNativeId(
        started.expectedRuntimeIdentityId,
      );
      if (!identity || evidence.engineId !== String(identity.native_id))
        throw new Error(
          "Proposed endpoint authenticates as a different Engine",
        );
      await this.store.completeRevision(
        operationId,
        {
          connectionId: input.connectionId,
          ...target,
          secretVersionRef: input.secretVersionRef,
        },
        started.expectedRuntimeIdentityId,
        evidence,
      );
      return this.connectionRevisionReceipt(operationId);
    } catch (error) {
      await this.store.markUnknown(
        operationId,
        "probe_failed_or_identity_mismatch",
      );
      return this.connectionRevisionReceipt(operationId);
    }
  }
  activateConnectionRevision(
    ...args: Parameters<
      SQLiteProviderConnectionStore["activateConnectionRevision"]
    >
  ) {
    return this.store.activateConnectionRevision(...args);
  }
  async retryDiscovery(operationId: string) {
    const operation = await this.store.discoveryOperation(operationId);
    if (!operation || typeof operation.intent_json !== "string") return null;
    const intent = DiscoveryIntentSchema.parse(
      JSON.parse(String(operation.intent_json)),
    );
    return this.discover({
      endpointUrl: intent.endpointUrl,
      environmentId: intent.environmentId,
      secretVersionRef: intent.secretVersionRef,
      operationId,
    });
  }
  async discoveryReceipt(operationId: string) {
    const operation = await this.store.discoveryOperation(operationId);
    if (!operation) return null;
    return {
      operationId: String(operation.id),
      state: String(operation.state),
      createdAtMs: Number(operation.created_at_ms),
      updatedAtMs: Number(operation.updated_at_ms),
      retryable: operation.state === "unknown",
      result: safeDiscoveryResult(operation.result_json),
    };
  }
  async retryConnectionRevision(operationId: string) {
    const operation = await this.store.connectionRevisionOperation(operationId);
    if (!operation || typeof operation.intent_json !== "string") return null;
    const intent = ConnectionRevisionIntentSchema.parse(
      JSON.parse(String(operation.intent_json)),
    );
    return this.proposeConnectionRevision({
      connectionId: intent.connectionId,
      endpointUrl: intent.endpointUrl,
      environmentId: intent.environmentId,
      secretVersionRef: intent.secretVersionRef,
      operationId,
    });
  }
  async connectionRevisionReceipt(operationId: string) {
    const operation = await this.store.connectionRevisionOperation(operationId);
    if (!operation) return null;
    return {
      operationId: String(operation.id),
      state: String(operation.state),
      createdAtMs: Number(operation.created_at_ms),
      updatedAtMs: Number(operation.updated_at_ms),
      retryable: operation.state === "unknown",
      result: safeDiscoveryResult(operation.result_json),
    };
  }
  private async resolveSecret(versionRef: string, apiKey?: string) {
    if (apiKey) return apiKey;
    if (!this.readSecret) throw new Error("Secret store is unavailable");
    return this.readSecret(versionRef);
  }
}
function normalizeTarget(
  input: {
    endpointUrl: string;
    environmentId: string;
    secretVersionRef: string;
  },
  allowLoopbackHttp: boolean,
) {
  const endpoint = new URL(input.endpointUrl);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  )
    throw new RangeError("Invalid Portainer endpoint URL");
  if (endpoint.pathname !== "/")
    throw new RangeError(
      "Portainer endpoint URLs must not include a base path",
    );
  if (
    endpoint.protocol === "http:" &&
    (!allowLoopbackHttp ||
      !["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname))
  )
    throw new RangeError(
      "Portainer HTTP requires explicit loopback development configuration",
    );
  if (
    !/^\d+$/.test(input.environmentId) ||
    input.environmentId === "0" ||
    !/^secret:[a-f0-9]{32}$/.test(input.secretVersionRef)
  )
    throw new RangeError("Invalid environment or secret version reference");
  return {
    endpointUrl: endpoint.toString().replace(/\/$/, ""),
    environmentId: input.environmentId,
  };
}

function safeDiscoveryResult(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const result = parsed as Record<string, unknown>;
    return {
      ...(typeof result.connectionId === "string"
        ? { connectionId: result.connectionId }
        : {}),
      ...(typeof result.engineId === "string"
        ? { engineId: result.engineId }
        : {}),
      ...(typeof result.connectionRevisionId === "string"
        ? { connectionRevisionId: result.connectionRevisionId }
        : {}),
      ...(typeof result.revision === "number"
        ? { revision: result.revision }
        : {}),
      ...(typeof result.duplicateRuntime === "boolean"
        ? { duplicateRuntime: result.duplicateRuntime }
        : {}),
      ...(typeof result.code === "string" ? { errorCode: result.code } : {}),
    };
  } catch {
    return null;
  }
}
