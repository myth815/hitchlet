import { z } from "zod";

const identity = z
  .object({
    requestId: z.string().uuid(),
    installationId: z.string().min(1),
    runtimeIdentityId: z.string().min(1),
    nativeEngineId: z.string().min(1),
    agentId: z.string().min(1),
  })
  .strict();

/** Read-only Runtime facts; an idle backend is never a physical shutdown permit. */
export const runtimeWorkloadRequestSchema = identity;
export const runtimeContainerWorkloadSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    running: z.boolean(),
    paused: z.boolean(),
    installationId: z.string().max(256).nullable(),
    runtimeIdentityId: z.string().max(256).nullable(),
    allocationId: z.string().max(256).nullable(),
    generation: z.number().int().positive().safe().nullable(),
  })
  .strict();
export const nativeProcessFactSchema = z
  .object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().nonnegative(),
    uid: z.number().int().nonnegative(),
    startTicks: z.string().regex(/^\d+$/),
    executable: z.string().max(4096).nullable(),
    unit: z.string().max(256).nullable(),
  })
  .strict();
export const runtimeBackgroundServiceSchema = z
  .object({
    unit: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@_.:-]*\.service$/),
    executable: z.string().startsWith("/").max(4096),
    uid: z.number().int().nonnegative(),
    userService: z.boolean().default(false),
  })
  .strict();
/** Written by native WSL startup outside the Runtime container; never self-issued by it. */
export const runtimeNativeContextSchema = z
  .object({
    distributionMachineId: z.string().regex(/^[a-f0-9]{32}$/),
    bootId: z.string().uuid(),
    pidNamespace: z.string().regex(/^pid:\[\d+\]$/),
  })
  .strict();
export const runtimeNativeWorkloadSchema = z
  .object({
    complete: z.boolean(),
    distributionMachineId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    bootId: z.string().uuid().nullable(),
    namespaces: z
      .object({
        pid: z.string(),
        user: z.string(),
        mount: z.string(),
        network: z.string(),
      })
      .strict()
      .nullable(),
    processes: z.array(nativeProcessFactSchema).max(8192),
    backgroundPids: z.array(z.number().int().positive()).max(256),
    errorCodes: z.array(z.string().min(1).max(128)).max(32),
  })
  .strict();
export const runtimeWorkloadResultSchema = identity
  .extend({
    observedAt: z.string().datetime(),
    controllerEpoch: z.number().int().nonnegative().safe(),
    complete: z.boolean(),
    workloadState: z.enum(["idle", "busy", "unknown"]),
    containers: z.array(runtimeContainerWorkloadSchema).max(1024),
    native: runtimeNativeWorkloadSchema,
    pendingCommandCount: z.number().int().nonnegative(),
    retainedAllocationCount: z.number().int().nonnegative(),
    backgroundProcessCount: z.number().int().nonnegative(),
    unapprovedProcessCount: z.number().int().nonnegative(),
    reasons: z.array(z.string().max(128)).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.workloadState === "idle" &&
      (!value.complete ||
        !value.native.complete ||
        value.pendingCommandCount ||
        value.retainedAllocationCount ||
        value.unapprovedProcessCount ||
        value.reasons.length ||
        value.native.errorCodes.length ||
        value.containers.some(
          (c) =>
            c.running ||
            c.paused ||
            (c.installationId === value.installationId &&
              c.runtimeIdentityId === value.runtimeIdentityId),
        ))
    )
      ctx.addIssue({
        code: "custom",
        message: "Idle requires complete, settled and empty workload evidence",
      });
  });
export type RuntimeWorkloadRequest = z.infer<
  typeof runtimeWorkloadRequestSchema
>;
export type RuntimeWorkloadResult = z.infer<typeof runtimeWorkloadResultSchema>;
export type RuntimeNativeWorkload = z.infer<typeof runtimeNativeWorkloadSchema>;
export type RuntimeContainerWorkload = z.infer<
  typeof runtimeContainerWorkloadSchema
>;
export type RuntimeBackgroundService = z.infer<
  typeof runtimeBackgroundServiceSchema
>;

export type RuntimeNativeContext = z.infer<typeof runtimeNativeContextSchema>;
