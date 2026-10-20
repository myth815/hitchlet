import { z } from "zod";
const absolute = z
  .string()
  .regex(/^\//)
  .refine(
    (v) =>
      !v.includes("\0") && !v.split("/").some((p) => p === ".." || p === "."),
  );
export const storageRootSchema = z
  .object({
    sourceRef: absolute,
    protocol: z.enum(["local", "nfs", "smb"]),
    secretVersionRef: z.string().nullable(),
    mountPoint: absolute,
    mountSource: z.string().min(1),
  })
  .strict();
export const runtimeStorageMountSchema = z
  .object({
    grantId: z.string().min(1),
    revisionId: z.string().min(1),
    approvedSourceRef: absolute,
    authorizedSubpath: z
      .string()
      .min(1)
      .refine(
        (v) =>
          !v.startsWith("/") &&
          !v.includes("\\") &&
          !v.includes("\0") &&
          v.split("/").every((p) => p !== ".." && p !== "." && p !== ""),
      ),
    protocol: z.enum(["local", "nfs", "smb"]),
    secretVersionRef: z.string().nullable(),
    target: absolute.refine(
      (v) =>
        v !== "/" &&
        v !== "/workspace" &&
        !["/proc", "/sys", "/dev", "/run", "/etc", "/root", "/home"].some(
          (p) => v === p || v.startsWith(p + "/"),
        ),
    ),
    mode: z.enum(["read_only", "read_write"]),
  })
  .strict();
export const runtimeStorageRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    installationId: z.string().min(1),
    runtimeIdentityId: z.string().min(1),
    nativeEngineId: z.string().min(1),
    inventory: z.boolean().default(false),
    mounts: z.array(runtimeStorageMountSchema).max(32),
  })
  .strict()
  .superRefine((v, c) => {
    for (let i = 0; i < v.mounts.length; i++)
      for (let j = 0; j < i; j++) {
        const a = v.mounts[i]!.target,
          b = v.mounts[j]!.target;
        if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
          c.addIssue({ code: "custom", message: "Overlapping mount targets" });
      }
  });
export const runtimeStorageResultSchema = z
  .object({
    requestId: z.string().uuid(),
    installationId: z.string().min(1),
    runtimeIdentityId: z.string().min(1),
    nativeEngineId: z.string().min(1),
    /** Remote sample wall clock. The controller adds its own receipt timestamp locally. */
    observedAtMs: z.number().int().nonnegative(),
    controllerEpoch: z.number().int().nonnegative(),
    inventory: z
      .array(
        z
          .object({
            kind: z.enum(["container", "network", "volume"]),
            id: z.string().min(1),
            allocationId: z.string(),
            generation: z.string(),
            operationId: z.string(),
            contractHash: z.string(),
          })
          .strict(),
      )
      .nullable(),
    imageStore: z
      .object({ root: absolute, availableMiB: z.number().int().nonnegative() })
      .strict(),
    mounts: z.array(
      z
        .object({
          grantId: z.string().min(1),
          resolvedSourceRef: absolute,
          sourceValidationEvidenceId: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type RuntimeStorageRequest = z.infer<typeof runtimeStorageRequestSchema>;
export type RuntimeStorageResult = z.infer<typeof runtimeStorageResultSchema>;
export type StorageRoot = z.infer<typeof storageRootSchema>;

/** Bound internal mount facts; explicit Simulator sources are non-host references.
 * The real Runtime Agent request still requires absolute approved host paths. */
export const resolvedStorageMountSchema = runtimeStorageMountSchema
  .extend({
    grantRevision: z.literal(1),
    approvedSourceRef: z.string().min(1),
    resolvedSourceRef: z.string().min(1),
    sourceValidationEvidenceId: z.string().min(1),
  })
  .strict();
export type ResolvedStorageMount = z.infer<typeof resolvedStorageMountSchema>;
