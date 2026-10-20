import {
  PowerPolicySchema,
  PowerCapabilitiesSchema,
  SmartPlugBindingSchema,
  SmartPlugBindingUpdateSchema,
  PowerPreviewStateSchema,
  PowerCapabilityUpdateSchema,
  type PowerPolicy,
  type PowerPreviewState,
} from "@hitchlet/contracts/admin";
import { ApplicationError } from "../application/errors.js";
import {
  executionReasons,
  shutdownReasons,
  type PowerContext,
} from "../domain/power.js";
import {
  loadMachineAdmission,
  machineAdmissionFence,
  type MachineAdmissionSnapshot,
} from "./human-use-guard.js";
import { type Storage } from "./index.js";
import { hash, type Row } from "./admin-store-utils.js";
import type { Statement } from "./protocol.js";

const kind = "power.dry-run";
const policyId = (machineId: string) => `power:${machineId}`;
// Include all relevant operations and allocations, including ones without a Claim yet.
const materialSql = `SELECT json_object(
 'maintenance',(SELECT json_object('paused',paused,'diskState',disk_state,'recovering',recovery_json IS NOT NULL) FROM system_maintenance WHERE singleton=1),
 'machine',(SELECT json_object('epoch',machine_epoch,'capabilities',json(capabilities_json),'management',json(management_json),'version',version) FROM machines WHERE id=:id),
 'policy',(SELECT json_object('version',version,'config',json(config_json)) FROM policies WHERE id=:policyId),
 'demands',json((SELECT json_group_array(json_object('id',id,'deadlineMs',COALESCE(provision_deadline_ms,queue_deadline_ms))) FROM (SELECT * FROM tickets WHERE phase='queued' AND EXISTS(SELECT 1 FROM json_each(request_json,'$.allowedMachineIds') WHERE value=:id) AND EXISTS(SELECT 1 FROM nodes n JOIN image_artifacts a ON a.image_version_id=tickets.image_version_id AND a.backend_kind=n.backend_kind AND a.environment_kind=json_extract(tickets.request_json,'$.kind') WHERE n.machine_id=:id AND n.admission='enabled' AND n.id IN(SELECT value FROM json_each(tickets.request_json,'$.allowedNodeIds')) AND n.backend_kind IN(SELECT value FROM json_each(tickets.request_json,'$.allowedProviders')) AND a.architecture IN(SELECT value FROM json_each(tickets.request_json,'$.allowedArchitectures'))) ORDER BY id))),
 'operations',json((SELECT json_group_array(json_object('id',id,'kind',kind,'state',state,'version',version,'epoch',controller_epoch)) FROM (SELECT * FROM operations WHERE state IN ('planned','running','unknown') AND (machine_id=:id OR node_id IN(SELECT id FROM nodes WHERE machine_id=:id) OR allocation_id IN(SELECT id FROM allocations WHERE machine_id=:id)) ORDER BY id))),
 'allocations',json((SELECT json_group_array(json_object('id',id,'purpose',purpose,'desiredState',desired_state,'observedState',observed_state,'cleanupStatus',cleanup_status,'version',version)) FROM (SELECT * FROM allocations WHERE machine_id=:id AND (cleanup_status<>'complete' OR id IN(SELECT allocation_id FROM capacity_claims WHERE state<>'released') OR id IN(SELECT parent_allocation_id FROM capacity_pools WHERE parent_allocation_id IS NOT NULL)) ORDER BY id)))
) AS material`;
const sql = materialSql.replaceAll(":policyId", "?").replaceAll(":id", "?");
const params = (id: string) => [id, policyId(id), id, id, id, id, id, id];
type PowerMaterial = {
  maintenance: { paused: number; diskState: string; recovering: number } | null;
  demands: { id: string; deadlineMs: number }[];
  machine: {
    epoch: number;
    capabilities: Record<string, unknown>;
    management: Record<string, unknown>;
    version: number;
  };
  policy: { version: number; config: unknown } | null;
  operations: {
    id: string;
    kind: string;
    state: string;
    version: number;
    epoch: number;
  }[];
  allocations: PowerContext["allocations"];
};
export type PowerSnapshot = {
  context: PowerContext;
  admission: MachineAdmissionSnapshot;
  material: string;
  data: PowerMaterial;
};
export type PowerActor = {
  operatorId: string;
  requestId: string;
  actorType?: "consumer" | "controller";
};

/** SQLite adapts domain decisions and fences every input in short BEGIN IMMEDIATE transactions. */
export class SQLitePowerStore {
  constructor(private readonly db: Storage) {}
  async load(machineId: string, now: number): Promise<PowerSnapshot> {
    const admission = await loadMachineAdmission(this.db, machineId, now);
    const row = await this.db.get<{ material: string }>(sql, params(machineId));
    if (!row) throw new ApplicationError("not_found");
    const data = JSON.parse(row.material) as PowerMaterial;
    const binding =
      data.machine.management.smartPlugBinding === undefined
        ? null
        : SmartPlugBindingSchema.parse(
            data.machine.management.smartPlugBinding,
          );
    const raw = PowerCapabilitiesSchema.safeParse(
      data.machine.capabilities.power,
    );
    // D22a has no evidence acceptance endpoint. Legacy/configured verified strings never grant power.
    const capabilities = PowerCapabilitiesSchema.parse(
      raw.success
        ? {
            ...raw.data,
            ...Object.fromEntries(
              (
                [
                  "sleep",
                  "normalShutdown",
                  "wakeFromSleep",
                  "coldBoot",
                  "wolWhilePossiblyOn",
                ] as const
              ).map((k) => [
                k,
                raw.data[k] === "unsupported" ? "unsupported" : "unverified",
              ]),
            ),
            verificationReportIds: [],
          }
        : {
            sleep: "unverified",
            normalShutdown: "unverified",
            wakeFromSleep: "unverified",
            coldBoot: "unverified",
            wolWhilePossiblyOn: "unverified",
            wakeRouteRef: null,
            verificationReportIds: [],
          },
    );
    return {
      admission,
      material: row.material,
      data,
      context: {
        machineId,
        machineVersion: data.machine.version,
        machineEpoch: data.machine.epoch,
        controllerEpoch: admission.data.controllerEpoch ?? 1,
        policyVersion: data.policy?.version ?? 0,
        policy: PowerPolicySchema.parse(data.policy?.config ?? {}),
        binding,
        capabilities,
        admission: admission.context,
        operations: data.operations,
        allocations: data.allocations,
      },
    };
  }
  fences(s: PowerSnapshot): Statement[] {
    return [
      machineAdmissionFence(s.admission),
      {
        kind: "run",
        sql: `UPDATE machines SET version=version WHERE id=? AND (${sql})=?`,
        params: [
          s.context.machineId,
          ...params(s.context.machineId),
          s.material,
        ],
        expectChanges: 1,
      },
    ];
  }
  view(s: PowerSnapshot, now: number) {
    return {
      machineId: s.context.machineId,
      machineVersion: s.context.machineVersion,
      machineEpoch: s.context.machineEpoch,
      version: s.context.policyVersion,
      policy: s.context.policy,
      binding: s.context.binding,
      capabilities: s.context.capabilities,
      executionAllowed: false as const,
      executionDisabledReasons: executionReasons(s.context),
      shutdownDisabledReasons: shutdownReasons(s.context, now),
      activePreviewId:
        s.data.operations.find(
          (o) =>
            o.kind === kind &&
            ["planned", "running", "unknown"].includes(o.state),
        )?.id ?? null,
    };
  }
  async configure(
    s: PowerSnapshot,
    policy: PowerPolicy,
    actor: PowerActor,
    now: number,
  ) {
    const id = policyId(s.context.machineId);
    await this.write([
      ...this.fences(s),
      s.context.policyVersion === 0
        ? {
            kind: "run",
            sql: "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES(?,?,'machine',?,?,?)",
            params: [
              id,
              `Power policy ${s.context.machineId}`,
              JSON.stringify(policy),
              now,
              now,
            ],
          }
        : {
            kind: "run",
            sql: "UPDATE policies SET config_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?",
            params: [JSON.stringify(policy), now, id, s.context.policyVersion],
            expectChanges: 1,
          },
      this.audit(
        actor,
        s.context.machineId,
        "power.policy_saved",
        { version: s.context.policyVersion + 1, policy },
        now,
      ),
    ]);
  }
  async capabilities(
    s: PowerSnapshot,
    input: unknown,
    actor: PowerActor,
    now: number,
  ) {
    const parsed = PowerCapabilityUpdateSchema.parse(input);
    if (parsed.expectedMachineVersion !== s.context.machineVersion)
      throw new ApplicationError("conflict");
    const capabilities = {
      ...s.data.machine.capabilities,
      power: { ...parsed.conclusions, verificationReportIds: [] },
    };
    await this.write([
      ...this.fences(s),
      {
        kind: "run",
        sql: "UPDATE machines SET capabilities_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?",
        params: [
          JSON.stringify(capabilities),
          now,
          s.context.machineId,
          parsed.expectedMachineVersion,
        ],
        expectChanges: 1,
      },
      this.audit(
        actor,
        s.context.machineId,
        "power.capability_conclusions_saved",
        { conclusions: parsed.conclusions },
        now,
      ),
    ]);
  }
  async bind(s: PowerSnapshot, input: unknown, actor: PowerActor, now: number) {
    const parsed = SmartPlugBindingUpdateSchema.parse(input);
    if (parsed.expectedMachineVersion !== s.context.machineVersion)
      throw new ApplicationError("conflict");
    if (parsed.binding && parsed.binding.machineId !== s.context.machineId)
      throw new ApplicationError("invalid_request");
    // A bound power intent keeps its target exclusive until every restore obligation is resolved.
    if (
      s.data.operations.some(
        (o) =>
          o.kind.startsWith("power.") &&
          ["planned", "running", "unknown"].includes(o.state),
      )
    )
      throw new ApplicationError("conflict");
    const binding = parsed.binding
      ? SmartPlugBindingSchema.parse({
          ...parsed.binding,
          device: {
            ...parsed.binding.device,
            macAddress: parsed.binding.device.macAddress.toLowerCase(),
          },
          version: (s.context.binding?.version ?? 0) + 1,
        })
      : null;
    const management = { ...s.data.machine.management };
    if (binding) management.smartPlugBinding = binding;
    else delete management.smartPlugBinding;
    await this.write([
      ...this.fences(s),
      {
        kind: "run",
        sql: "UPDATE machines SET management_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?",
        params: [
          JSON.stringify(management),
          now,
          s.context.machineId,
          parsed.expectedMachineVersion,
        ],
        expectChanges: 1,
      },
      this.audit(
        actor,
        s.context.machineId,
        "power.binding_saved",
        { bindingId: binding?.id ?? null, version: binding?.version ?? null },
        now,
      ),
    ]);
  }
  async restoreMachines(now: number) {
    const rows = await this.db.all<{ machine_id: string }>(
      "SELECT DISTINCT machine_id FROM operations WHERE kind='power.dry-run' AND state='running' AND json_extract(result_json,'$.restoreRequired')=1 AND json_extract(result_json,'$.phase')='off_wait' AND json_extract(result_json,'$.restoreNotBeforeMs')<=? LIMIT 16",
      [now],
    );
    return rows.map((r) => r.machine_id);
  }
  async list(machineId: string) {
    const rows = await this.db.all<Row>(
      "SELECT result_json FROM operations WHERE machine_id=? AND kind=? ORDER BY created_at_ms DESC,id DESC LIMIT 100",
      [machineId, kind],
    );
    return rows.map((r) =>
      PowerPreviewStateSchema.parse(JSON.parse(String(r.result_json))),
    );
  }
  async get(machineId: string, id: string) {
    const row = await this.db.get<Row>(
      "SELECT result_json FROM operations WHERE id=? AND machine_id=? AND kind=?",
      [id, machineId, kind],
    );
    if (!row) throw new ApplicationError("not_found");
    return PowerPreviewStateSchema.parse(JSON.parse(String(row.result_json)));
  }
  async create(s: PowerSnapshot, state: PowerPreviewState, actor: PowerActor) {
    const dedup =
      state.mode === "fault_recovery"
        ? `${kind}:${state.machineId}:incident:${state.incidentId}`
        : `${kind}:${state.id}`;
    const intent = JSON.stringify({
      dryRun: true,
      executable: false,
      mode: state.mode,
      policy: s.context.policy,
      binding: state.binding,
      incidentId: state.incidentId,
    });
    await this.write([
      ...this.fences(s),
      {
        kind: "run",
        sql: "INSERT INTO operations(id,machine_id,machine_epoch,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,result_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'running',?,?,?,?,?,?)",
        params: [
          state.id,
          state.machineId,
          state.machineEpoch,
          state.controllerEpoch,
          kind,
          state.id,
          dedup,
          hash(intent),
          intent,
          JSON.stringify(state),
          state.updatedAtMs,
          state.createdAtMs,
          state.updatedAtMs,
        ],
      },
      this.event(state),
      this.audit(
        actor,
        state.machineId,
        "power.preview_started",
        {
          previewId: state.id,
          mode: state.mode,
          dryRun: true,
          affectedClaimIds: state.affectedClaimIds,
          riskAcknowledgement: state.riskAcknowledgement,
        },
        state.updatedAtMs,
      ),
    ]);
  }
  async save(
    s: PowerSnapshot,
    previous: PowerPreviewState,
    state: PowerPreviewState,
    actor: PowerActor,
  ) {
    const terminal =
      ["complete", "cancelled"].includes(state.phase) ||
      (state.phase === "manual" && !state.restoreRequired);
    const operationState = terminal
      ? state.phase === "complete"
        ? "succeeded"
        : "cancelled"
      : "running";
    await this.write([
      ...this.fences(s),
      {
        kind: "run",
        sql: "UPDATE operations SET result_json=?,state=?,version=version+1,next_check_at_ms=?,updated_at_ms=? WHERE id=? AND kind=? AND version=? AND state='running'",
        params: [
          JSON.stringify(state),
          operationState,
          state.restoreNotBeforeMs ?? state.updatedAtMs,
          state.updatedAtMs,
          state.id,
          kind,
          previous.version,
        ],
        expectChanges: 1,
      },
      this.event(state),
      this.audit(
        actor,
        state.machineId,
        "power.preview_advanced",
        { previewId: state.id, phase: state.phase, dryRun: true },
        state.updatedAtMs,
      ),
    ]);
  }
  private event(p: PowerPreviewState): Statement {
    return {
      kind: "run",
      sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES('power_preview',?,?,'power.preview_updated',?,?)",
      params: [
        p.id,
        p.version,
        p.updatedAtMs,
        JSON.stringify({
          machineId: p.machineId,
          phase: p.phase,
          dryRun: true,
          executable: false,
          restoreRequired: p.restoreRequired,
        }),
      ],
    };
  }
  private audit(
    actor: PowerActor,
    id: string,
    action: string,
    details: unknown,
    now: number,
  ): Statement {
    return {
      kind: "run",
      sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES(?,?,?,'machine',?,?,?,?)",
      params: [
        actor.actorType ?? "consumer",
        actor.operatorId,
        action,
        id,
        actor.requestId,
        now,
        JSON.stringify(details),
      ],
    };
  }
  private async write(statements: Statement[]) {
    try {
      await this.db.batchTransaction(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["STORAGE_CAS_FAILED", "STORAGE_CONSTRAINT"].includes(
          String(error.code),
        )
      )
        throw new ApplicationError("conflict");
      throw error;
    }
  }
}
