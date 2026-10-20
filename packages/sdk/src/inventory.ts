import {
  AdminSchemas as S,
  type PortainerConnectionInput,
  type MachineInput,
  type NodeInput,
  type NodeRuntimeConfigInput,
  type NodeCapabilityAttestationInput,
  type NetworkProfileInput,
  type NetworkProfileRevisionInput,
  type StorageProfileInput,
  type StorageProfileRevisionInput,
  type ImageDraftInput,
  type ImageVersionDraftInput,
  type DraftArtifactInput,
  ManagementDenyUpdateSchema,
  type ManagementDenyUpdate,
} from "@hitchlet/contracts/admin";
import type { HttpTransport } from "./transport.js";
const path = encodeURIComponent;
/** Registration/configuration uses fixed references, one-shot writes and the shared contracts. Keep each key until its journal receipt is known. */
export class InventoryCommands {
  constructor(private readonly http: HttpTransport) {}
  updateNetworkDeny(body: ManagementDenyUpdate, key: string) {
    return this.http.request(
      "/v1/admin/network-deny",
      "PUT",
      ManagementDenyUpdateSchema.parse(body),
      (v) => S.AdminInstallationViewSchema.parse(v),
      { key, retry: false },
    );
  }
  installation() {
    return this.http.request("/v1/admin/installation", "GET", undefined, (v) =>
      S.AdminInstallationViewSchema.parse(v),
    );
  }
  connections() {
    return this.http.request(
      "/v1/provider-connections",
      "GET",
      undefined,
      (v) => S.ProviderConnectionViewSchema.array().parse(v),
    );
  }
  discover(body: PortainerConnectionInput, key: string) {
    return this.http.request(
      "/v1/provider-connections",
      "POST",
      S.PortainerConnectionInputSchema.parse(body),
      (v) => S.ProviderOperationReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  discovery(id: string) {
    return this.http.request(
      `/v1/provider-discovery/${path(id)}`,
      "GET",
      undefined,
      (v) => S.ProviderOperationReceiptSchema.parse(v),
    );
  }
  retryDiscovery(id: string, key: string) {
    return this.http.request(
      `/v1/provider-discovery/${path(id)}/retry`,
      "POST",
      {},
      (v) => S.ProviderOperationReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  proposeRevision(id: string, body: PortainerConnectionInput, key: string) {
    return this.http.request(
      `/v1/provider-connections/${path(id)}/revisions`,
      "POST",
      S.PortainerConnectionInputSchema.parse(body),
      (v) => S.ProviderOperationReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  proposal(id: string) {
    return this.http.request(
      `/v1/provider-connection-proposals/${path(id)}`,
      "GET",
      undefined,
      (v) => S.ProviderOperationReceiptSchema.parse(v),
    );
  }
  retryProposal(id: string, key: string) {
    return this.http.request(
      `/v1/provider-connection-proposals/${path(id)}/retry`,
      "POST",
      {},
      (v) => S.ProviderOperationReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  activateRevision(
    id: string,
    revisionId: string,
    expectedVersion: number,
    key: string,
  ) {
    return this.http.request(
      `/v1/provider-connections/${path(id)}/activate-revision`,
      "POST",
      S.ConnectionActivationSchema.parse({ revisionId }),
      (v) => S.ConnectionActivationReceiptSchema.parse(v),
      { key, expectedVersion, retry: false },
    );
  }
  createMachine(body: MachineInput, key: string) {
    return this.http.request(
      "/v1/machines",
      "POST",
      S.MachineInputSchema.parse(body),
      (v) => S.MachineReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  createNode(body: NodeInput, key: string) {
    return this.http.request(
      "/v1/nodes",
      "POST",
      S.NodeInputSchema.parse(body),
      (v) => S.NodeReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  configureRuntime(
    id: string,
    body: NodeRuntimeConfigInput,
    expectedVersion: number,
    key: string,
  ) {
    return this.http.request(
      `/v1/nodes/${path(id)}/runtime-config`,
      "PUT",
      S.NodeRuntimeConfigSchema.parse(body),
      (v) => S.NodeRuntimeConfigReceiptSchema.parse(v),
      { key, expectedVersion, retry: false },
    );
  }
  /** Imports externally obtained evidence; this method does not run or certify the hardware tests. */
  attestCapabilities(
    id: string,
    body: NodeCapabilityAttestationInput,
    expectedVersion: number,
    key: string,
  ) {
    return this.http.request(
      `/v1/nodes/${path(id)}/capability-attestations`,
      "POST",
      S.NodeCapabilityAttestationSchema.parse(body),
      (v) => S.NodeCapabilityAttestationReceiptSchema.parse(v),
      { key, expectedVersion, retry: false },
    );
  }
  storageProfiles() {
    return this.http.request("/v1/storage-profiles", "GET", undefined, (v) =>
      S.AdminProfileViewSchema.array().parse(v),
    );
  }
  createNetwork(body: NetworkProfileInput, key: string) {
    return this.http.request(
      "/v1/network-profiles",
      "POST",
      S.NetworkProfileInputSchema.parse(body),
      (v) => S.ProfileWriteReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  reviseNetwork(
    id: string,
    body: NetworkProfileRevisionInput,
    expectedVersion: number,
    key: string,
  ) {
    return this.http.request(
      `/v1/network-profiles/${path(id)}/revisions`,
      "POST",
      S.NetworkProfileRevisionSchema.parse(body),
      (v) => S.ProfileWriteReceiptSchema.parse(v),
      { key, expectedVersion, retry: false },
    );
  }
  createStorage(body: StorageProfileInput, key: string) {
    return this.http.request(
      "/v1/storage-profiles",
      "POST",
      S.StorageProfileInputSchema.parse(body),
      (v) => S.ProfileWriteReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  reviseStorage(
    id: string,
    body: StorageProfileRevisionInput,
    expectedVersion: number,
    key: string,
  ) {
    return this.http.request(
      `/v1/storage-profiles/${path(id)}/revisions`,
      "POST",
      S.StorageProfileRevisionSchema.parse(body),
      (v) => S.ProfileWriteReceiptSchema.parse(v),
      { key, expectedVersion, retry: false },
    );
  }
  createDraft(body: ImageDraftInput, key: string) {
    return this.http.request(
      "/v1/images",
      "POST",
      S.ImageDraftSchema.parse(body),
      (v) => S.DraftCreationReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  createVersion(id: string, body: ImageVersionDraftInput, key: string) {
    return this.http.request(
      `/v1/images/${path(id)}/versions`,
      "POST",
      S.ImageVersionDraftSchema.parse(body),
      (v) => S.DraftCreationReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  addArtifact(id: string, body: DraftArtifactInput, key: string) {
    return this.http.request(
      `/v1/image-versions/${path(id)}/artifacts`,
      "POST",
      S.DraftArtifactSchema.parse(body),
      (v) => S.ArtifactReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  prewarm(nodeId: string, artifactId: string, key: string) {
    return this.http.request(
      `/v1/nodes/${path(nodeId)}/image-cache/prewarm`,
      "POST",
      S.CacheArtifactSchema.parse({ artifactId }),
      (v) => S.CachePlanReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  evict(nodeId: string, artifactId: string, key: string) {
    return this.http.request(
      `/v1/nodes/${path(nodeId)}/image-cache/gc`,
      "POST",
      S.CacheArtifactSchema.parse({ artifactId }),
      (v) => S.CachePlanReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
}
