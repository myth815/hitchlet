import { z } from "zod";

/** Supplemental console on an already claimed VM; SSH acquire/access is unchanged. */
export const ConsoleActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("access") }).strict(),
  z.object({ kind: z.literal("secure_attention") }).strict(),
  z
    .object({
      kind: z.literal("frame"),
      width: z.number().int().min(16).max(1024),
      height: z.number().int().min(16).max(768),
    })
    .strict(),
  z
    .object({
      kind: z.literal("key"),
      keyCode: z.number().int().min(1).max(255),
    })
    .strict(),
  z
    .object({ kind: z.literal("text"), text: z.string().min(1).max(2048) })
    .strict(),
  z
    .object({
      kind: z.literal("pointer"),
      x: z.number().int().min(0).max(65535),
      y: z.number().int().min(0).max(65535),
      click: z.boolean(),
    })
    .strict(),
]);
export type ConsoleAction = z.infer<typeof ConsoleActionSchema>;
export const ConsoleCommandSchema = z
  .object({
    generation: z.number().int().positive(),
    commandId: z.string().uuid(),
    action: ConsoleActionSchema,
  })
  .strict();
export type ConsoleCommand = z.infer<typeof ConsoleCommandSchema>;
export const ConsoleResultSchema = z
  .object({
    ticketId: z.string().min(1),
    generation: z.number().int().positive(),
    commandId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    protocol: z.literal("console"),
    status: z.enum(["available", "captured", "completed", "unknown"]),
    authentication: z
      .object({
        kind: z.literal("existing_account_login_required"),
        username: z.string().min(1),
      })
      .strict(),
    frame: z
      .object({
        width: z.number().int().min(16).max(1024),
        height: z.number().int().min(16).max(768),
        mimeType: z.literal("image/png"),
        dataBase64: z.string().min(1).max(5_000_000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConsoleResult = z.infer<typeof ConsoleResultSchema>;
