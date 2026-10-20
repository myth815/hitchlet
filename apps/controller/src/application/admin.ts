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
import { validAttestedCapability } from "../domain/attested-capability.js";

export type Probe = PortainerProbe;
type ObservationSnapshot = Awaited<
  ReturnType<SQLiteMachineNodeStore["duePortainerObservations"]>
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
  ) {
    this.reads = new SQLiteAdminReadStore(db);
    this.cacheReads = new SQLiteImageCacheStore(db, now);
    this.publishing = new ImagePublishingService(db, probe, now, readSecret);
    this.connections = new SQLiteProviderConnectionStore(db, now);
    this.connectionUseCases = new PortainerConnectionService(
      this.connections,
      probe,
      now,
      allowLoopbackHttp,
      readSecret,
    );
    this.inventory = new SQLiteMachineNodeStore(db, now);
    this.revocations = new SQLiteProfileRevocationStore(db, now);
    this.profiles = new SQLiteProfileStore(db, now);
    this.images = new SQLiteImageValidationStore(db, now);
    this.validations = new ImageValidationService(
      new SQLiteValidationStore(db, now),
      now,
    );
  }
  discover(input: Parameters<PortainerConnectionService["discover"]>[0]) {
    return this.connectionUseCases.discover(input);
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
  attestNodeCapabilities(
    input: Parameters<SQLiteMachineNodeStore["attestCapabilities"]>[0],
  ) {
    return this.inventory.attestCapabilities(input);
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
