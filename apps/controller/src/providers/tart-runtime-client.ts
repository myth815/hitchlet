import { randomUUID } from "node:crypto";
import {
  tartAllocationIdentitySchema,
  tartInspectionSchema,
  tartRuntimeActionSchema,
  tartRuntimeActionRequestSchema,
  tartRuntimeActionResponseSchema,
  tartRuntimeFactsRequestSchema,
  tartRuntimeFactsResponseSchema,
  type TartAllocationIdentity,
  type TartGuestBootstrapReceipt,
  type TartGuestBootstrapRequest,
  type TartInspection,
  type TartNetworkPlan,
  type TartReconcileRequest,
  type TartRuntimeAction,
  type TartRuntimeFacts,
} from "@hitchlet/contracts/internal";
import type { RuntimeAgentJsonTransport } from "./runtime-network-client.js";

export type TartRuntimeHttpClientOptions = Readonly<{
  transport: RuntimeAgentJsonTransport;
  installationId: string;
  runtimeIdentityId: string;
  controllerEpoch: number;
  deadlineMs: number;
  now?: () => number;
}>;

const MAX_ACTION_HTTP_TIMEOUT_MS = 240_000;
const FACTS_HTTP_TIMEOUT_MS = 30_000;

/** Authenticated Tart Runtime Agent adapter; transport owns HTTPS, mTLS, secrets and bounds. */
export class TartRuntimeHttpClient {
  private readonly now: () => number;

  constructor(private readonly options: TartRuntimeHttpClientOptions) {
    if (!options.installationId || !options.runtimeIdentityId)
      throw new Error("Tart Runtime Agent identity is required");
    if (
      !Number.isSafeInteger(options.controllerEpoch) ||
      options.controllerEpoch < 1
    )
      throw new Error("Tart Runtime Agent controller epoch is invalid");
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1)
      throw new Error("Tart Runtime Agent operation deadline is invalid");
    this.now = options.now ?? Date.now;
  }

  inspect(identity: TartAllocationIdentity): Promise<TartInspection> {
    return this.action({ kind: "inspect", identity });
  }

  reconcile(request: TartReconcileRequest): Promise<TartInspection> {
    return this.action({ kind: "reconcile", request });
  }

  bootstrapApply(
    identity: TartAllocationIdentity,
    request: TartGuestBootstrapRequest,
  ): Promise<TartInspection> {
    return this.action({
      kind: "bootstrap.apply",
      identity,
      request,
    });
  }

  revokeNetwork(
    identity: TartAllocationIdentity,
    network: TartNetworkPlan,
  ): Promise<TartInspection> {
    return this.action({ kind: "network.revoke", identity, network });
  }

  destroy(identity: TartAllocationIdentity): Promise<TartInspection> {
    return this.action({ kind: "destroy", identity });
  }

  async facts(): Promise<TartRuntimeFacts> {
    return readTartRuntimeFacts(
      this.options.transport,
      this.options.installationId,
      this.options.runtimeIdentityId,
      FACTS_HTTP_TIMEOUT_MS,
    );
  }

  private async action(rawAction: TartRuntimeAction): Promise<TartInspection> {
    const action = tartRuntimeActionSchema.parse(rawAction);
    const now = this.now();
    const operationRemainingMs = this.options.deadlineMs - now;
    if (operationRemainingMs < 1)
      throw new Error("Tart Runtime Agent action deadline has expired");
    const actionDeadlineMs = Math.min(
      this.options.deadlineMs,
      now + MAX_ACTION_HTTP_TIMEOUT_MS,
    );
    const actionBudgetMs = actionDeadlineMs - now;
    const identity =
      action.kind === "reconcile" ? action.request.identity : action.identity;
    if (
      action.kind === "bootstrap.apply" &&
      !sameIdentity(action.identity, action.request.identity)
    )
      throw new Error("Tart bootstrap identity does not match the action");
    const request = tartRuntimeActionRequestSchema.parse({
      requestNonce: randomUUID(),
      deadline: new Date(actionDeadlineMs).toISOString(),
      controllerEpoch: this.options.controllerEpoch,
      installationId: this.options.installationId,
      runtimeIdentityId: this.options.runtimeIdentityId,
      action,
    });
    assertIdentityBinding(
      identity,
      request.installationId,
      request.runtimeIdentityId,
    );
    const response = tartRuntimeActionResponseSchema.parse(
      await this.options.transport.exchangeJson(
        "/v1/tart/actions",
        request,
        actionBudgetMs,
      ),
    );
    if (
      response.requestNonce !== request.requestNonce ||
      response.installationId !== request.installationId ||
      response.runtimeIdentityId !== request.runtimeIdentityId
    )
      throw new Error("Tart Runtime Agent action identity mismatch");
    const result = tartInspectionSchema.parse(response.result);
    if (!sameIdentity(result.identity, identity))
      throw new Error("Tart Runtime Agent result does not match the action");
    return result;
  }
}

/** Read a nonce-bound discovery sample; it is not a qualification receipt. */
export async function readTartRuntimeFacts(
  transport: RuntimeAgentJsonTransport,
  installationId: string,
  runtimeIdentityId: string,
  timeoutMs = FACTS_HTTP_TIMEOUT_MS,
): Promise<TartRuntimeFacts> {
  const request = tartRuntimeFactsRequestSchema.parse({
    requestNonce: randomUUID(),
    installationId,
    runtimeIdentityId,
  });
  const response = tartRuntimeFactsResponseSchema.parse(
    await transport.exchangeJson("/v1/tart/facts", request, timeoutMs),
  );
  if (
    response.requestNonce !== request.requestNonce ||
    response.installationId !== request.installationId ||
    response.runtimeIdentityId !== request.runtimeIdentityId
  )
    throw new Error("Tart Runtime Agent facts identity mismatch");
  return response.facts;
}

function assertIdentityBinding(
  rawIdentity: TartAllocationIdentity,
  installationId: string,
  runtimeIdentityId: string,
): void {
  const identity = tartAllocationIdentitySchema.parse(rawIdentity);
  if (
    identity.installationId !== installationId ||
    identity.runtimeIdentityId !== runtimeIdentityId
  )
    throw new Error("Tart Runtime Agent action identity mismatch");
}

function sameIdentity(
  left: TartAllocationIdentity,
  right: TartAllocationIdentity,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.runtimeIdentityId === right.runtimeIdentityId &&
    left.connectionRevisionId === right.connectionRevisionId &&
    left.allocationId === right.allocationId &&
    left.generation === right.generation &&
    left.operationId === right.operationId &&
    left.controlVersion === right.controlVersion &&
    left.purpose === right.purpose
  );
}
