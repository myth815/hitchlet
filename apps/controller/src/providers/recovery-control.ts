import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { NodeRuntimeConfigSchema } from "@hitchlet/contracts/admin";
import type { Storage } from "../storage/index.js";
import { probePortainer } from "./portainer-probe.js";
import { runtimeClient } from "./runtime-credentials.js";

/** Read-only proof of credential revocation and immutable runtime ownership. */
export function recoveryControlVerifier(
  db: Storage,
  secrets: { get(ref: string): Promise<string> },
  client: (
    profile: z.infer<typeof NodeRuntimeConfigSchema>,
    secrets: { get(ref: string): Promise<string> },
  ) => Pick<ReturnType<typeof runtimeClient>, "storageFacts"> = runtimeClient,
) {
  const revision = async (id: string) => {
    const r = await db.get<{
      endpoint_ref: string;
      provider_endpoint_id: string;
      secret_version_ref: string;
      native_id: string;
    }>(
      "SELECT r.endpoint_ref,r.provider_endpoint_id,r.secret_version_ref,i.native_id FROM provider_connection_revisions r JOIN runtime_identities i ON i.id=r.verified_runtime_identity_id WHERE r.id=?",
      [id],
    );
    if (!r) throw new Error("Recovery connection missing");
    return r;
  };
  return {
    async provider(oldId: string, newId: string) {
      const old = await revision(oldId),
        next = await revision(newId);
      const response = await fetch(
        new URL("/api/endpoints", old.endpoint_ref),
        {
          headers: { "X-API-Key": await secrets.get(old.secret_version_ref) },
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        },
      );
      if (![401, 403].includes(response.status))
        throw new Error("Old Portainer credential is not proven revoked");
      const evidence = await probePortainer({
        endpointUrl: next.endpoint_ref,
        environmentId: next.provider_endpoint_id,
        apiKey: await secrets.get(next.secret_version_ref),
      });
      if (
        evidence.engineId !== old.native_id ||
        evidence.engineId !== next.native_id
      )
        throw new Error("Recovery Engine identity changed");
    },
    async runtime(
      old: z.infer<typeof NodeRuntimeConfigSchema>,
      next: z.infer<typeof NodeRuntimeConfigSchema>,
      nodeId: string,
    ) {
      const row = await db.get<{
        installation_id: string;
        runtime_identity_id: string;
        native_id: string;
      }>(
        "SELECT i.installation_id,n.runtime_identity_id,r.native_id FROM nodes n JOIN runtime_identities r ON r.id=n.runtime_identity_id JOIN installations i ON i.singleton=1 WHERE n.id=?",
        [nodeId],
      );
      if (!row) throw new Error("Recovery Node missing");
      const request = {
        requestId: randomUUID(),
        installationId: row.installation_id,
        runtimeIdentityId: row.runtime_identity_id,
        nativeEngineId: row.native_id,
        mounts: [],
        inventory: true,
      };
      let rejected = false;
      try {
        await client(old, secrets).storageFacts(request);
      } catch (error) {
        rejected =
          error instanceof Error &&
          /^Runtime Agent returned HTTP (401|403)$/.test(error.message);
      }
      if (!rejected)
        throw new Error("Old Runtime bearer is not proven revoked");
      const facts = await client(next, secrets).storageFacts({
        ...request,
        requestId: randomUUID(),
      });
      // Runtime facts are authenticated independently from its numeric epoch. The
      // epoch is used only after old bearer rejection to pass the existing fence.
      if (!facts.inventory)
        throw new Error("Recovery requires complete owned inventory");
      const known = await db.all<{
        id: string;
        generation: bigint;
        contract_hash: string | null;
        operation_id: string | null;
      }>(
        "SELECT a.id,a.generation,r.contract_hash,o.id operation_id FROM allocations a LEFT JOIN resolved_provision_contracts r ON r.id=a.resolved_provision_contract_id LEFT JOIN operations o ON o.allocation_id=a.id AND o.kind='allocation.provision' WHERE a.node_id=? AND a.cleanup_status<>'complete'",
        [nodeId],
      );
      const unknownResources = facts.inventory.filter(
        (item) =>
          !known.some(
            (a) =>
              a.id === item.allocationId &&
              String(a.generation) === item.generation &&
              a.contract_hash === item.contractHash &&
              a.operation_id === item.operationId,
          ),
      ).length;
      return { controllerEpoch: facts.controllerEpoch, unknownResources };
    },
  };
}
