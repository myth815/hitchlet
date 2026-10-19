import { z } from "zod";

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    stage: z.literal("D05"),
    executionMode: z.enum(["disabled", "simulator", "portainer"]),
    recoveryState: z.enum(["ready", "recovering", "unavailable"]),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
