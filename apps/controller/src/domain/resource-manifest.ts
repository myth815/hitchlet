import { createHash } from "node:crypto";
import type { OwnedResource, ProvisionPlan } from "../providers/port.js";

/** Manifest identity belongs to one allocation generation; its digest describes the actual owned inventory. */
export function resourceManifest(
  plan: ProvisionPlan,
  objects: readonly OwnedResource[],
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
        }))
        .sort(
          (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
        ),
    }),
  };
}
