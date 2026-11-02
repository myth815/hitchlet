import { z } from "zod";
import {
  tartAllocationIdentitySchema,
  tartGuestBootstrapRequestSchema,
  tartInspectionSchema,
  tartLocalTemplateRefSchema,
  tartReconcileRequestSchema,
} from "./tart-runtime.js";

const nonce = z.string().uuid();
const artifactDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const tartRuntimeTemplateProofSchema = z
  .object({
    templateRef: tartLocalTemplateRefSchema,
    artifactDigest,
    proofKind: z.literal("sealed_local_bundle_v1"),
    sealedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const installedIdentity = {
  installationId: z.string().min(1).max(200),
  runtimeIdentityId: z.string().min(1).max(200),
};

export const tartRuntimeActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("inspect"),
      identity: tartAllocationIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconcile"),
      request: tartReconcileRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bootstrap.apply"),
      identity: tartAllocationIdentitySchema,
      request: tartGuestBootstrapRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("destroy"),
      identity: tartAllocationIdentitySchema,
    })
    .strict(),
]);

function actionIdentity(action: z.infer<typeof tartRuntimeActionSchema>) {
  return action.kind === "reconcile"
    ? action.request.identity
    : action.identity;
}

export const tartRuntimeActionRequestSchema = z
  .object({
    requestNonce: nonce,
    deadline: z.string().datetime({ offset: true }),
    controllerEpoch: z.number().int().positive(),
    ...installedIdentity,
    action: tartRuntimeActionSchema,
  })
  .strict()
  .refine((request) => {
    const identity = actionIdentity(request.action);
    return (
      identity.installationId === request.installationId &&
      identity.runtimeIdentityId === request.runtimeIdentityId &&
      (request.action.kind !== "bootstrap.apply" ||
        sameActionIdentity(identity, request.action.request.identity))
    );
  }, "Tart action identity does not match the configured runtime");

export const tartRuntimeFactsRequestSchema = z
  .object({
    requestNonce: nonce,
    ...installedIdentity,
  })
  .strict();

export const tartRuntimeFactsSchema = z
  .object({
    nativeRuntimeNamespaceId: z.string().uuid(),
    tartVersion: z.string().min(1).max(100),
    hostOS: z.literal("macos"),
    hostArch: z.literal("arm64"),
    hostCpuCount: z.number().int().positive().safe(),
    hostMemoryBytes: z.number().int().positive().safe(),
    templates: z.array(tartRuntimeTemplateProofSchema),
  })
  .strict();

export const tartRuntimeActionResponseSchema = z
  .object({
    requestNonce: nonce,
    ...installedIdentity,
    result: tartInspectionSchema,
  })
  .strict();

export const tartRuntimeFactsResponseSchema = z
  .object({
    requestNonce: nonce,
    ...installedIdentity,
    facts: tartRuntimeFactsSchema,
  })
  .strict();

export type TartRuntimeAction = z.infer<typeof tartRuntimeActionSchema>;
export type TartRuntimeActionRequest = z.infer<
  typeof tartRuntimeActionRequestSchema
>;
export type TartRuntimeActionResponse = z.infer<
  typeof tartRuntimeActionResponseSchema
>;
export type TartRuntimeFacts = z.infer<typeof tartRuntimeFactsSchema>;
export type TartRuntimeTemplateProof = z.infer<
  typeof tartRuntimeTemplateProofSchema
>;
export type TartRuntimeFactsRequest = z.infer<
  typeof tartRuntimeFactsRequestSchema
>;
export type TartRuntimeFactsResponse = z.infer<
  typeof tartRuntimeFactsResponseSchema
>;

function sameActionIdentity(
  left: z.infer<typeof tartAllocationIdentitySchema>,
  right: z.infer<typeof tartAllocationIdentitySchema>,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.runtimeIdentityId === right.runtimeIdentityId &&
    left.connectionRevisionId === right.connectionRevisionId &&
    left.allocationId === right.allocationId &&
    left.generation === right.generation &&
    left.operationId === right.operationId &&
    left.controlVersion === right.controlVersion &&
    left.purpose === right.purpose
  );
}
