import {
  ImageCachePortError,
  type ImageCacheExecutionPort,
} from "../providers/image-cache-port.js";
import {
  SQLiteImageCacheStore,
  type ClaimedImageCacheOperation,
  type ImageCacheDiagnostic,
} from "../storage/image-cache-store.js";

export type CacheCapacityEvidence = Readonly<{
  verified: true;
  evidenceId: string;
  /** Controller receipt time; remote sample time never gates admission. */
  observedAtMs: number;
  /** Optional remote wall-clock sample retained only for diagnosis. */
  sampledAtMs?: number;
  availableMiB: number;
  requiredMiB: number;
  lowWaterMiB: number;
}>;

/** D23 must supply fresh, host-backed capacity evidence before new image pulls. */
export type ImageCacheCapacityGuard = (
  operation: ClaimedImageCacheOperation,
) => Promise<CacheCapacityEvidence | undefined>;

export type ImageCacheOperationStore = Pick<
  SQLiteImageCacheStore,
  | "claimDue"
  | "assertCurrent"
  | "pullAllowed"
  | "evictionBlock"
  | "recordReady"
  | "recordAbsent"
  | "markDeleteStarted"
  | "markDeleteConfirmed"
  | "finish"
  | "finishKnownFailure"
>;

export class ImageCacheWorker {
  constructor(
    private readonly store: ImageCacheOperationStore,
    private readonly provider: ImageCacheExecutionPort,
    private readonly capacity: ImageCacheCapacityGuard,
    private readonly now = Date.now,
  ) {}

  async reconcile(): Promise<{
    claimed: number;
    succeeded: number;
    deferred: number;
  }> {
    const operations = await this.store.claimDue();
    let succeeded = 0;
    let deferred = 0;
    for (const operation of operations) {
      const result = await this.runOne(operation);
      if (result === "succeeded") succeeded++;
      else deferred++;
    }
    return { claimed: operations.length, succeeded, deferred };
  }

  private async runOne(
    op: ClaimedImageCacheOperation,
  ): Promise<"succeeded" | "deferred"> {
    try {
      if (!(await this.store.assertCurrent(op))) return "deferred";
      if (op.kind === "image-cache.pull") return await this.pull(op);
      return await this.evict(op);
    } catch (error) {
      const code = diagnosticFor(error);
      await this.store
        .finish(op.operationId, op.ownerToken, "unknown", code)
        .catch(() => undefined);
      return "deferred";
    }
  }

  private async pull(
    op: ClaimedImageCacheOperation,
  ): Promise<"succeeded" | "deferred"> {
    if (!(await this.store.pullAllowed(op))) {
      await this.store.finish(
        op.operationId,
        op.ownerToken,
        "unknown",
        "operation_superseded",
      );
      return "deferred";
    }
    let local = await this.provider.inspectLocal(op);
    if (local.presence === "present") {
      if (
        local.localRef !== op.digest ||
        local.architecture !== op.architecture ||
        local.os !== "linux"
      ) {
        await this.store.finishKnownFailure(
          op,
          "artifact_verification_failed",
          "invalid",
        );
        return "deferred";
      }
      await this.provider.verifyRegistryManifest(op);
      if (
        !(await this.store.assertCurrent(op)) ||
        !(await this.store.pullAllowed(op))
      ) {
        await this.store.finish(
          op.operationId,
          op.ownerToken,
          "unknown",
          "operation_superseded",
        );
        return "deferred";
      }
      const recorded = await this.store.recordReady(
        op,
        local.localRef,
        local.sizeMiB,
      );
      return recorded ? "succeeded" : "deferred";
    }

    if (!(await this.store.pullAllowed(op))) {
      await this.store.finishKnownFailure(
        op,
        "operation_superseded",
        "missing",
      );
      return "deferred";
    }
    const evidence = await this.capacity(op);
    if (!validCapacityEvidence(evidence, this.now())) {
      await this.store.finishKnownFailure(op, "capacity_unverified", "missing");
      return "deferred";
    }
    await this.provider.verifyRegistryManifest(op);
    if (
      !(await this.store.assertCurrent(op)) ||
      !(await this.store.pullAllowed(op))
    ) {
      await this.store.finishKnownFailure(
        op,
        "operation_superseded",
        "missing",
      );
      return "deferred";
    }
    await this.provider.pullPinned(op);
    if (!(await this.store.assertCurrent(op))) return "deferred";
    local = await this.provider.inspectLocal(op);
    if (
      local.presence !== "present" ||
      local.localRef !== op.digest ||
      local.architecture !== op.architecture ||
      local.os !== "linux"
    ) {
      await this.store.finish(
        op.operationId,
        op.ownerToken,
        "unknown",
        "artifact_verification_failed",
      );
      return "deferred";
    }
    const recorded = await this.store.recordReady(
      op,
      local.localRef,
      local.sizeMiB,
    );
    return recorded ? "succeeded" : "deferred";
  }

  private async evict(
    op: ClaimedImageCacheOperation,
  ): Promise<"succeeded" | "deferred"> {
    const local = await this.provider.inspectLocal(op);
    if (local.presence === "absent" && !op.deleteAttempted) {
      const recorded = await this.store.recordAbsent(op);
      return recorded ? "succeeded" : "deferred";
    }
    if (
      local.presence === "present" &&
      (local.localRef !== op.digest ||
        local.architecture !== op.architecture ||
        local.os !== "linux")
    ) {
      await this.store.finish(
        op.operationId,
        op.ownerToken,
        "unknown",
        "artifact_verification_failed",
      );
      return "deferred";
    }
    const block = await this.store.evictionBlock(op);
    if (block) {
      if (op.deleteAttempted)
        await this.store.finish(
          op.operationId,
          op.ownerToken,
          "unknown",
          block,
        );
      else await this.store.finishKnownFailure(op, block, "ready");
      return "deferred";
    }
    const imageId =
      local.presence === "present" ? local.imageId : op.deleteImageId;
    if (!imageId) {
      await this.store.finish(
        op.operationId,
        op.ownerToken,
        "unknown",
        "provider_error",
      );
      return "deferred";
    }
    if (await this.provider.imageInUse(op, imageId)) {
      if (op.deleteAttempted)
        await this.store.finish(
          op.operationId,
          op.ownerToken,
          "unknown",
          "image_in_use",
        );
      else await this.store.finishKnownFailure(op, "image_in_use", "ready");
      return "deferred";
    }
    if (!(await this.store.assertCurrent(op))) return "deferred";
    if (!(await this.store.markDeleteStarted(op, imageId))) return "deferred";
    await this.provider.removePinned(op);
    if (!(await this.store.markDeleteConfirmed(op))) return "deferred";
    if (!(await this.store.assertCurrent(op))) return "deferred";
    if (await this.provider.imageInUse(op, imageId)) {
      await this.store.finish(
        op.operationId,
        op.ownerToken,
        "unknown",
        "image_in_use",
      );
      return "deferred";
    }
    const after = await this.provider.inspectLocal(op);
    if (after.presence !== "absent") {
      await this.store.finish(
        op.operationId,
        op.ownerToken,
        "unknown",
        "provider_error",
      );
      return "deferred";
    }
    const recorded = await this.store.recordAbsent(op);
    return recorded ? "succeeded" : "deferred";
  }
}

function validCapacityEvidence(
  evidence: CacheCapacityEvidence | undefined,
  now: number,
): evidence is CacheCapacityEvidence {
  return (
    !!evidence &&
    evidence.verified === true &&
    evidence.evidenceId.length > 0 &&
    Number.isSafeInteger(evidence.observedAtMs) &&
    evidence.observedAtMs <= now &&
    now - evidence.observedAtMs <= 30_000 &&
    Number.isSafeInteger(evidence.availableMiB) &&
    Number.isSafeInteger(evidence.requiredMiB) &&
    Number.isSafeInteger(evidence.lowWaterMiB) &&
    evidence.availableMiB >= evidence.requiredMiB + evidence.lowWaterMiB &&
    evidence.requiredMiB > 0 &&
    evidence.lowWaterMiB >= 0
  );
}

function diagnosticFor(error: unknown): ImageCacheDiagnostic {
  if (!(error instanceof ImageCachePortError)) return "provider_error";
  switch (error.code) {
    case "runtime_identity_mismatch":
    case "connection_revision_unavailable":
    case "artifact_verification_failed":
    case "engine_unavailable":
    case "provider_error":
      return error.code;
  }
}
