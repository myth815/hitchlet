import { randomUUID } from "node:crypto";
import type { Storage } from "./index.js";
import { StorageError } from "./index.js";
import {
  integer,
  nullableString,
  parseJson,
  validateNetworkProfile,
  type Row,
} from "./admin-store-utils.js";

export class SQLiteProfileStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async listProfiles(kind: "network" | "storage") {
    const rows =
      kind === "network"
        ? await this.db.all<Row>(
            "SELECT p.id,p.name,p.status,p.current_revision_id,p.version,r.revision,r.policy_json AS config_json,r.created_at_ms FROM network_profiles p LEFT JOIN network_profile_revisions r ON r.id=p.current_revision_id ORDER BY p.name",
          )
        : await this.db.all<Row>(
            "SELECT p.id,p.name,p.status,p.current_revision_id,p.version,r.revision,r.kind,r.config_json,r.secret_version_ref,r.created_at_ms FROM storage_profiles p LEFT JOIN storage_profile_revisions r ON r.id=p.current_revision_id ORDER BY p.name",
          );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind,
      status: String(r.status),
      currentRevisionId: nullableString(r.current_revision_id),
      version: integer(r.version),
      revision: r.revision === null ? null : integer(r.revision),
      protocol: nullableString(r.kind),
      config: r.config_json === null ? null : parseJson(String(r.config_json)),
      secretVersionRef: nullableString(r.secret_version_ref),
      createdAtMs: r.created_at_ms === null ? null : integer(r.created_at_ms),
    }));
  }
  async createProfile(
    kind: "network" | "storage",
    input: {
      id?: string;
      name: string;
      config: unknown;
      protocol?: "local" | "nfs" | "smb";
      secretVersionRef?: string | null;
      authorizedConsumerIds: readonly string[];
    },
  ) {
    const id = input.id ?? randomUUID(),
      revisionId = randomUUID(),
      time = this.now();
    const config = JSON.stringify(input.config);
    if (
      !input.name.trim() ||
      !input.config ||
      typeof input.config !== "object" ||
      Array.isArray(input.config)
    )
      throw new RangeError("Profile policy/config must be a structured object");
    if (kind === "network") validateNetworkProfile(input.config);
    const storageConfig = input.config as Record<string, unknown>;
    if (
      kind === "storage" &&
      (!input.protocol ||
        typeof storageConfig.sourceRef !== "string" ||
        !storageConfig.sourceRef.trim() ||
        !Array.isArray(storageConfig.allowedSubpaths) ||
        storageConfig.allowedSubpaths.length === 0 ||
        !Array.isArray(storageConfig.allowedModes) ||
        storageConfig.allowedModes.length === 0 ||
        storageConfig.allowedModes.some(
          (mode) => mode !== "read_only" && mode !== "read_write",
        ))
    )
      throw new RangeError(
        "Storage source, allowed subpaths, and allowed modes are required",
      );
    if (
      input.secretVersionRef != null &&
      !/^secret:[a-f0-9]{32}$/.test(input.secretVersionRef)
    )
      throw new RangeError(
        "Storage profile must reference a fixed secret version",
      );
    const table = kind === "network" ? "network_profiles" : "storage_profiles",
      revisions =
        kind === "network"
          ? "network_profile_revisions"
          : "storage_profile_revisions";
    const statements: import("../storage/protocol.js").Statement[] = [
      {
        kind: "run",
        sql: `INSERT INTO ${table}(id,name,created_at_ms) VALUES(?,?,?)`,
        params: [id, input.name, time],
      },
      {
        kind: "run",
        sql:
          kind === "network"
            ? `INSERT INTO ${revisions}(id,profile_id,revision,policy_json,created_at_ms) VALUES(?,?,1,?,?)`
            : `INSERT INTO ${revisions}(id,profile_id,revision,kind,config_json,secret_version_ref,created_at_ms) VALUES(?,?,1,?,?,?,?)`,
        params:
          kind === "network"
            ? [revisionId, id, config, time]
            : [
                revisionId,
                id,
                input.protocol!,
                config,
                input.secretVersionRef ?? null,
                time,
              ],
      },
      {
        kind: "run",
        sql: `UPDATE ${table} SET current_revision_id=? WHERE id=? AND current_revision_id IS NULL`,
        params: [revisionId, id],
        expectChanges: 1,
      },
    ];
    for (const consumerId of new Set(input.authorizedConsumerIds)) {
      const row = await this.db.get<Row>(
        "SELECT authorization_json,version FROM consumers WHERE id=? AND status='active'",
        [consumerId],
      );
      if (!row) throw new RangeError("Authorized consumer not found");
      const auth = parseJson(String(row.authorization_json)),
        key = kind === "network" ? "networkProfileIds" : "storageProfileIds";
      const ids = Array.isArray(auth[key])
        ? auth[key].filter((v): v is string => typeof v === "string")
        : [];
      if (auth[key] !== "all") {
        auth[key] = [...new Set([...ids, id])];
        statements.push({
          kind: "run",
          sql: "UPDATE consumers SET authorization_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?",
          params: [JSON.stringify(auth), time, consumerId, Number(row.version)],
          expectChanges: 1,
        });
      }
    }
    await this.db.batchTransaction(statements);
    return { id, revisionId, revision: 1, version: 1 };
  }
  async newProfileRevision(
    kind: "network" | "storage",
    id: string,
    expectedVersion: number,
    input: {
      config: unknown;
      protocol?: "local" | "nfs" | "smb";
      secretVersionRef?: string | null;
    },
  ) {
    const table = kind === "network" ? "network_profiles" : "storage_profiles",
      revisions =
        kind === "network"
          ? "network_profile_revisions"
          : "storage_profile_revisions";
    const profile = await this.db.get<Row>(
      `SELECT version,current_revision_id FROM ${table} WHERE id=?`,
      [id],
    );
    if (!profile) throw new RangeError("Profile not found");
    if (Number(profile.version) !== expectedVersion)
      throw new StorageError("STORAGE_CAS_FAILED", "Profile version conflict");
    if (
      !input.config ||
      typeof input.config !== "object" ||
      Array.isArray(input.config) ||
      (kind === "network" && Object.keys(input.config as object).length === 0)
    )
      throw new RangeError("Invalid profile policy/config");
    const storageConfig = input.config as Record<string, unknown>;
    if (kind === "network") validateNetworkProfile(input.config);
    if (
      kind === "storage" &&
      (!input.protocol ||
        typeof storageConfig.sourceRef !== "string" ||
        !storageConfig.sourceRef.trim() ||
        !Array.isArray(storageConfig.allowedSubpaths) ||
        storageConfig.allowedSubpaths.length === 0 ||
        !Array.isArray(storageConfig.allowedModes) ||
        storageConfig.allowedModes.length === 0 ||
        storageConfig.allowedModes.some(
          (mode) => mode !== "read_only" && mode !== "read_write",
        ))
    )
      throw new RangeError(
        "Storage source, allowed subpaths, and allowed modes are required",
      );
    if (
      input.secretVersionRef != null &&
      !/^secret:[a-f0-9]{32}$/.test(input.secretVersionRef)
    )
      throw new RangeError(
        "Storage profile must reference a fixed secret version",
      );
    const revision = await this.db.get<Row>(
      `SELECT max(revision) AS revision FROM ${revisions} WHERE profile_id=?`,
      [id],
    );
    const next = Number(revision?.revision ?? 0) + 1,
      revisionId = randomUUID(),
      time = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql:
          kind === "network"
            ? `INSERT INTO ${revisions}(id,profile_id,revision,policy_json,created_at_ms) VALUES(?,?,?,?,?)`
            : `INSERT INTO ${revisions}(id,profile_id,revision,kind,config_json,secret_version_ref,created_at_ms) VALUES(?,?,?,?,?,?,?)`,
        params:
          kind === "network"
            ? [revisionId, id, next, JSON.stringify(input.config), time]
            : [
                revisionId,
                id,
                next,
                input.protocol!,
                JSON.stringify(input.config),
                input.secretVersionRef ?? null,
                time,
              ],
      },
      {
        kind: "run",
        sql: `UPDATE ${table} SET current_revision_id=?,version=version+1 WHERE id=? AND version=?`,
        params: [revisionId, id, expectedVersion],
        expectChanges: 1,
      },
    ]);
    return { id, revisionId, revision: next, version: expectedVersion + 1 };
  }
}
