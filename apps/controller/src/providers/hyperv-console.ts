import { HyperVNodeRuntimeConfigSchema } from "@hitchlet/contracts/admin";
import type { Storage } from "../storage/index.js";
import type { LocalSecretStore } from "../storage/secret-store.js";
import type { ConsoleExecutor } from "../application/console.js";
import { createHyperVRuntimeClient } from "./runtime-credentials.js";
/** Current authenticated transport, bound to the original provision operation and exact Node. */
export function createHyperVConsoleExecutor(
  storage: Storage,
  secrets: LocalSecretStore,
): ConsoleExecutor {
  return async (request) => {
    const i = request.identity;
    const row = await storage.get<{
      config_json: string;
      controller_epoch: bigint;
    }>(
      `SELECT n.config_json,installed.controller_epoch FROM allocations a
       JOIN operations o ON o.id=? AND o.allocation_id=a.id AND o.kind='allocation.provision' AND o.state='succeeded'
       JOIN nodes n ON n.id=a.node_id AND n.runtime_identity_id=a.runtime_identity_id AND n.backend_kind='hyperv'
       JOIN runtime_identities ri ON ri.id=a.runtime_identity_id AND ri.backend_kind='hyperv'
       JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.enabled=1 AND pc.runtime_identity_id=ri.id AND pc.backend_kind='hyperv'
       JOIN provider_connection_revisions current ON current.id=pc.current_revision_id AND current.connection_id=pc.id AND current.verified_runtime_identity_id=ri.id
       JOIN provider_connection_revisions frozen ON frozen.id=o.connection_revision_id AND frozen.connection_id=pc.id AND frozen.verified_runtime_identity_id=ri.id
       JOIN installations installed ON installed.singleton=1
       JOIN leases l ON l.allocation_id=a.id AND l.state='active' AND l.claimed_at_ms IS NOT NULL
       JOIN tickets t ON t.id=l.ticket_id AND t.phase='ready'
       WHERE a.id=? AND a.runtime_identity_id=? AND a.generation=? AND a.control_version=? AND o.control_version=a.control_version
       AND o.generation=a.generation AND o.connection_revision_id=? AND installed.installation_id=?
       AND a.desired_state='present' AND a.observed_state='running' AND l.expires_at_ms>?`,
      [
        i.operationId,
        i.allocationId,
        i.runtimeIdentityId,
        i.generation,
        i.controlVersion,
        i.connectionRevisionId,
        i.installationId,
        Date.now(),
      ],
    );
    if (!row) throw Error("Console exact active allocation unavailable");
    const profile = HyperVNodeRuntimeConfigSchema.parse(
      JSON.parse(row.config_json).runtimeProfile,
    );
    const runtime = await createHyperVRuntimeClient({
      profile,
      secrets,
      installationId: i.installationId,
      runtimeIdentityId: i.runtimeIdentityId,
      controllerEpoch: Number(row.controller_epoch),
      deadlineMs: Math.min(Date.parse(request.expiresAt), Date.now() + 15000),
    });
    return runtime.console(request);
  };
}
