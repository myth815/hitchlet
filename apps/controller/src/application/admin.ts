import type { Storage } from "../storage/index.js";
import {
  SQLiteImageValidationStore,
  SQLiteMachineNodeStore,
  SQLiteProfileStore,
  SQLiteProviderConnectionStore,
} from "../storage/admin-stores.js";
import type { PortainerProbe } from "../providers/port.js";
import { PortainerConnectionService } from "./provider-connections.js";
import { ImageValidationService } from "./image-validation.js";
import { SQLiteValidationStore } from "../storage/validation-store.js";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";

export type Probe = PortainerProbe;

/** Admin use-case facade: transport handlers call these cohesive persistence workflows. */
export class AdminService {
  private readonly connections: SQLiteProviderConnectionStore;
  private readonly connectionUseCases: PortainerConnectionService;
  private readonly inventory: SQLiteMachineNodeStore;
  private readonly profiles: SQLiteProfileStore;
  private readonly images: SQLiteImageValidationStore;
  private readonly validations: ImageValidationService;

  constructor(
    db: Storage,
    probe: Probe,
    now = Date.now,
    allowLoopbackHttp = false,
    readSecret?: (versionRef: string) => Promise<string>,
  ) {
    this.connections = new SQLiteProviderConnectionStore(db, now);
    this.connectionUseCases = new PortainerConnectionService(
      this.connections,
      probe,
      now,
      allowLoopbackHttp,
      readSecret,
    );
    this.inventory = new SQLiteMachineNodeStore(db, now);
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
  listNodes() {
    return this.inventory.listNodes();
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
  getValidation(id: string) {
    return this.validations.get(id);
  }
  getDraftVersion(id: string) {
    return this.images.getDraftVersion(id);
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
