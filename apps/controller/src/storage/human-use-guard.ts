import {
  HumanUsePolicySchema,
  type HumanUsePolicy,
} from "@hitchlet/contracts/admin";
import { hostHeartbeatSchema } from "@hitchlet/contracts/internal";
import {
  evaluateMachineAdmission,
  type MachineAdmissionContext,
  type Resources,
} from "../domain/human-use.js";
import { ApplicationError } from "../application/errors.js";
import { StorageError, type Storage } from "./index.js";
import type { Statement } from "./protocol.js";

/* One deterministic SQLite read owns all inputs to the pure rule. The exact same expression
 * is compared inside BEGIN IMMEDIATE before writing a claim or policy. Heartbeat updates
 * do not increment Machine.version, so entity-version CAS alone is insufficient. */
const snapshotSql = `SELECT json_object(
 'machine',(SELECT json_object('id',id,'name',name,'usageMode',usage_mode,'source',source,'admission',admission,'power',observed_power,'version',version,'management',json(management_json)) FROM machines WHERE id=:machineId),
 'pools',json((SELECT json_group_array(json_object('id',id,'parentAllocationId',parent_allocation_id,'capacity',json_object('cpuMillis',total_cpu_millis,'memoryMiB',total_memory_mib,'scratchMiB',total_scratch_mib),'reserve',json_object('cpuMillis',system_cpu_millis,'memoryMiB',system_memory_mib,'scratchMiB',system_scratch_mib),'version',version)) FROM (SELECT * FROM capacity_pools WHERE machine_id=:machineId ORDER BY id))),
 'nodes',json((SELECT json_group_array(json_object('id',id,'name',name,'poolId',pool_id,'admission',admission,'observedHealth',observed_health,'capabilities',json(capabilities_json),'version',version,'observedAtMs',observed_at_ms)) FROM (SELECT * FROM nodes WHERE machine_id=:machineId ORDER BY id))),
 'allocations',json((SELECT json_group_array(json_object('id',id,'nodeId',node_id,'purpose',purpose,'desiredState',desired_state,'observedState',observed_state,'cleanupStatus',cleanup_status,'version',version)) FROM (SELECT * FROM allocations WHERE machine_id=:machineId AND (id IN (SELECT allocation_id FROM capacity_claims WHERE state<>'released') OR id IN (SELECT parent_allocation_id FROM capacity_pools WHERE parent_allocation_id IS NOT NULL)) ORDER BY id))),
 'claims',json((SELECT json_group_array(json_object('id',id,'allocationId',allocation_id,'poolId',pool_id,'state',state,'resources',json_object('cpuMillis',cpu_millis,'memoryMiB',memory_mib,'scratchMiB',scratch_mib),'version',version)) FROM (SELECT c.* FROM capacity_claims c WHERE c.state<>'released' AND (c.allocation_id IN (SELECT id FROM allocations WHERE machine_id=:machineId) OR c.pool_id IN (SELECT id FROM capacity_pools WHERE machine_id=:machineId)) ORDER BY c.id))),
 'holds',json((SELECT json_group_array(json_object('id',id,'kind',kind,'reason',reason,'expiresAt',expires_at_ms)) FROM (SELECT * FROM holds WHERE machine_id=:machineId AND released_at_ms IS NULL ORDER BY id))),
 'host',(SELECT json_object('heartbeat',json(s.heartbeat_json),'receivedAt',s.received_at_ms,'sessionEpoch',s.session_epoch,'agentId',s.agent_id,'bootId',s.agent_boot_id,'agentMachineId',a.machine_id,'status',a.status,'currentBootId',a.current_boot_id,'agentSessionEpoch',a.session_epoch,'acceptedControllerEpoch',a.accepted_controller_epoch) FROM machine_snapshots s LEFT JOIN agents a ON a.id=s.agent_id AND a.kind='host' WHERE s.machine_id=:machineId),
 'controllerEpoch',(SELECT controller_epoch FROM installations WHERE singleton=1)
) AS material`;
// Positional bindings are the worker protocol. Every occurrence binds the same machine.
const materialSql = snapshotSql.replaceAll(":machineId", "?");
const machineParameters = (id: string) =>
  Array<string>(snapshotSql.split(":machineId").length - 1).fill(id);

type Material = {
  machine: {
    id: string;
    name: string;
    source: string;
    usageMode: "shared" | "dedicated";
    admission: MachineAdmissionContext["admission"];
    power: string;
    version: number;
    management: { humanUsePolicy?: unknown };
  } | null;
  pools: MachineAdmissionContext["pools"];
  nodes: (Omit<
    MachineAdmissionContext["nodes"][number],
    "manualInventory" | "capabilityExpiresAtMs"
  > & {
    version: number;
    capabilities: { admissionMode?: string; expiresAt?: string };
  })[];
  allocations: MachineAdmissionContext["allocations"];
  claims: MachineAdmissionContext["claims"];
  holds: (MachineAdmissionContext["holds"][number] & {
    expiresAt: number | null;
  })[];
  host: {
    heartbeat: unknown;
    receivedAt: number;
    sessionEpoch: number;
    agentId: string;
    bootId: string;
    agentMachineId: string;
    status: string;
    currentBootId: string;
    agentSessionEpoch: number;
    acceptedControllerEpoch: number;
  } | null;
  controllerEpoch: number | null;
};
export type MachineAdmissionSnapshot = {
  material: string;
  data: Material;
  context: MachineAdmissionContext;
};

export async function loadMachineAdmission(
  db: Storage,
  machineId: string,
  now: number,
): Promise<MachineAdmissionSnapshot> {
  const row = await db.get<{ material: string }>(
    materialSql,
    machineParameters(machineId),
  );
  if (!row) throw new ApplicationError("not_found");
  const data = JSON.parse(row.material) as Material;
  if (!data.machine) throw new ApplicationError("not_found");
  const management = data.machine.management;
  const rawPolicy =
    management && typeof management === "object"
      ? management.humanUsePolicy
      : undefined;
  const policy = HumanUsePolicySchema.safeParse(rawPolicy);
  let observation: MachineAdmissionContext["observation"] = null;
  if (data.host) {
    const parsed = hostHeartbeatSchema.safeParse(data.host.heartbeat);
    if (parsed.success) {
      const h = data.host;
      observation = {
        snapshot: parsed.data.snapshot,
        receivedAtMs: h.receivedAt,
        revoked: h.status === "disabled",
        authenticated:
          h.status === "active" &&
          h.agentMachineId === machineId &&
          parsed.data.snapshot.machineId === machineId &&
          h.agentId === parsed.data.snapshot.agentId &&
          h.bootId === parsed.data.snapshot.bootId &&
          h.currentBootId === h.bootId &&
          h.sessionEpoch > 0 &&
          h.sessionEpoch === h.agentSessionEpoch &&
          parsed.data.sessionEpoch === h.sessionEpoch &&
          parsed.data.controllerEpoch === data.controllerEpoch &&
          h.acceptedControllerEpoch === data.controllerEpoch,
      };
    }
  }
  return {
    material: row.material,
    data,
    context: {
      machineId,
      source: data.machine.source,
      admission: data.machine.admission,
      power: data.machine.power,
      policy: policy.success ? policy.data : null,
      policyInvalid: rawPolicy !== undefined && !policy.success,
      pools: data.pools,
      nodes: data.nodes.map((n) => ({
        ...n,
        manualInventory:
          n.capabilities?.admissionMode === "constant_online_manual_inventory",
        capabilityExpiresAtMs:
          typeof n.capabilities?.expiresAt === "string"
            ? Date.parse(n.capabilities.expiresAt)
            : null,
      })),
      allocations: data.allocations,
      claims: data.claims,
      holds: data.holds.filter(
        (h) => h.expiresAt === null || h.expiresAt > now,
      ),
      observation,
    },
  };
}

export function machineAdmissionFence(
  snapshot: MachineAdmissionSnapshot,
): Statement {
  return {
    kind: "run",
    sql: `UPDATE machines SET version=version WHERE id=? AND (${materialSql})=?`,
    params: [
      snapshot.context.machineId,
      ...machineParameters(snapshot.context.machineId),
      snapshot.material,
    ],
    expectChanges: 1,
  };
}
export async function prepareMachineAdmission(
  db: Storage,
  machineId: string,
  nodeId: string,
  requested: Resources,
  now: number,
) {
  const snapshot = await loadMachineAdmission(db, machineId, now);
  const evaluation = evaluateMachineAdmission(
    snapshot.context,
    now,
    nodeId,
    requested,
  );
  if (!evaluation.allowed)
    throw new StorageError("STORAGE_CAS_FAILED", evaluation.reasons.join("; "));
  return machineAdmissionFence(snapshot);
}
export function policyContext(
  snapshot: MachineAdmissionSnapshot,
  policy: HumanUsePolicy,
) {
  return {
    ...snapshot.context,
    policy,
    policyInvalid: false,
    pools: snapshot.context.pools.map((p) =>
      p.parentAllocationId === null
        ? { ...p, reserve: policy.systemReserve }
        : p,
    ),
  };
}
