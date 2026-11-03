import { z } from "zod";
import {
  vmAllocationIdentitySchema,
  vmResourceSpecSchema,
} from "./vm-runtime-identity.js";

export const hyperVAbsolutePathSchema = z
  .string()
  .min(3)
  .refine(
    (v) =>
      /^[A-Za-z]:\\/.test(v) &&
      !v.includes("\0") &&
      !v.split(/[\\/]/).includes(".."),
    "local absolute Windows path required",
  );
export const hyperVRequestSchema = z
  .object({
    identity: vmAllocationIdentitySchema,
    template: z
      .object({
        configPath: hyperVAbsolutePathSchema,
        configSha256: z.string().regex(/^[a-f0-9]{64}$/),
        guestOs: z.enum(["windows", "linux"]),
        architecture: z.literal("amd64"),
        generation: z.union([z.literal(1), z.literal(2)]),
      })
      .strict(),
    resources: vmResourceSpecSchema,
    switchName: z.string().min(1).max(200),
  })
  .strict();
export type HyperVRequest = z.infer<typeof hyperVRequestSchema>;
export const hyperVNativeVmSchema = z
  .object({
    id: z.string().uuid(),
    owner: z.string(),
    directory: hyperVAbsolutePathSchema,
    configurationPath: hyperVAbsolutePathSchema,
    diskPaths: z.array(hyperVAbsolutePathSchema),
    cpus: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    dynamicMemory: z.boolean(),
    generation: z.union([z.literal(1), z.literal(2)]),
    state: z.enum(["running", "stopped", "other"]),
    switchNames: z.array(z.string()),
    dynamicMac: z.boolean(),
    ipv4: z.array(z.ipv4()),
  })
  .strict();
export type HyperVNativeVm = z.infer<typeof hyperVNativeVmSchema>;

export const hyperVInspectionSchema = z
  .object({
    identity: vmAllocationIdentitySchema,
    presence: z.enum(["present", "absent", "unknown"]),
    inventoryComplete: z.boolean(),
    reason: z.string().optional(),
    vm: hyperVNativeVmSchema.optional(),
    requestedEnvironment: z
      .object({
        guestOs: z.enum(["windows", "linux"]),
        architecture: z.literal("amd64"),
      })
      .strict()
      .optional(),
    bootstrapStatus: z.literal("not_implemented"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.presence === "present" && !value.vm)
      ctx.addIssue({
        code: "custom",
        message: "Present Hyper-V observation requires native VM identity",
      });
    if (value.presence !== "present" && value.vm)
      ctx.addIssue({
        code: "custom",
        message: "Non-present Hyper-V observation cannot carry a VM",
      });
    if (value.presence === "absent" && !value.inventoryComplete)
      ctx.addIssue({
        code: "custom",
        message: "Hyper-V absence requires complete inventory",
      });
  });
export type HyperVInspection = z.infer<typeof hyperVInspectionSchema>;

export const hyperVNativeFactsSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().optional(),
    hostArchitecture: z.string(),
    implementedOperations: z.array(z.string()),
  })
  .strict();
export const hyperVRuntimeFactsSchema = hyperVNativeFactsSchema.extend({
  nativeRuntimeNamespaceId: z.string().uuid(),
});
export type HyperVRuntimeFacts = z.infer<typeof hyperVRuntimeFactsSchema>;

export const hyperVRuntimeActionSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("reconcile"), request: hyperVRequestSchema })
    .strict(),
  ...(["inspect", "stop", "destroy"] as const).map((kind) =>
    z
      .object({ kind: z.literal(kind), identity: vmAllocationIdentitySchema })
      .strict(),
  ),
]);
export type HyperVRuntimeAction = z.infer<typeof hyperVRuntimeActionSchema>;
const binding = {
  installationId: z.string().min(1).max(200),
  runtimeIdentityId: z.string().min(1).max(200),
};
export const hyperVRuntimeFactsRequestSchema = z
  .object({ requestNonce: z.string().uuid(), ...binding })
  .strict();
export const hyperVRuntimeActionRequestSchema = z
  .object({
    requestNonce: z.string().uuid(),
    ...binding,
    controllerEpoch: z.number().int().positive(),
    deadline: z.string().datetime({ offset: true }),
    action: hyperVRuntimeActionSchema,
  })
  .strict()
  .refine((request) => {
    const identity = hyperVActionIdentity(request.action);
    return (
      identity.installationId === request.installationId &&
      identity.runtimeIdentityId === request.runtimeIdentityId
    );
  }, "Hyper-V action identity does not match runtime binding");
export const hyperVRuntimeActionResponseSchema = z
  .object({
    requestNonce: z.string().uuid(),
    ...binding,
    result: hyperVInspectionSchema,
  })
  .strict();
export const hyperVRuntimeFactsResponseSchema = z
  .object({
    requestNonce: z.string().uuid(),
    ...binding,
    facts: hyperVRuntimeFactsSchema,
  })
  .strict();
export type HyperVRuntimeActionRequest = z.infer<
  typeof hyperVRuntimeActionRequestSchema
>;
export function hyperVActionIdentity(action: HyperVRuntimeAction) {
  return action.kind === "reconcile"
    ? action.request.identity
    : action.identity;
}
