import { randomUUID } from "node:crypto";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";
import { z } from "zod";
import { hash } from "../storage/admin-store-utils.js";
import { SQLiteValidationStore } from "../storage/validation-store.js";

const JsonObject = z.record(z.string(), z.unknown());
function object(value: unknown, label: string) {
  const result = JsonObject.safeParse(JSON.parse(String(value)));
  if (!result.success) throw new TypeError(`Stored ${label} is invalid`);
  return result.data;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

export class ImageValidationService {
  constructor(
    private readonly store: SQLiteValidationStore,
    private readonly now = Date.now,
  ) {}

  async schedule(
    input: ImageValidationRequest & { versionId: string; requestedBy: string },
  ) {
    const receipt = await this.scheduleInternal(input);
    if (!receipt)
      throw new Error("Initial validation scheduling produced no receipt");
    return receipt;
  }

  private async scheduleInternal(
    input: ImageValidationRequest & { versionId: string; requestedBy: string },
    retry?: {
      id: string;
      contract: Record<string, unknown>;
      deadlineMs: number;
    },
  ) {
    if (input.storage.length > 0)
      throw new RangeError(
        "Persistent validation mounts are unsupported until source evidence is available",
      );
    const context = await this.store.loadContext(input);
    const { consumer, target, deny } = context;
    let network = context.network;
    if (retry) {
      if (retry.deadlineMs <= this.now()) return;
      network = await this.store.frozenNetwork(
        String(retry.contract.networkRevisionId),
      );
      if (
        !target ||
        target.runtime_identity_id !== retry.contract.runtimeIdentityId ||
        target.connection_revision_id !== retry.contract.connectionRevisionId
      )
        return;
    }
    if (!consumer || consumer.status !== "active" || consumer.role !== "admin")
      throw new RangeError("Administrator identity is unavailable");
    if (
      !network ||
      network.status !== "active" ||
      network.current_revision_id === null
    )
      throw new RangeError("Network profile has no active immutable revision");
    if (!target)
      throw new RangeError(
        "No registered node matches this artifact and connection",
      );
    if (!deny)
      throw new RangeError("Platform network deny revision is unavailable");
    const authorization = object(
      consumer.authorization_json,
      "consumer authorization",
    );
    const permitted = (key: string, id: string) =>
      authorization[key] === "all" ||
      stringArray(authorization[key]).includes(id);
    if (!permitted("nodeIds", String(target.node_id)))
      throw new RangeError("Node is not authorized for validation");
    if (!permitted("imageIds", String(target.image_id)))
      throw new RangeError("Image is not authorized for validation");
    if (!permitted("networkProfileIds", input.networkProfileId))
      throw new RangeError("Network profile is not authorized for validation");
    const caps = object(target.capabilities_json, "node capabilities");
    const recipe = object(
      target.access_recipe_json,
      "artifact access contract",
    );
    const nodeAccess = stringArray(caps.supportedAccess);
    const accessProtocols = stringArray(recipe.accessProtocols);
    const networkPolicy = object(network.policy_json, "network policy");
    const bindings: [] = [];
    const requested = input.resources.request;
    const minimum = {
      cpuMillis: Number(target.minimum_cpu_millis),
      memoryMiB: Number(target.minimum_memory_mib),
      scratchMiB: Number(target.minimum_scratch_mib),
    };
    if (
      input.resources.limit.cpuMillis !== requested.cpuMillis ||
      input.resources.limit.memoryMiB !== requested.memoryMiB ||
      input.resources.limit.scratchMiB !== requested.scratchMiB ||
      requested.cpuMillis < minimum.cpuMillis ||
      requested.memoryMiB < minimum.memoryMiB ||
      requested.scratchMiB < minimum.scratchMiB ||
      input.resources.isolation !== "shared_kernel" ||
      input.resources.accelerators.length > 0
    )
      throw new RangeError(
        "Docker validation resources must meet artifact minimums and use equal v1 request/limit without unverified accelerators",
      );
    const expiry =
      typeof caps.expiresAt === "string"
        ? Date.parse(caps.expiresAt)
        : Number.NaN;
    const block =
      caps.cpuHardLimit !== "verified" ||
      caps.memoryHardLimit !== "verified" ||
      caps.networkPolicyEnforcement !== "verified" ||
      (input.resources.scratchEnforcement === "required" &&
        caps.scratchHardLimit !== "verified") ||
      caps.capacity === undefined ||
      !Array.isArray(caps.verifiedNetworkProfileRevisionIds) ||
      !caps.verifiedNetworkProfileRevisionIds.includes(
        String(network.current_revision_id),
      ) ||
      !stringArray(caps.architectures).includes(String(target.architecture)) ||
      !stringArray(caps.guestOs).includes(String(target.guest_os)) ||
      !stringArray(caps.resourceKinds).includes("container") ||
      !accessProtocols.some((protocol) => nodeAccess.includes(protocol)) ||
      !Number.isFinite(expiry) ||
      expiry <= this.now() ||
      target.admission !== "enabled" ||
      target.machine_admission !== "enabled" ||
      Number(target.connection_enabled) !== 1 ||
      target.observed_health !== "healthy" ||
      Number(target.observed_at_ms ?? 0) + 120_000 <= this.now() ||
      target.observed_power !== "on";
    let blockReason = block
      ? "node_capacity_or_network_capability_unverified"
      : null;
    if (!block) {
      const capacity = JsonObject.parse(caps.capacity) as Record<
        string,
        unknown
      >;
      if (
        ["cpuMillis", "memoryMiB", "scratchMiB"].some(
          (key) =>
            typeof capacity[key] !== "number" ||
            Number(capacity[key]) < requested[key as keyof typeof requested],
        )
      )
        blockReason = "node_capacity_or_network_capability_unverified";
    }
    const time = this.now(),
      validationId = retry?.id ?? randomUUID(),
      allocationId = randomUUID(),
      claimId = randomUUID(),
      operationId = randomUUID();
    const contract = {
      imageVersionId: input.versionId,
      imageArtifactId: input.imageArtifactId,
      backendKind: target.backend_kind,
      environmentKind: target.environment_kind,
      variant: target.variant,
      digest: target.content_digest,
      artifactRef: target.artifact_ref,
      manifest: object(target.manifest_json, "image manifest"),
      requirements: object(target.requirements_json, "artifact requirements"),
      access: recipe,
      runtimeIdentityId: target.runtime_identity_id,
      platformDenyRevisionId: deny.id,
      managementDenyRules: JSON.parse(String(deny.management_deny_rules_json)),
      architecture: target.architecture,
      guestOs: target.guest_os,
      nodeId: input.nodeId,
      nodeCapabilities: caps,
      connectionRevisionId: target.connection_revision_id,
      networkProfileId: input.networkProfileId,
      networkRevisionId: network.current_revision_id,
      networkPolicy,
      storageBindings: bindings,
      resources: input.resources,
      minimumResources: minimum,
      deadlineSeconds: input.deadlineSeconds,
      request: input,
      network: {
        grantId: `validation:${validationId}`,
        networkProfileRevisionId: network.current_revision_id,
        platformDenyRevisionId: deny.id,
        mode: "isolated_bridge",
        ipv6: networkPolicy.ipv6,
        allowedEgress: networkPolicy.allowedEgress,
        allowedIngressSourceCidrs: networkPolicy.allowedIngressSourceCidrs,
        managementDenyRules: JSON.parse(
          String(deny.management_deny_rules_json),
        ),
        enforcement: "docker_iptables",
        verificationRequired: true,
      },
      storage: [],
    };
    if (retry && blockReason) return;
    const result = await this.store.persistSchedule({
      request: input,
      context: { ...context, network },
      bindings,
      contract: retry?.contract ?? {
        ...contract,
        selectionHash: hash(JSON.stringify(contract)),
      },
      blockReason,
      ids: { validationId, allocationId, claimId, operationId },
      now: time,
      deadlineMs: retry?.deadlineMs ?? time + input.deadlineSeconds * 1000,
      ...(retry ? { retry: true } : {}),
    });
    return {
      validationId,
      allocationId: result.reserved ? allocationId : null,
      operationId: result.reserved ? operationId : null,
      state: "queued",
      scheduler: result.reserved ? "queued" : "blocked",
      blockReason: result.reserved
        ? null
        : result.reservationConflict
          ? "admission_or_authorization_changed_before_reservation"
          : (blockReason ?? "insufficient_validation_capacity"),
      testOutcome: "pending",
      cleanupStatus: "pending",
      deadlineMs: retry?.deadlineMs ?? time + input.deadlineSeconds * 1000,
    };
  }

  async retryBlocked() {
    for (const row of await this.store.blockedRuns()) {
      const contract = object(
        row.accepted_contract_json,
        "validation contract",
      );
      if (Number(row.deadline_ms) <= this.now()) continue;
      await this.scheduleInternal(
        contract.request as ImageValidationRequest & {
          versionId: string;
          requestedBy: string;
        },
        { id: String(row.id), contract, deadlineMs: Number(row.deadline_ms) },
      ).catch(async (error: unknown) => {
        if (!(error instanceof RangeError)) throw error;
        await this.store.noteBlocked(String(row.id), this.now());
      });
    }
  }

  cancel(id: string) {
    return this.store.terminate(id, "cancelled");
  }

  get(id: string) {
    return this.store.getValidation(id);
  }
}
