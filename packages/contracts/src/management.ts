import { z } from "zod";
import {
  AcquireRequestSchema,
  ResourceAmountsSchema,
  TicketViewSchema,
  RevokeRequestSchema,
} from "./schemas.js";

const id = z.string().uuid();
const version = z.number().int().positive().safe();
const time = z.number().int().nonnegative().safe();
const scope = z.union([z.literal("all"), z.array(id).max(1000)]);
/** Logical grants affect new admission; a Ticket retains its accepted immutable revisions. */
export const ConsumerAuthorizationSchema = z
  .object({
    imageIds: scope,
    nodeIds: scope,
    networkProfileIds: scope,
    storageProfileIds: scope,
  })
  .strict();
export const ConsumerQuotaSchema = z
  .object({
    maxQueuedTickets: z.number().int().min(1).max(10000),
    maxActiveTickets: z.number().int().min(1).max(10000),
    maxLeaseTtlSeconds: z.number().int().min(1).max(31536000),
    maxLifetimeSeconds: z.number().int().min(1).max(31536000),
    maxResources: ResourceAmountsSchema,
    defaultExpiryPolicyId: id,
  })
  .strict()
  .refine(
    (q) => q.maxLeaseTtlSeconds <= q.maxLifetimeSeconds,
    "TTL cannot exceed total lifetime",
  );
export const ConsumerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["human", "service", "agent"]),
    role: z.enum(["viewer", "consumer", "operator", "admin"]),
    status: z.enum(["active", "disabled"]),
    authorization: ConsumerAuthorizationSchema,
    quota: ConsumerQuotaSchema,
  })
  .strict();
export const ConsumerUpdateSchema = ConsumerInputSchema.extend({
  expectedVersion: version,
}).strict();
export const ConsumerViewSchema = ConsumerInputSchema.extend({
  id,
  version,
  updatedAtMs: time,
}).strict();
/** Names and associates the existing destroy lifecycle policy only. TTL and maximum lifetime come from Consumer quota. */
export const LifecyclePolicyInputSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();
export const LifecyclePolicyUpdateSchema = LifecyclePolicyInputSchema.extend({
  expectedVersion: version,
}).strict();
export const LifecyclePolicyViewSchema = LifecyclePolicyInputSchema.extend({
  id,
  version,
  updatedAtMs: time,
}).strict();
export const IssueCredentialSchema = z.object({ consumerId: id }).strict();
export const IssuedCredentialSchema = z
  .object({ consumerId: id, credentialId: id, token: z.string().min(32) })
  .strict();
const amounts = ResourceAmountsSchema;
/** Consumer directory excludes provider addresses, sourceRef, secret refs and observation internals. */
export const AuthorizedCatalogSchema = z
  .object({
    observedAtMs: time,
    quota: ConsumerQuotaSchema,
    versions: z.array(
      z
        .object({
          id,
          imageId: id,
          imageName: z.string(),
          version: z.string(),
          kind: z.literal("container"),
          architectures: z.array(z.enum(["amd64", "arm64"])),
          platforms: z.array(
            z
              .object({
                architecture: z.enum(["amd64", "arm64"]),
                artifactId: id,
                digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
                minimumResources: amounts,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    networks: z.array(
      z
        .object({ id, name: z.string(), revisionId: id, revision: version })
        .strict(),
    ),
    storage: z.array(
      z
        .object({
          id,
          name: z.string(),
          revisionId: id,
          revision: version,
          allowedSubpaths: z.array(z.string()),
          allowedModes: z.array(z.enum(["read_only", "read_write"])),
        })
        .strict(),
    ),
    nodes: z.array(
      z
        .object({
          id,
          name: z.string(),
          machineId: id,
          machineName: z.string(),
          architecture: z.enum(["amd64", "arm64"]),
          admission: z.enum(["enabled", "draining", "disabled"]),
          health: z.string(),
          version,
        })
        .strict(),
    ),
  })
  .strict();
export const FeasibilitySchema = z
  .object({
    observedAtMs: time,
    capacityGuaranteed: z.literal(false),
    eligibleNodeIds: z.array(id),
    reasons: z.array(z.string()),
  })
  .strict();
export const ManagementTicketQuerySchema = z
  .object({
    consumerId: id.optional(),
    nodeId: id.optional(),
    imageVersionId: id.optional(),
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
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const ManagementTicketPageSchema = z
  .object({
    observedAtMs: time,
    items: z.array(TicketViewSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const ManagementOperationSchema = z
  .object({
    id,
    ticketId: id.nullable(),
    nodeId: id.nullable(),
    runtimeIdentityId: id.nullable(),
    connectionRevisionId: id.nullable(),
    kind: z.string(),
    state: z.enum([
      "planned",
      "running",
      "unknown",
      "succeeded",
      "failed",
      "cancelled",
    ]),
    attemptCount: z.number().int().nonnegative(),
    version,
    nextCheckAtMs: time,
    updatedAtMs: time,
    errorCode: z.string().nullable(),
    retryable: z.boolean(),
  })
  .strict();
export const ManagementEventSchema = z
  .object({
    id: z.string().regex(/^(?:audit:)?\d+$/),
    type: z.string(),
    occurredAtMs: time,
    version: z.number().int().positive().nullable(),
    actorId: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export const ManagementTimelineSchema = z
  .object({
    operations: z.array(ManagementOperationSchema),
    events: z.array(ManagementEventSchema),
  })
  .strict();
export const OperationRetrySchema = z
  .object({
    expectedVersion: version,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const AdmissionUpdateSchema = z
  .object({
    expectedVersion: version,
    admission: z.enum(["enabled", "draining", "disabled"]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const VersionReceiptSchema = z.object({ id, version }).strict();
export const ImageRetireSchema = z
  .object({
    expectedEntityVersion: version,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const AdminCommandReceiptSchema = z
  .object({
    key: z.string(),
    path: z.string(),
    state: z.enum(["unknown", "completed"]),
    status: z.number().int().nullable(),
    createdAtMs: time,
    reviewedAtMs: time.nullable(),
  })
  .strict();
/** Acknowledges human investigation only. It never certifies success, repeats an effect or releases capacity. */
export const AdminCommandReviewSchema = z
  .object({
    key: z.string().min(1).max(200),
    path: z.string().min(1).max(1000),
    evidenceTargetId: id,
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export const ManagementOverviewSchema = z
  .object({
    observedAtMs: time,
    phases: z.record(z.string(), z.number().int().nonnegative()),
    cleanupBlocked: z.number().int().nonnegative(),
    unknownOperations: z.number().int().nonnegative(),
    machines: z.array(
      z
        .object({
          id,
          name: z.string(),
          admission: z.string(),
          observedPower: z.string(),
          hostObservation: z.string(),
          humanPresence: z.string(),
          capacity: amounts,
          claimed: amounts,
          systemReserve: amounts,
          nodes: z.array(
            z
              .object({
                id,
                name: z.string(),
                admission: z.string(),
                health: z.string(),
                available: amounts,
                canAdmit: z.boolean(),
                reasons: z.array(z.string()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    initialization: z
      .object({
        connections: z.number().int().nonnegative(),
        machines: z.number().int().nonnegative(),
        nodes: z.number().int().nonnegative(),
        publishedVersions: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const ManagementSchemas = {
  ConsumerAuthorizationSchema,
  ConsumerQuotaSchema,
  ConsumerInputSchema,
  ConsumerUpdateSchema,
  ConsumerViewSchema,
  LifecyclePolicyInputSchema,
  LifecyclePolicyUpdateSchema,
  LifecyclePolicyViewSchema,
  IssueCredentialSchema,
  IssuedCredentialSchema,
  AuthorizedCatalogSchema,
  AcquireRequestSchema,
  FeasibilitySchema,
  ManagementTicketQuerySchema,
  ManagementTicketPageSchema,
  ManagementOperationSchema,
  ManagementTimelineSchema,
  OperationRetrySchema,
  AdmissionUpdateSchema,
  VersionReceiptSchema,
  ImageRetireSchema,
  AdminCommandReceiptSchema,
  AdminCommandReviewSchema,
  ManagementOverviewSchema,
};
export type AdminCommandReview = z.infer<typeof AdminCommandReviewSchema>;
export const PreparedManagementRevokeSchema = z
  .object({
    kind: z.literal("revoke"),
    ticketId: id,
    body: RevokeRequestSchema,
  })
  .strict();
export type PreparedManagementRevoke = z.infer<
  typeof PreparedManagementRevokeSchema
>;
export type ConsumerInput = z.infer<typeof ConsumerInputSchema>;
export type ConsumerUpdate = z.infer<typeof ConsumerUpdateSchema>;
export type ConsumerView = z.infer<typeof ConsumerViewSchema>;
export type AuthorizedCatalog = z.infer<typeof AuthorizedCatalogSchema>;
export type ManagementTicketQuery = z.input<typeof ManagementTicketQuerySchema>;
export type OperationRetry = z.infer<typeof OperationRetrySchema>;
export type AdmissionUpdate = z.infer<typeof AdmissionUpdateSchema>;
