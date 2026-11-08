import { z } from "zod";
import { vmAllocationIdentitySchema } from "./vm-runtime-identity.js";
const base = {
  identity: vmAllocationIdentitySchema,
  nonce: z.string().uuid(),
  passwordHash: z.string().regex(/^[a-f0-9]{64}$/),
};
export const hyperVInteractiveRequestSchema = z
  .object({
    ...base,
    mode: z.enum(["inspect", "prepare"]),
    expiresAt: z.string().datetime(),
    password: z.string().min(40).max(128).optional(),
  })
  .strict()
  .refine(
    (r) => r.mode !== "prepare" || r.password !== undefined,
    "Preparation requires material",
  );
export const hyperVInteractiveReceiptSchema = z
  .object({
    ...base,
    account: z.literal("workspace"),
    status: z.enum(["not_applied", "applied", "unknown"]),
  })
  .strict();
export const hyperVGuestInteractiveRequestSchema = z
  .object({
    ...base,
    account: z.literal("workspace"),
    vmId: z.string().uuid(),
    guestOs: z.literal("windows"),
    architecture: z.literal("amd64"),
  })
  .strict();
export const hyperVGuestInteractiveReceiptSchema =
  hyperVGuestInteractiveRequestSchema.extend({
    status: z.enum(["not_applied", "applied", "unknown"]),
  });
export type HyperVInteractiveRequest = z.infer<
  typeof hyperVInteractiveRequestSchema
>;
export type HyperVInteractiveReceipt = z.infer<
  typeof hyperVInteractiveReceiptSchema
>;
export type HyperVGuestInteractiveRequest = z.infer<
  typeof hyperVGuestInteractiveRequestSchema
>;
