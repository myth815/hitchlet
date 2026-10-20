import { z } from "zod";

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    // Legacy protocol marker retained for wire compatibility; deployment acceptance is tracked separately.
    stage: z.literal("D05"),
    executionMode: z.enum(["disabled", "simulator", "portainer"]),
    recoveryState: z.enum(["ready", "recovering", "unavailable"]),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
