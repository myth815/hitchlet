import { hyperVTemplateProofMatches } from "./hyperv-facts.js";
import { runtimeStorageMountSchema } from "@hitchlet/contracts/internal";
import { randomUUID } from "node:crypto";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";
import { z } from "zod";
import { hash } from "../storage/admin-store-utils.js";
import { SQLiteValidationStore } from "../storage/validation-store.js";
import {
  tartTemplateProofMatches,
  type TartFactsForRevision,
} from "./tart-facts.js";
import type { ExecutionSelection } from "../providers/execution-dispatcher.js";
import { executionEnabled } from "../providers/execution-registry.js";

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
    private readonly tartFactsForRevision?: TartFactsForRevision,
    private readonly enabledExecutionMode?: ExecutionSelection,
    private readonly hyperVFactsForRevision?: import("../providers/runtime-credentials.js").HyperVFactsForRevision,
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
    if (
      !executionEnabled(
        this.enabledExecutionMode,
        object(target.config_json, "node config").executionMode,
      )
    ) {
      if (retry) return;
      throw new RangeError(
        "Node execution mode is disabled for new validation work",
      );
    }
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
    const bindings = [];
    for (const [index, request] of input.storage.entries()) {
      if (!permitted("storageProfileIds", request.storageProfileId))
        throw new RangeError("Storage profile not authorized for validation");
      const frozen =
        retry && Array.isArray(retry.contract.storageBindings)
          ? retry.contract.storageBindings[index]
          : undefined;
      const profile = frozen
        ? await this.store.frozenStorage(
            request.storageProfileId,
            String(JsonObject.parse(frozen).storageProfileRevisionId),
          )
        : context.storageProfiles.get(request.storageProfileId);
      if (
        !profile ||
        profile.status !== "active" ||
        !profile.current_revision_id
      )
        throw new RangeError("Storage profile unavailable");
      const config = object(profile.config_json, "storage config");
      const subpaths = stringArray(config.allowedSubpaths),
        modes = stringArray(config.allowedModes);
      if (
        !modes.includes(request.mode) ||
        (request.authorizedSubpath === "." &&
          (profile.kind !== "smb" || !subpaths.includes("."))) ||
        !subpaths.some(
          (p) =>
            request.authorizedSubpath === p ||
            request.authorizedSubpath.startsWith(p.replace(/\/$/, "") + "/"),
        )
      )
        throw new RangeError("Storage path or mode exceeds authorization");
      runtimeStorageMountSchema.parse({
        grantId: `validation:${index}`,
        revisionId: profile.current_revision_id,
        approvedSourceRef: config.sourceRef,
        authorizedSubpath: request.authorizedSubpath,
        protocol: profile.kind,
        secretVersionRef: profile.secret_version_ref,
        target: request.mountPath,
        mode: request.mode,
      });
      if (
        !stringArray(caps.verifiedStorageProfileRevisionIds).includes(
          String(profile.current_revision_id),
        )
      )
        throw new RangeError("Storage revision not verified on Node");
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
    const isTart = target.backend_kind === "tart";
    const isHyperV = target.backend_kind === "hyperv",
      isVm = isTart || isHyperV;
    if (
      isTart &&
      networkPolicy.tartMode !== undefined &&
      networkPolicy.tartMode !== "trusted_nat" &&
      networkPolicy.tartMode !== "isolated"
    )
      throw new RangeError("Invalid Tart network mode");
    const trustedNat =
      isHyperV || (isTart && networkPolicy.tartMode !== "isolated");
    let tartProofVerified = !isTart;
    if (isTart && this.tartFactsForRevision) {
      try {
        const facts = await this.tartFactsForRevision({
          installationId: String(target.installation_id),
          runtimeIdentityId: String(target.runtime_identity_id),
          connectionRevisionId: String(target.connection_revision_id),
          nodeId: String(target.node_id),
          config: object(target.config_json, "node config"),
        });
        tartProofVerified = tartTemplateProofMatches(facts, {
          nativeRuntimeNamespaceId: String(target.native_runtime_namespace_id),
          artifactRef: String(target.artifact_ref),
          digest: String(target.content_digest),
          architecture: String(target.architecture),
          guestOs: String(target.guest_os),
        });
      } catch {
        tartProofVerified = false;
      }
    }
    let hyperVProofVerified = !isHyperV;
    if (isHyperV && this.hyperVFactsForRevision) {
      try {
        const facts = await this.hyperVFactsForRevision({
          installationId: String(target.installation_id),
          runtimeIdentityId: String(target.runtime_identity_id),
          connectionRevisionId: String(target.connection_revision_id),
          nodeId: String(target.node_id),
          config: object(target.config_json, "node config"),
        });
        hyperVProofVerified = hyperVTemplateProofMatches(facts, {
          nativeRuntimeNamespaceId: String(target.native_runtime_namespace_id),
          artifactRef: String(target.artifact_ref),
          digest: String(target.content_digest),
          architecture: String(target.architecture),
          guestOs: String(target.guest_os),
        });
      } catch {
        hyperVProofVerified = false;
      }
    }
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
      input.resources.isolation !==
        (isVm ? "virtual_machine" : "shared_kernel") ||
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
      (!trustedNat && caps.networkPolicyEnforcement !== "verified") ||
      (input.resources.scratchEnforcement === "required" &&
        caps.scratchHardLimit !== "verified") ||
      caps.capacity === undefined ||
      (!trustedNat &&
        (!Array.isArray(caps.verifiedNetworkProfileRevisionIds) ||
          !caps.verifiedNetworkProfileRevisionIds.includes(
            String(network.current_revision_id),
          ))) ||
      !stringArray(caps.architectures).includes(String(target.architecture)) ||
      !stringArray(caps.guestOs).includes(String(target.guest_os)) ||
      !stringArray(caps.resourceKinds).includes(isVm ? "vm" : "container") ||
      !accessProtocols.some((protocol) => nodeAccess.includes(protocol)) ||
      !Number.isFinite(expiry) ||
      expiry <= this.now() ||
      target.admission !== "enabled" ||
      target.machine_admission !== "enabled" ||
      Number(target.connection_enabled) !== 1 ||
      target.observed_health !== "healthy" ||
      Number(target.observed_at_ms ?? 0) + 120_000 <= this.now() ||
      target.observed_power !== "on";
    let blockReason =
      isHyperV && !hyperVProofVerified
        ? "hyperv_template_proof_unavailable_or_mismatched"
        : isTart && !tartProofVerified
          ? "tart_template_proof_unavailable_or_mismatched"
          : block
            ? "node_capacity_or_network_capability_unverified"
            : null;
    if (
      isVm &&
      (input.storage.length > 0 ||
        requested.cpuMillis % 1000 !== 0 ||
        input.resources.scratchEnforcement === "required" ||
        accessProtocols.length !== 1 ||
        accessProtocols[0] !== "ssh" ||
        !Array.isArray(recipe.ports) ||
        recipe.ports.length !== 1 ||
        recipe.ports[0] !== 22 ||
        recipe.discovery !== "guest_ipv4" ||
        recipe.readiness !== "authenticated_ssh")
    )
      blockReason = isHyperV
        ? "hyperv_validation_request_unsupported"
        : "tart_validation_request_unsupported";
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
      ...(isTart ? { tartTemplateProofVerified: tartProofVerified } : {}),
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
        mode: trustedNat
          ? "trusted_nat"
          : isTart
            ? "isolated_vm"
            : "isolated_bridge",
        ipv6: trustedNat ? "not_enforced" : networkPolicy.ipv6,
        allowedEgress: trustedNat ? [] : networkPolicy.allowedEgress,
        allowedIngressSourceCidrs: trustedNat
          ? []
          : networkPolicy.allowedIngressSourceCidrs,
        enforcement: trustedNat
          ? isHyperV
            ? "hyperv_nat"
            : "tart_nat"
          : isTart
            ? "tart_agent"
            : "docker_iptables",
        verificationRequired: !trustedNat,
        managementDenyRules: trustedNat
          ? []
          : JSON.parse(String(deny.management_deny_rules_json)),
      },
      storage: bindings.map((b, index) => ({
        grantId: `validation:${validationId}:${index}`,
        grantRevision: 1,
        storageProfileRevisionId: b.storageProfileRevisionId,
        protocol: b.protocol,
        approvedSourceRef: b.sourceRef,
        authorizedSubpath: b.authorizedSubpath,
        mountPath: b.mountPath,
        mode: b.mode,
        secretVersionRef: b.secretVersionRef,
      })),
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
