import { z } from "zod";
import { ConsoleActionSchema } from "./console.js";
import { vmAllocationIdentitySchema } from "./vm-runtime-identity.js";
export const hyperVConsoleRequestSchema = z
  .object({
    identity: vmAllocationIdentitySchema,
    commandId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    action: ConsoleActionSchema,
  })
  .strict();
export type HyperVConsoleRequest = z.infer<typeof hyperVConsoleRequestSchema>;
export const hyperVConsoleResultSchema = z
  .object({
    identity: vmAllocationIdentitySchema,
    commandId: z.string().uuid(),
    status: z.enum(["available", "captured", "completed", "unknown"]),
    account: z.string().min(1),
    frame: z
      .object({
        width: z.number().int().min(16).max(1024),
        height: z.number().int().min(16).max(768),
        pixelFormat: z.literal("rgb565le"),
        dataBase64: z.string().min(1).max(2_100_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HyperVConsoleResult = z.infer<typeof hyperVConsoleResultSchema>;
