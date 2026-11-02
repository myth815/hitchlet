import { z } from "zod";
import { tartNetworkPlanSchema } from "./tart-network.js";

const id = z.string().min(1).max(200);
const fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{20,44}={0,2}$/);
const publicKey = z
  .string()
  .min(32)
  .max(16_384)
  .regex(
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,2}(?: .*)?$/,
  );
const nonce = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Allocation ownership identity; operation/control version are fences, not owner keys. */
export const tartAllocationIdentitySchema = z
  .object({
    installationId: id,
    runtimeIdentityId: id,
    connectionRevisionId: id,
    allocationId: id,
    generation: z.number().int().positive(),
    operationId: id,
    controlVersion: z.number().int().positive(),
    purpose: z.enum(["tenant", "validation"]),
  })
  .strict();

/** A preinstalled local Tart template. configSha256 covers config.json only, not VM disks. */
export const tartLocalTemplateRefSchema = z
  .object({
    source: z.literal("local"),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    guestOS: z.enum(["darwin", "linux"]),
    guestArch: z.literal("arm64"),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const tartResourceSpecSchema = z
  .object({
    cpus: z.number().int().min(1).max(64),
    memoryMiB: z.number().int().min(512).max(1_048_576),
  })
  .strict();

/** Contains client public material only. No private key, password, or passphrase is accepted. */
export const tartGuestBootstrapRequestSchema = z
  .object({
    identity: tartAllocationIdentitySchema,
    nonce,
    account: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
    clientPublicKey: publicKey,
    clientPublicKeyFingerprint: fingerprint,
    networkEvidence: z
      .object({
        reference: id,
        revisionId: id,
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export const tartGuestBootstrapReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      identity: tartAllocationIdentitySchema,
      nonce,
      account: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
      clientPublicKeyFingerprint: fingerprint,
      hostPublicKey: publicKey,
      hostKeyFingerprint: fingerprint,
      networkEvidenceReference: id,
      networkEvidenceExpiresAt: z.string().datetime({ offset: true }),
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      identity: tartAllocationIdentitySchema,
      nonce,
      reason: z.string().min(1).max(200),
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export const tartReconcileRequestSchema = z
  .object({
    identity: tartAllocationIdentitySchema,
    template: tartLocalTemplateRefSchema,
    resources: tartResourceSpecSchema,
    network: tartNetworkPlanSchema,
    bootstrap: tartGuestBootstrapRequestSchema.optional(),
  })
  .strict()
  .refine(
    (request) =>
      !request.bootstrap ||
      sameImmutableTartAllocation(request.identity, request.bootstrap.identity),
    "bootstrap identity must match reconcile allocation",
  );

const tartInspectionIdentity = tartAllocationIdentitySchema;
const tartNetworkVMIdentity = z
  .object({
    vmName: z.string().min(1).max(200),
    device: z.string().min(1).max(64),
    inode: z.string().min(1).max(64),
    macAddress: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
  })
  .strict();
const tartNetworkPolicyReadback = z
  .object({
    allow: z.array(z.string().max(4096)).max(4096),
    block: z.array(z.string().max(4096)).max(4096),
    ruleCount: z.number().int().min(0).max(8192),
  })
  .strict();
const tartNetworkProcessIdentity = z
  .object({
    pid: z.number().int().positive().safe(),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const tartNetworkObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      backend: z.literal("softnet"),
      status: z.literal("policy_match"),
      identity: tartAllocationIdentitySchema,
      revisionId: id,
      contractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      policyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      vm: tartNetworkVMIdentity,
      process: tartNetworkProcessIdentity,
      control: z
        .object({
          transport: z.literal("unix_stream_fd"),
          connected: z.literal(true),
        })
        .strict(),
      readback: tartNetworkPolicyReadback,
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      backend: z.literal("softnet"),
      status: z.literal("unknown"),
      identity: tartAllocationIdentitySchema,
      revisionId: id.optional(),
      contractHash: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
      reason: z.string().min(1).max(200),
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);
export const tartNetworkCleanupReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      backend: z.literal("softnet"),
      status: z.literal("removed"),
      identity: tartAllocationIdentitySchema,
      revisionId: id,
      contractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      policyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      vm: tartNetworkVMIdentity,
      process: tartNetworkProcessIdentity,
      processExitObserved: z.literal(true),
      readback: tartNetworkPolicyReadback,
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      backend: z.literal("softnet"),
      status: z.literal("not_started"),
      identity: tartAllocationIdentitySchema,
      revisionId: id,
      contractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      vmName: z.string().min(1).max(200),
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      backend: z.literal("softnet"),
      status: z.literal("unknown"),
      identity: tartAllocationIdentitySchema,
      revisionId: id.optional(),
      contractHash: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
      vmName: z.string().min(1).max(200).optional(),
      reason: z.string().min(1).max(200),
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export const tartInspectionSchema = z.discriminatedUnion("presence", [
  z
    .object({
      presence: z.literal("present"),
      identity: tartInspectionIdentity,
      vmName: z.string().min(1),
      state: z.enum(["running", "stopped", "suspended"]),
      resources: tartResourceSpecSchema,
      bootstrapStatus: z.enum([
        "not_requested",
        "pending",
        "applied",
        "unknown",
      ]),
      network: tartNetworkObservationSchema,
      networkCleanupReceipt: tartNetworkCleanupReceiptSchema.optional(),
      ipAddress: z
        .string()
        .regex(/^(?:\d{1,3}\.){3}\d{1,3}$/)
        .optional(),
      bootstrapReceipt: tartGuestBootstrapReceiptSchema.optional(),
    })
    .strict(),
  z
    .object({
      presence: z.literal("absent"),
      identity: tartInspectionIdentity,
      inventoryCompleteness: z.literal("complete"),
      networkCleanupReceipt: tartNetworkCleanupReceiptSchema.optional(),
    })
    .strict(),
  z
    .object({
      presence: z.literal("unknown"),
      identity: tartInspectionIdentity,
      reason: z.string().min(1).max(200),
    })
    .strict(),
]);

export type TartAllocationIdentity = z.infer<
  typeof tartAllocationIdentitySchema
>;
export type TartLocalTemplateRef = z.infer<typeof tartLocalTemplateRefSchema>;
export type TartResourceSpec = z.infer<typeof tartResourceSpecSchema>;
export type TartGuestBootstrapRequest = z.infer<
  typeof tartGuestBootstrapRequestSchema
>;
export type TartGuestBootstrapReceipt = z.infer<
  typeof tartGuestBootstrapReceiptSchema
>;
export type TartReconcileRequest = z.infer<typeof tartReconcileRequestSchema>;
export type TartNetworkObservation = z.infer<
  typeof tartNetworkObservationSchema
>;
export type TartNetworkCleanupReceipt = z.infer<
  typeof tartNetworkCleanupReceiptSchema
>;
export type TartInspection = z.infer<typeof tartInspectionSchema>;

/** Stable owner-key components shared by the Tart provider and local driver. */
export function tartAllocationOwnerTuple(
  identity: TartAllocationIdentity,
): readonly [string, string, string, string, number, "tenant" | "validation"] {
  return [
    identity.installationId,
    identity.runtimeIdentityId,
    identity.connectionRevisionId,
    identity.allocationId,
    identity.generation,
    identity.purpose,
  ];
}

function sameImmutableTartAllocation(
  left: TartAllocationIdentity,
  right: TartAllocationIdentity,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.runtimeIdentityId === right.runtimeIdentityId &&
    left.connectionRevisionId === right.connectionRevisionId &&
    left.allocationId === right.allocationId &&
    left.generation === right.generation &&
    left.purpose === right.purpose
  );
}
