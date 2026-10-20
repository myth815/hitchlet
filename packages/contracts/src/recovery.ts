import { z } from "zod";
import { NodeRuntimeConfigSchema } from "./admin.js";
const recoverySecret = z.string().regex(/^secret:[a-f0-9]{32}$/);
export const RecoveryControlPlanSchema = z
  .object({
    oldControllerStopped: z.literal(true),
    connections: z.array(
      z
        .object({
          connectionId: z.string().min(1),
          revisionId: z.string().min(1),
        })
        .strict(),
    ),
    runtimes: z.array(
      z
        .object({
          nodeId: z.string().min(1),
          runtimeProfile: NodeRuntimeConfigSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type RecoveryControlPlan = z.infer<typeof RecoveryControlPlanSchema>;
export const RecoveryStateSchema = z
  .object({
    id: z.string().uuid(),
    restoredAtMs: z.number().int(),
    stage: z.enum(["controls_required", "reconciling"]),
    oldConnectionRevisions: z.array(
      z
        .object({
          connectionId: z.string(),
          runtimeIdentityId: z.string(),
          revisionId: z.string(),
          secretVersionRef: recoverySecret.nullable(),
        })
        .strict(),
    ),
    oldRuntimeProfiles: z.array(
      z
        .object({
          nodeId: z.string(),
          runtimeIdentityId: z.string(),
          runtimeProfile: NodeRuntimeConfigSchema,
        })
        .strict(),
    ),
    restoredAllocationIds: z.array(z.string()),
    quarantinedNodes: z.array(z.string()).default([]),
  })
  .strict();
