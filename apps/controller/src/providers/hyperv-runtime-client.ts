import { randomUUID } from "node:crypto";
import {
  hyperVInspectionSchema,
  hyperVConsoleResultSchema,
  type HyperVConsoleRequest,
  vmAllocationIdentitySchema,
  hyperVRuntimeActionSchema,
  hyperVRuntimeActionRequestSchema,
  hyperVRuntimeActionResponseSchema,
  hyperVRuntimeConsoleResponseSchema,
  hyperVRuntimeFactsRequestSchema,
  hyperVRuntimeFactsResponseSchema,
  type VmAllocationIdentity as HyperVAllocationIdentity,
  type HyperVInspection,
  type HyperVRequest,
  type HyperVGuestBootstrapRequest,
  type HyperVRuntimeAction,
  type HyperVRuntimeFacts,
} from "@hitchlet/contracts/internal";
import type { RuntimeAgentJsonTransport } from "./runtime-network-client.js";

export type HyperVRuntimeHttpClientOptions = Readonly<{
  transport: RuntimeAgentJsonTransport;
  installationId: string;
  runtimeIdentityId: string;
  controllerEpoch: number;
  deadlineMs: number;
  now?: () => number;
}>;

const MAX_ACTION_HTTP_TIMEOUT_MS = 240_000;
const FACTS_HTTP_TIMEOUT_MS = 30_000;

/** Authenticated HyperV Runtime Agent adapter; transport owns HTTPS, mTLS, secrets and bounds. */
export class HyperVRuntimeHttpClient {
  private readonly now: () => number;

  constructor(private readonly options: HyperVRuntimeHttpClientOptions) {
    if (!options.installationId || !options.runtimeIdentityId)
      throw new Error("HyperV Runtime Agent identity is required");
    if (
      !Number.isSafeInteger(options.controllerEpoch) ||
      options.controllerEpoch < 1
    )
      throw new Error("HyperV Runtime Agent controller epoch is invalid");
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1)
      throw new Error("HyperV Runtime Agent operation deadline is invalid");
    this.now = options.now ?? Date.now;
  }

  inspect(identity: HyperVAllocationIdentity): Promise<HyperVInspection> {
    return this.action({ kind: "inspect", identity });
  }

  reconcile(request: HyperVRequest): Promise<HyperVInspection> {
    return this.action({ kind: "reconcile", request });
  }

  bootstrapApply(
    request: HyperVGuestBootstrapRequest,
  ): Promise<HyperVInspection> {
    return this.action({ kind: "bootstrap.apply", request });
  }

  stop(identity: HyperVAllocationIdentity): Promise<HyperVInspection> {
    return this.action({ kind: "stop", identity });
  }

  destroy(identity: HyperVAllocationIdentity): Promise<HyperVInspection> {
    return this.action({ kind: "destroy", identity });
  }

  async console(request: HyperVConsoleRequest) {
    return hyperVConsoleResultSchema.parse(
      await this.actionResult({ kind: "console", request }),
    );
  }

  async facts(): Promise<HyperVRuntimeFacts> {
    return readHyperVRuntimeFacts(
      this.options.transport,
      this.options.installationId,
      this.options.runtimeIdentityId,
      FACTS_HTTP_TIMEOUT_MS,
    );
  }

  private async action(
    rawAction: HyperVRuntimeAction,
  ): Promise<HyperVInspection> {
    return hyperVInspectionSchema.parse(await this.actionResult(rawAction));
  }

  private async actionResult(rawAction: HyperVRuntimeAction) {
    const action = hyperVRuntimeActionSchema.parse(rawAction);
    const now = this.now();
    const operationRemainingMs = this.options.deadlineMs - now;
    if (operationRemainingMs < 1)
      throw new Error("HyperV Runtime Agent action deadline has expired");
    const actionDeadlineMs = Math.min(
      this.options.deadlineMs,
      now + MAX_ACTION_HTTP_TIMEOUT_MS,
    );
    const actionBudgetMs = actionDeadlineMs - now;
    const identity =
      action.kind === "reconcile" ||
      action.kind === "bootstrap.apply" ||
      action.kind === "console"
        ? action.request.identity
        : action.identity;
    const request = hyperVRuntimeActionRequestSchema.parse({
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
    const response = (
      action.kind === "console"
        ? hyperVRuntimeConsoleResponseSchema
        : hyperVRuntimeActionResponseSchema
    ).parse(
      await this.options.transport.exchangeJson(
        "/v1/hyperv/actions",
        request,
        actionBudgetMs,
      ),
    );
    if (
      response.requestNonce !== request.requestNonce ||
      response.installationId !== request.installationId ||
      response.runtimeIdentityId !== request.runtimeIdentityId
    )
      throw new Error("HyperV Runtime Agent action identity mismatch");
    const result = response.result;
    if (!sameIdentity(result.identity, identity))
      throw new Error("HyperV Runtime Agent result does not match the action");
    return result;
  }
}

/** Read a nonce-bound discovery sample; it is not a qualification receipt. */
export async function readHyperVRuntimeFacts(
  transport: RuntimeAgentJsonTransport,
  installationId: string,
  runtimeIdentityId: string,
  timeoutMs = FACTS_HTTP_TIMEOUT_MS,
): Promise<HyperVRuntimeFacts> {
  const request = hyperVRuntimeFactsRequestSchema.parse({
    requestNonce: randomUUID(),
    installationId,
    runtimeIdentityId,
  });
  const response = hyperVRuntimeFactsResponseSchema.parse(
    await transport.exchangeJson("/v1/hyperv/facts", request, timeoutMs),
  );
  if (
    response.requestNonce !== request.requestNonce ||
    response.installationId !== request.installationId ||
    response.runtimeIdentityId !== request.runtimeIdentityId
  )
    throw new Error("HyperV Runtime Agent facts identity mismatch");
  return response.facts;
}

function assertIdentityBinding(
  rawIdentity: HyperVAllocationIdentity,
  installationId: string,
  runtimeIdentityId: string,
): void {
  const identity = vmAllocationIdentitySchema.parse(rawIdentity);
  if (
    identity.installationId !== installationId ||
    identity.runtimeIdentityId !== runtimeIdentityId
  )
    throw new Error("HyperV Runtime Agent action identity mismatch");
}

function sameIdentity(
  left: HyperVAllocationIdentity,
  right: HyperVAllocationIdentity,
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
