import { createHash } from "node:crypto";
import type { OwnedResource, ProvisionPlan } from "../providers/port.js";

/** Manifest identity belongs to one allocation generation; its digest describes the actual owned inventory. */
export function resourceManifest(
  plan: Pick<ProvisionPlan, "identity"> & {
    resolved: Pick<ProvisionPlan["resolved"], "contractHash">;
  },
  objects: readonly (Pick<
    OwnedResource,
    "id" | "kind" | "ownership" | "identity" | "contractHash"
  > & { details?: Readonly<Record<string, unknown>> | null | undefined })[],
) {
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    manifestId: `manifest-${digest({ installationId: plan.identity.installationId, allocationId: plan.identity.allocationId, generation: plan.identity.generation })}`,
    manifestHash: digest({
      owner: plan.identity,
      contractHash: plan.resolved.contractHash,
      objects: objects
        .filter((item) => item.ownership === "owned")
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          ownership: item.ownership,
          owner: item.identity,
          contractHash: item.contractHash,
          ...(item.details && typeof item.details.memberName === "string"
            ? {
                member: {
                  name: item.details.memberName,
                  artifactDigest: item.details.artifactDigest ?? null,
                  ipv4: item.details.ipv4 ?? null,
                  resources: item.details.resources ?? null,
                  target: item.details.target ?? null,
                  mountBindings: item.details.mountBindings ?? [],
                },
              }
            : {}),
        }))
        .sort(
          (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
        ),
    }),
  };
}
