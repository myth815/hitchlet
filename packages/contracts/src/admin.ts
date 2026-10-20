import { z } from "zod";
import { StorageRequestSchema, ResourceContractSchema } from "./schemas.js";

const id = z.string().uuid();
const admissionState = z.enum(["enabled", "draining", "disabled"]);
const nodeHealth = z.enum(["healthy", "degraded", "unknown", "lost"]);
const minimumResources = z
  .object({
    cpuMillis: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    scratchMiB: z.number().int().nonnegative(),
  })
  .strict();
export const MachineResourcesSchema = z
  .object({
    cpuMillis: z.number().int().nonnegative().safe(),
    memoryMiB: z.number().int().nonnegative().safe(),
    scratchMiB: z.number().int().nonnegative().safe(),
  })
  .strict();
const bootstrap = z
  .object({
    mechanism: z.string().min(1),
    contractVersion: z.string().min(1),
    identityReset: z.literal(true),
  })
  .strict();
const requirements = z
  .object({
    bootstrap,
    requiredCapabilities: z.array(z.string().min(1)).default([]),
  })
  .strict();
const access = z
  .object({
    accessProtocols: z.array(z.enum(["ssh", "rdp"])).min(1),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
    account: z.string().min(1),
    allowedSourceCidrs: z.array(z.string()),
    discovery: z.string().min(1),
    readiness: z.string().min(1),
  })
  .strict();
const egress = z
  .object({
    cidr: z.string().min(1),
    protocol: z.enum(["tcp", "udp"]),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
  })
  .strict();
const networkPolicy = z
  .object({
    allowedEgress: z.array(egress),
    allowedIngressSourceCidrs: z.array(z.string().min(1)),
    ipv6: z.enum(["disabled", "verified_equivalent"]),
  })
  .strict();
const storageConfig = z
  .object({
    sourceRef: z.string().min(1),
    allowedSubpaths: z.array(z.string().min(1)).min(1),
    allowedModes: z.array(z.enum(["read_only", "read_write"])).min(1),
  })
  .strict();
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type AdminImageValidationRequest = z.input<
  typeof ImageValidationRequestSchema
>;
export type AdminImageVersionSummary = z.infer<
  typeof AdminImageVersionSummarySchema
>;
export type AdminValidationHistoryItem = z.infer<
  typeof AdminValidationHistoryItemSchema
>;
export type AdminImageAliasView = z.infer<typeof AdminImageAliasViewSchema>;
export type AdminDraftVersionView = z.infer<typeof DraftVersionViewSchema>;
export const PortainerConnectionInputSchema = z
  .object({
    endpointUrl: z.string().url(),
    environmentId: z.string().regex(/^\d+$/),
    secretVersionRef: z.string().regex(/^secret:[a-f0-9]{32}$/),
  })
  .strict();
export const ProviderOperationReceiptSchema = z
  .object({
    operationId: id,
    state: z.enum(["planned", "running", "unknown", "succeeded"]),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    retryable: z.boolean(),
    result: z
      .object({
        connectionId: id.optional(),
        engineId: z.string().min(1).optional(),
        connectionRevisionId: id.optional(),
        revision: z.number().int().positive().optional(),
        duplicateRuntime: z.boolean().optional(),
        errorCode: z.string().optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const ConnectionActivationSchema = z.object({ revisionId: id }).strict();
export const ConnectionActivationReceiptSchema = z
  .object({
    connectionId: id,
    currentRevisionId: id,
    version: z.number().int().positive(),
  })
  .strict();
export const MachineInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    hostOs: z.enum(["linux", "windows", "macos"]),
    architecture: z.enum(["amd64", "arm64"]),
    capacity: minimumResources,
  })
  .strict();
export const HumanUsePolicySchema = z
  .object({
    blockShutdownForAnyInteractiveSession: z.literal(true),
    blockShutdownOnUnknownPresence: z.literal(true),
    maximumObservationAgeSeconds: z.number().int().min(1).max(3600),
    admissionDuringInteraction: z.enum(["block_new", "within_reserved_budget"]),
    /** humanReserved is included in systemReserve; it must never be subtracted twice. */
    humanReserved: MachineResourcesSchema,
    systemReserve: MachineResourcesSchema,
    /** Physical root claim envelope, including infrastructure backing. Child claims are not charged twice. */
    unattendedMaximum: MachineResourcesSchema,
    attendedMaximum: MachineResourcesSchema,
    cpuPressureLimitPercent: z.number().finite().min(1).max(100),
    memoryPressureLimitPercent: z.number().finite().min(1).max(100),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const resource of ["cpuMillis", "memoryMiB", "scratchMiB"] as const) {
      if (policy.attendedMaximum[resource] > policy.unattendedMaximum[resource])
        ctx.addIssue({
          code: "custom",
          path: ["attendedMaximum", resource],
          message: "attended ceiling cannot exceed unattended ceiling",
        });
      if (policy.humanReserved[resource] > policy.systemReserve[resource])
        ctx.addIssue({
          code: "custom",
          path: ["humanReserved", resource],
          message:
            "human reserve is included in system reserve and cannot exceed it",
        });
      if (
        policy.unattendedMaximum[resource] + policy.systemReserve[resource] >
          Number.MAX_SAFE_INTEGER ||
        policy.attendedMaximum[resource] + policy.systemReserve[resource] >
          Number.MAX_SAFE_INTEGER
      )
        ctx.addIssue({
          code: "custom",
          path: ["systemReserve", resource],
          message: "resource budget exceeds safe integer range",
        });
    }
  });
export const MachineDependencyViewSchema = z
  .object({
    machineId: id,
    name: z.string(),
    usageMode: z.enum(["shared", "dedicated"]),
    admission: admissionState,
    hostObservation: z
      .object({
        state: z.enum(["fresh", "stale", "missing", "revoked"]),
        humanPresence: z.enum(["present", "absent", "unknown"]),
        cpuPercent: z.number().nullable(),
        memoryPercent: z.number().nullable(),
        unmanagedActivityHold: z.boolean().nullable(),
        receivedAtMs: z.number().int().nonnegative().nullable(),
        probeStatus: z.enum(["complete", "partial", "failed"]).nullable(),
        sessionsComplete: z.boolean().nullable(),
        interactiveSessionCount: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    capacity: minimumResources,
    systemReserve: MachineResourcesSchema,
    humanUsePolicy: HumanUsePolicySchema.nullable(),
    policySource: z.enum([
      "configured",
      "manual_inventory_frozen_budget",
      "missing",
    ]),
    physicalUsage: MachineResourcesSchema,
    workloadUsage: MachineResourcesSchema,
    shutdownDisabledReasons: z.array(z.string()),
    holds: z.array(
      z.object({ id, kind: z.string(), reason: z.string() }).strict(),
    ),
    dependencyTree: z.array(
      z
        .object({
          key: z.string(),
          parentKey: z.string().nullable(),
          kind: z.enum(["machine", "pool", "node", "allocation"]),
          id,
          name: z.string(),
          purpose: z.string().nullable(),
          claimed: MachineResourcesSchema,
        })
        .strict(),
    ),
    canAdmitTenants: z.boolean(),
    disabledReasons: z.array(z.string()),
    nodes: z.array(
      z
        .object({
          id,
          name: z.string(),
          admission: admissionState,
          observedHealth: nodeHealth,
          poolId: id,
          parentAllocationId: id.nullable(),
          dependencies: z.array(z.string()),
          version: z.number().int().positive(),
          admissionMode: z.enum([
            "observed_host",
            "constant_online_manual_inventory",
          ]),
          canAdmit: z.boolean(),
          disabledReasons: z.array(z.string()),
          available: MachineResourcesSchema,
          admissionAssurance: z.enum([
            "manual_inventory_trial",
            "bounded_partial_host",
            "complete_host",
            "unavailable_host",
          ]),
          limitations: z.array(z.string()),
        })
        .strict(),
    ),
    version: z.number().int().positive(),
  })
  .strict();
export const MachinePolicyUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    policy: HumanUsePolicySchema,
  })
  .strict();
export const MachinePolicyReceiptSchema = z
  .object({
    machineId: id,
    version: z.number().int().positive(),
    policy: HumanUsePolicySchema,
  })
  .strict();
export const MachinePolicyDryRunSchema = z
  .object({
    machine: MachineDependencyViewSchema,
    canApply: z.boolean(),
    updateDisabledReasons: z.array(z.string()),
  })
  .strict();
export type HumanUsePolicy = z.infer<typeof HumanUsePolicySchema>;
export const NodeAdmissionModeSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    mode: z.enum(["observed_host", "constant_online_manual_inventory"]),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type NodeAdmissionModeUpdate = z.input<typeof NodeAdmissionModeSchema>;
export const NodeAdmissionModeReceiptSchema = z
  .object({
    nodeId: id,
    version: z.number().int().positive(),
    mode: z.enum(["observed_host", "constant_online_manual_inventory"]),
  })
  .strict();
export const NodeInputSchema = z
  .object({ name: z.string().min(1).max(120), machineId: id, connectionId: id })
  .strict();
const secretRef = z.string().regex(/^secret:[a-f0-9]{32}$/);
const runtimeDenyRule = z.union([
  z
    .object({
      cidr: z.string().min(3),
      protocol: z.literal("any"),
      ports: z.literal("any"),
    })
    .strict(),
  z
    .object({
      cidr: z.string().min(3),
      protocol: z.enum(["tcp", "udp"]),
      ports: z.union([
        z.literal("any"),
        z.array(z.number().int().min(1).max(65535)).min(1),
      ]),
    })
    .strict(),
]);
export const NodeRuntimeConfigSchema = z
  .object({
    accessHost: z.string().min(1).max(253),
    networkCidrBase: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/),
    userlandProxy: z.boolean(),
    runtimeAgent: z
      .object({
        id,
        baseUrl: z.string().url(),
        tokenSecretRef: secretRef,
        caSecretRef: secretRef,
        clientCertSecretRef: secretRef,
        clientKeySecretRef: secretRef,
      })
      .strict(),
    managementDenyRevisionId: id,
    managementDenyRules: z.array(runtimeDenyRule),
  })
  .strict();
export const NodeCapabilityAttestationSchema = z
  .object({
    expectedEngineId: z.string().min(1).max(200),
    expectedDockerVersion: z.string().min(1).max(100),
    expectedPortainerVersion: z.string().min(1).max(100),
    architecture: z.enum(["amd64", "arm64"]),
    checkedAt: z.string().datetime({ offset: true }),
    report: z
      .object({
        runId: id,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        scopes: z
          .object(
            Object.fromEntries(
              [
                "resourceLimits",
                "firewallInput",
                "firewallForward",
                "ipv6",
                "sshBootstrap",
                "cleanupRecovery",
              ].map((key) => [
                key,
                z
                  .object({
                    status: z.literal("passed"),
                    summary: z.string().min(1).max(1000),
                    evidenceRef: z.string().min(1).max(500),
                  })
                  .strict(),
              ]),
            ),
          )
          .strict(),
      })
      .strict(),
    networkProfileRevisionIds: z.array(id).min(1),
  })
  .strict();
export const NodeRuntimeConfigReceiptSchema = z
  .object({
    nodeId: id,
    runtimeConfigured: z.literal(true),
    admission: z.literal("disabled"),
    version: z.number().int().positive(),
  })
  .strict();
export const NodeCapabilityAttestationReceiptSchema = z
  .object({
    nodeId: id,
    admission: z.literal("enabled"),
    observedHealth: z.literal("healthy"),
    capabilityFingerprint: sha,
    offline: z.literal(false),
    powerEnabled: z.literal(false),
    version: z.number().int().positive(),
  })
  .strict();
export const NetworkProfileInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    policy: networkPolicy,
    authorizedConsumerIds: z.array(id).min(1),
  })
  .strict();
export const NetworkProfileRevisionSchema = z
  .object({ policy: networkPolicy })
  .strict();
export const StorageProfileInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    protocol: z.enum(["local", "nfs", "smb"]),
    config: storageConfig,
    secretVersionRef: z
      .string()
      .regex(/^secret:[a-f0-9]{32}$/)
      .nullable(),
    authorizedConsumerIds: z.array(id).min(1),
  })
  .strict();
export const StorageProfileRevisionSchema = z
  .object({
    protocol: z.enum(["local", "nfs", "smb"]),
    config: storageConfig,
    secretVersionRef: z
      .string()
      .regex(/^secret:[a-f0-9]{32}$/)
      .nullable(),
  })
  .strict();
export const ImageDraftSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    version: z.string().min(1).max(120),
    architecture: z.enum(["amd64", "arm64"]),
    artifactRef: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
    digest: sha,
    minimumResources,
    bootstrap,
    access,
    authorizedConsumerIds: z.array(id).min(1),
  })
  .strict();
export const DraftArtifactSchema = z
  .object({
    architecture: z.enum(["amd64", "arm64"]),
    artifactRef: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
    digest: sha,
    minimumResources,
    requirements,
    access,
  })
  .strict();
export const ImageVersionDraftSchema = z
  .object({
    version: z.string().min(1).max(120),
    architecture: z.enum(["amd64", "arm64"]),
    artifactRef: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
    digest: sha,
    minimumResources,
    requirements,
    access,
  })
  .strict();
export const ImageValidationRequestSchema = z
  .object({
    imageArtifactId: id,
    nodeId: id,
    networkProfileId: id,
    storage: z.array(StorageRequestSchema),
    resources: ResourceContractSchema,
    deadlineSeconds: z.number().int().positive().max(1800).default(1800),
  })
  .strict();
export const ImagePublishRequestSchema = z
  .object({ expectedEntityVersion: z.number().int().positive() })
  .strict();
export const ImagePublishReceiptSchema = z
  .object({
    versionId: id,
    status: z.literal("published"),
    entityVersion: z.number().int().positive(),
  })
  .strict();
export const ImageAliasNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
export const ImageAliasRequestSchema = z
  .object({ versionId: id, expectedVersion: z.number().int().nonnegative() })
  .strict();
export const ImageAliasReceiptSchema = z
  .object({
    imageId: id,
    alias: z.string().min(1),
    versionId: id,
    version: z.number().int().positive(),
  })
  .strict();
export const ValidationIdSchema = z.object({ validationId: id }).strict();
export const CacheArtifactSchema = z.object({ artifactId: id }).strict();
export const MachineReceiptSchema = z
  .object({
    id,
    poolId: id,
    admission: z.literal("disabled"),
    observedPower: z.literal("unknown"),
    offline: z.literal(false),
    powerEnabled: z.literal(false),
    capacity: minimumResources,
  })
  .strict();
export const NodeReceiptSchema = z
  .object({
    id,
    machineId: id,
    connectionId: id,
    admission: z.literal("disabled"),
    observedHealth: z.literal("unknown"),
    capabilities: z.object({ verified: z.literal(false) }).strict(),
    offline: z.literal(false),
  })
  .strict();
export const ProfileWriteReceiptSchema = z
  .object({
    id,
    revisionId: id,
    revision: z.number().int().positive(),
    version: z.number().int().positive(),
  })
  .strict();
export const DraftCreationReceiptSchema = z
  .object({
    imageId: id,
    versionId: id,
    artifactId: id,
    status: z.literal("draft"),
    digest: sha,
    architecture: z.enum(["amd64", "arm64"]),
  })
  .strict();
export const ArtifactReceiptSchema = z
  .object({
    artifactId: id,
    versionId: id,
    digest: sha,
    architecture: z.enum(["amd64", "arm64"]),
  })
  .strict();
export const ValidationScheduleReceiptSchema = z
  .object({
    validationId: id,
    allocationId: id.nullable(),
    operationId: id.nullable(),
    state: z.literal("queued"),
    scheduler: z.enum(["queued", "blocked"]),
    blockReason: z.string().nullable(),
    testOutcome: z.literal("pending"),
    cleanupStatus: z.literal("pending"),
    deadlineMs: z.number().int().positive(),
  })
  .strict();
export const CachePlanReceiptSchema = z.union([
  z.object({ state: z.literal("ready"), operationId: z.null() }).strict(),
  z
    .object({
      state: z.literal("queued"),
      operationId: id,
      digest: sha.optional(),
    })
    .strict(),
]);
export const DraftVersionViewSchema = z
  .object({
    version: z
      .object({
        id,
        imageId: id,
        imageName: z.string(),
        description: z.string(),
        version: z.string(),
        status: z.enum(["draft", "validating"]),
        entityVersion: z.number().int().positive(),
        manifest: z.record(z.string(), z.unknown()),
        createdAtMs: z.number().int().nonnegative(),
        updatedAtMs: z.number().int().nonnegative(),
      })
      .strict(),
    artifacts: z.array(
      z
        .object({
          id,
          provider: z.literal("portainer"),
          kind: z.literal("container"),
          architecture: z.enum(["amd64", "arm64"]),
          guestOs: z.literal("linux"),
          artifactRef: z.string(),
          digest: sha,
          minimumResources,
          requirements,
          access,
        })
        .strict(),
    ),
  })
  .strict();
export const AdminIdSchema = z.object({ id });
export const AdminJsonObjectSchema = z.record(z.string(), z.unknown());
export const PortainerEvidenceSchema = z
  .object({
    engineId: z.string().min(1),
    dockerVersion: z.string().min(1),
    apiVersion: z.string().min(1),
    minimumApiVersion: z.string().min(1),
    os: z.string().min(1),
    architecture: z.enum(["amd64", "arm64"]),
    portainerVersion: z.string().min(1),
    cpuCount: z.number().int().positive(),
    memoryBytes: z.number().int().positive(),
    containerCount: z.number().int().nonnegative(),
    unmanagedContainerCount: z.number().int().nonnegative(),
  })
  .strict();
export const ProviderConnectionViewSchema = z
  .object({
    id,
    backendKind: z.literal("portainer"),
    runtimeIdentityId: id,
    currentRevisionId: id.nullable(),
    enabled: z.boolean(),
    version: z.number().int().positive(),
    revision: z.number().int().positive().nullable(),
    endpointUrl: z.string().url().nullable(),
    environmentId: z.string().nullable(),
    verifiedAtMs: z.number().int().nonnegative().nullable(),
    evidence: PortainerEvidenceSchema.nullable(),
  })
  .strict();
export const NodeViewSchema = z
  .object({
    id,
    machineId: id,
    name: z.string(),
    backendKind: z.enum(["portainer", "hyperv", "tart"]),
    providerConnectionId: id,
    runtimeIdentityId: id,
    poolId: id,
    admission: admissionState,
    observedHealth: nodeHealth,
    capabilities: z
      .object({
        verified: z.boolean(),
        expiresAt: z.string().nullable(),
        architectures: z.array(z.enum(["amd64", "arm64"])),
        guestOs: z.array(z.enum(["linux", "windows", "macos"])),
        resourceKinds: z.array(z.enum(["container", "vm"])),
        supportedAccess: z.array(z.enum(["ssh", "rdp"])),
      })
      .strict(),
    observedAtMs: z.number().int().nonnegative().nullable(),
    version: z.number().int().positive(),
  })
  .strict();
export const AdminInstallationViewSchema = z
  .object({
    installationId: id,
    controllerEpoch: z.number().int().positive(),
    platformNetworkDeny: z
      .object({
        revisionId: id,
        revision: z.number().int().positive(),
        managementDenyRules: z.array(runtimeDenyRule),
        reason: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const AdminProfileViewSchema = z
  .object({
    id,
    name: z.string(),
    kind: z.enum(["network", "storage"]),
    status: z.string(),
    currentRevisionId: id.nullable(),
    version: z.number().int().positive(),
    revision: z.number().int().positive().nullable(),
    protocol: z.string().nullable(),
    config: z.record(z.string(), z.unknown()).nullable(),
    secretVersionRef: z
      .string()
      .regex(/^secret:[a-f0-9]{32}$/)
      .nullable(),
    createdAtMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const AdminValidationViewSchema = z
  .object({
    id,
    imageArtifactId: id,
    nodeId: id,
    requestedByConsumerId: id,
    reportId: id.nullable(),
    acceptedContract: z.record(z.string(), z.unknown()),
    state: z.enum([
      "queued",
      "running",
      "releasing",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    testOutcome: z.enum(["pending", "passed", "failed"]),
    cleanupStatus: z.enum(["pending", "running", "blocked", "complete"]),
    scope: z.record(z.string(), z.unknown()),
    checks: z.record(z.string(), z.unknown()),
    deadlineMs: z.number().int().positive(),
    finishedAtMs: z.number().int().nonnegative().nullable(),
    evidenceExpiresAtMs: z.number().int().nonnegative().nullable(),
    version: z.number().int().positive(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const AdminImageVersionSummarySchema = z
  .object({
    id,
    imageId: id,
    imageName: z.string(),
    description: z.string(),
    version: z.string(),
    status: z.enum([
      "draft",
      "validating",
      "published",
      "deprecated",
      "blocked",
    ]),
    entityVersion: z.number().int().positive(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    publishedAtMs: z.number().int().nonnegative().nullable(),
    artifacts: z.array(
      z
        .object({
          id,
          architecture: z.enum(["amd64", "arm64"]),
          digest: sha,
          minimumResources,
        })
        .strict(),
    ),
  })
  .strict();
export const AdminValidationHistoryItemSchema = z
  .object({
    id,
    imageArtifactId: id,
    nodeId: id,
    state: z.enum([
      "queued",
      "running",
      "releasing",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    testOutcome: z.enum(["pending", "passed", "failed"]),
    cleanupStatus: z.enum(["pending", "running", "blocked", "complete"]),
    reportId: id.nullable(),
    deadlineMs: z.number().int().positive(),
    finishedAtMs: z.number().int().nonnegative().nullable(),
    version: z.number().int().positive(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export const AdminImageAliasViewSchema = z
  .object({
    imageId: id,
    alias: ImageAliasNameSchema,
    versionId: id,
    version: z.number().int().positive(),
  })
  .strict();
export const AdminCacheOperationReceiptSchema = z
  .object({
    operationId: id,
    nodeId: id,
    artifactId: id,
    kind: z.enum(["image-cache.pull", "image-cache.evict"]),
    state: z.enum([
      "planned",
      "running",
      "succeeded",
      "failed",
      "unknown",
      "cancelled",
    ]),
    attemptCount: z.number().int().nonnegative(),
    nextCheckAtMs: z.number().int().nonnegative(),
    cache: z
      .object({
        desiredState: z.enum(["present", "absent"]),
        observedState: z.enum([
          "missing",
          "pulling",
          "ready",
          "invalid",
          "evicting",
          "unknown",
        ]),
        localRef: z.string().nullable(),
        sizeMiB: z.number().int().nonnegative().nullable(),
        digestVerifiedAtMs: z.number().int().nonnegative().nullable(),
        pinnedUntilMs: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    diagnostic: z
      .enum([
        "runtime_identity_mismatch",
        "connection_revision_unavailable",
        "capacity_unverified",
        "artifact_verification_failed",
        "engine_unavailable",
        "image_in_use",
        "cache_referenced",
        "operation_superseded",
        "provider_error",
      ])
      .nullable(),
  })
  .strict();

export const AdminSchemas = {
  ImageAliasNameSchema,
  ImagePublishRequestSchema,
  ImagePublishReceiptSchema,
  ImageAliasRequestSchema,
  ImageAliasReceiptSchema,
  PortainerConnectionInputSchema,
  ProviderOperationReceiptSchema,
  ImageVersionDraftSchema,
  ConnectionActivationSchema,
  ConnectionActivationReceiptSchema,
  MachineInputSchema,
  HumanUsePolicySchema,
  MachineDependencyViewSchema,
  MachinePolicyDryRunSchema,
  MachinePolicyUpdateSchema,
  MachinePolicyReceiptSchema,
  NodeInputSchema,
  NodeAdmissionModeSchema,
  NodeAdmissionModeReceiptSchema,
  NodeRuntimeConfigSchema,
  NodeCapabilityAttestationSchema,
  NetworkProfileInputSchema,
  NetworkProfileRevisionSchema,
  StorageProfileInputSchema,
  StorageProfileRevisionSchema,
  ImageDraftSchema,
  DraftArtifactSchema,
  ImageValidationRequestSchema,
  ValidationIdSchema,
  CacheArtifactSchema,
  MachineReceiptSchema,
  NodeReceiptSchema,
  NodeRuntimeConfigReceiptSchema,
  NodeCapabilityAttestationReceiptSchema,
  ProfileWriteReceiptSchema,
  DraftVersionViewSchema,
  DraftCreationReceiptSchema,
  ArtifactReceiptSchema,
  ValidationScheduleReceiptSchema,
  CachePlanReceiptSchema,
  ProviderConnectionViewSchema,
  NodeViewSchema,
  AdminInstallationViewSchema,
  AdminProfileViewSchema,
  AdminValidationViewSchema,
  AdminImageVersionSummarySchema,
  AdminValidationHistoryItemSchema,
  AdminImageAliasViewSchema,
  AdminCacheOperationReceiptSchema,
};
