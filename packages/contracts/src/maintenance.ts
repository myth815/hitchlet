import { z } from "zod";

/** Safe operational admission and capacity facts; no backend credentials or raw logs. */
export const SystemHealthSchema = z
  .object({
    admission: z.enum([
      "open",
      "paused",
      "recovery_required",
      "disk_low",
      "disk_full",
      "disk_unknown",
    ]),
    reason: z.string(),
    version: z.number().int().positive(),
    disk: z
      .object({
        availableMiB: z.number().int().nonnegative().nullable(),
        lowWaterMiB: z.number().int().nonnegative(),
        reserveMiB: z.number().int().nonnegative(),
        observedAtMs: z.number().int().nonnegative(),
      })
      .strict(),
    runtimeDisks: z
      .array(
        z
          .object({
            nodeId: z.string(),
            state: z.enum(["healthy", "low", "full", "unknown"]),
            availableMiB: z.number().int().nonnegative().nullable(),
            /** Controller receipt time used for bounded admission freshness. */
            observedAtMs: z.number().int().nonnegative(),
            /** Agent sample clock, diagnostic only and allowed to differ from the controller. */
            sampledAtMs: z.number().int().nonnegative().optional(),
            reserveMiB: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default([]),
    recovery: z
      .object({
        id: z.string().uuid(),
        stage: z.enum(["controls_required", "reconciling"]),
        restoredAtMs: z.number().int().nonnegative(),
        quarantinedNodeIds: z.array(z.string()),
      })
      .strict()
      .nullable()
      .default(null),
    recoveryRequired: z.boolean(),
    offlineLeaseEnforcement: z.literal("unsupported"),
  })
  .strict();
export const AdmissionPauseSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
/** Verified SQLite snapshot metadata; independent encrypted secrets/key are managed separately. */
export const BackupViewSchema = z
  .object({
    id: z.string().uuid(),
    createdAtMs: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    verified: z.literal(true),
  })
  .strict();
export const BackupListSchema = z.array(BackupViewSchema);
/** Explicit empty JSON body keeps backup POST framing consistent across real HTTP clients. */
export const BackupCreateSchema = z.object({}).strict();
/** Replace one credential and revoke every browser session derived from it. */
export const CredentialRotationSchema = z
  .object({ consumerId: z.string().min(1), credentialId: z.string().min(1) })
  .strict();
/** One-time secret response. Callers must not persist it in browser storage or logs. */
export const CredentialReceiptSchema = z
  .object({
    credentialId: z.string().uuid(),
    token: z.string().min(32),
    consumerId: z.string().min(1),
  })
  .strict();
/** Explicit approval follows authenticated takeover and allocation reconciliation; admission remains paused. */
export const RecoveryApprovalSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    oldControllerStopped: z.literal(true),
    oldProviderCredentialsRevoked: z.literal(true),
    oldRuntimeCredentialsRevoked: z.literal(true),
  })
  .strict();
/** Current gates; cleanup and accepted lease continuation remain available while paused. */
export type SystemHealth = z.infer<typeof SystemHealthSchema>;
/** File identity and consistency-checked size, never backup contents. */
export type BackupView = z.infer<typeof BackupViewSchema>;

/** Administrator-selected credential ID obtained from the safe credential listing. */
export type CredentialRotationRequest = z.input<
  typeof CredentialRotationSchema
>;
/** Attest external revocation after the offline takeover command has verified it. */
export type RecoveryApproval = z.input<typeof RecoveryApprovalSchema>;
export const CredentialQuerySchema = z
  .object({ consumerId: z.string().min(1).optional() })
  .strict();
export const CredentialListSchema = z.array(
  z
    .object({
      credentialId: z.string(),
      consumerId: z.string(),
      consumerName: z.string(),
      tokenPrefix: z.string(),
      status: z.enum(["active", "revoked", "expired"]),
      createdAtMs: z.number().int().nonnegative(),
      expiresAtMs: z.number().int().nonnegative().nullable(),
      lastUsedAtMs: z.number().int().nonnegative().nullable(),
    })
    .strict(),
);

export const DiagnosticsSchema = z
  .object({
    generatedAtMs: z.number().int().nonnegative(),
    health: SystemHealthSchema,
    schemaVersion: z.number().int().positive(),
    pendingOperations: z.number().int().nonnegative(),
    cleanupBacklog: z.number().int().nonnegative(),
    latestBackup: BackupViewSchema.nullable(),
  })
  .strict();
