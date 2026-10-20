import { z } from "zod";
const id = z.string().uuid();
const integer = z.number().int().safe().nonnegative();
/** Trusted installation file only. This is deliberately NOT a management write DTO. */
export const PowerInstallationSchema = z
  .object({
    machines: z
      .array(
        z
          .object({
            machineId: id,
            agentId: id,
            enabled: z.boolean().default(false),
            automatic: z.boolean().default(false),
            idleSeconds: integer.min(1).max(604800).default(1800),
            guardHash: z.string().regex(/^[a-f0-9]{64}$/),
            executorHash: z.string().regex(/^[a-f0-9]{64}$/),
            route: z
              .object({
                id,
                kind: z.literal("local_lan"),
                interfaceAddress: z.ipv4(),
                broadcastAddress: z.ipv4(),
                macAddress: z
                  .string()
                  .regex(/^(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/),
              })
              .strict(),
            /** Requires a completed controller-owned qualification with this exact binding. */
            qualificationId: id.optional(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type PowerInstallation = z.infer<typeof PowerInstallationSchema>;
export type PowerInstallationMachine = PowerInstallation["machines"][number];
export const PowerExecutionSchema = z
  .object({
    id,
    machineId: id,
    agentId: id,
    version: integer.min(1),
    qualification: z.boolean(),
    bindingHash: z.string(),
    guardHash: z.string(),
    executorHash: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum([
      "idle",
      "draining",
      "prepared",
      "committing",
      "shutdown_requested",
      "off_expected",
      "waking",
      "ready",
      "cancel_pending",
      "cancelled",
      "manual",
    ]),
    machineEpoch: integer.min(1),
    controllerEpoch: integer.min(1),
    machineVersion: integer.min(1),
    bootId: id,
    conditionKey: z.string(),
    idleSinceMs: integer.nullable(),
    lastEvaluationAtMs: integer,
    token: id.nullable(),
    tokenExpiresAtMs: integer.nullable(),
    cancelRequestedAtMs: integer.nullable(),
    resumeWakeOnDemand: z.boolean(),
    acceptedAtMs: integer.nullable(),
    acceptedReceiptId: id.nullable(),
    observedPower: z.enum(["on", "unknown"]),
    onlineWolAtMs: integer.nullable(),
    recoveredBootId: id.nullable(),
    wakeAttempts: integer.max(3),
    nextWakeAtMs: integer.nullable(),
    deadlineMs: integer.nullable(),
    reasons: z.array(z.string()),
    createdAtMs: integer,
    updatedAtMs: integer,
  })
  .strict();
export type PowerExecution = z.infer<typeof PowerExecutionSchema>;
export const PowerExecutionStartSchema = z
  .object({ qualification: z.boolean().default(false) })
  .strict();
export const PowerExecutionCommandSchema = z
  .object({
    expectedVersion: integer.min(1),
    action: z.enum(["cancel", "wake"]),
    provisionDeadlineMs: integer.optional(),
  })
  .strict();
export const PowerExecutionViewSchema = z
  .object({
    configured: z.boolean(),
    enabled: z.boolean(),
    automatic: z.boolean(),
    verified: z.boolean(),
    reasons: z.array(z.string()),
    executions: z.array(PowerExecutionSchema),
  })
  .strict();
export const HostPowerEventSchema = z
  .object({
    cycleId: id.optional(),
    bootId: id,
    osBootId: id,
    controllerEpoch: integer.min(1),
    sessionEpoch: integer.min(1),
    guardHash: z.string().regex(/^[a-f0-9]{64}$/),
    executorHash: z.string().regex(/^[a-f0-9]{64}$/),
    powerProtocolVersion: z.literal(1),
    event: z.enum(["poll", "prepared", "accepted", "cancelled", "rejected"]),
    token: id.optional(),
  })
  .strict();
export type HostPowerEvent = z.infer<typeof HostPowerEventSchema>;
export const HostPowerDirectiveSchema = z
  .object({
    action: z.enum(["none", "prepare", "commit", "cancel"]),
    cycleId: id.nullable(),
    machineEpoch: integer.nullable(),
    token: id.nullable(),
    expiresAtMs: integer.nullable(),
  })
  .strict();
export type HostPowerDirective = z.infer<typeof HostPowerDirectiveSchema>;

export type PowerExecutionStart = z.input<typeof PowerExecutionStartSchema>;
export type PowerExecutionCommand = z.infer<typeof PowerExecutionCommandSchema>;
