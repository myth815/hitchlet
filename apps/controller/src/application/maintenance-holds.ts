import {
  MaintenanceHoldInputSchema,
  MaintenanceHoldReceiptSchema,
  type MaintenanceHoldReceipt,
} from "@hitchlet/contracts/admin";
import { ApplicationError, AuthFailure } from "./errors.js";
import type { Storage } from "../storage/index.js";
import {
  collaboratorMaintenanceHoldMarker as marker,
  loadMachineAdmission,
  machineAdmissionFence,
} from "../storage/human-use-guard.js";
import type { Statement } from "../storage/protocol.js";

type HoldRow = {
  id: string;
  machine_id: string;
  reason: string;
  created_by_consumer_id: string | null;
  created_at_ms: number | bigint;
  expires_at_ms: number | bigint | null;
  released_at_ms: number | bigint | null;
};
export type HoldActor = {
  consumerId: string;
  scopes: readonly string[];
};

/** Explicit, owner-bound maintenance usage holds on the existing manual Hold kind. */
export class MaintenanceHoldService {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}

  private requireScope(actor: HoldActor, scope: string) {
    if (!actor.scopes.includes(scope)) throw new AuthFailure("forbidden");
  }
  private isManaged(row: HoldRow | undefined): row is HoldRow {
    return (
      !!row &&
      row.reason.startsWith(marker(row.id)) &&
      row.expires_at_ms === null
    );
  }
  private project(row: HoldRow): MaintenanceHoldReceipt {
    return MaintenanceHoldReceiptSchema.parse({
      id: row.id,
      machineId: row.machine_id,
      reason: row.reason.slice(marker(row.id).length),
      createdByConsumerId: row.created_by_consumer_id,
      createdAtMs: Number(row.created_at_ms),
      expiresAtMs: null,
      releasedAtMs:
        row.released_at_ms === null ? null : Number(row.released_at_ms),
      state: row.released_at_ms === null ? "active" : "released",
    });
  }
  private async row(id: string) {
    const row = await this.db.get<HoldRow>(
      "SELECT id,machine_id,reason,created_by_consumer_id,created_at_ms,expires_at_ms,released_at_ms FROM holds WHERE id=? AND kind='manual'",
      [id],
    );
    return this.isManaged(row) ? row : undefined;
  }
  private async requireMachineGrant(actor: HoldActor, machineId: string) {
    const row = await this.db.get<{ allowed: number }>(
      "SELECT EXISTS(SELECT 1 FROM consumers c JOIN nodes n ON n.machine_id=? WHERE c.id=? AND c.status='active' AND (json_extract(c.authorization_json,'$.nodeIds')='all' OR EXISTS(SELECT 1 FROM json_each(c.authorization_json,'$.nodeIds') g WHERE g.value=n.id))) AS allowed",
      [machineId, actor.consumerId],
    );
    if (Number(row?.allowed) !== 1) throw new ApplicationError("not_found");
  }
  async authorizeAcquire(input: {
    machineId: string;
    holdId: string;
    body: unknown;
    actor: HoldActor;
  }) {
    this.requireScope(input.actor, "tickets:write");
    const body = MaintenanceHoldInputSchema.parse(input.body),
      prior = await this.row(input.holdId);
    if (prior) {
      if (
        prior.machine_id !== input.machineId ||
        prior.created_by_consumer_id !== input.actor.consumerId ||
        prior.reason !== `${marker(input.holdId)}${body.reason}` ||
        prior.released_at_ms !== null
      )
        throw new ApplicationError("conflict");
      return;
    }
    await this.requireMachineGrant(input.actor, input.machineId);
  }
  async authorizeRelease(input: {
    machineId: string;
    holdId: string;
    actor: HoldActor;
  }) {
    this.requireScope(input.actor, "tickets:write");
    const row = await this.row(input.holdId);
    if (
      !row ||
      row.machine_id !== input.machineId ||
      row.created_by_consumer_id !== input.actor.consumerId
    )
      throw new ApplicationError("not_found");
  }

  async list(machineId: string, actor: HoldActor) {
    this.requireScope(actor, "tickets:read");
    await this.requireMachineGrant(actor, machineId);
    const rows = await this.db.all<HoldRow>(
      "SELECT id,machine_id,reason,created_by_consumer_id,created_at_ms,expires_at_ms,released_at_ms FROM holds WHERE machine_id=? AND kind='manual' AND created_by_consumer_id=? AND released_at_ms IS NULL AND substr(reason,1,?)=? ORDER BY created_at_ms,id",
      [
        machineId,
        actor.consumerId,
        "[collaborator-maintenance:".length,
        "[collaborator-maintenance:",
      ],
    );
    return rows
      .filter((row) => this.isManaged(row))
      .map((row) => this.project(row));
  }

  async get(machineId: string, holdId: string, actor: HoldActor) {
    this.requireScope(actor, "tickets:read");
    const row = await this.row(holdId);
    if (
      !row ||
      row.machine_id !== machineId ||
      row.created_by_consumer_id !== actor.consumerId
    )
      throw new ApplicationError("not_found");
    return this.project(row);
  }

  async acquire(input: {
    machineId: string;
    holdId: string;
    body: unknown;
    actor: HoldActor;
    requestId: string;
  }) {
    const body = MaintenanceHoldInputSchema.parse(input.body);
    await this.authorizeAcquire(input);
    const prior = await this.row(input.holdId);
    if (prior) {
      if (
        prior.machine_id !== input.machineId ||
        prior.created_by_consumer_id !== input.actor.consumerId ||
        prior.reason !== `${marker(input.holdId)}${body.reason}` ||
        prior.released_at_ms !== null
      )
        throw new ApplicationError("conflict");
      return this.project(prior);
    }
    const now = this.now();
    const snapshot = await loadMachineAdmission(this.db, input.machineId, now);
    const statements: Statement[] = [
      machineAdmissionFence(snapshot),
      {
        kind: "run",
        sql: `INSERT INTO holds(id,machine_id,kind,reason,created_by_consumer_id,created_at_ms,expires_at_ms)
          SELECT ?,?,'manual',?,?,?,NULL
          WHERE EXISTS(SELECT 1 FROM machines m WHERE m.id=? AND m.power_lifecycle NOT IN('shutdown_requested','off_expected','waking','unknown') AND (m.admission<>'draining' OR EXISTS(SELECT 1 FROM operations d WHERE d.machine_id=m.id AND d.kind='power.execution' AND d.state='running' AND json_extract(d.result_json,'$.phase') IN('draining','prepared'))))
          AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.machine_id=? AND o.kind='power.execution' AND (o.state IN('planned','unknown') OR (o.state='running' AND COALESCE(json_extract(o.result_json,'$.phase') NOT IN('idle','draining','prepared'),1))))
          AND EXISTS(SELECT 1 FROM consumers c WHERE c.id=? AND c.status='active' AND (json_extract(c.authorization_json,'$.nodeIds')='all' OR EXISTS(SELECT 1 FROM nodes n JOIN json_each(c.authorization_json,'$.nodeIds') g ON g.value=n.id WHERE n.machine_id=?)))`,
        params: [
          input.holdId,
          input.machineId,
          `${marker(input.holdId)}${body.reason}`,
          input.actor.consumerId,
          now,
          input.machineId,
          input.machineId,
          input.actor.consumerId,
          input.machineId,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'machine.maintenance_hold_acquired','machine',?,?,?,?)",
        params: [
          input.actor.consumerId,
          input.machineId,
          input.requestId,
          now,
          JSON.stringify({ holdId: input.holdId, reason: body.reason }),
        ],
      },
    ];
    try {
      await this.db.batchTransaction(statements);
    } catch (error) {
      const raced = await this.row(input.holdId);
      if (
        raced &&
        raced.machine_id === input.machineId &&
        raced.created_by_consumer_id === input.actor.consumerId &&
        raced.reason === `${marker(input.holdId)}${body.reason}` &&
        raced.released_at_ms === null
      )
        return this.project(raced);
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
    const created = await this.row(input.holdId);
    if (!created) throw new ApplicationError("conflict");
    return this.project(created);
  }

  async release(input: {
    machineId: string;
    holdId: string;
    actor: HoldActor;
    requestId: string;
  }) {
    await this.authorizeRelease(input);
    const row = await this.row(input.holdId);
    if (
      !row ||
      row.machine_id !== input.machineId ||
      row.created_by_consumer_id !== input.actor.consumerId
    )
      throw new ApplicationError("not_found");
    if (row.released_at_ms !== null) return this.project(row);
    const now = this.now();
    const snapshot = await loadMachineAdmission(this.db, input.machineId, now);
    const invalidatedCondition = `maintenance-hold-release:${input.holdId}`;
    try {
      await this.db.batchTransaction([
        machineAdmissionFence(snapshot),
        {
          kind: "run",
          sql: "UPDATE holds SET released_at_ms=? WHERE id=? AND machine_id=? AND kind='manual' AND created_by_consumer_id=? AND released_at_ms IS NULL AND substr(reason,1,?)=? AND EXISTS(SELECT 1 FROM consumers c WHERE c.id=holds.created_by_consumer_id AND c.status='active')",
          params: [
            now,
            input.holdId,
            input.machineId,
            input.actor.consumerId,
            marker(input.holdId).length,
            marker(input.holdId),
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'machine.maintenance_hold_released','machine',?,?,?,?)",
          params: [
            input.actor.consumerId,
            input.machineId,
            input.requestId,
            now,
            JSON.stringify({ holdId: input.holdId }),
          ],
        },
        {
          kind: "run",
          sql: "UPDATE operations SET result_json=json_set(result_json,'$.idleSinceMs',NULL,'$.conditionKey',?,'$.lastEvaluationAtMs',?,'$.updatedAtMs',?,'$.version',version+1),version=version+1,updated_at_ms=? WHERE machine_id=? AND kind='power.execution' AND state='running' AND json_extract(result_json,'$.phase')='idle'",
          params: [invalidatedCondition, now, now, now, input.machineId],
        },
        {
          kind: "run",
          sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) SELECT 'power_execution',id,version,'power.execution_updated',?, ?,json_object('machineId',?,'phase','idle','qualification',json_extract(result_json,'$.qualification'),'reasons',json(json_extract(result_json,'$.reasons'))) FROM operations WHERE machine_id=? AND kind='power.execution' AND state='running' AND json_extract(result_json,'$.phase')='idle' AND json_extract(result_json,'$.conditionKey')=? AND updated_at_ms=?",
          params: [
            input.actor.consumerId,
            now,
            input.machineId,
            input.machineId,
            invalidatedCondition,
            now,
          ],
        },
        {
          kind: "run",
          sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) SELECT 'consumer',?,'power.execution_updated','machine',?,?,?,json_object('cycleId',id,'phase','idle','qualification',json_extract(result_json,'$.qualification'),'reason','Maintenance hold release restarted idle grace') FROM operations WHERE machine_id=? AND kind='power.execution' AND state='running' AND json_extract(result_json,'$.phase')='idle' AND json_extract(result_json,'$.conditionKey')=? AND updated_at_ms=?",
          params: [
            input.actor.consumerId,
            input.machineId,
            input.requestId,
            now,
            input.machineId,
            invalidatedCondition,
            now,
          ],
        },
      ]);
    } catch (error) {
      const raced = await this.row(input.holdId);
      if (
        raced &&
        raced.machine_id === input.machineId &&
        raced.created_by_consumer_id === input.actor.consumerId &&
        raced.released_at_ms !== null
      )
        return this.project(raced);
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
    const released = await this.row(input.holdId);
    if (!released) throw new ApplicationError("conflict");
    return this.project(released);
  }
}
