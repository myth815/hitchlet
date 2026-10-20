import { randomUUID } from "node:crypto";
import type {
  HostBootRequest,
  HostEnrollRequest,
  HostHeartbeat,
  HostPairingRequest,
} from "@hitchlet/contracts/internal";
import {
  hostHeartbeatSchema,
  hostAgentViewSchema,
  hostSnapshotViewSchema,
  classifyFreshHumanPresence,
} from "@hitchlet/contracts/internal";
import type { Storage } from "./index.js";
import { hash, type Row } from "./admin-store-utils.js";
import { AuthFailure } from "../application/errors.js";
import { ApplicationError } from "../application/errors.js";

/** SQLite owns all identity and observation CAS boundaries; HTTP never issues SQL. */
export class HostAgentStore {
  constructor(private readonly db: Storage) {}
  private async installation() {
    const row = await this.db.get<Row>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!row) throw new ApplicationError("not_found");
    return {
      installationId: String(row.installation_id),
      controllerEpoch: Number(row.controller_epoch),
    };
  }
  async pair(
    input: HostPairingRequest,
    tokenHash: string,
    now: number,
    actorId: string,
    requestId: string,
  ) {
    const installation = await this.installation();
    const machine = await this.db.get<Row>(
      "SELECT id FROM machines WHERE id=?",
      [input.machineId],
    );
    if (!machine) throw new ApplicationError("not_found");
    const existing = await this.db.get<Row>(
      "SELECT id FROM agents WHERE machine_id=? AND kind='host'",
      [input.machineId],
    );
    const agentId = existing ? String(existing.id) : randomUUID();
    const statements: import("./protocol.js").Statement[] = [];
    if (existing) {
      if (input.expectedSessionEpoch === undefined)
        throw new RangeError("Re-pair requires expectedSessionEpoch");
      statements.push({
        kind: "run",
        sql: "UPDATE agents SET credential_hash=?,host_identity=?,enrollment_hash=?,enrollment_expires_at_ms=?,enrollment_consumed=0 WHERE id=? AND kind='host' AND status='disabled' AND session_epoch=?",
        params: [
          hash(randomUUID()),
          input.hostIdentity,
          tokenHash,
          now + 300_000,
          agentId,
          input.expectedSessionEpoch,
        ],
        expectChanges: 1,
      });
    } else {
      if (input.expectedSessionEpoch !== undefined)
        throw new RangeError("Unexpected session epoch for new Host");
      statements.push({
        kind: "run",
        sql: "INSERT INTO agents(id,machine_id,kind,status,credential_hash,host_identity,enrollment_hash,enrollment_expires_at_ms) VALUES(?,?,'host','disabled',?,?,?,?)",
        params: [
          agentId,
          input.machineId,
          hash(randomUUID()),
          input.hostIdentity,
          tokenHash,
          now + 300_000,
        ],
      });
    }
    statements.push({
      kind: "run",
      sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'host.pair','agent',?,?,?,?)",
      params: [
        actorId,
        agentId,
        requestId,
        now,
        JSON.stringify({ reason: input.reason, machineId: input.machineId }),
      ],
    });
    await this.db.batchTransaction(statements);
    return {
      agentId,
      machineId: input.machineId,
      ...installation,
      expiresAt: new Date(now + 300_000).toISOString(),
    };
  }
  async enroll(input: HostEnrollRequest, credentialHash: string, now: number) {
    const installation = await this.installation();
    if (input.installationId !== installation.installationId)
      throw new AuthFailure("unauthenticated");
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: `UPDATE agents SET credential_hash=?,status='active',enrollment_hash=NULL,enrollment_expires_at_ms=NULL,enrollment_consumed=1
      WHERE id=? AND machine_id=? AND kind='host' AND host_identity=? AND enrollment_consumed=0
      AND enrollment_hash=? AND enrollment_expires_at_ms>? AND EXISTS(SELECT 1 FROM machines WHERE id=agents.machine_id AND host_os=? AND architecture=?)`,
        params: [
          credentialHash,
          input.agentId,
          input.machineId,
          input.hostIdentity,
          hash(input.pairingToken),
          now,
          input.hostOs,
          input.architecture,
        ],
        expectChanges: 1,
      },
    ]);
    return {
      agentId: input.agentId,
      machineId: input.machineId,
      ...installation,
      sessionEpoch: Number(
        (await this.db.get<Row>("SELECT session_epoch FROM agents WHERE id=?", [
          input.agentId,
        ]))!.session_epoch,
      ),
    };
  }
  private async authenticated(agentId: string, credentialHash: string) {
    const row = await this.db.get<Row>(
      "SELECT * FROM agents WHERE id=? AND credential_hash=? AND kind='host' AND status='active' AND enrollment_consumed=1",
      [agentId, credentialHash],
    );
    if (!row) throw new AuthFailure("unauthenticated");
    return row;
  }
  async start(
    agentId: string,
    credentialHash: string,
    input: HostBootRequest,
    now: number,
  ) {
    const row = await this.authenticated(agentId, credentialHash);
    const installation = await this.installation();
    if (
      input.installationId !== installation.installationId ||
      input.controllerEpoch !== installation.controllerEpoch
    )
      throw new ApplicationError("agent_epoch_conflict");
    const duplicate =
      row.current_boot_id === input.bootId &&
      Number(row.session_epoch) === input.expectedSessionEpoch + 1 &&
      Number(row.accepted_controller_epoch) === input.controllerEpoch;
    const next = input.expectedSessionEpoch + 1;
    if (!Number.isSafeInteger(next))
      throw new RangeError("session epoch exhausted");
    const guard = `id=? AND credential_hash=? AND kind='host' AND status='active' AND enrollment_consumed=1 AND EXISTS(SELECT 1 FROM installations WHERE singleton=1 AND installation_id=? AND controller_epoch=?)`;
    if (duplicate) {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: `UPDATE agents SET last_seen_at_ms=last_seen_at_ms WHERE ${guard} AND current_boot_id=? AND session_epoch=? AND accepted_controller_epoch=?`,
          params: [
            agentId,
            credentialHash,
            input.installationId,
            input.controllerEpoch,
            input.bootId,
            next,
            input.controllerEpoch,
          ],
          expectChanges: 1,
        },
      ]);
    } else {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: `UPDATE agents SET current_boot_id=?,session_epoch=?,accepted_controller_epoch=?,last_seen_at_ms=NULL WHERE ${guard} AND session_epoch=?`,
          params: [
            input.bootId,
            next,
            input.controllerEpoch,
            agentId,
            credentialHash,
            input.installationId,
            input.controllerEpoch,
            input.expectedSessionEpoch,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "INSERT INTO agent_boots(agent_id,boot_id,session_epoch,controller_epoch,started_at_ms) VALUES(?,?,?,?,?)",
          params: [agentId, input.bootId, next, input.controllerEpoch, now],
        },
        {
          kind: "run",
          sql: "DELETE FROM machine_snapshots WHERE agent_id=?",
          params: [agentId],
        },
      ]);
    }
    return {
      bootId: input.bootId,
      sessionEpoch: next,
      controllerEpoch: input.controllerEpoch,
    };
  }
  async heartbeat(
    agentId: string,
    credentialHash: string,
    input: HostHeartbeat,
    now: number,
  ) {
    const row = await this.authenticated(agentId, credentialHash);
    const s = input.snapshot;
    if (s.agentId !== agentId || s.machineId !== row.machine_id)
      throw new AuthFailure("forbidden");
    const observed = Date.parse(s.observedAt);
    if (observed > now || now - observed > 60_000)
      throw new RangeError("Untrusted observation time");
    const serialized = JSON.stringify(input),
      digest = hash(serialized);
    const current = await this.db.get<Row>(
      "SELECT * FROM machine_snapshots WHERE machine_id=?",
      [s.machineId],
    );
    const duplicate =
      current?.agent_boot_id === s.bootId &&
      Number(current.sequence) === s.sequence &&
      current.heartbeat_hash === digest &&
      Number(current.session_epoch) === input.sessionEpoch;
    const guard = {
      kind: "run" as const,
      sql: `UPDATE agents SET last_seen_at_ms=${duplicate ? "last_seen_at_ms" : "?"} WHERE id=? AND machine_id=? AND credential_hash=? AND kind='host' AND status='active' AND enrollment_consumed=1 AND current_boot_id=? AND session_epoch=? AND accepted_controller_epoch=?
      AND EXISTS(SELECT 1 FROM installations WHERE singleton=1 AND installation_id=? AND controller_epoch=?)
      AND EXISTS(SELECT 1 FROM agent_boots WHERE agent_id=agents.id AND boot_id=? AND session_epoch=? AND started_at_ms<=?)`,
      params: [
        ...(duplicate ? [] : [now]),
        agentId,
        s.machineId,
        credentialHash,
        s.bootId,
        input.sessionEpoch,
        input.controllerEpoch,
        input.installationId,
        input.controllerEpoch,
        s.bootId,
        input.sessionEpoch,
        observed + 5000,
      ],
      expectChanges: 1,
    };
    if (duplicate) {
      await this.db.batchTransaction([
        guard,
        {
          kind: "run",
          sql: "UPDATE machine_snapshots SET received_at_ms=received_at_ms WHERE machine_id=? AND agent_id=? AND agent_boot_id=? AND session_epoch=? AND sequence=? AND heartbeat_hash=?",
          params: [
            s.machineId,
            agentId,
            s.bootId,
            input.sessionEpoch,
            s.sequence,
            digest,
          ],
          expectChanges: 1,
        },
      ]);
    } else {
      await this.db.batchTransaction([
        guard,
        {
          kind: "run",
          sql: `INSERT INTO machine_snapshots(machine_id,agent_id,agent_boot_id,sequence,observed_at_ms,received_at_ms,sessions_json,workloads_json,resources_json,probe_status,heartbeat_json,heartbeat_hash,session_epoch)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET agent_id=excluded.agent_id,agent_boot_id=excluded.agent_boot_id,sequence=excluded.sequence,observed_at_ms=excluded.observed_at_ms,received_at_ms=excluded.received_at_ms,sessions_json=excluded.sessions_json,workloads_json=excluded.workloads_json,resources_json=excluded.resources_json,probe_status=excluded.probe_status,heartbeat_json=excluded.heartbeat_json,heartbeat_hash=excluded.heartbeat_hash,session_epoch=excluded.session_epoch
        WHERE machine_snapshots.agent_boot_id=excluded.agent_boot_id AND machine_snapshots.session_epoch=excluded.session_epoch AND machine_snapshots.sequence<excluded.sequence AND machine_snapshots.observed_at_ms<=excluded.observed_at_ms`,
          params: [
            s.machineId,
            agentId,
            s.bootId,
            s.sequence,
            observed,
            now,
            JSON.stringify({
              sessions: s.sessions,
              complete: s.sessionsComplete,
              activeInteraction: s.activeInteraction,
            }),
            JSON.stringify({ unmanagedActivityHold: s.unmanagedActivityHold }),
            JSON.stringify(s.resources),
            s.probeStatus,
            serialized,
            digest,
            input.sessionEpoch,
          ],
          expectChanges: 1,
        },
      ]);
    }
    return {
      sequence: s.sequence,
      sessionEpoch: input.sessionEpoch,
      receivedAt: new Date(
        duplicate ? Number(current!.received_at_ms) : now,
      ).toISOString(),
      duplicate,
      offlineLeaseEnforcement: false as const,
    };
  }
  async revoke(
    agentId: string,
    expected: number,
    reason: string,
    actorId: string,
    requestId: string,
    now: number,
  ) {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE agents SET status='disabled',credential_hash=?,enrollment_hash=NULL,enrollment_expires_at_ms=NULL,current_boot_id=NULL,session_epoch=session_epoch+1 WHERE id=? AND kind='host' AND session_epoch=?",
        params: [hash(randomUUID()), agentId, expected],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'host.revoke','agent',?,?,?,?)",
        params: [actorId, agentId, requestId, now, JSON.stringify({ reason })],
      },
    ]);
  }
  async session(agentId: string, credentialHash: string) {
    const row = await this.authenticated(agentId, credentialHash);
    return {
      ...(await this.installation()),
      sessionEpoch: Number(row.session_epoch),
      bootId: row.current_boot_id,
    };
  }
  async view(agentId: string) {
    const row = await this.db.get<Row>(
      "SELECT id,machine_id,status,enrollment_consumed,session_epoch,current_boot_id,last_seen_at_ms FROM agents WHERE id=? AND kind='host'",
      [agentId],
    );
    if (!row) throw new ApplicationError("not_found");
    return hostAgentViewSchema.parse({
      agentId: row.id,
      machineId: row.machine_id,
      status: row.status,
      paired: row.enrollment_consumed === 1n,
      sessionEpoch: Number(row.session_epoch),
      bootId: row.current_boot_id,
      lastSeenAt:
        row.last_seen_at_ms === null
          ? null
          : new Date(Number(row.last_seen_at_ms)).toISOString(),
      protocolVersion: 1,
      offlineLeaseEnforcement: false,
    });
  }
  async snapshot(machineId: string, now: number) {
    const row = await this.db.get<Row>(
      `SELECT s.*,a.status,a.current_boot_id,a.session_epoch AS current_session_epoch,a.accepted_controller_epoch,i.controller_epoch FROM machine_snapshots s JOIN agents a ON a.id=s.agent_id JOIN installations i ON i.singleton=1 WHERE s.machine_id=?`,
      [machineId],
    );
    if (!row || row.heartbeat_json === null) return null;
    const input = hostHeartbeatSchema.parse(
      JSON.parse(String(row.heartbeat_json)),
    );
    const valid =
      row.status === "active" &&
      row.current_boot_id === row.agent_boot_id &&
      row.current_session_epoch === row.session_epoch &&
      row.accepted_controller_epoch === row.controller_epoch;
    const fresh =
      valid &&
      now >= Number(row.received_at_ms) &&
      now - Number(row.received_at_ms) <= 30_000 &&
      now - Date.parse(input.snapshot.observedAt) <= 30_000;
    return hostSnapshotViewSchema.parse({
      snapshot: input.snapshot,
      receivedAt: new Date(Number(row.received_at_ms)).toISOString(),
      fresh,
      humanPresence: fresh
        ? classifyFreshHumanPresence(
            input.snapshot,
            Number(row.received_at_ms),
            now,
            30_000,
          )
        : "unknown",
      offlineLeaseEnforcement: false,
    });
  }
}
