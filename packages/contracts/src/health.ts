import { z } from "zod";

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    stage: z.literal("D00"),
    simulator: z.literal("not_implemented"),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
