import { randomUUID } from "node:crypto";
import type { Storage } from "./index.js";

export type ImageCacheOperationKind = "image-cache.pull" | "image-cache.evict";
export type ImageCacheDiagnostic =
  | "runtime_identity_mismatch"
  | "connection_revision_unavailable"
  | "capacity_unverified"
  | "artifact_verification_failed"
  | "engine_unavailable"
  | "image_in_use"
  | "cache_referenced"
  | "operation_superseded"
  | "provider_error";

export type ImageCacheOperationReceipt = Readonly<{
  operationId: string;
  nodeId: string;
  artifactId: string;
  kind: ImageCacheOperationKind;
  state:
    | "planned"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown"
    | "cancelled";
  attemptCount: number;
  nextCheckAtMs: number;
  cache: Readonly<{
    desiredState: "present" | "absent";
    observedState:
      | "missing"
      | "pulling"
      | "ready"
      | "invalid"
      | "evicting"
      | "unknown";
    localRef: string | null;
    sizeMiB: number | null;
    digestVerifiedAtMs: number | null;
    pinnedUntilMs: number | null;
  }> | null;
  diagnostic: ImageCacheDiagnostic | null;
}>;

export type ClaimedImageCacheOperation = Readonly<{
  operationId: string;
  nodeId: string;
  artifactId: string;
  kind: ImageCacheOperationKind;
  ownerToken: string;
  version: number;
  attemptCount: number;
  controllerEpoch: number;
  runtimeIdentityId: string;
  nativeEngineId: string;
  connectionRevisionId: string;
  endpointRef: string;
  providerEndpointId: string;
  secretVersionRef: string | null;
  connectionConfig: Readonly<Record<string, unknown>>;
  artifactRef: string;
  digest: string;
  architecture: "amd64" | "arm64";
  sizeMiB: number | null;
  deleteAttempted: boolean;
  deleteConfirmed: boolean;
  deleteImageId: string | null;
}>;

const DIAGNOSTICS = new Set<ImageCacheDiagnostic>([
  "runtime_identity_mismatch",
  "connection_revision_unavailable",
  "capacity_unverified",
  "artifact_verification_failed",
  "engine_unavailable",
  "image_in_use",
  "cache_referenced",
  "operation_superseded",
  "provider_error",
]);

function safeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new RangeError("Unsafe cache operation integer");
  return number;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : safeInteger(value);
}

function diagnostic(value: unknown): ImageCacheDiagnostic | null {
  if (typeof value !== "string") return null;
  return DIAGNOSTICS.has(value as ImageCacheDiagnostic)
    ? (value as ImageCacheDiagnostic)
    : null;
}

/** Durable, narrow SQL boundary for image-cache operations and their receipts. */
export class SQLiteImageCacheStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
    private readonly leaseMs = 360_000,
  ) {}

  async operationReceipt(
    nodeId: string,
    operationId: string,
  ): Promise<ImageCacheOperationReceipt | undefined> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT o.id,o.node_id,o.image_artifact_id,o.kind,o.state,o.attempt_count,o.next_check_at_ms,
              json_extract(o.result_json,'$.diagnostic') AS diagnostic,
              c.desired_state,c.observed_state,c.local_ref,c.size_mib,c.digest_verified_at_ms,c.pinned_until_ms
       FROM operations o LEFT JOIN image_caches c
         ON c.node_id=o.node_id AND c.image_artifact_id=o.image_artifact_id
       WHERE o.id=? AND o.node_id=? AND o.kind IN ('image-cache.pull','image-cache.evict')`,
      [operationId, nodeId],
    );
    if (!row) return undefined;
    const kind = String(row.kind);
    if (kind !== "image-cache.pull" && kind !== "image-cache.evict")
      return undefined;
    const observed = row.observed_state;
    return {
      operationId: String(row.id),
      nodeId: String(row.node_id),
      artifactId: String(row.image_artifact_id),
      kind,
      state: String(row.state) as ImageCacheOperationReceipt["state"],
      attemptCount: safeInteger(row.attempt_count),
      nextCheckAtMs: safeInteger(row.next_check_at_ms),
      cache:
        row.desired_state === null || row.desired_state === undefined
          ? null
          : {
              desiredState: String(row.desired_state) as "present" | "absent",
              observedState: String(
                observed,
              ) as ImageCacheOperationReceipt["cache"] extends infer C
                ? C extends { observedState: infer S }
                  ? S
                  : never
                : never,
              localRef:
                typeof row.local_ref === "string" ? row.local_ref : null,
              sizeMiB: nullableInteger(row.size_mib),
              digestVerifiedAtMs: nullableInteger(row.digest_verified_at_ms),
              pinnedUntilMs: nullableInteger(row.pinned_until_ms),
            },
      diagnostic: diagnostic(row.diagnostic),
    };
  }

  async claimDue(limit = 16): Promise<readonly ClaimedImageCacheOperation[]> {
    const now = this.now();
    const due = await this.db.all<Record<string, unknown>>(
      `SELECT o.id FROM operations o
       WHERE o.kind IN ('image-cache.pull','image-cache.evict')
         AND ((o.state IN ('planned','unknown') AND o.next_check_at_ms<=?)
           OR (o.state='running' AND o.locked_until_ms<=?))
         AND o.controller_epoch<=(SELECT controller_epoch FROM installations WHERE singleton=1)
       ORDER BY o.next_check_at_ms,o.created_at_ms,o.id LIMIT ?`,
      [now, now, Math.max(1, Math.min(limit, 64))],
    );
    const claimed: ClaimedImageCacheOperation[] = [];
    for (const candidate of due) {
      const ownerToken = randomUUID();
      const result = await this.db.run(
        `UPDATE operations SET state='running',owner_token=?,locked_until_ms=?,attempt_count=attempt_count+1,
              controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1),
              version=version+1,updated_at_ms=?
         WHERE id=? AND kind IN ('image-cache.pull','image-cache.evict')
           AND controller_epoch<=(SELECT controller_epoch FROM installations WHERE singleton=1)
           AND ((state IN ('planned','unknown') AND next_check_at_ms<=?)
             OR (state='running' AND locked_until_ms<=?))`,
        [ownerToken, now + this.leaseMs, now, String(candidate.id), now, now],
      );
      if (result.changes !== 1n) continue;
      const row = await this.db.get<Record<string, unknown>>(
        `SELECT o.id,o.node_id,o.image_artifact_id,o.kind,o.owner_token,o.version,o.attempt_count,o.controller_epoch,
                o.runtime_identity_id,o.connection_revision_id,ri.native_id,
                r.endpoint_ref,r.provider_endpoint_id,r.secret_version_ref,r.config_json,
                a.artifact_ref,a.content_digest,a.architecture,c.size_mib,
                COALESCE(json_extract(o.result_json,'$.deleteAttempted'),0) AS delete_attempted,
                COALESCE(json_extract(o.result_json,'$.deleteConfirmed'),0) AS delete_confirmed,
                json_extract(o.result_json,'$.deleteImageId') AS delete_image_id
         FROM operations o
         JOIN runtime_identities ri ON ri.id=o.runtime_identity_id AND ri.backend_kind='portainer'
         JOIN provider_connection_revisions r ON r.id=o.connection_revision_id
           AND r.verified_runtime_identity_id=o.runtime_identity_id
         JOIN image_artifacts a ON a.id=o.image_artifact_id AND a.backend_kind='portainer'
         LEFT JOIN image_caches c ON c.node_id=o.node_id AND c.image_artifact_id=o.image_artifact_id
         WHERE o.id=? AND o.state='running' AND o.owner_token=? AND o.controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)`,
        [String(candidate.id), ownerToken],
      );
      if (!row) {
        await this.finish(
          String(candidate.id),
          ownerToken,
          "unknown",
          "connection_revision_unavailable",
        );
        continue;
      }
      try {
        const config: unknown = JSON.parse(String(row.config_json));
        if (!config || typeof config !== "object" || Array.isArray(config))
          throw new Error();
        const architecture = String(row.architecture);
        if (architecture !== "amd64" && architecture !== "arm64")
          throw new Error();
        claimed.push({
          operationId: String(row.id),
          nodeId: String(row.node_id),
          artifactId: String(row.image_artifact_id),
          kind: String(row.kind) as ImageCacheOperationKind,
          ownerToken,
          version: safeInteger(row.version),
          attemptCount: safeInteger(row.attempt_count),
          controllerEpoch: safeInteger(row.controller_epoch),
          runtimeIdentityId: String(row.runtime_identity_id),
          nativeEngineId: String(row.native_id),
          connectionRevisionId: String(row.connection_revision_id),
          endpointRef: String(row.endpoint_ref),
          providerEndpointId: String(row.provider_endpoint_id),
          secretVersionRef:
            typeof row.secret_version_ref === "string"
              ? row.secret_version_ref
              : null,
          connectionConfig: config as Record<string, unknown>,
          artifactRef: String(row.artifact_ref),
          digest: String(row.content_digest),
          architecture,
          sizeMiB: nullableInteger(row.size_mib),
          deleteAttempted: Number(row.delete_attempted) === 1,
          deleteConfirmed: Number(row.delete_confirmed) === 1,
          deleteImageId:
            typeof row.delete_image_id === "string"
              ? row.delete_image_id
              : null,
        });
      } catch {
        await this.finish(
          String(candidate.id),
          ownerToken,
          "failed",
          "artifact_verification_failed",
        );
      }
    }
    return claimed;
  }

  async assertCurrent(op: ClaimedImageCacheOperation): Promise<boolean> {
    const now = this.now();
    const renewed = await this.db.run(
      `UPDATE operations SET locked_until_ms=? WHERE id=? AND node_id=? AND runtime_identity_id=? AND connection_revision_id=?
         AND image_artifact_id=? AND kind=? AND state='running' AND owner_token=? AND version=?
         AND locked_until_ms>? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)
         AND EXISTS(SELECT 1 FROM image_artifacts a WHERE a.id=operations.image_artifact_id AND a.content_digest=?)`,
      [
        now + this.leaseMs,
        op.operationId,
        op.nodeId,
        op.runtimeIdentityId,
        op.connectionRevisionId,
        op.artifactId,
        op.kind,
        op.ownerToken,
        op.version,
        now,
        op.digest,
      ],
    );
    return renewed.changes === 1n;
  }

  async pullAllowed(op: ClaimedImageCacheOperation): Promise<boolean> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT 1 AS allowed FROM operations o JOIN nodes n ON n.id=o.node_id
       JOIN machines m ON m.id=n.machine_id JOIN provider_connections pc ON pc.id=n.provider_connection_id
       WHERE o.id=? AND o.state='running' AND o.owner_token=? AND o.version=?
         AND n.admission='enabled' AND n.observed_health='healthy' AND n.observed_at_ms+120000>?
         AND m.admission='enabled' AND m.observed_power='on' AND m.source='local' AND pc.enabled=1
         AND o.controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)
         AND EXISTS(SELECT 1 FROM system_maintenance WHERE paused=0 AND disk_state='healthy' AND recovery_json IS NULL) AND NOT EXISTS(SELECT 1 FROM system_maintenance s,json_each(s.runtime_disks_json) d WHERE d.key=n.id AND (json_extract(d.value,'$.state')<>'healthy' OR json_extract(d.value,'$.observedAtMs')+30000<?))`,
      [op.operationId, op.ownerToken, op.version, this.now(), this.now()],
    );
    return !!row;
  }

  async evictionBlock(
    op: ClaimedImageCacheOperation,
  ): Promise<"cache_referenced" | "image_in_use" | undefined> {
    const cache = await this.db.get<Record<string, unknown>>(
      `SELECT 1 AS blocked FROM image_caches c JOIN image_artifacts a ON a.id=c.image_artifact_id
       WHERE c.node_id=? AND c.image_artifact_id=? AND c.desired_state='absent' AND c.observed_state='evicting'
         AND c.local_ref=a.content_digest AND a.content_digest=?
         AND (c.pinned_until_ms IS NULL OR c.pinned_until_ms<=?)`,
      [op.nodeId, op.artifactId, op.digest, this.now()],
    );
    if (!cache) return "cache_referenced";
    const refs = await this.db.get<Record<string, unknown>>(
      `SELECT 1 AS blocked WHERE
         EXISTS(SELECT 1 FROM allocations x JOIN image_artifacts a ON a.id=x.image_artifact_id WHERE a.content_digest=? AND x.cleanup_status<>'complete')
         OR EXISTS(SELECT 1 FROM image_validations v JOIN image_artifacts a ON a.id=v.image_artifact_id WHERE a.content_digest=?
           AND v.state IN ('queued','running','releasing')
           AND json_extract(v.checks_json,'$.scheduler') IN ('queued','running'))
         OR EXISTS(SELECT 1 FROM image_caches c JOIN image_artifacts a ON a.id=c.image_artifact_id
           WHERE a.content_digest=? AND c.node_id=? AND c.observed_state NOT IN ('missing','invalid')
             AND NOT (c.node_id=? AND c.image_artifact_id=?))
         OR EXISTS(SELECT 1 FROM operations other JOIN image_artifacts oa ON oa.id=other.image_artifact_id WHERE oa.content_digest=?
           AND other.node_id=? AND other.id<>? AND other.kind='image-cache.pull' AND other.state IN ('planned','running','unknown'))`,
      [
        op.digest,
        op.digest,
        op.digest,
        op.nodeId,
        op.nodeId,
        op.artifactId,
        op.digest,
        op.nodeId,
        op.operationId,
      ],
    );
    return refs ? "cache_referenced" : undefined;
  }

  async recordReady(
    op: ClaimedImageCacheOperation,
    localRef: string,
    sizeMiB: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 0 || localRef !== op.digest)
      return false;
    const now = this.now();
    try {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: `UPDATE image_caches SET desired_state='present',observed_state='ready',local_ref=?,size_mib=?,digest_verified_at_ms=?,last_error_json=NULL
                WHERE node_id=? AND image_artifact_id=? AND EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.state='running' AND o.owner_token=? AND o.version=? AND o.locked_until_ms>? AND o.controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1))`,
          params: [
            localRef,
            sizeMiB,
            now,
            op.nodeId,
            op.artifactId,
            op.operationId,
            op.ownerToken,
            op.version,
            now,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: `UPDATE operations SET state='succeeded',result_json=json_object('verifiedDigest',?,'sizeMiB',?),owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=?
                WHERE id=? AND state='running' AND owner_token=? AND version=? AND locked_until_ms>? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)`,
          params: [
            op.digest,
            sizeMiB,
            now,
            op.operationId,
            op.ownerToken,
            op.version,
            now,
          ],
          expectChanges: 1,
        },
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async recordAbsent(op: ClaimedImageCacheOperation): Promise<boolean> {
    const now = this.now();
    try {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: `UPDATE image_caches SET desired_state='absent',observed_state='missing',local_ref=NULL,size_mib=NULL,digest_verified_at_ms=NULL,last_error_json=NULL
                WHERE node_id=? AND image_artifact_id=? AND observed_state='evicting'
                  AND EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.state='running' AND o.owner_token=? AND o.version=? AND o.locked_until_ms>? AND o.controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1))`,
          params: [
            op.nodeId,
            op.artifactId,
            op.operationId,
            op.ownerToken,
            op.version,
            now,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: `UPDATE operations SET state='succeeded',result_json=json_object('removedDigest',?),owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=?
                WHERE id=? AND state='running' AND owner_token=? AND version=? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)
                  AND locked_until_ms>? AND (COALESCE(json_extract(result_json,'$.deleteAttempted'),0)=0 OR COALESCE(json_extract(result_json,'$.deleteConfirmed'),0)=1)`,
          params: [
            op.digest,
            now,
            op.operationId,
            op.ownerToken,
            op.version,
            now,
          ],
          expectChanges: 1,
        },
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async markDeleteStarted(
    op: ClaimedImageCacheOperation,
    imageId: string,
  ): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE operations SET result_json=json_set(COALESCE(result_json,'{}'),'$.deleteAttempted',1,'$.deleteImageId',?)
       WHERE id=? AND state='running' AND owner_token=? AND version=? AND locked_until_ms>? AND kind='image-cache.evict'
         AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)`,
      [imageId, op.operationId, op.ownerToken, op.version, this.now()],
    );
    return result.changes === 1n;
  }

  async markDeleteConfirmed(op: ClaimedImageCacheOperation): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE operations SET result_json=json_set(COALESCE(result_json,'{}'),'$.deleteConfirmed',1)
       WHERE id=? AND state='running' AND owner_token=? AND version=? AND locked_until_ms>? AND kind='image-cache.evict'
         AND COALESCE(json_extract(result_json,'$.deleteAttempted'),0)=1
         AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)`,
      [op.operationId, op.ownerToken, op.version, this.now()],
    );
    return result.changes === 1n;
  }

  async finish(
    operationId: string,
    ownerToken: string,
    state: "failed" | "unknown",
    code: ImageCacheDiagnostic,
  ): Promise<void> {
    const now = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: `UPDATE operations SET state=?,result_json=json_set(COALESCE(result_json,'{}'),'$.diagnostic',?),next_check_at_ms=?,owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=?
              WHERE id=? AND kind IN ('image-cache.pull','image-cache.evict') AND state='running' AND owner_token=? AND locked_until_ms>? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)`,
        params: [
          state,
          code,
          now + (state === "unknown" ? 15_000 : 60_000),
          now,
          operationId,
          ownerToken,
          now,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: `UPDATE image_caches SET observed_state=CASE WHEN EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.kind='image-cache.evict') THEN 'evicting' ELSE 'unknown' END,last_error_json=json_object('code',?)
              WHERE EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.node_id=image_caches.node_id AND o.image_artifact_id=image_caches.image_artifact_id AND o.state=? AND o.owner_token IS NULL)`,
        params: [operationId, code, operationId, state],
      },
    ]);
  }

  async finishKnownFailure(
    op: ClaimedImageCacheOperation,
    code: ImageCacheDiagnostic,
    cacheState: "missing" | "ready" | "invalid",
  ): Promise<void> {
    const now = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: `UPDATE image_caches SET observed_state=?,
                desired_state=CASE WHEN ?='ready' THEN 'present' ELSE desired_state END,
                local_ref=CASE WHEN ?='ready' THEN local_ref ELSE NULL END,
                size_mib=CASE WHEN ?='ready' THEN size_mib ELSE NULL END,
                digest_verified_at_ms=CASE WHEN ?='ready' THEN digest_verified_at_ms ELSE NULL END,
                last_error_json=json_object('code',?)
              WHERE node_id=? AND image_artifact_id=?
                AND EXISTS(SELECT 1 FROM operations o WHERE o.id=? AND o.kind=? AND o.state='running' AND o.owner_token=? AND o.version=? AND o.locked_until_ms>? AND o.controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1))`,
        params: [
          cacheState,
          cacheState,
          cacheState,
          cacheState,
          cacheState,
          code,
          op.nodeId,
          op.artifactId,
          op.operationId,
          op.kind,
          op.ownerToken,
          op.version,
          now,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: `UPDATE operations SET state='failed',result_json=json_set(COALESCE(result_json,'{}'),'$.diagnostic',?),next_check_at_ms=?,owner_token=NULL,locked_until_ms=NULL,version=version+1,updated_at_ms=?
              WHERE id=? AND state='running' AND owner_token=? AND version=? AND locked_until_ms>? AND controller_epoch=(SELECT controller_epoch FROM installations WHERE singleton=1)`,
        params: [
          code,
          now + 60_000,
          now,
          op.operationId,
          op.ownerToken,
          op.version,
          now,
        ],
        expectChanges: 1,
      },
    ]);
  }
}
