import type { Storage } from "./index.js";
type Row = Record<string, string | number | bigint | null>;

/** Minimal identity persistence boundary for bearer and browser credentials. */
export class SQLiteIdentityStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async bearer(prefix: string, hash: string): Promise<Row | undefined> {
    const row = await this.db.get<Row>(
      `SELECT cc.id,cc.consumer_id,cc.scopes_json,c.role,c.status FROM consumer_credentials cc
      JOIN consumers c ON c.id=cc.consumer_id WHERE cc.token_prefix=? AND cc.token_hash=? AND cc.revoked_at_ms IS NULL
      AND (cc.expires_at_ms IS NULL OR cc.expires_at_ms>?)`,
      [prefix, hash, this.now()],
    );
    if (row)
      await this.db.run(
        "UPDATE consumer_credentials SET last_used_at_ms=? WHERE id=?",
        [this.now(), String(row.id)],
      );
    return row;
  }
  session(tokenHash: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      `SELECT s.id,s.consumer_id,s.csrf_token_hash,c.role,c.status FROM gui_sessions s JOIN consumers c ON c.id=s.consumer_id
      JOIN consumer_credentials cc ON cc.id=s.source_credential_id AND cc.consumer_id=s.consumer_id AND cc.revoked_at_ms IS NULL
      AND (cc.expires_at_ms IS NULL OR cc.expires_at_ms>?)
      WHERE s.token_hash=? AND s.revoked_at_ms IS NULL AND s.expires_at_ms>?`,
      [this.now(), tokenHash, this.now()],
    );
  }
  createSession(input: {
    id: string;
    consumerId: string;
    sourceCredentialId: string;
    tokenHash: string;
    csrfHash: string;
    now: number;
    expires: number;
  }) {
    return this.db.run(
      "INSERT INTO gui_sessions(id,consumer_id,token_hash,csrf_token_hash,created_at_ms,expires_at_ms,source_credential_id) VALUES(?,?,?,?,?,?,?)",
      [
        input.id,
        input.consumerId,
        input.tokenHash,
        input.csrfHash,
        input.now,
        input.expires,
        input.sourceCredentialId,
      ],
    );
  }
  revokeSession(tokenHash: string, now: number) {
    return this.db.run(
      "UPDATE gui_sessions SET revoked_at_ms=? WHERE token_hash=? AND revoked_at_ms IS NULL",
      [now, tokenHash],
    );
  }
}
