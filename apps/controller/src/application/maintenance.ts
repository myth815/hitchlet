import { statfs } from "node:fs/promises";
import { LocalMaintenanceStore } from "../storage/maintenance-store.js";
import { pruneHistory } from "../storage/history-retention.js";
import { StorageError } from "../storage/index.js";
import type { Storage } from "../storage/index.js";
export { admissionOpen } from "../storage/maintenance-store.js";

/** Schedules operational work through the local SQLite/filesystem adapter. */
export class MaintenanceService {
  private readonly store: LocalMaintenanceStore;
  constructor(
    private readonly db: Storage,
    dataDir: string,
    limits = { lowWaterMiB: 1024, reserveMiB: 128 },
    private readonly now = Date.now,
    space = statfs,
    retention = { dailyCopies: 7, weeklyCopies: 4 },
  ) {
    this.store = new LocalMaintenanceStore(
      db,
      dataDir,
      limits,
      now,
      space,
      retention,
    );
  }
  diagnostics() {
    return this.store.diagnostics();
  }
  health() {
    return this.store.health();
  }
  sampleDisk() {
    return this.store.sampleDisk();
  }
  noteWriteFailure() {
    return this.store.noteWriteFailure();
  }
  pause(reason: string, actor?: string, requestId?: string) {
    return this.store.pause(reason, actor, requestId);
  }
  resume(reason: string, actor?: string, requestId?: string) {
    return this.store.resume(reason, actor, requestId);
  }
  backups() {
    return this.store.backups();
  }
  async backup(key?: string, actor?: string, requestId?: string) {
    if (key) {
      const receipt = await this.store.backupReceipt(key, actor);
      if (receipt) return receipt;
    }
    const health = await this.health();
    if (health.admission.startsWith("disk_"))
      throw new StorageError(
        "STORAGE_MAINTENANCE",
        "Backup requires healthy local storage",
      );
    return this.store.backup(key, actor, requestId);
  }
  retainBackups() {
    return this.store.retainBackups();
  }
  credentials(consumerId?: string) {
    return this.store.credentials(consumerId);
  }
  rotateCredential(
    consumerId: string,
    credentialId: string,
    actor = consumerId,
    requestId?: string,
  ) {
    return this.store.rotateCredential(
      consumerId,
      credentialId,
      actor,
      requestId,
    );
  }
  async maintain() {
    const health = await this.sampleDisk();
    await pruneHistory(this.db, this.now());
    await this.retainBackups();
    const last = (await this.backups())[0];
    if (
      ["open", "paused"].includes(health.admission) &&
      (!last || this.now() - last.createdAtMs >= 86400000)
    )
      await this.backup();
  }
}
