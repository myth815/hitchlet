import { z } from "zod";
import { StorageRequestSchema } from "@hitchlet/contracts";
import { ResourceContractSchema } from "@hitchlet/contracts/schemas";

const id = z.string().uuid();
const minimumResources = z
  .object({
    cpuMillis: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    scratchMiB: z.number().int().nonnegative(),
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
export const NodeInputSchema = z
  .object({ name: z.string().min(1).max(120), machineId: id, connectionId: id })
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
    deadlineSeconds: z.number().int().positive().max(1800),
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
    admission: z.string(),
    observedHealth: z.string(),
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
    acceptedContract: z.record(z.string(), z.unknown()),
    state: z.string(),
    testOutcome: z.string(),
    cleanupStatus: z.string(),
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

export const AdminSchemas = {
  PortainerConnectionInputSchema,
  ProviderOperationReceiptSchema,
  ImageVersionDraftSchema,
  ConnectionActivationSchema,
  ConnectionActivationReceiptSchema,
  MachineInputSchema,
  NodeInputSchema,
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
  ProfileWriteReceiptSchema,
  DraftVersionViewSchema,
  DraftCreationReceiptSchema,
  ArtifactReceiptSchema,
  ValidationScheduleReceiptSchema,
  CachePlanReceiptSchema,
  ProviderConnectionViewSchema,
  NodeViewSchema,
  AdminProfileViewSchema,
  AdminValidationViewSchema,
};
