import { z } from "zod";
import type {
  AcceleratorRequirement,
  ApiErrorResponse,
  PageQuery,
  RequestedResources,
  ResourceAmounts,
  ResourceContract,
  CursorPage,
} from "./common.js";
import type {
  AuthenticatedPrincipal,
  AcquireRequest,
  AccessRequest,
  CancelRequest,
  EventQuery,
  ImageSelector,
  LeaseRequest,
  ReleaseRequest,
  AcceptedLeaseRequest,
  ResourceEvent,
  StorageRequest,
  TicketListQuery,
  TicketSummary,
  AcceptedAcquireRequest,
  TicketView,
  LeaseView,
  TicketPlacementView,
  TicketHealthView,
  SchedulingView,
  PendingRenewalView,
  CleanupBlockerView,
  LeaseRenewalView,
  AccessGrant,
  RenewRequest,
  RevokeRequest,
  ImageSummary,
  ImageArtifactView,
  ImageVersionView,
  AcquireReceipt,
  RenewReceipt,
  RenewOutcome,
  ReadyTicketView,
  ReleasedTicketView,
  PreparedTicketCommand,
} from "./consumer.js";

const id = z.string().uuid();
const siteKey = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const positiveInt = z.number().safe().int().positive();
const nonnegativeInt = z.number().safe().int().nonnegative();
const boundedPage = z.number().safe().int().min(1).max(200);
const eventCursor = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");

export const ResourceAmountsSchema: z.ZodType<ResourceAmounts> = z
  .object({
    cpuMillis: nonnegativeInt.max(1_000_000),
    memoryMiB: nonnegativeInt.max(1_048_576),
    scratchMiB: nonnegativeInt.max(1_048_576),
  })
  .strict();
export const AcceleratorRequirementSchema = z
  .object({
    api: z.enum(["cuda", "metal", "video_codec", "other"]),
    apiName: z.string().trim().min(1).max(128).optional(),
    minimumMemoryMiB: positiveInt.max(1_048_576).optional(),
    requiredFeatures: z.array(z.string().trim().min(1).max(128)),
  })
  .strict()
  .superRefine((x, ctx) => {
    if (x.api === "other" && !x.apiName)
      ctx.addIssue({
        code: "custom",
        path: ["apiName"],
        message: "Required when api is other",
      });
    if (x.api !== "other" && x.apiName !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["apiName"],
        message: "Only valid when api is other",
      });
  });
export const RequestedResourcesSchema = z
  .object({
    cpuMillis: positiveInt.max(1_000_000),
    memoryMiB: positiveInt.max(1_048_576),
    scratchMiB: nonnegativeInt.max(1_048_576),
    scratchEnforcement: z.enum(["required", "best_effort"]).optional(),
    isolation: z.enum(["shared_kernel", "virtual_machine"]).optional(),
    accelerators: z.array(AcceleratorRequirementSchema).optional(),
  })
  .strict();
export const ImageSelectorSchema: z.ZodType<ImageSelector> = z.union([
  z.object({ versionId: id }).strict(),
  z.object({ imageId: id, alias: z.string().trim().min(1).max(128) }).strict(),
]);
export const StorageRequestSchema: z.ZodType<StorageRequest> = z
  .object({
    storageProfileId: id,
    authorizedSubpath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (p) =>
          !p.startsWith("/") &&
          !/^[A-Za-z]:/.test(p) &&
          !p.includes("\0") &&
          !p.includes("\\") &&
          !p.endsWith("/") &&
          p
            .split("/")
            .every((part) => part !== ".." && part !== "." && part.length > 0),
        "Must be a safe relative path",
      ),
    mountPath: z
      .string()
      .regex(/^\/(?:[A-Za-z0-9._-]+\/?)*$/)
      .refine(
        (p) =>
          !p.endsWith("/") &&
          !p.split("/").includes("..") &&
          !p.split("/").includes("."),
        "Must be a normalized absolute path",
      ),
    mode: z.enum(["read_only", "read_write"]),
  })
  .strict();
export const LeaseRequestSchema = z
  .object({
    requestedSeconds: positiveInt.max(31_536_000).optional(),
    maximumLifetimeSeconds: positiveInt.max(31_536_000).optional(),
    queueTimeoutSeconds: positiveInt.max(86_400).optional(),
    provisioningTimeoutSeconds: positiveInt.max(86_400).optional(),
    expiryPolicyId: id.optional(),
  })
  .strict();
export const AccessRequestSchema = z
  .object({
    protocol: z.enum(["ssh", "rdp"]),
    clientPublicKey: z.string().trim().min(32).max(16_384).optional(),
  })
  .strict();
export const AcquireRequestSchema = z
  .object({
    image: ImageSelectorSchema,
    resources: RequestedResourcesSchema,
    networkProfileId: id,
    kind: z.enum(["container", "vm"]).optional(),
    allowedArchitectures: z
      .array(z.enum(["amd64", "arm64"]))
      .min(1)
      .optional(),
    allowedProviders: z
      .array(z.enum(["portainer", "hyperv", "tart"]))
      .min(1)
      .optional(),
    locality: z.literal("local_only").optional(),
    siteIds: z.array(siteKey).optional(),
    allowedMachineIds: z.array(id).min(1).optional(),
    allowedNodeIds: z.array(id).min(1).optional(),
    requiredLabels: z.record(z.string(), z.string().max(256)).optional(),
    requiredCapabilities: z
      .array(
        z.enum([
          "offlineLeaseEnforcement",
          "cpuHardLimit",
          "memoryHardLimit",
          "scratchHardLimit",
          "networkPolicyEnforcement",
        ]),
      )
      .optional(),
    storage: z.array(StorageRequestSchema).optional(),
    access: AccessRequestSchema.optional(),
    lease: LeaseRequestSchema.optional(),
    labels: z.record(z.string(), z.string().max(1024)).optional(),
    clientRef: z.string().max(512).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !(
        value.kind === "container" &&
        value.resources.isolation === "virtual_machine"
      ) &&
      !(value.kind === "vm" && value.resources.isolation === "shared_kernel"),
    { message: "Isolation is incompatible with the requested resource kind" },
  );
export const RenewRequestSchema = z
  .object({
    generation: positiveInt,
    expectedLeaseVersion: positiveInt,
    requestedTtlSec: positiveInt.max(31_536_000).optional(),
  })
  .strict();
export const AccessCommandRequestSchema = z
  .object({ generation: positiveInt })
  .strict();
export const ReleaseRequestSchema: z.ZodType<ReleaseRequest> = z
  .object({ generation: positiveInt, reclaimable: z.literal(true) })
  .strict();
export const CancelRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1024).optional() })
  .strict();
export const RevokeRequestSchema = z
  .object({
    generation: positiveInt.nullable(),
    expectedTicketVersion: positiveInt,
    reason: z.string().trim().min(1).max(1024),
  })
  .strict();
export const AuthenticatedPrincipalSchema: z.ZodType<AuthenticatedPrincipal> = z
  .object({
    consumerId: id,
    role: z.enum(["viewer", "consumer", "operator", "admin"]),
    scopes: z.array(z.string()),
    source: z.enum(["bearer", "session"]),
  })
  .strict();
export const PageQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: boundedPage.optional(),
  })
  .strict();
export const TicketListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: boundedPage.optional(),
    phase: z
      .enum([
        "queued",
        "reserved",
        "provisioning",
        "ready",
        "releasing",
        "released",
      ])
      .optional(),
  })
  .strict();
export const EventQuerySchema = z
  .object({
    after: eventCursor.optional(),
    limit: boundedPage.optional(),
    ticketId: id.optional(),
  })
  .strict();
const utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .datetime({ offset: false });
export const TicketSummarySchema = z
  .object({
    id,
    consumerId: id,
    phase: z.enum([
      "queued",
      "reserved",
      "provisioning",
      "ready",
      "releasing",
      "released",
    ]),
    version: positiveInt,
    pinnedImageVersionId: id,
    terminalReason: z
      .enum([
        "consumer_release",
        "consumer_cancel",
        "queue_timeout",
        "provision_timeout",
        "provision_failed",
        "unclaimed_timeout",
        "lease_expired",
        "max_lifetime",
        "resource_lost",
        "admin_revoke",
      ])
      .nullable(),
    cleanupStatus: z.enum([
      "not_needed",
      "pending",
      "running",
      "blocked",
      "complete",
    ]),
    createdAt: utc,
    updatedAt: utc,
    readyAt: utc.nullable(),
    releasedAt: utc.nullable(),
  })
  .strict();
export function CursorPageSchema<T extends z.ZodType>(item: T) {
  return z
    .object({ items: z.array(item), nextCursor: z.string().nullable() })
    .strict();
}
export const TicketSummaryPageSchema = CursorPageSchema(TicketSummarySchema);
export const ResourceEventSchema: z.ZodType<ResourceEvent> = z
  .object({
    id: eventCursor,
    aggregateType: z.string().min(1),
    aggregateId: id,
    aggregateVersion: positiveInt,
    eventType: z.string().min(1),
    occurredAt: utc,
    payload: z.json(),
  })
  .strict();
export const ResourceEventPageSchema = CursorPageSchema(ResourceEventSchema);
export const ApiErrorResponseSchema: z.ZodType<ApiErrorResponse> = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        details: z.record(z.string(), z.json()),
        retryable: z.boolean(),
        requestId: id,
      })
      .strict(),
  })
  .strict();

const resourceContractSchema = z
  .object({
    request: ResourceAmountsSchema,
    limit: ResourceAmountsSchema,
    scratchEnforcement: z.enum(["required", "best_effort"]),
    isolation: z.enum(["shared_kernel", "virtual_machine"]),
    accelerators: z.array(AcceleratorRequirementSchema),
  })
  .strict();
const acceptedLeaseSchema: z.ZodType<AcceptedLeaseRequest> = z
  .object({
    requestedSeconds: positiveInt,
    maximumLifetimeSeconds: positiveInt,
    queueTimeoutSeconds: positiveInt,
    provisioningTimeoutSeconds: positiveInt,
    expiryPolicyId: id,
    maximumTtlSeconds: positiveInt,
  })
  .strict();
export const AcceptedAcquireRequestSchema = z
  .object({
    image: z.object({ versionId: id }).strict(),
    resources: resourceContractSchema,
    networkProfileId: id,
    kind: z.enum(["container", "vm"]),
    allowedArchitectures: z
      .tuple([z.enum(["amd64", "arm64"])])
      .rest(z.enum(["amd64", "arm64"])),
    allowedProviders: z
      .tuple([z.enum(["portainer", "hyperv", "tart"])])
      .rest(z.enum(["portainer", "hyperv", "tart"])),
    locality: z.literal("local_only"),
    siteIds: z.array(siteKey),
    allowedMachineIds: z.tuple([id]).rest(id).optional(),
    allowedNodeIds: z.tuple([id]).rest(id).optional(),
    requiredLabels: z.record(z.string(), z.string()),
    requiredCapabilities: z.array(
      z.enum([
        "offlineLeaseEnforcement",
        "cpuHardLimit",
        "memoryHardLimit",
        "scratchHardLimit",
        "networkPolicyEnforcement",
      ]),
    ),
    storage: z.array(StorageRequestSchema),
    access: AccessRequestSchema,
    lease: acceptedLeaseSchema,
    labels: z.record(z.string(), z.string()),
    clientRef: z.string().optional(),
  })
  .strict();
export const LeaseViewSchema: z.ZodType<LeaseView> = z
  .object({
    id,
    generation: positiveInt,
    version: positiveInt,
    state: z.enum(["pending", "active", "revoking", "revoked"]),
    claimBy: utc.nullable(),
    claimedAt: utc.nullable(),
    expiresAt: utc.nullable(),
    renewUntil: utc.nullable(),
    revokedAt: utc.nullable(),
  })
  .strict();
export const TicketPlacementViewSchema: z.ZodType<TicketPlacementView> = z
  .object({
    machineId: id,
    nodeId: id,
    provider: z.enum(["portainer", "hyperv", "tart"]),
    architecture: z.enum(["amd64", "arm64"]),
    imageArtifactId: id,
  })
  .strict();
export const TicketHealthViewSchema: z.ZodType<TicketHealthView> = z
  .object({
    state: z.enum(["unknown", "preparing", "healthy", "degraded", "lost"]),
    observedAt: utc.nullable(),
    reasonCodes: z.array(z.string()),
  })
  .strict();
export const SchedulingViewSchema: z.ZodType<SchedulingView> = z
  .object({
    checkedAt: utc.nullable(),
    reasonCodes: z.array(z.string()),
    matchingNodeCount: nonnegativeInt,
    nextCheckAt: utc.nullable(),
  })
  .strict();
export const PendingRenewalViewSchema: z.ZodType<PendingRenewalView> = z
  .object({
    renewalId: id,
    proposedLeaseVersion: positiveInt,
    proposedExpiresAt: utc,
    lastConfirmedExpiresAt: utc,
    decisionDeadline: utc,
  })
  .strict();
export const CleanupBlockerViewSchema: z.ZodType<CleanupBlockerView> = z
  .object({
    managedResourceId: id,
    kind: z.string(),
    reasonCodes: z.array(z.string()),
    retainUntil: utc.nullable(),
    nextCheckAt: utc.nullable(),
  })
  .strict();
const ticketViewObjectSchema = TicketSummarySchema.extend({
  acceptedRequest: AcceptedAcquireRequestSchema,
  pinnedProfileRevisions: z
    .object({
      networkProfileRevisionId: id,
      storageProfileRevisionIds: z.array(id),
    })
    .strict(),
  queueDeadline: utc,
  provisioningDeadline: utc.nullable(),
  lease: LeaseViewSchema.nullable(),
  placement: TicketPlacementViewSchema.nullable(),
  health: TicketHealthViewSchema,
  scheduling: SchedulingViewSchema,
  renewalPending: PendingRenewalViewSchema.nullable(),
  cleanupBlockedResources: z.array(CleanupBlockerViewSchema),
}).strict();
// The object schema performs full strict runtime validation; this annotation preserves exactOptionalPropertyTypes at the public DTO boundary.
export const TicketViewSchema: z.ZodType<TicketView> =
  ticketViewObjectSchema as z.ZodType<TicketView>;
const activeLeaseShape = {
  id,
  generation: positiveInt,
  version: positiveInt,
  state: z.literal("active"),
  claimBy: utc,
  claimedAt: utc.nullable(),
  expiresAt: utc,
  renewUntil: utc,
  revokedAt: utc.nullable(),
};
export const ReadyTicketViewSchema: z.ZodType<ReadyTicketView> =
  ticketViewObjectSchema.extend({
    phase: z.literal("ready"),
    lease: z.object(activeLeaseShape).strict(),
    placement: TicketPlacementViewSchema,
  }) as z.ZodType<ReadyTicketView>;
export const ReleasedTicketViewSchema: z.ZodType<ReleasedTicketView> =
  ticketViewObjectSchema.extend({
    phase: z.literal("released"),
    terminalReason: z.enum([
      "consumer_release",
      "consumer_cancel",
      "queue_timeout",
      "provision_timeout",
      "provision_failed",
      "unclaimed_timeout",
      "lease_expired",
      "max_lifetime",
      "resource_lost",
      "admin_revoke",
    ]),
    cleanupStatus: z.enum(["not_needed", "complete"]),
    releasedAt: utc,
  }) as z.ZodType<ReleasedTicketView>;
export const AcquireReceiptSchema: z.ZodType<AcquireReceipt> = z
  .object({
    ticket: TicketViewSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict() as z.ZodType<AcquireReceipt>;
const renewalBaseShape = {
  id,
  leaseId: id,
  proposedVersion: positiveInt,
  proposedExpiresAt: utc,
  isInitialClaim: z.boolean(),
  decisionDeadline: utc,
  createdAt: utc,
  updatedAt: utc,
};
const renewalDecisionSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...renewalBaseShape,
      state: z.literal("pending"),
      reasonCode: z.null(),
      confirmedReceipt: z.null(),
    })
    .strict(),
  z
    .object({
      ...renewalBaseShape,
      state: z.literal("confirmed"),
      reasonCode: z.null(),
      confirmedReceipt: z
        .object({
          renewalId: id,
          ticketId: id,
          generation: positiveInt,
          leaseId: id,
          leaseVersion: positiveInt,
          claimedAt: utc,
          expiresAt: utc,
          renewUntil: utc,
          offlineEnforcement: z.enum(["confirmed", "not_guaranteed"]),
          guardAcknowledgementId: id.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...renewalBaseShape,
      state: z.enum(["rejected", "cancelled"]),
      reasonCode: z.string().min(1),
      confirmedReceipt: z.null(),
    })
    .strict(),
]);
export const LeaseRenewalViewSchema: z.ZodType<LeaseRenewalView> =
  renewalDecisionSchema;
export const RenewReceiptSchema: z.ZodType<RenewReceipt> = z
  .object({
    renewalId: id,
    ticketId: id,
    generation: positiveInt,
    leaseId: id,
    leaseVersion: positiveInt,
    claimedAt: utc,
    expiresAt: utc,
    renewUntil: utc,
    offlineEnforcement: z.enum(["confirmed", "not_guaranteed"]),
    guardAcknowledgementId: id.nullable(),
  })
  .strict();
export const RenewOutcomeSchema: z.ZodType<RenewOutcome> = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("confirmed"),
        renewalId: id,
        receipt: RenewReceiptSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("pending"),
        renewal: z
          .object({
            ...renewalBaseShape,
            state: z.literal("pending"),
            reasonCode: z.null(),
            confirmedReceipt: z.null(),
          })
          .strict(),
        location: z.string().min(1),
        lastConfirmedExpiresAt: utc,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("rejected"),
        renewal: z
          .object({
            ...renewalBaseShape,
            state: z.enum(["rejected", "cancelled"]),
            reasonCode: z.string().min(1),
            confirmedReceipt: z.null(),
          })
          .strict(),
        reasonCode: z.string().min(1),
      })
      .strict(),
  ],
) as z.ZodType<RenewOutcome>;
export const AccessGrantSchema: z.ZodType<AccessGrant> = z
  .object({
    ticketId: id,
    leaseId: id,
    leaseVersion: positiveInt,
    generation: positiveInt,
    access: z
      .object({
        protocol: z.enum(["ssh", "rdp"]),
        host: z.string().min(1),
        port: positiveInt.max(65535),
        username: z.string().min(1),
        hostKeyFingerprint: z.string().nullable(),
        expiresAt: utc,
      })
      .strict(),
    authentication: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("client_public_key"),
          publicKeyFingerprint: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ssh_certificate"),
          certificate: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ephemeral_private_key"),
          privateKey: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("ephemeral_password"),
          password: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();

export const ImageSummarySchema: z.ZodType<ImageSummary> = z
  .object({
    id,
    name: z.string().min(1),
    description: z.string(),
  })
  .strict();
export const ImageArtifactViewSchema: z.ZodType<ImageArtifactView> = z
  .object({
    id,
    provider: z.enum(["portainer", "hyperv", "tart"]),
    kind: z.enum(["container", "vm"]),
    architecture: z.enum(["amd64", "arm64"]),
    guestOs: z.enum(["linux", "windows", "macos"]),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    accessProtocols: z.array(z.enum(["ssh", "rdp"])),
  })
  .strict();
export const ImageVersionViewSchema: z.ZodType<ImageVersionView> = z
  .object({
    id,
    imageId: id,
    version: z.string().min(1),
    status: z.enum([
      "draft",
      "validating",
      "published",
      "blocked",
      "deprecated",
    ]),
    minimumResources: ResourceAmountsSchema,
    artifacts: z.array(ImageArtifactViewSchema),
  })
  .strict();
export const ImageSummaryPageSchema = CursorPageSchema(ImageSummarySchema);
const preparedCommon = {
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().min(1).max(200),
  ticketId: id,
};
const preparedTicketCommandUnion = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("acquire"),
      idempotencyKey: z.string().min(1).max(200),
      request: AcquireRequestSchema,
    })
    .strict(),
  z
    .object({
      ...preparedCommon,
      kind: z.literal("renew"),
      request: RenewRequestSchema,
    })
    .strict(),
  z
    .object({
      ...preparedCommon,
      kind: z.literal("release"),
      request: ReleaseRequestSchema,
    })
    .strict(),
  z
    .object({
      ...preparedCommon,
      kind: z.literal("cancel"),
      request: CancelRequestSchema,
    })
    .strict(),
  z
    .object({
      ...preparedCommon,
      kind: z.literal("access"),
      request: AccessCommandRequestSchema,
    })
    .strict(),
]);
// The raw union above is the runtime/OpenAPI authority and is compared with the DTO below.
// This public bridge only removes Zod's optional-property `undefined` output widening under exactOptionalPropertyTypes.
export const PreparedTicketCommandSchema: z.ZodType<PreparedTicketCommand> =
  preparedTicketCommandUnion as z.ZodType<PreparedTicketCommand>;

// Zod 4 exposes native JSON Schema conversion for the registered public schemas.
export const PublicSchemas = {
  AuthenticatedPrincipal: AuthenticatedPrincipalSchema,
  AcquireRequest: AcquireRequestSchema,
  ResourceAmounts: ResourceAmountsSchema,
  RequestedResources: RequestedResourcesSchema,
  ImageSelector: ImageSelectorSchema,
  StorageRequest: StorageRequestSchema,
  LeaseRequest: LeaseRequestSchema,
  RenewRequest: RenewRequestSchema,
  AccessCommandRequest: AccessCommandRequestSchema,
  ReleaseRequest: ReleaseRequestSchema,
  CancelRequest: CancelRequestSchema,
  RevokeRequest: RevokeRequestSchema,
  PageQuery: PageQuerySchema,
  TicketListQuery: TicketListQuerySchema,
  EventQuery: EventQuerySchema,
  ResourceEvent: ResourceEventSchema,
  ResourceEventPage: ResourceEventPageSchema,
  TicketSummary: TicketSummarySchema,
  TicketSummaryPage: TicketSummaryPageSchema,
  AcceptedAcquireRequest: AcceptedAcquireRequestSchema,
  TicketView: TicketViewSchema,
  ReadyTicketView: ReadyTicketViewSchema,
  ReleasedTicketView: ReleasedTicketViewSchema,
  AcquireReceipt: AcquireReceiptSchema,
  LeaseView: LeaseViewSchema,
  TicketPlacementView: TicketPlacementViewSchema,
  TicketHealthView: TicketHealthViewSchema,
  SchedulingView: SchedulingViewSchema,
  PendingRenewalView: PendingRenewalViewSchema,
  CleanupBlockerView: CleanupBlockerViewSchema,
  LeaseRenewalView: LeaseRenewalViewSchema,
  RenewReceipt: RenewReceiptSchema,
  RenewOutcome: RenewOutcomeSchema,
  AccessGrant: AccessGrantSchema,
  ImageSummary: ImageSummarySchema,
  ImageArtifactView: ImageArtifactViewSchema,
  ImageVersionView: ImageVersionViewSchema,
  ImageSummaryPage: ImageSummaryPageSchema,
  PreparedTicketCommand: PreparedTicketCommandSchema,
  ApiErrorResponse: ApiErrorResponseSchema,
} as const;
export function toPublicJsonSchema() {
  return z.toJSONSchema(z.object(PublicSchemas).strict(), {
    target: "draft-2020-12",
  });
}

type Assert<T extends true> = T;
type Normalize<T> = T extends unknown
  ? T extends readonly (infer U)[]
    ? readonly Normalize<U>[]
    : T extends object
      ? {
          readonly [K in keyof T as {} extends Pick<T, K>
            ? never
            : K]: Normalize<T[K]>;
        } & {
          readonly [K in keyof T as {} extends Pick<T, K>
            ? K
            : never]?: Normalize<Exclude<T[K], undefined>>;
        }
      : T
  : never;
type Fits<Contract, Schema> = [Normalize<Contract>] extends [
  Normalize<z.output<Schema>>,
]
  ? [Normalize<z.output<Schema>>] extends [Normalize<Contract>]
    ? true
    : false
  : false;
export type SchemaContractChecks = [
  Assert<Fits<AuthenticatedPrincipal, typeof AuthenticatedPrincipalSchema>>,
  Assert<Fits<ResourceAmounts, typeof ResourceAmountsSchema>>,
  Assert<Fits<AcceleratorRequirement, typeof AcceleratorRequirementSchema>>,
  Assert<Fits<RequestedResources, typeof RequestedResourcesSchema>>,
  Assert<Fits<ImageSelector, typeof ImageSelectorSchema>>,
  Assert<Fits<StorageRequest, typeof StorageRequestSchema>>,
  Assert<Fits<AcquireRequest, typeof AcquireRequestSchema>>,
  Assert<Fits<LeaseRequest, typeof LeaseRequestSchema>>,
  Assert<Fits<AccessRequest, typeof AccessRequestSchema>>,
  Assert<Fits<CancelRequest, typeof CancelRequestSchema>>,
  Assert<Fits<RenewRequest, typeof RenewRequestSchema>>,
  Assert<Fits<ReleaseRequest, typeof ReleaseRequestSchema>>,
  Assert<Fits<RevokeRequest, typeof RevokeRequestSchema>>,
  Assert<Fits<PageQuery, typeof PageQuerySchema>>,
  Assert<Fits<TicketListQuery, typeof TicketListQuerySchema>>,
  Assert<Fits<EventQuery, typeof EventQuerySchema>>,
  Assert<Fits<ResourceEvent, typeof ResourceEventSchema>>,
  Assert<Fits<TicketSummary, typeof TicketSummarySchema>>,
  Assert<Fits<CursorPage<TicketSummary>, typeof TicketSummaryPageSchema>>,
  Assert<Fits<ResourceContract, typeof resourceContractSchema>>,
  Assert<Fits<AcceptedLeaseRequest, typeof acceptedLeaseSchema>>,
  Assert<Fits<AcceptedAcquireRequest, typeof AcceptedAcquireRequestSchema>>,
  Assert<Fits<TicketView, typeof TicketViewSchema>>,
  Assert<Fits<LeaseView, typeof LeaseViewSchema>>,
  Assert<Fits<TicketPlacementView, typeof TicketPlacementViewSchema>>,
  Assert<Fits<TicketHealthView, typeof TicketHealthViewSchema>>,
  Assert<Fits<SchedulingView, typeof SchedulingViewSchema>>,
  Assert<Fits<PendingRenewalView, typeof PendingRenewalViewSchema>>,
  Assert<Fits<CleanupBlockerView, typeof CleanupBlockerViewSchema>>,
  Assert<Fits<LeaseRenewalView, typeof LeaseRenewalViewSchema>>,
  Assert<Fits<AccessGrant, typeof AccessGrantSchema>>,
  Assert<Fits<ApiErrorResponse, typeof ApiErrorResponseSchema>>,
  Assert<Fits<ImageSummary, typeof ImageSummarySchema>>,
  Assert<Fits<ImageArtifactView, typeof ImageArtifactViewSchema>>,
  Assert<Fits<ImageVersionView, typeof ImageVersionViewSchema>>,
  Assert<Fits<AcquireReceipt, typeof AcquireReceiptSchema>>,
  Assert<Fits<RenewReceipt, typeof RenewReceiptSchema>>,
  Assert<Fits<RenewOutcome, typeof RenewOutcomeSchema>>,
  Assert<Fits<ReadyTicketView, typeof ReadyTicketViewSchema>>,
  Assert<Fits<ReleasedTicketView, typeof ReleasedTicketViewSchema>>,
  Assert<Fits<PreparedTicketCommand, typeof preparedTicketCommandUnion>>,
];
export const schemaContractChecks: SchemaContractChecks = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
