import { SQLiteAdminCommandStore } from "../storage/admin-command-store.js";
import type { Storage } from "../storage/index.js";
/** Management recovery boundary. The store excludes one-time secret endpoints. */
export class AdminCommandJournal {
  private readonly store: SQLiteAdminCommandStore;
  constructor(db: Storage, now = Date.now) {
    this.store = new SQLiteAdminCommandStore(db, now);
  }
  prepare(...args: Parameters<SQLiteAdminCommandStore["prepare"]>) {
    return this.store.prepare(...args);
  }
  complete(...args: Parameters<SQLiteAdminCommandStore["complete"]>) {
    return this.store.complete(...args);
  }
  receipts(consumerId: string) {
    return this.store.receipts(consumerId);
  }
  review(...args: Parameters<SQLiteAdminCommandStore["review"]>) {
    return this.store.review(...args);
  }
}
