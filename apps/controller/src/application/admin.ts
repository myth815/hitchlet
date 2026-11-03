import { SQLiteProfileRevocationStore } from "../storage/profile-revocation-store.js";
import { ImagePublishingService } from "./image-publishing.js";
import type { Storage } from "../storage/index.js";
import {
  SQLiteImageValidationStore,
  SQLiteMachineNodeStore,
  SQLiteProfileStore,
  SQLiteProviderConnectionStore,
} from "../storage/admin-stores.js";
import type { PortainerEvidence, PortainerProbe } from "../providers/port.js";
import { PortainerConnectionService } from "./provider-connections.js";
import { ImageValidationService } from "./image-validation.js";
import { SQLiteValidationStore } from "../storage/validation-store.js";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";
import { SQLiteAdminReadStore } from "../storage/admin-read-store.js";
import { SQLiteImageCacheStore } from "../storage/image-cache-store.js";
import {
  validAttestedCapability,
  validTartAttestedCapability,
} from "../domain/attested-capability.js";
import type { TartFactsForRevision } from "../providers/runtime-credentials.js";
import type { ExecutionMode } from "../providers/execution-dispatcher.js";
import type {
  NodeCapabilityAttestationInput,
  TartNodeRuntimeConfigInput,
} from "@hitchlet/contracts/admin";
import { tartTemplateProofMatches } from "./tart-facts.js";
import type { TartRuntimeFacts } from "@hitchlet/contracts/internal";

export type Probe = PortainerProbe;
type ObservationSnapshot = Awaited<
  ReturnType<SQLiteMachineNodeStore["duePortainerObservations"]>
>[number];
type TartObservationSnapshot = Awaited<
  ReturnType<SQLiteMachineNodeStore["dueTartObservations"]>
>[number];

/** Admin use-case facade: transport handlers call these cohesive persistence workflows. */
export class AdminService {
  private readonly connections: SQLiteProviderConnectionStore;
  private readonly connectionUseCases: PortainerConnectionService;
  private readonly inventory: SQLiteMachineNodeStore;
  private readonly revocations: SQLiteProfileRevocationStore;
  private readonly profiles: SQLiteProfileStore;
  private readonly images: SQLiteImageValidationStore;
  private readonly validations: ImageValidationService;
  private readonly publishing: ImagePublishingService;
  private readonly reads: SQLiteAdminReadStore;
  private readonly cacheReads: SQLiteImageCacheStore;

  constructor(
    db: Storage,
    private readonly probe: Probe,
    private readonly now = Date.now,
    allowLoopbackHttp = false,
    private readonly readSecret?: (versionRef: string) => Promise<string>,
    private readonly tartFactsForRevision?: TartFactsForRevision,
    enabledExecutionMode?: ExecutionMode | "disabled",
  ) {
    this.reads = new SQLiteAdminReadStore(db);
    this.cacheReads = new SQLiteImageCacheStore(db, now);
    this.publishing = new ImagePublishingService(
      db,
      probe,
      now,
      readSecret,
      tartFactsForRevision,
    );
    this.connections = new SQLiteProviderConnectionStore(db, now);
    this.connectionUseCases = new PortainerConnectionService(
      this.connections,
      probe,
      now,
      allowLoopbackHttp,
      readSecret,
      tartFactsForRevision,
    );
    this.inventory = new SQLiteMachineNodeStore(db, now);
    this.revocations = new SQLiteProfileRevocationStore(db, now);
    this.profiles = new SQLiteProfileStore(db, now);
    this.images = new SQLiteImageValidationStore(db, now);
    this.validations = new ImageValidationService(
      new SQLiteValidationStore(db, now),
      now,
      tartFactsForRevision,
      enabledExecutionMode,
    );
  }
  discover(input: Parameters<PortainerConnectionService["discover"]>[0]) {
    return this.connectionUseCases.discover(input);
  }
  discoverTart(
    input: Parameters<PortainerConnectionService["discoverTart"]>[0],
  ) {
    return this.connectionUseCases.discoverTart(input);
  }
  listConnections() {
    return this.connections.listConnections();
  }
  retryDiscovery(operationId: string) {
    return this.connectionUseCases.retryDiscovery(operationId);
  }
  retryConnectionRevision(operationId: string) {
    return this.connectionUseCases.retryConnectionRevision(operationId);
  }
  discoveryReceipt(operationId: string) {
    return this.connectionUseCases.discoveryReceipt(operationId);
  }
  connectionRevisionReceipt(operationId: string) {
    return this.connectionUseCases.connectionRevisionReceipt(operationId);
  }
  proposeConnectionRevision(
    input: Parameters<
      PortainerConnectionService["proposeConnectionRevision"]
    >[0],
  ) {
    return this.connectionUseCases.proposeConnectionRevision(input);
  }
  activateConnectionRevision(
    ...args: Parameters<
      SQLiteProviderConnectionStore["activateConnectionRevision"]
    >
  ) {
    return this.connectionUseCases.activateConnectionRevision(...args);
  }
  createMachine(input: Parameters<SQLiteMachineNodeStore["createMachine"]>[0]) {
    return this.inventory.createMachine(input);
  }
  registerNode(input: Parameters<SQLiteMachineNodeStore["registerNode"]>[0]) {
    return this.inventory.registerNode(input);
  }
  async configureNodeRuntime(
    input: Parameters<SQLiteMachineNodeStore["configureRuntime"]>[0],
  ) {
    const refs = input.config.runtimeAgent as Record<string, unknown>;
    if (!this.connectionUseCases || typeof refs !== "object")
      throw new Error("Runtime Agent configuration unavailable");
    if (this.readSecret) {
      for (const key of [
        "tokenSecretRef",
        "caSecretRef",
        "clientCertSecretRef",
        "clientKeySecretRef",
      ]) {
        const ref = refs[key];
        if (typeof ref !== "string")
          throw new RangeError("Invalid Runtime Agent secret reference");
        await this.readSecret(ref);
      }
    } else
      throw new Error(
        "Encrypted secret store is required for Runtime Agent registration",
      );
    return this.inventory.configureRuntime(input);
  }
  async configureTartNodeRuntime(input: {
    nodeId: string;
    expectedVersion: number;
    config: TartNodeRuntimeConfigInput;
    operatorId: string;
    requestId: string;
  }) {
    if (!this.readSecret)
      throw new Error(
        "Encrypted secret store is required for Runtime Agent registration",
      );
    for (const key of [
      "tokenSecretRef",
      "caSecretRef",
      "clientCertSecretRef",
      "clientKeySecretRef",
    ] as const) {
      const ref = input.config.runtimeAgent[key];
      await this.readSecret(ref);
    }
    return this.inventory.configureTartRuntime(input);
  }
  attestNodeCapabilities(
    input: Parameters<SQLiteMachineNodeStore["attestCapabilities"]>[0],
  ) {
    return this.inventory.attestCapabilities(input);
  }
  async attestTartNodeCapabilities(
    input: {
      nodeId: string;
      expectedVersion: number;
      operatorId: string;
      requestId: string;
    } & Extract<NodeCapabilityAttestationInput, { backendKind: "tart" }>,
  ) {
    const target = await this.inventory.tartAttestationTarget(input.nodeId);
    if (
      !target ||
      Number(target.version) !== input.expectedVersion ||
      typeof target.runtime_identity_id !== "string" ||
      typeof target.current_revision_id !== "string" ||
      typeof target.installation_id !== "string" ||
      typeof target.config_json !== "string"
    )
      throw new Error("Tart node registration or connection revision changed");
    if (!this.tartFactsForRevision)
      throw new Error("Authenticated Tart Runtime facts probe is unavailable");
    const rawConfig: unknown = JSON.parse(target.config_json);
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig))
      throw new RangeError("Tart node runtime config is invalid");
    const facts = await this.tartFactsForRevision({
      installationId: target.installation_id,
      runtimeIdentityId: String(target.runtime_identity_id),
      connectionRevisionId: String(target.current_revision_id),
      nodeId: input.nodeId,
      config: rawConfig as Record<string, unknown>,
    });
    if (
      !tartTemplateProofMatches(facts, {
        nativeRuntimeNamespaceId: String(target.native_id),
        artifactRef: input.templateRef,
        digest: input.templateDigest,
        architecture: input.architecture,
        guestOs: input.guestOs,
      }) ||
      facts.tartVersion !== input.expectedTartVersion
    )
      throw new RangeError(
        "Fresh Tart Runtime facts do not match the submitted qualification target",
      );
    return this.inventory.attestTartCapabilities({
      ...input,
      expectedConnectionRevisionId: String(target.current_revision_id),
      facts,
    });
  }
  async refreshPortainerObservations() {
    const checkedAt = this.now();
    // Each refresh batch is capped in the store and probes those nodes in
    // parallel. The Portainer probe has a 10-second network bound, so an
    // independent scheduler can refresh a bounded set without being held
    // behind a long-running allocation operation.
    const snapshots = await this.inventory.duePortainerObservations(
      checkedAt,
      45_000,
      16,
    );
    const settled = await Promise.allSettled(
      snapshots.map(async (snapshot) => {
        let capabilities: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(snapshot.capabilitiesJson);
          if (isRecord(parsed)) capabilities = parsed;
        } catch {
          // An invalid stored capability document cannot be renewed by observation.
        }
        if (
          !capabilities ||
          !validAttestedCapability(capabilities, checkedAt)
        ) {
          if (capabilities && capabilityExpired(capabilities, checkedAt)) {
            if (
              await this.inventory.recordPortainerObservation(
                snapshot,
                "unknown",
              )
            )
              return "expired" as const;
          } else if (
            await this.inventory.recordPortainerObservation(
              snapshot,
              "degraded",
            )
          ) {
            return "unhealthy" as const;
          }
          return "unchanged" as const;
        }
        try {
          if (!this.readSecret || !snapshot.apiKeyRef)
            throw new Error("Portainer connection secret is unavailable");
          const apiKey = await this.readSecret(snapshot.apiKeyRef);
          const evidence = await this.probe({
            endpointUrl: snapshot.endpointUrl,
            environmentId: snapshot.environmentId,
            apiKey,
          });
          assertObservationMatches(snapshot, capabilities, evidence);
          if (
            await this.inventory.recordPortainerObservation(
              snapshot,
              "healthy",
              checkedAt,
            )
          )
            return "refreshed" as const;
        } catch {
          if (
            await this.inventory.recordPortainerObservation(
              snapshot,
              "degraded",
            )
          )
            return "unhealthy" as const;
        }
        return "unchanged" as const;
      }),
    );
    const failure = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (failure) throw failure.reason;
    const outcomes = settled.map((item) => {
      if (item.status !== "fulfilled")
        throw new Error("Portainer observation result did not settle");
      return item.value;
    });
    return {
      checked: snapshots.length,
      refreshed: outcomes.filter((value) => value === "refreshed").length,
      unhealthy: outcomes.filter((value) => value === "unhealthy").length,
      expired: outcomes.filter((value) => value === "expired").length,
    };
  }
  async refreshTartObservations() {
    const checkedAt = this.now();
    const snapshots = await this.inventory.dueTartObservations(
      checkedAt,
      45_000,
      16,
    );
    const settled = await Promise.allSettled(
      snapshots.map(async (snapshot) => {
        let capabilities: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(snapshot.capabilitiesJson);
          if (isRecord(parsed)) capabilities = parsed;
        } catch {
          // Invalid stored qualification is not refreshed by live observation.
        }
        if (
          !capabilities ||
          !validTartAttestedCapability(capabilities, checkedAt)
        ) {
          const expired =
            !capabilities || capabilityExpired(capabilities, checkedAt);
          if (
            await this.inventory.recordTartObservation(
              snapshot,
              expired ? "unknown" : "degraded",
            )
          )
            return expired ? ("expired" as const) : ("unhealthy" as const);
          return "unchanged" as const;
        }
        try {
          if (!this.tartFactsForRevision)
            throw new Error(
              "Authenticated Tart Runtime facts probe is unavailable",
            );
          const parsedConfig: unknown = JSON.parse(snapshot.configJson);
          if (!isRecord(parsedConfig))
            throw new Error("Tart Node config is invalid");
          const facts = await this.tartFactsForRevision({
            installationId: snapshot.installationId,
            runtimeIdentityId: snapshot.runtimeIdentityId,
            connectionRevisionId: snapshot.currentRevisionId,
            nodeId: snapshot.nodeId,
            config: parsedConfig,
          });
          assertTartObservationMatches(snapshot, capabilities, facts);
          if (
            await this.inventory.recordTartObservation(
              snapshot,
              "healthy",
              checkedAt,
            )
          )
            return "refreshed" as const;
        } catch {
          if (await this.inventory.recordTartObservation(snapshot, "degraded"))
            return "unhealthy" as const;
        }
        return "unchanged" as const;
      }),
    );
    const failure = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (failure) throw failure.reason;
    const outcomes = settled.map((item) => {
      if (item.status !== "fulfilled")
        throw new Error("Tart observation result did not settle");
      return item.value;
    });
    return {
      checked: snapshots.length,
      refreshed: outcomes.filter((value) => value === "refreshed").length,
      unhealthy: outcomes.filter((value) => value === "unhealthy").length,
      expired: outcomes.filter((value) => value === "expired").length,
    };
  }
  listNodes() {
    return this.inventory.listNodes();
  }
  updateNodeAdmissionMode(
    input: Parameters<SQLiteMachineNodeStore["updateNodeAdmissionMode"]>[0],
  ) {
    return this.inventory.updateNodeAdmissionMode(input);
  }
  machineDryRun(machineId: string) {
    return this.inventory.machineDryRun(machineId);
  }
  machinePolicyDryRun(
    input: Parameters<SQLiteMachineNodeStore["machinePolicyDryRun"]>[0],
  ) {
    return this.inventory.machinePolicyDryRun(input);
  }
  machineDependencies() {
    return this.inventory.listMachineDependencies();
  }
  updateHumanUsePolicy(
    input: Parameters<SQLiteMachineNodeStore["updateHumanUsePolicy"]>[0],
  ) {
    return this.inventory.updateHumanUsePolicy(input);
  }
  getInstallation() {
    return this.inventory.getInstallation();
  }
  profileRevisions(
    ...args: Parameters<SQLiteProfileRevocationStore["revisions"]>
  ) {
    return this.revocations.revisions(...args);
  }
  previewGrantRevocation(
    ...args: Parameters<SQLiteProfileRevocationStore["preview"]>
  ) {
    return this.revocations.preview(...args);
  }
  revokeGrants(...args: Parameters<SQLiteProfileRevocationStore["revoke"]>) {
    return this.revocations.revoke(...args);
  }
  createProfile(...args: Parameters<SQLiteProfileStore["createProfile"]>) {
    return this.profiles.createProfile(...args);
  }
  newProfileRevision(
    ...args: Parameters<SQLiteProfileStore["newProfileRevision"]>
  ) {
    return this.profiles.newProfileRevision(...args);
  }
  listProfiles(...args: Parameters<SQLiteProfileStore["listProfiles"]>) {
    return this.profiles.listProfiles(...args);
  }
  createDraft(input: Parameters<SQLiteImageValidationStore["createDraft"]>[0]) {
    return this.images.createDraft(input);
  }
  createVersion(
    input: Parameters<SQLiteImageValidationStore["createVersion"]>[0],
  ) {
    return this.images.createVersion(input);
  }
  addDraftArtifact(
    ...args: Parameters<SQLiteImageValidationStore["addDraftArtifact"]>
  ) {
    return this.images.addDraftArtifact(...args);
  }
  scheduleValidation(
    input: ImageValidationRequest & { versionId: string; requestedBy: string },
  ) {
    return this.validations.schedule(input);
  }
  publishVersion(id: string, expected: number) {
    return this.publishing.publish(id, expected);
  }
  moveImageAlias(
    imageId: string,
    alias: string,
    versionId: string,
    expected: number,
  ) {
    return this.publishing.moveAlias(imageId, alias, versionId, expected);
  }
  cancelValidation(id: string) {
    return this.validations.cancel(id);
  }
  getValidation(id: string) {
    return this.validations.get(id);
  }
  getDraftVersion(id: string) {
    return this.images.getDraftVersion(id);
  }
  listImageVersions() {
    return this.reads.listImageVersions();
  }
  listValidationHistory(versionId: string) {
    return this.reads.listValidationHistory(versionId);
  }
  listImageAliases(imageId: string) {
    return this.reads.listImageAliases(imageId);
  }
  cacheOperationReceipt(nodeId: string, operationId: string) {
    return this.cacheReads.operationReceipt(nodeId, operationId);
  }
  prewarmImageCache(
    input: Parameters<SQLiteImageValidationStore["prewarmImageCache"]>[0],
  ) {
    return this.images.prewarmImageCache(input);
  }
  planCacheEviction(
    input: Parameters<SQLiteImageValidationStore["planCacheEviction"]>[0],
  ) {
    return this.images.planCacheEviction(input);
  }
}

function assertTartObservationMatches(
  snapshot: TartObservationSnapshot,
  capability: Record<string, unknown>,
  facts: TartRuntimeFacts,
) {
  const guestOs = Array.isArray(capability.guestOs)
    ? capability.guestOs[0]
    : undefined;
  const capacity = capability.capacity;
  if (
    facts.nativeRuntimeNamespaceId !== snapshot.nativeNamespaceId ||
    facts.nativeRuntimeNamespaceId !== capability.nativeNamespaceId ||
    facts.hostOS !== "macos" ||
    snapshot.hostOs !== "macos" ||
    facts.hostArch !== "arm64" ||
    snapshot.architecture !== "arm64" ||
    facts.tartVersion !== capability.tartVersion ||
    capability.providerVersion !== `Tart/${facts.tartVersion}` ||
    capability.connectionRevisionId !== snapshot.revisionId ||
    !isRecord(capacity) ||
    capacity.cpuMillis !== snapshot.cpuMillis ||
    capacity.memoryMiB !== snapshot.memoryMiB ||
    snapshot.cpuMillis > facts.hostCpuCount * 1000 ||
    snapshot.memoryMiB > Math.floor(facts.hostMemoryBytes / 1024 ** 2) ||
    (guestOs !== "linux" && guestOs !== "macos") ||
    !tartTemplateProofMatches(facts, {
      nativeRuntimeNamespaceId: snapshot.nativeNamespaceId,
      artifactRef: String(capability.templateRef),
      digest: String(capability.templateDigest),
      architecture: String(capability.architecture),
      guestOs,
    })
  )
    throw new Error("Live Tart observation does not match the attested Node");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilityExpired(capability: Record<string, unknown>, now: number) {
  if (typeof capability.expiresAt !== "string") return true;
  const expiry = Date.parse(capability.expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

function assertObservationMatches(
  snapshot: ObservationSnapshot,
  capability: Record<string, unknown>,
  evidence: PortainerEvidence,
) {
  const versionMatch =
    capability.providerVersion ===
    `Portainer/${evidence.portainerVersion}; Docker/${evidence.dockerVersion}`;
  const capacity = capability.capacity;
  if (
    evidence.engineId !== snapshot.engineId ||
    capability.connectionRevisionId !== snapshot.revisionId ||
    evidence.os !== "linux" ||
    evidence.architecture !== snapshot.architecture ||
    !Array.isArray(capability.architectures) ||
    !capability.architectures.includes(evidence.architecture) ||
    !versionMatch ||
    !isRecord(capacity) ||
    capacity.cpuMillis !== snapshot.cpuMillis ||
    capacity.memoryMiB !== snapshot.memoryMiB ||
    snapshot.cpuMillis > evidence.cpuCount * 1000 ||
    snapshot.memoryMiB > Math.floor(evidence.memoryBytes / 1024 ** 2)
  )
    throw new Error("Live Portainer observation does not match attested Node");
}
