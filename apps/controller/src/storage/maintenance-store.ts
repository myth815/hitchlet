import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  open,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  DiagnosticsSchema,
  CredentialListSchema,
  BackupViewSchema,
  SystemHealthSchema,
  type BackupView,
} from "@hitchlet/contracts/admin";
import type { Storage } from "./index.js";
import { pruneHistory } from "./history-retention.js";

export async function admissionOpen(
  db: Storage,
  nodeId?: string,
  now = Date.now(),
): Promise<boolean> {
  if (db.writeFailure?.()) return false;
  const row = await db.get<{ open: bigint }>(
    "SELECT (paused=0 AND disk_state='healthy' AND recovery_json IS NULL) AS open FROM system_maintenance WHERE singleton=1",
  );
  if (row?.open !== 1n) return false;
  if (nodeId) {
    const node = await db.get<{ config_json: string }>(
      "SELECT config_json FROM nodes WHERE id=? AND admission='enabled'",
      [nodeId],
    );
    if (!node) return false;
    const facts = await db.get<{ runtime_disks_json: string }>(
      "SELECT runtime_disks_json FROM system_maintenance WHERE singleton=1",
    );
    const disk = facts
      ? JSON.parse(facts.runtime_disks_json)[nodeId]
      : undefined;
    if (
      (JSON.parse(node.config_json).executionMode === "portainer" && !disk) ||
      (disk &&
        (disk.state !== "healthy" ||
          disk.observedAtMs > now ||
          disk.observedAtMs + 30000 < now))
    )
      return false;
  }
  return true;
}

/** Operational state gates new work only. Cleanup and accepted lease handling keep their existing paths. */
export class LocalMaintenanceStore {
  private readonly activeBackups = new Map<string, Promise<BackupView>>();
  constructor(
    private readonly db: Storage,
    private readonly dataDir: string,
    private readonly limits = { lowWaterMiB: 1024, reserveMiB: 128 },
    private readonly now = Date.now,
    private readonly space = statfs,
    private readonly retention = { dailyCopies: 7, weeklyCopies: 4 },
  ) {}
  async sampleDisk() {
    const observedAtMs = this.now();
    let availableMiB: number | null = null;
    try {
      const facts = await this.space(this.dataDir);
      availableMiB = Math.floor(
        (Number(facts.bavail) * Number(facts.bsize)) / 1048576,
      );
      if (!Number.isSafeInteger(availableMiB) || availableMiB < 0)
        availableMiB = null;
    } catch {}
    const state =
      availableMiB === null
        ? "unknown"
        : availableMiB <= this.limits.reserveMiB
          ? "full"
          : availableMiB <= this.limits.lowWaterMiB
            ? "low"
            : "healthy";
    if (state !== "healthy")
      for (const file of await readdir(join(this.dataDir, "logs")).catch(
        () => [],
      ))
        if (/^controller\.log\.\d+$/.test(file))
          await unlink(join(this.dataDir, "logs", file)).catch(() => undefined);
    await this.db.run(
      "UPDATE system_maintenance SET disk_state=?,disk_json=?,version=version+1,updated_at_ms=? WHERE singleton=1",
      [
        state,
        JSON.stringify({ availableMiB, ...this.limits, observedAtMs }),
        observedAtMs,
      ],
    );
    if (state === "healthy") this.db.clearWriteFailure?.();
    return this.health();
  }
  async noteWriteFailure() {
    await this.db
      .run(
        "UPDATE system_maintenance SET disk_state='full',reason='SQLite write failed; new work requires a successful disk probe',version=version+1,updated_at_ms=? WHERE singleton=1",
        [this.now()],
      )
      .catch(() => undefined);
  }
  async health() {
    const row = await this.db.get<{
      paused: bigint;
      disk_state: string;
      disk_json: string;
      recovery_json: string | null;
      reason: string;
      version: bigint;
      runtime_disks_json: string;
    }>("SELECT * FROM system_maintenance WHERE singleton=1");
    if (!row) throw new Error("Maintenance state unavailable");
    return SystemHealthSchema.parse({
      admission: this.db.writeFailure?.()
        ? "disk_full"
        : row.recovery_json
          ? "recovery_required"
          : row.disk_state !== "healthy"
            ? `disk_${row.disk_state}`
            : row.paused === 1n
              ? "paused"
              : "open",
      reason: row.reason,
      version: Number(row.version),
      disk:
        row.disk_json === "{}"
          ? { availableMiB: null, ...this.limits, observedAtMs: 0 }
          : JSON.parse(row.disk_json),
      runtimeDisks: Object.values(JSON.parse(row.runtime_disks_json)),
      recovery: row.recovery_json
        ? (() => {
            const recovery = JSON.parse(row.recovery_json!);
            return {
              id: recovery.id,
              stage: recovery.stage,
              restoredAtMs: recovery.restoredAtMs,
              quarantinedNodeIds: recovery.quarantinedNodes ?? [],
            };
          })()
        : null,
      recoveryRequired: !!row.recovery_json,
      offlineLeaseEnforcement: "unsupported",
    });
  }
  async pause(
    reason: string,
    actor = "controller",
    requestId: string = randomUUID(),
  ) {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE system_maintenance SET paused=1,reason=?,version=version+1,updated_at_ms=? WHERE singleton=1",
        params: [reason, this.now()],
      },
      this.admissionAudit("paused", reason, actor, requestId),
    ]);
    return this.health();
  }
  async resume(
    reason: string,
    actor = "controller",
    requestId: string = randomUUID(),
  ) {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE system_maintenance SET paused=0,reason=?,version=version+1,updated_at_ms=? WHERE singleton=1 AND recovery_json IS NULL AND disk_state='healthy'",
        params: [reason, this.now()],
        expectChanges: 1,
      },
      this.admissionAudit("resumed", reason, actor, requestId),
    ]);
    return this.health();
  }
  private admissionAudit(
    action: string,
    reason: string,
    actor: string,
    requestId: string,
  ) {
    return {
      kind: "run" as const,
      sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,?,'system','admission',?,?,?)",
      params: [
        actor,
        `admission.${action}`,
        requestId,
        this.now(),
        JSON.stringify({ reason }),
      ],
    };
  }
  async backups(): Promise<BackupView[]> {
    const root = join(this.dataDir, "backups");
    const result: BackupView[] = [];
    for (const file of await backupFiles(root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      try {
        const item = BackupViewSchema.parse(
          JSON.parse(await readFile(join(root, file), "utf8")),
        );
        const info = await stat(join(root, `${item.id}.sqlite`));
        if (info.isFile() && info.size === item.sizeBytes) result.push(item);
      } catch {}
    }
    return result.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
  /** Read-only replay precedes the disk gate; an accepted receipt is not new work. */
  async backupReceipt(
    key: string,
    actor = "controller",
  ): Promise<BackupView | undefined> {
    const id = backupId(key, actor),
      row = await this.db.get<{ state: string; result_json: string | null }>(
        "SELECT state,result_json FROM operations WHERE id=? AND kind='system.backup'",
        [id],
      );
    if (row?.state === "succeeded" && row.result_json)
      return BackupViewSchema.parse(JSON.parse(row.result_json));
    return (await this.backups()).find((view) => view.id === id);
  }
  backup(
    key?: string,
    actor = "controller",
    requestId: string = randomUUID(),
  ): Promise<BackupView> {
    const id = backupId(key, actor);
    const current = this.activeBackups.get(id);
    if (current) return current;
    const pending = this.createBackup(id, actor, requestId).finally(() =>
      this.activeBackups.delete(id),
    );
    this.activeBackups.set(id, pending);
    return pending;
  }
  private async createBackup(
    id: string,
    actor: string,
    requestId: string,
  ): Promise<BackupView> {
    const previous = await this.db.get<{
      state: string;
      result_json: string | null;
    }>(
      "SELECT state,result_json FROM operations WHERE id=? AND kind='system.backup'",
      [id],
    );
    if (previous?.state === "succeeded" && previous.result_json)
      return BackupViewSchema.parse(JSON.parse(previous.result_json));
    if (previous?.state === "failed")
      throw new Error(
        "The original backup failed; use a new request key to request another backup",
      );
    const createdAtMs = this.now(),
      root = join(this.dataDir, "backups");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const installation = await this.db.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation) throw new Error("Installation missing");
    await this.db.run(
      "INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,'system.backup',?,?,'running',?,'{}',?,?,?) ON CONFLICT(id) DO NOTHING",
      [
        id,
        installation.installation_id,
        installation.controller_epoch,
        id,
        `backup:${id}`,
        createHash("sha256").update(id).digest("hex"),
        createdAtMs,
        createdAtMs,
        createdAtMs,
      ],
    );
    const temporary = join(root, `${id}.partial`),
      destination = join(root, `${id}.sqlite`);
    // A crash after durable metadata but before the SQLite receipt must replay
    // the already verified file, rather than overwrite it or fail on EEXIST.
    const completed = (await this.backups()).find((view) => view.id === id);
    if (completed) {
      await this.db.run(
        "UPDATE operations SET state='succeeded',result_json=?,updated_at_ms=? WHERE id=?",
        [JSON.stringify(completed), this.now(), id],
      );
      return completed;
    }

    try {
      await this.db.backup(temporary);
      await chmod(temporary, 0o600);
      const file = await open(temporary, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const view = BackupViewSchema.parse({
        id,
        createdAtMs,
        sizeBytes: (await stat(destination)).size,
        verified: true,
      });
      await writeFile(join(root, `${id}.json`), JSON.stringify(view), {
        mode: 0o600,
        flag: "wx",
      });
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: "UPDATE operations SET state='succeeded',result_json=?,updated_at_ms=? WHERE id=?",
          params: [JSON.stringify(view), this.now(), id],
        },
        {
          kind: "run",
          sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('controller',?,'system.backup','operation',?,?,?,'{}')",
          params: [actor, id, requestId, this.now()],
        },
      ]);
      await this.retainBackups();
      return view;
    } catch (error) {
      await this.db
        .run(
          "UPDATE operations SET state='failed',result_json='{" +
            '"code":"BACKUP_FAILED"' +
            "}',updated_at_ms=? WHERE id=?",
          [this.now(), id],
        )
        .catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  async retainBackups() {
    // Seven daily buckets and four additional weekly buckets. Failed/partial files never count as backups.
    const items = await this.backups(),
      keep = new Set<string>(),
      days = new Set<number>(),
      weeks = new Set<number>();
    for (const item of items) {
      const day = Math.floor(item.createdAtMs / 86400000);
      if (!days.has(day) && days.size < this.retention.dailyCopies) {
        days.add(day);
        keep.add(item.id);
      }
    }
    for (const item of items) {
      const week = Math.floor(item.createdAtMs / (7 * 86400000));
      if (!weeks.has(week) && weeks.size < this.retention.weeklyCopies) {
        weeks.add(week);
        keep.add(item.id);
      }
    }
    for (const item of items)
      if (!keep.has(item.id)) {
        await unlink(join(this.dataDir, "backups", `${item.id}.sqlite`));
        await unlink(join(this.dataDir, "backups", `${item.id}.json`));
      }
    // Pre-migration snapshots have no operation in the old schema. Their fixed
    // worker-generated names carry creation time and receive the same bounded
    // day/week policy; unrelated files are never touched.
    const upgrades = (await backupFiles(join(this.dataDir, "backups")))
      .flatMap((file) => {
        const match = /^upgrade-(\d+)-v\d+\.sqlite$/.exec(file);
        return match ? [{ file, time: Number(match[1]) }] : [];
      })
      .sort((a, b) => b.time - a.time);
    const upgradeKeep = new Set<string>(),
      upgradeDays = new Set<number>(),
      upgradeWeeks = new Set<number>();
    for (const item of upgrades) {
      const day = Math.floor(item.time / 86400000);
      if (
        !upgradeDays.has(day) &&
        upgradeDays.size < this.retention.dailyCopies
      ) {
        upgradeDays.add(day);
        upgradeKeep.add(item.file);
      }
    }
    for (const item of upgrades) {
      const week = Math.floor(item.time / (7 * 86400000));
      if (
        !upgradeWeeks.has(week) &&
        upgradeWeeks.size < this.retention.weeklyCopies
      ) {
        upgradeWeeks.add(week);
        upgradeKeep.add(item.file);
      }
    }
    for (const item of upgrades)
      if (!upgradeKeep.has(item.file))
        await unlink(join(this.dataDir, "backups", item.file));
  }
  async diagnostics() {
    const row = await this.db.get<{
      schema_version: bigint;
      pending: bigint;
      cleanup: bigint;
    }>(
      "SELECT (SELECT max(version) FROM schema_migrations) schema_version,(SELECT count(*) FROM operations WHERE state IN('planned','running','unknown')) pending,(SELECT count(*) FROM allocations WHERE cleanup_status<>'complete') cleanup",
    );
    return DiagnosticsSchema.parse({
      generatedAtMs: this.now(),
      health: await this.health(),
      schemaVersion: Number(row?.schema_version),
      pendingOperations: Number(row?.pending),
      cleanupBacklog: Number(row?.cleanup),
      latestBackup: (await this.backups())[0] ?? null,
    });
  }
  async credentials(consumerId?: string) {
    const rows = await this.db.all<{
      id: string;
      consumer_id: string;
      name: string;
      token_prefix: string;
      created_at_ms: bigint;
      expires_at_ms: bigint | null;
      last_used_at_ms: bigint | null;
      revoked_at_ms: bigint | null;
    }>(
      "SELECT cc.id,cc.consumer_id,c.name,cc.token_prefix,cc.created_at_ms,cc.expires_at_ms,cc.last_used_at_ms,cc.revoked_at_ms FROM consumer_credentials cc JOIN consumers c ON c.id=cc.consumer_id WHERE (? IS NULL OR cc.consumer_id=?) ORDER BY cc.created_at_ms DESC,cc.id LIMIT 200",
      [consumerId ?? null, consumerId ?? null],
    );
    return CredentialListSchema.parse(
      rows.map((r) => ({
        credentialId: r.id,
        consumerId: r.consumer_id,
        consumerName: r.name,
        tokenPrefix: r.token_prefix,
        status:
          r.revoked_at_ms !== null
            ? "revoked"
            : r.expires_at_ms !== null && Number(r.expires_at_ms) <= this.now()
              ? "expired"
              : "active",
        createdAtMs: Number(r.created_at_ms),
        expiresAtMs: r.expires_at_ms === null ? null : Number(r.expires_at_ms),
        lastUsedAtMs:
          r.last_used_at_ms === null ? null : Number(r.last_used_at_ms),
      })),
    );
  }
  async rotateCredential(
    consumerId: string,
    credentialId: string,
    actor = consumerId,
    requestId: string = randomUUID(),
  ) {
    const existing = await this.db.get<{ scopes_json: string }>(
      "SELECT cc.scopes_json FROM consumer_credentials cc JOIN consumers c ON c.id=cc.consumer_id WHERE cc.id=? AND cc.consumer_id=? AND c.status='active'",
      [credentialId, consumerId],
    );
    if (!existing) throw new RangeError("Current credential not found");
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID(),
      now = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE consumer_credentials SET revoked_at_ms=COALESCE(revoked_at_ms,?) WHERE id=? AND consumer_id=? AND (revoked_at_ms IS NULL OR NOT EXISTS(SELECT 1 FROM consumer_credentials active WHERE active.consumer_id=consumer_credentials.consumer_id AND active.revoked_at_ms IS NULL AND (active.expires_at_ms IS NULL OR active.expires_at_ms>?)))",
        params: [now, credentialId, consumerId, now],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE gui_sessions SET revoked_at_ms=? WHERE source_credential_id=? AND revoked_at_ms IS NULL",
        params: [now, credentialId],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          id,
          consumerId,
          token.slice(0, 12),
          createHash("sha256").update(token).digest("hex"),
          existing.scopes_json,
          now,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'credential.rotated','consumer',?,?,?,?)",
        params: [
          actor,
          consumerId,
          requestId,
          now,
          JSON.stringify({
            oldCredentialId: credentialId,
            newCredentialId: id,
          }),
        ],
      },
    ]);
    return { credentialId: id, token, consumerId };
  }
}

function backupId(key: string | undefined, actor: string) {
  const raw = key
    ? createHash("sha256").update(`backup:${actor}:${key}`).digest("hex")
    : randomUUID().replaceAll("-", "");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

/** Listing/replay must remain read-only even before the first backup directory exists. */
async function backupFiles(root: string) {
  try {
    return await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
