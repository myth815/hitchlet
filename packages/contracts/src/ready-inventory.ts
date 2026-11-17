import { z } from "zod";
import { CleanupProofIdentitySchema } from "./cleanup-proof.js";
const Id = z.string().min(1).max(512);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Positive = z.number().int().positive();
const Expected = z
  .object({
    allocationId: Id,
    controlVersion: Positive,
    manifestId: Id,
    manifestHash: Hash,
  })
  .partial()
  .strict();
export const ReadyInventoryQuerySchema = z
  .object({
    leaseId: z.string().uuid(),
    generation: Positive,
    expected: Expected.optional(),
  })
  .strict();
export const ReadyInventoryHttpQuerySchema = z
  .object({
    leaseId: z.string().uuid(),
    generation: z.coerce.number().int().positive(),
    allocationId: Id.optional(),
    controlVersion: z.coerce.number().int().positive().optional(),
    manifestId: Id.optional(),
    manifestHash: Hash.optional(),
  })
  .strict();
export const TicketReadyInventorySchema = z
  .object({
    version: z.literal("1.0"),
    ticketId: Id,
    consumerId: Id,
    leaseId: Id,
    generation: Positive,
    allocationId: Id,
    controlVersion: Positive,
    manifest: z.object({ id: Id, hash: Hash }).strict(),
    createIdentity: CleanupProofIdentitySchema,
    objects: z
      .array(
        z
          .object({
            id: Id,
            kind: z.enum(["container", "volume", "network_policy"]),
            ownership: z.literal("owned"),
            identity: CleanupProofIdentitySchema,
            contractHash: Hash,
          })
          .strict(),
      )
      .length(3),
    completeness: z.literal("complete"),
    ticketPhase: z.literal("ready"),
    leaseState: z.literal("active"),
    readyAtMs: Positive,
    readAtMs: Positive,
    producer: z.literal("controller.allocation.ready"),
    basis: z.literal("persisted_ready_manifest"),
    nativeObservedAtRead: z.literal(false),
  })
  .strict();
export type ReadyInventoryQuery = z.infer<typeof ReadyInventoryQuerySchema>;
export type TicketReadyInventory = z.infer<typeof TicketReadyInventorySchema>;
