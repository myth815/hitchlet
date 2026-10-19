import { randomUUID } from "node:crypto";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";
import { z } from "zod";
import {
  safeMountPath,
  safeRelativePath,
  type Row,
} from "../storage/admin-store-utils.js";
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
    const context = await this.store.loadContext(input);
    const { consumer, network, storageProfiles, target } = context;
    if (!consumer || consumer.status !== "active")
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
    const authorization = object(
      consumer.authorization_json,
      "consumer authorization",
    );
    const permitted = (key: string, id: string) =>
      authorization[key] === "all" ||
      stringArray(authorization[key]).includes(id);
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
    const bindings = [];
    for (const request of input.storage) {
      if (!permitted("storageProfileIds", request.storageProfileId))
        throw new RangeError(
          "Storage profile is not authorized for validation",
        );
      if (
        !safeRelativePath(request.authorizedSubpath) ||
        !safeMountPath(request.mountPath)
      )
        throw new RangeError("Invalid validation storage path");
      const profile = storageProfiles.get(request.storageProfileId);
      if (
        !profile ||
        profile.status !== "active" ||
        profile.current_revision_id === null
      )
        throw new RangeError(
          "Storage profile has no active immutable revision",
        );
      const config = object(
        profile.config_json,
        "storage profile configuration",
      );
      const allowedPaths = stringArray(config.allowedSubpaths),
        allowedModes = stringArray(config.allowedModes);
      if (
        !allowedModes.includes(request.mode) ||
        !allowedPaths.some(
          (prefix) =>
            request.authorizedSubpath === prefix ||
            request.authorizedSubpath.startsWith(
              `${prefix.replace(/\/$/, "")}/`,
            ),
        )
      )
        throw new RangeError(
          "Validation storage request exceeds the frozen profile authorization",
        );
      bindings.push({
        storageProfileId: request.storageProfileId,
        storageProfileRevisionId: String(profile.current_revision_id),
        profileVersion: Number(profile.version),
        protocol: String(profile.kind),
        sourceRef: String(config.sourceRef),
        authorizedSubpath: request.authorizedSubpath,
        mountPath: request.mountPath,
        mode: request.mode,
        secretVersionRef:
          typeof profile.secret_version_ref === "string"
            ? profile.secret_version_ref
            : null,
      });
    }
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
    const storageVerified = bindings.every((binding) =>
      stringArray(caps.verifiedStorageProfileRevisionIds).includes(
        binding.storageProfileRevisionId,
      ),
    );
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
      !storageVerified ||
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
      ? storageVerified
        ? "node_capacity_or_network_capability_unverified"
        : "node_storage_capability_unverified"
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
      validationId = randomUUID(),
      allocationId = randomUUID(),
      claimId = randomUUID(),
      operationId = randomUUID();
    const contract = {
      imageVersionId: input.versionId,
      imageArtifactId: input.imageArtifactId,
      digest: target.content_digest,
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
      deadlineSeconds: input.deadlineSeconds,
    };
    const result = await this.store.persistSchedule({
      request: input,
      context,
      bindings,
      contract,
      blockReason,
      ids: { validationId, allocationId, claimId, operationId },
      now: time,
      deadlineMs: time + input.deadlineSeconds * 1000,
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
      deadlineMs: time + input.deadlineSeconds * 1000,
    };
  }

  get(id: string) {
    return this.store.getValidation(id);
  }
}
