import { z } from "zod";

/** Shared VM ownership and command fences; never a consumer placement selector. */
export const vmAllocationIdentitySchema = z
  .object({
    installationId: z.string().min(1).max(200),
    runtimeIdentityId: z.string().min(1).max(200),
    connectionRevisionId: z.string().min(1).max(200),
    allocationId: z.string().min(1).max(200),
    generation: z.number().int().positive(),
    operationId: z.string().min(1).max(200),
    controlVersion: z.number().int().positive(),
    purpose: z.enum(["tenant", "validation"]),
  })
  .strict();
export const vmResourceSpecSchema = z
  .object({
    cpus: z.number().int().min(1).max(64),
    memoryMiB: z.number().int().min(512).max(1_048_576),
  })
  .strict();
export type VmAllocationIdentity = z.infer<typeof vmAllocationIdentitySchema>;
export function vmAllocationOwnerTuple(
  identity: VmAllocationIdentity,
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
