import { SQLiteRecoveryStore } from "../storage/recovery-store.js";
import {
  RecoveryControlPlanSchema,
  RecoveryStateSchema,
  type RecoveryControlPlan,
} from "@hitchlet/contracts/internal";
export { restoreLedger as restoreBackup } from "../storage/recovery-store.js";
export { RecoveryControlPlanSchema } from "@hitchlet/contracts/internal";
import { z } from "zod";
import { NodeRuntimeConfigSchema } from "@hitchlet/contracts/admin";
import type { Storage } from "../storage/index.js";

/** External verification must prove old credentials are rejected, not merely
 * timed out, and new credentials still address the same immutable Engine. */
export async function acceptRecoveryControls(
  db: Storage,
  raw: RecoveryControlPlan,
  verify: {
    provider: (oldRevisionId: string, newRevisionId: string) => Promise<void>;
    runtime: (
      oldProfile: z.infer<typeof NodeRuntimeConfigSchema>,
      newProfile: z.infer<typeof NodeRuntimeConfigSchema>,
      nodeId: string,
    ) => Promise<{ controllerEpoch: number; unknownResources: number }>;
  },
  now = Date.now,
) {
  const store = new SQLiteRecoveryStore(db);
  const plan = RecoveryControlPlanSchema.parse(raw),
    row = await store.context();
  if (!row?.recovery_json) throw new Error("No isolated recovery pending");
  const state = RecoveryStateSchema.parse(JSON.parse(row.recovery_json));
  if (state.stage !== "controls_required")
    throw new Error("Control takeover already recorded");
  const transports: Record<
    string,
    {
      connectionRevisionId: string;
      runtimeProfile: z.infer<typeof NodeRuntimeConfigSchema>;
    }
  > = {};
  let epochFloor = 0;
  const quarantinedNodes: string[] = [];
  // A Runtime identity has exactly one Node (schema UNIQUE); several logical
  // connections may point at it. Revoke every historical connection credential,
  // then authenticate the single Agent once rather than trusting a first match.
  for (const old of state.oldConnectionRevisions) {
    const next = plan.connections.filter(
      (c) => c.connectionId === old.connectionId,
    );
    if (next.length !== 1 || next[0]!.revisionId === old.revisionId)
      throw new Error(
        "Each restored connection requires one new verified revision",
      );
    const revision = await store.activatedRevision(
      next[0]!.revisionId,
      old.connectionId,
    );
    if (
      !revision ||
      revision.runtime_identity_id !== old.runtimeIdentityId ||
      revision.secret_version_ref === old.secretVersionRef
    )
      throw new Error(
        "Provider credential must be rotated and activated on the same Engine",
      );
    await verify.provider(old.revisionId, next[0]!.revisionId);
  }
  for (const oldRuntime of state.oldRuntimeProfiles) {
    const runtime = plan.runtimes.filter((r) => r.nodeId === oldRuntime.nodeId);
    if (
      runtime.length !== 1 ||
      runtime[0]!.runtimeProfile.runtimeAgent.tokenSecretRef ===
        oldRuntime.runtimeProfile.runtimeAgent.tokenSecretRef
    )
      throw new Error("Runtime bearer must be rotated");
    const evidence = await verify.runtime(
      oldRuntime.runtimeProfile,
      runtime[0]!.runtimeProfile,
      oldRuntime.nodeId,
    );
    epochFloor = Math.max(epochFloor, evidence.controllerEpoch);
    if (evidence.unknownResources > 0) quarantinedNodes.push(oldRuntime.nodeId);
    const connection = state.oldConnectionRevisions.find(
      (c) => c.runtimeIdentityId === oldRuntime.runtimeIdentityId,
    );
    if (!connection)
      throw new Error("Runtime Agent has no verified provider connection");
    transports[oldRuntime.runtimeIdentityId] = {
      connectionRevisionId: plan.connections.find(
        (c) => c.connectionId === connection.connectionId,
      )!.revisionId,
      runtimeProfile: runtime[0]!.runtimeProfile,
    };
  }
  await store.acceptControls(
    row,
    state,
    transports,
    epochFloor,
    quarantinedNodes,
    now(),
  );
}
export async function approveRecovery(
  db: Storage,
  actor: string,
  requestId: string,
  reason: string,
  now = Date.now,
) {
  const store = new SQLiteRecoveryStore(db);
  const row = await store.context();
  if (!row?.recovery_json) throw new Error("No recovery pending");
  const state = RecoveryStateSchema.parse(JSON.parse(row.recovery_json));
  if (state.stage !== "reconciling")
    throw new Error("External control has not been reacquired");
  // The ordinary integrity reconciler proves the full persisted manifest under
  // the newly authenticated transport. Keep valid ready leases and Claims;
  // uncertainty consumes capacity and requires a disabled Node.
  const active = await store.activeAllocations();
  const installation = await store.epoch();
  const time = now();
  for (const allocation of active) {
    const integrity = allocation.integrity
      ? JSON.parse(allocation.integrity)
      : null;
    const fresh =
      integrity &&
      integrity.observedAtMs >= state.restoredAtMs &&
      integrity.observedAtMs + 60_000 >= time &&
      allocation.controller_epoch === installation?.controller_epoch &&
      allocation.operation_control === allocation.control_version;
    const healthy =
      fresh &&
      integrity.state === "healthy" &&
      allocation.observed_state === "running" &&
      allocation.phase === "ready" &&
      allocation.lease_state === "active" &&
      Number(allocation.expires_at_ms) > time;
    // Validation has no tenant Lease. Its authenticated takeover inventory is
    // sufficient to keep it isolated, never to publish it or release its Claim.
    const internalIsolated =
      allocation.purpose !== "tenant" &&
      state.restoredAllocationIds.includes(allocation.id) &&
      state.oldRuntimeProfiles.some((r) => r.nodeId === allocation.node_id) &&
      allocation.observed_state === "unknown" &&
      allocation.admission === "disabled";
    const quarantined =
      internalIsolated ||
      (fresh &&
        integrity.state === "unknown" &&
        allocation.observed_state === "unknown" &&
        allocation.admission === "disabled");
    if (!healthy && !quarantined)
      throw new Error(
        "Every restored allocation requires fresh matching integrity evidence or explicit cleanup",
      );
  }
  for (const nodeId of state.quarantinedNodes)
    if (!(await store.nodeIsDisabled(nodeId)))
      throw new Error(
        "Unknown resources require their Node to remain disabled",
      );
  await store.approve(row, state, active, actor, requestId, reason, time);
}
