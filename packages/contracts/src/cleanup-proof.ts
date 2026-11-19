import { z } from "zod";
import {
  validDockerOwnedKinds,
  containerGroupInventorySchema,
} from "./container-group.js";

const Id = z.string().min(1).max(512);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Positive = z.number().int().positive();
export const CleanupProofQuerySchema = z
  .object({
    leaseId: z.string().uuid(),
    generation: Positive,
    expected: z
      .object({
        allocationId: Id,
        cleanupOperationId: Id,
        cleanupControlVersion: Positive,
        manifestId: Id,
        manifestHash: Hash,
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export const CleanupProofIdentitySchema = z
  .object({
    installationId: Id,
    allocationId: Id,
    generation: Positive,
    operationId: Id,
    controlVersion: Positive,
    purpose: z.literal("tenant"),
    runtimeIdentityId: Id,
    connectionRevisionId: Id,
  })
  .strict();
export const CleanupProofRuntimeSchema = z
  .object({ runtimeIdentityId: Id, connectionRevisionId: Id })
  .strict();
export const CleanupProofObjectSchema = z
  .object({
    id: Id,
    kind: z.enum(["container", "volume", "network_policy"]),
    ownership: z.literal("owned"),
  })
  .strict();
export const CleanupProofReceiptSchema = z
  .object({
    resourceId: Id,
    kind: z.enum(["container", "volume", "network_policy"]),
    presence: z.literal("absent"),
    runtime: CleanupProofRuntimeSchema,
    identity: CleanupProofIdentitySchema,
    networkRules: z.enum(["removed", "never_installed", "not_applicable"]),
    verifiedAtMs: Positive,
  })
  .strict();
export const TicketCleanupProofSchema = z
  .object({
    version: z.literal("1.0"),
    ticketId: Id,
    consumerId: Id,
    leaseId: Id,
    generation: Positive,
    allocationId: Id,
    cleanupOperationId: Id,
    cleanupControlVersion: Positive,
    manifest: z.object({ id: Id, hash: Hash }).strict(),
    createIdentity: CleanupProofIdentitySchema,
    containerGroup: containerGroupInventorySchema.optional(),
    cleanupIdentity: CleanupProofIdentitySchema,
    objects: z
      .array(CleanupProofObjectSchema)
      .min(3)
      .refine(validDockerOwnedKinds),
    receipts: z.array(CleanupProofReceiptSchema).min(3),
    after: z
      .object({
        presence: z.literal("absent"),
        completeness: z.literal("complete"),
        identity: CleanupProofIdentitySchema,
        runtime: CleanupProofRuntimeSchema,
        verifiedAtMs: Positive,
      })
      .strict(),
    claimState: z.literal("released"),
    leaseState: z.literal("revoked"),
    providerCleanup: z.literal("complete"),
    producer: z.literal("controller.allocation.cleanup"),
    readAtMs: Positive,
    io: z.literal("unknown"),
    wholeScopeWriteExclusion: z.literal("unknown"),
  })
  .strict();
export const CleanupProofHttpQuerySchema = z
  .object({
    leaseId: z.string().uuid(),
    generation: z.coerce.number().int().positive(),
    allocationId: Id.optional(),
    cleanupOperationId: Id.optional(),
    cleanupControlVersion: z.coerce.number().int().positive().optional(),
    manifestId: Id.optional(),
    manifestHash: Hash.optional(),
  })
  .strict();
export type CleanupProofQuery = z.infer<typeof CleanupProofQuerySchema>;
export type TicketCleanupProof = z.infer<typeof TicketCleanupProofSchema>;
