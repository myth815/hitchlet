import {
  PowerExecutionSchema,
  type PowerExecution,
} from "@hitchlet/contracts/admin";
import type { Storage } from "./index.js";
import type { Statement } from "./protocol.js";
import {
  SQLitePowerStore,
  type PowerSnapshot,
  type PowerActor,
} from "./power-store.js";
import { ApplicationError } from "../application/errors.js";

export class PowerExecutionStore {
  readonly safety: SQLitePowerStore;
  constructor(readonly db: Storage) {
    this.safety = new SQLitePowerStore(db);
  }
  /** Qualification references outlive the bounded history shown in the GUI. */
  async get(machineId: string, id: string) {
    const row = await this.db.get<{ result_json: string }>(
      "SELECT result_json FROM operations WHERE id=? AND machine_id=? AND kind='power.execution'",
      [id, machineId],
    );
    return row
      ? PowerExecutionSchema.parse(JSON.parse(row.result_json))
      : undefined;
  }
  async list(machineId: string) {
    const rows = await this.db.all<{ result_json: string }>(
      "SELECT result_json FROM operations WHERE machine_id=? AND kind='power.execution' ORDER BY created_at_ms DESC,id DESC LIMIT 100",
      [machineId],
    );
    return rows.map((r) =>
      PowerExecutionSchema.parse(JSON.parse(r.result_json)),
    );
  }
  async active() {
    const rows = await this.db.all<{ result_json: string }>(
      "SELECT result_json FROM operations WHERE kind='power.execution' AND state IN ('planned','running','unknown') ORDER BY created_at_ms LIMIT 64",
    );
    return rows.map((r) =>
      PowerExecutionSchema.parse(JSON.parse(r.result_json)),
    );
  }
  async write(
    s: PowerSnapshot,
    p: PowerExecution,
    previous: PowerExecution | null,
    extra: Statement[] = [],
    actor: PowerActor = {
      operatorId: "controller",
      requestId: p.id,
      actorType: "controller",
    },
  ) {
    const terminal = ["ready", "cancelled", "manual"].includes(p.phase);
    const state = terminal
      ? p.phase === "ready"
        ? "succeeded"
        : "cancelled"
      : "running";
    try {
      await this.db.batchTransaction([
        ...this.safety.fences(s),
        previous
          ? {
              kind: "run",
              sql: "UPDATE operations SET result_json=?,state=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND state='running'",
              params: [
                JSON.stringify(p),
                state,
                p.updatedAtMs,
                p.id,
                previous.version,
              ],
              expectChanges: 1,
            }
          : {
              kind: "run",
              sql: "INSERT INTO operations(id,machine_id,machine_epoch,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,result_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,'power.execution',?,?,'running',?,?,?,?,?,?)",
              params: [
                p.id,
                p.machineId,
                p.machineEpoch,
                p.controllerEpoch,
                p.id,
                `power.execution:${p.id}`,
                p.bindingHash,
                JSON.stringify({
                  qualification: p.qualification,
                  guardHash: p.guardHash,
                }),
                JSON.stringify(p),
                p.updatedAtMs,
                p.createdAtMs,
                p.updatedAtMs,
              ],
            },
        ...extra,
        {
          kind: "run",
          sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,occurred_at_ms,payload_json) VALUES('power_execution',?,?,'power.execution_updated',?,?)",
          params: [
            p.id,
            p.version,
            p.updatedAtMs,
            JSON.stringify({
              machineId: p.machineId,
              phase: p.phase,
              qualification: p.qualification,
              reasons: p.reasons,
            }),
          ],
        },
        {
          kind: "run",
          sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES(?,?,'power.execution_updated','machine',?,?,?,?)",
          params: [
            actor.actorType ?? "consumer",
            actor.operatorId,
            p.machineId,
            actor.requestId,
            p.updatedAtMs,
            JSON.stringify({
              cycleId: p.id,
              phase: p.phase,
              qualification: p.qualification,
            }),
          ],
        },
      ]);
    } catch (e) {
      if (
        e instanceof Error &&
        "code" in e &&
        ["STORAGE_CAS_FAILED", "STORAGE_CONSTRAINT"].includes(String(e.code))
      )
        throw new ApplicationError("conflict");
      throw e;
    }
  }
}
