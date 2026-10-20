import type { z } from "zod";
import Database from "better-sqlite3";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  writeFile,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  RecoveryStateSchema,
  type RecoveryControlPlan,
} from "@hitchlet/contracts/internal";
import { NodeRuntimeConfigSchema } from "@hitchlet/contracts/admin";
import { openStorageForRestore, type Storage } from "./index.js";
import { LocalSecretStore } from "./secret-store.js";
/** Offline only: the destination must be empty. A fault ledger is preserved by
 * leaving its original directory untouched; the injected key is never copied. */
export async function restoreLedger(
  input: {
    backupFile: string;
    destination: string;
    encryptedSecretsDir?: string;
    masterKeyFile?: string;
    oldControllerStopped: true;
  },
  now = Date.now,
): Promise<{ adminToken: string; recoveryId: string }> {
  const destination = resolve(input.destination);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if ((await readdir(destination)).length)
    throw new Error(
      "Restore requires an empty isolated destination; preserve the fault directory separately",
    );
  await writeFile(
    join(destination, "restore-in-progress.json"),
    JSON.stringify({ admission: "closed", startedAtMs: now() }),
    { mode: 0o600, flag: "wx" },
  );
  const source = new Database(resolve(input.backupFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const check = source.pragma("integrity_check") as {
      integrity_check: string;
    }[];
    if (
      check.length !== 1 ||
      check[0]?.integrity_check !== "ok" ||
      (source.pragma("foreign_key_check") as unknown[]).length
    )
      throw new Error("Backup failed consistency checks");
    await source.backup(join(destination, "hitchlet.sqlite"));
  } finally {
    source.close();
  }
  if (input.encryptedSecretsDir) {
    if (!input.masterKeyFile)
      throw new Error(
        "Restore encrypted secrets with the separately injected master key file",
      );
    await mkdir(join(destination, "secrets"), { mode: 0o700 });
    const secrets = await LocalSecretStore.open(
      destination,
      input.masterKeyFile,
    );
    for (const file of await readdir(input.encryptedSecretsDir)) {
      if (!/^[a-f0-9]{32}\.secret$/.test(file))
        throw new Error("Secret backup contains an unexpected entry");
      const source = join(input.encryptedSecretsDir, file);
      if (
        !(await lstat(source)).isFile() ||
        (await lstat(source)).isSymbolicLink()
      )
        throw new Error("Secret backup must contain regular encrypted files");
      await copyFile(source, join(destination, "secrets", file));
      await chmod(join(destination, "secrets", file), 0o600);
      await secrets.get(`secret:${file.slice(0, 32)}`);
    }
  }

  let db: Storage;
  try {
    db = await openStorageForRestore(destination);
  } catch (error) {
    await writeFile(
      join(destination, "maintenance-state.json"),
      JSON.stringify({
        state: "migration_failed",
        admission: "closed",
        preservedLedger: true,
      }),
      { mode: 0o600 },
    );
    throw error;
  }
  try {
    await db.check();
    const time = now(),
      id = randomUUID();
    const oldConnections = await db.all<{
      connectionId: string;
      runtimeIdentityId: string;
      revisionId: string;
      secretVersionRef: string | null;
    }>(
      "SELECT c.id connectionId,c.runtime_identity_id runtimeIdentityId,r.id revisionId,r.secret_version_ref secretVersionRef FROM provider_connections c JOIN provider_connection_revisions r ON r.connection_id=c.id WHERE c.backend_kind='portainer' AND (r.endpoint_ref LIKE 'https://%' OR r.endpoint_ref LIKE 'http://%')",
    );
    const nodes = await db.all<{
      id: string;
      runtime_identity_id: string;
      config_json: string;
    }>(
      "SELECT id,runtime_identity_id,config_json FROM nodes WHERE backend_kind='portainer' AND json_extract(config_json,'$.executionMode')='portainer'",
    );
    const state = RecoveryStateSchema.parse({
      id,
      restoredAtMs: time,
      stage: "controls_required",
      oldConnectionRevisions: oldConnections,
      oldRuntimeProfiles: nodes.map((n) => ({
        nodeId: n.id,
        runtimeIdentityId: n.runtime_identity_id,
        runtimeProfile: NodeRuntimeConfigSchema.parse(
          JSON.parse(n.config_json).runtimeProfile,
        ),
      })),
      restoredAllocationIds: (
        await db.all<{ id: string }>(
          "SELECT id FROM allocations WHERE cleanup_status<>'complete'",
        )
      ).map((a) => a.id),
    });
    const admin = await db.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='admin' AND status='active' ORDER BY created_at_ms LIMIT 1",
    );
    if (!admin) throw new Error("Restored ledger has no administrator");
    const adminToken = randomBytes(32).toString("base64url");
    await db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE system_maintenance SET paused=1,recovery_json=?,transports_json='{}',reason='Restored ledger: reacquire external control and reconcile before explicit approval',version=version+1,updated_at_ms=? WHERE singleton=1",
        params: [JSON.stringify(state), time],
      },
      {
        kind: "run",
        sql: "UPDATE consumer_credentials SET revoked_at_ms=? WHERE revoked_at_ms IS NULL",
        params: [time],
      },
      {
        kind: "run",
        sql: "UPDATE gui_sessions SET revoked_at_ms=? WHERE revoked_at_ms IS NULL",
        params: [time],
      },
      {
        kind: "run",
        sql: "UPDATE agents SET status='disabled',credential_hash=?,current_boot_id=NULL,accepted_controller_epoch=0,session_epoch=session_epoch+1,enrollment_hash=NULL,enrollment_expires_at_ms=NULL,enrollment_consumed=1",
        params: [createHash("sha256").update(randomBytes(32)).digest("hex")],
      },
      { kind: "run", sql: "DELETE FROM machine_snapshots" },
      {
        kind: "run",
        sql: "UPDATE allocations SET observed_state='unknown',version=version+1 WHERE cleanup_status<>'complete'",
      },
      {
        kind: "run",
        sql: "UPDATE nodes SET admission='disabled',observed_health='unknown',version=version+1",
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state=CASE WHEN state='running' THEN 'unknown' ELSE state END,owner_token=NULL,locked_until_ms=NULL,next_check_at_ms=?,updated_at_ms=? WHERE allocation_id IS NOT NULL AND state IN('planned','running','unknown','failed')",
        params: [time, time],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET result_json=json_remove(COALESCE(result_json,'{}'),'$.integrity'),owner_token=NULL,locked_until_ms=NULL WHERE kind='allocation.provision' AND state='succeeded'",
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='cancelled',owner_token=NULL,locked_until_ms=NULL,updated_at_ms=? WHERE id IN(SELECT operation_id FROM lease_renewals WHERE state='pending')",
        params: [time],
      },
      {
        kind: "run",
        sql: "UPDATE lease_renewals SET state='cancelled',rejection_json='{\"code\":\"CONTROLLER_RESTORE\"}',version=version+1,updated_at_ms=? WHERE state='pending'",
        params: [time],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='failed',result_json='{\"code\":\"LOCAL_ACTION_INTERRUPTED_BY_RESTORE\"}',owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=? WHERE kind='system.backup' AND state IN('planned','running','unknown')",
        params: [time],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          randomUUID(),
          admin.id,
          adminToken.slice(0, 12),
          createHash("sha256").update(adminToken).digest("hex"),
          JSON.stringify([
            "tickets:read",
            "tickets:write",
            "tickets:revoke",
            "images:read",
            "events:read",
          ]),
          time,
        ],
      },
      audit("offline-restore", id, "system.restored", time, {
        oldControllerStopped: input.oldControllerStopped,
      }),
    ]);
    await unlink(join(destination, "restore-in-progress.json"));
    return { adminToken, recoveryId: id };
  } finally {
    await db.close();
  }
}

function audit(
  actor: string,
  target: string,
  action: string,
  now: number,
  details: unknown,
  requestId: string = randomUUID(),
  actorType: "controller" | "consumer" = "controller",
) {
  return {
    kind: "run" as const,
    sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES(?,?,?,'system',?,?,?,?)",
    params: [
      actorType,
      actor,
      action,
      target,
      requestId,
      now,
      JSON.stringify(details),
    ],
  };
}

export type RecoveryTransportMap = Record<
  string,
  {
    connectionRevisionId: string;
    runtimeProfile: z.infer<typeof NodeRuntimeConfigSchema>;
  }
>;
export class SQLiteRecoveryStore {
  constructor(private readonly db: Storage) {}
  context() {
    return this.db.get<{ recovery_json: string | null; version: bigint }>(
      "SELECT recovery_json,version FROM system_maintenance WHERE singleton=1",
    );
  }
  activatedRevision(revisionId: string, connectionId: string) {
    return this.db.get<{
      secret_version_ref: string | null;
      runtime_identity_id: string;
    }>(
      "SELECT r.secret_version_ref,c.runtime_identity_id FROM provider_connection_revisions r JOIN provider_connections c ON c.id=r.connection_id AND c.current_revision_id=r.id WHERE r.id=? AND c.id=?",
      [revisionId, connectionId],
    );
  }
  activeAllocations() {
    return this.db.all<{
      id: string;
      purpose: string;
      node_id: string;
      version: bigint;
      node_version: bigint;
      operation_version: bigint | null;
      lease_version: bigint | null;
      observed_state: string;
      phase: string | null;
      lease_state: string | null;
      expires_at_ms: bigint | null;
      integrity: string | null;
      controller_epoch: bigint | null;
      admission: string;
      control_version: bigint;
      operation_control: bigint | null;
    }>(
      "SELECT a.id,a.purpose,a.node_id,a.version,n.version node_version,o.version operation_version,l.version lease_version,a.observed_state,a.control_version,o.control_version operation_control,t.phase,l.state lease_state,l.expires_at_ms,json_extract(o.result_json,'$.integrity') integrity,o.controller_epoch,n.admission FROM allocations a JOIN nodes n ON n.id=a.node_id LEFT JOIN tickets t ON t.id=a.ticket_id LEFT JOIN leases l ON l.allocation_id=a.id LEFT JOIN operations o ON o.allocation_id=a.id AND o.kind='allocation.provision' WHERE a.cleanup_status<>'complete'",
    );
  }
  epoch() {
    return this.db.get<{ controller_epoch: bigint }>(
      "SELECT controller_epoch FROM installations WHERE singleton=1",
    );
  }
  nodeIsDisabled(nodeId: string) {
    return this.db.get(
      "SELECT 1 FROM nodes WHERE id=? AND admission='disabled'",
      [nodeId],
    );
  }
  async acceptControls(
    row: NonNullable<Awaited<ReturnType<SQLiteRecoveryStore["context"]>>>,
    state: z.infer<typeof RecoveryStateSchema>,
    transports: RecoveryTransportMap,
    epochFloor: number,
    quarantinedNodes: string[],
    time: number,
  ) {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE system_maintenance SET recovery_json=?,transports_json=?,version=version+1,updated_at_ms=? WHERE singleton=1 AND version=? AND recovery_json=?",
        params: [
          JSON.stringify({ ...state, stage: "reconciling", quarantinedNodes }),
          JSON.stringify(transports),
          time,
          row.version,
          row.recovery_json,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE installations SET controller_epoch=MAX(controller_epoch,?)+1 WHERE singleton=1",
        params: [epochFloor],
      },
      ...state.oldRuntimeProfiles.map((old) => ({
        kind: "run" as const,
        sql: "UPDATE nodes SET config_json=json_set(config_json,'$.runtimeProfile',json(?)),version=version+1 WHERE id=?",
        params: [
          JSON.stringify(transports[old.runtimeIdentityId]!.runtimeProfile),
          old.nodeId,
        ],
      })),
      audit("offline-takeover", state.id, "system.control_reacquired", time, {
        oldCredentialsRejected: true,
      }),
    ]);
  }
  async approve(
    row: NonNullable<Awaited<ReturnType<SQLiteRecoveryStore["context"]>>>,
    state: z.infer<typeof RecoveryStateSchema>,
    active: Awaited<ReturnType<SQLiteRecoveryStore["activeAllocations"]>>,
    actor: string,
    requestId: string,
    reason: string,
    time: number,
  ) {
    await this.db.batchTransaction([
      ...active.map((a) => ({
        kind: "run" as const,
        sql: "UPDATE allocations SET version=version WHERE id=? AND version=? AND control_version=? AND observed_state=? AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=allocations.node_id AND n.version=?) AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.allocation_id=allocations.id AND o.kind='allocation.provision')) OR EXISTS(SELECT 1 FROM operations o WHERE o.allocation_id=allocations.id AND o.kind='allocation.provision' AND o.version=?)) AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM leases l WHERE l.allocation_id=allocations.id)) OR EXISTS(SELECT 1 FROM leases l WHERE l.allocation_id=allocations.id AND l.version=?))",
        params: [
          a.id,
          a.version,
          a.control_version,
          a.observed_state,
          a.node_version,
          a.operation_version,
          a.operation_version,
          a.lease_version,
          a.lease_version,
        ],
        expectChanges: 1,
      })),
      {
        kind: "run",
        sql: "UPDATE capacity_claims SET state='quarantined',version=version+1,updated_at_ms=? WHERE state<>'released' AND allocation_id IN(SELECT id FROM allocations WHERE observed_state='unknown' AND cleanup_status<>'complete')",
        params: [time],
      },
      ...state.quarantinedNodes.map((nodeId) => ({
        kind: "run" as const,
        sql: "UPDATE nodes SET admission='disabled' WHERE id=? AND admission='disabled'",
        params: [nodeId],
        expectChanges: 1,
      })),
      {
        kind: "run",
        sql: "UPDATE system_maintenance SET recovery_json=NULL,reason=?,version=version+1,updated_at_ms=? WHERE singleton=1 AND version=?",
        params: [reason, time, row.version],
        expectChanges: 1,
      },
      audit(
        actor,
        state.id,
        "system.recovery_approved",
        time,
        { reason },
        requestId,
        "consumer",
      ),
    ]);
  }
}
