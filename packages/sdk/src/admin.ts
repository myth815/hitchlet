import {
  AdminSchemas,
  PowerSchemas,
  type AdminImageValidationRequest,
} from "@hitchlet/contracts/admin";
import type { HttpTransport } from "./transport.js";

/** Narrow management API backed by the controller's shared runtime schemas. */
export class AdminCommands {
  constructor(private readonly http: HttpTransport) {}
  /** Management-only power projection; executable is always false in D22a. */
  powerConfiguration(machineId: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power`,
      "GET",
      undefined,
      (v) => PowerSchemas.PowerConfigurationSchema.parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  /** Evaluates a proposed policy without persisting it or starting a power cycle. */
  previewPowerPolicy(
    machineId: string,
    body: import("@hitchlet/contracts/admin").PowerConfigurationUpdate,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power-policy/dry-run`,
      "POST",
      PowerSchemas.PowerConfigurationUpdateSchema.parse(body),
      (v) => PowerSchemas.PowerPolicyPreviewSchema.parse(v),
      {
        key: crypto.randomUUID(),
        retry: false,
        ...(isCancelled ? { isCancelled } : {}),
      },
    );
  }
  /** CAS write; an unknown response must be resolved by reading configuration, never automatic retry. */
  updatePowerPolicy(
    machineId: string,
    body: import("@hitchlet/contracts/admin").PowerConfigurationUpdate,
    key: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power-policy`,
      "PUT",
      PowerSchemas.PowerConfigurationUpdateSchema.parse(body),
      (v) => PowerSchemas.PowerConfigurationSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  /** Records only unsupported/unverified conclusions. This never certifies hardware. */
  updatePowerCapabilities(
    machineId: string,
    body: import("@hitchlet/contracts/admin").PowerCapabilityUpdate,
    key: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power-capabilities`,
      "PUT",
      PowerSchemas.PowerCapabilityUpdateSchema.parse(body),
      (v) => PowerSchemas.PowerConfigurationSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  /** One exclusive device identity per machine; fixed secret reference only, never plaintext. */
  updateSmartPlugBinding(
    machineId: string,
    body: import("@hitchlet/contracts/admin").SmartPlugBindingUpdate,
    key: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/smart-plug-binding`,
      "PUT",
      PowerSchemas.SmartPlugBindingUpdateSchema.parse(body),
      (v) => PowerSchemas.PowerConfigurationSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  /** Lists persistent sandbox cycles, separate from real Machine state and Agent receipts. */
  powerPreviews(machineId: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power-previews`,
      "GET",
      undefined,
      (v) => PowerSchemas.PowerPreviewStateSchema.array().parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  /** Retrieves a sandbox cycle after restart or an uncertain management response. */
  powerPreview(
    machineId: string,
    previewId: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power-previews/${encodeURIComponent(previewId)}`,
      "GET",
      undefined,
      (v) => PowerSchemas.PowerPreviewStateSchema.parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  /** Starts one isolated intent; fault incidents have stable IDs and cannot be cut twice. */
  startPowerPreview(
    machineId: string,
    body: import("@hitchlet/contracts/admin").PowerPreviewStart,
    key: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power-previews`,
      "POST",
      PowerSchemas.PowerPreviewStartSchema.parse(body),
      (v) => PowerSchemas.PowerPreviewStateSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  /** CAS appends a synthetic event; cancellation retains an existing restoration duty. */
  advancePowerPreview(
    machineId: string,
    previewId: string,
    body: import("@hitchlet/contracts/admin").PowerPreviewAdvance,
    key: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/power-previews/${encodeURIComponent(previewId)}/advance`,
      "POST",
      PowerSchemas.PowerPreviewAdvanceSchema.parse(body),
      (v) => PowerSchemas.PowerPreviewStateSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  nodes(isCancelled?: () => boolean) {
    return this.http.request(
      "/v1/nodes",
      "GET",
      undefined,
      (v) => AdminSchemas.NodeViewSchema.array().parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  machines(isCancelled?: () => boolean) {
    return this.http.request(
      "/v1/machines",
      "GET",
      undefined,
      (v) => AdminSchemas.MachineDependencyViewSchema.array().parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  machineDryRun(machineId: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/dry-run`,
      "GET",
      undefined,
      (v) => AdminSchemas.MachineDependencyViewSchema.parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  previewHumanUsePolicy(
    machineId: string,
    body: {
      expectedVersion: number;
      policy: import("@hitchlet/contracts/admin").HumanUsePolicy;
    },
    isCancelled?: () => boolean,
  ) {
    const input = AdminSchemas.MachinePolicyUpdateSchema.parse(body);
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/human-use-policy/dry-run`,
      "POST",
      input,
      (v) => AdminSchemas.MachinePolicyDryRunSchema.parse(v),
      {
        key: crypto.randomUUID(),
        retry: false,
        ...(isCancelled ? { isCancelled } : {}),
      },
    );
  }
  updateHumanUsePolicy(
    machineId: string,
    body: {
      expectedVersion: number;
      policy: import("@hitchlet/contracts/admin").HumanUsePolicy;
    },
    key: string,
    isCancelled?: () => boolean,
  ) {
    const input = AdminSchemas.MachinePolicyUpdateSchema.parse(body);
    return this.http.request(
      `/v1/machines/${encodeURIComponent(machineId)}/human-use-policy`,
      "PUT",
      input,
      (v) => AdminSchemas.MachinePolicyReceiptSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  updateNodeAdmissionMode(
    nodeId: string,
    body: import("@hitchlet/contracts/admin").NodeAdmissionModeUpdate,
    key: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/nodes/${encodeURIComponent(nodeId)}/admission-mode`,
      "PUT",
      AdminSchemas.NodeAdmissionModeSchema.parse(body),
      (v) => AdminSchemas.NodeAdmissionModeReceiptSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  networkProfiles(isCancelled?: () => boolean) {
    return this.http.request(
      "/v1/network-profiles",
      "GET",
      undefined,
      (v) => AdminSchemas.AdminProfileViewSchema.array().parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  imageVersions(isCancelled?: () => boolean) {
    return this.http.request(
      "/v1/admin/image-versions",
      "GET",
      undefined,
      (v) => AdminSchemas.AdminImageVersionSummarySchema.array().parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  draftVersion(id: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/admin/image-versions/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      (v) => AdminSchemas.DraftVersionViewSchema.parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  validationHistory(versionId: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/admin/image-versions/${encodeURIComponent(versionId)}/validations`,
      "GET",
      undefined,
      (v) => AdminSchemas.AdminValidationHistoryItemSchema.array().parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  imageAliases(imageId: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/admin/images/${encodeURIComponent(imageId)}/aliases`,
      "GET",
      undefined,
      (v) => AdminSchemas.AdminImageAliasViewSchema.array().parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  cacheOperationReceipt(
    nodeId: string,
    operationId: string,
    isCancelled?: () => boolean,
  ) {
    return this.http.request(
      `/v1/nodes/${encodeURIComponent(nodeId)}/image-cache/operations/${encodeURIComponent(operationId)}`,
      "GET",
      undefined,
      (v) => AdminSchemas.AdminCacheOperationReceiptSchema.parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  scheduleValidation(
    versionId: string,
    body: AdminImageValidationRequest,
    key: string,
    isCancelled?: () => boolean,
  ) {
    const request = AdminSchemas.ImageValidationRequestSchema.parse(body);
    return this.http.request(
      `/v1/image-versions/${encodeURIComponent(versionId)}/validate`,
      "POST",
      request,
      (v) => AdminSchemas.ValidationScheduleReceiptSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  validation(id: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/image-validations/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      (v) => AdminSchemas.AdminValidationViewSchema.parse(v),
      isCancelled ? { isCancelled } : {},
    );
  }
  cancelValidation(id: string, key: string, isCancelled?: () => boolean) {
    return this.http.request(
      `/v1/image-validations/${encodeURIComponent(id)}/cancel`,
      "POST",
      {},
      (v) => AdminSchemas.AdminValidationViewSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  publish(
    versionId: string,
    expectedEntityVersion: number,
    key: string,
    isCancelled?: () => boolean,
  ) {
    const body = AdminSchemas.ImagePublishRequestSchema.parse({
      expectedEntityVersion,
    });
    return this.http.request(
      `/v1/image-versions/${encodeURIComponent(versionId)}/publish`,
      "POST",
      body,
      (v) => AdminSchemas.ImagePublishReceiptSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
  setAlias(
    imageId: string,
    alias: string,
    versionId: string,
    expectedVersion: number,
    key: string,
    isCancelled?: () => boolean,
  ) {
    const body = AdminSchemas.ImageAliasRequestSchema.parse({
      versionId,
      expectedVersion,
    });
    return this.http.request(
      `/v1/images/${encodeURIComponent(imageId)}/aliases/${encodeURIComponent(AdminSchemas.ImageAliasNameSchema.parse(alias))}`,
      "PUT",
      body,
      (v) => AdminSchemas.ImageAliasReceiptSchema.parse(v),
      { key, retry: false, ...(isCancelled ? { isCancelled } : {}) },
    );
  }
}
