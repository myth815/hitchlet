import { randomUUID } from "node:crypto";
import type { Storage } from "./index.js";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";
import {
  hash,
  integer,
  normalizeDraftRequirements,
  parseJson,
  safeMountPath,
  safeRelativePath,
  validateArtifact,
  validateBootstrapAndAccess,
  type Row,
} from "./admin-store-utils.js";

export class SQLiteImageValidationStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async getDraftVersion(id: string) {
    const version = await this.db.get<Row>(
      "SELECT v.*,i.name,i.description FROM image_versions v JOIN images i ON i.id=v.image_id WHERE v.id=? AND v.status IN ('draft','validating')",
      [id],
    );
    if (!version) return undefined;
    const artifacts = await this.db.all<Row>(
      "SELECT id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,requirements_json,access_recipe_json FROM image_artifacts WHERE image_version_id=?",
      [id],
    );
    return {
      version: {
        id: String(version.id),
        imageId: String(version.image_id),
        imageName: String(version.name),
        description: String(version.description),
        version: String(version.version),
        status: String(version.status),
        entityVersion: integer(version.entity_version),
        manifest: parseJson(String(version.manifest_json)),
        createdAtMs: integer(version.created_at_ms),
        updatedAtMs: integer(version.updated_at_ms),
      },
      artifacts: artifacts.map((a) => ({
        id: String(a.id),
        provider: String(a.backend_kind),
        kind: String(a.environment_kind),
        architecture: String(a.architecture),
        guestOs: String(a.guest_os),
        artifactRef: String(a.artifact_ref),
        digest: String(a.content_digest),
        minimumResources: {
          cpuMillis: integer(a.minimum_cpu_millis),
          memoryMiB: integer(a.minimum_memory_mib),
          scratchMiB: integer(a.minimum_scratch_mib),
        },
        requirements: parseJson(String(a.requirements_json)),
        access: parseJson(String(a.access_recipe_json)),
      })),
    };
  }
  async createDraft(input: {
    name: string;
    description?: string;
    version: string;
    architecture: "amd64" | "arm64";
    artifactRef: string;
    digest: string;
    minimumResources: {
      cpuMillis: number;
      memoryMiB: number;
      scratchMiB: number;
    };
    bootstrap: unknown;
    access: unknown;
    authorizedConsumerIds: readonly string[];
  }) {
    validateArtifact(input.artifactRef, input.digest);
    validateBootstrapAndAccess(input.bootstrap, input.access);
    if (
      !Object.values(input.minimumResources).every(Number.isSafeInteger) ||
      input.minimumResources.cpuMillis < 1 ||
      input.minimumResources.memoryMiB < 1 ||
      input.minimumResources.scratchMiB < 0
    )
      throw new RangeError("Invalid minimum resources");
    const imageId = randomUUID(),
      versionId = randomUUID(),
      artifactId = randomUUID(),
      time = this.now();
    const requirements = {
      bootstrap: input.bootstrap,
      requiredCapabilities: [] as string[],
    };
    const manifest = {
      requirements,
      access: input.access,
      platform: { architecture: input.architecture, guestOs: "linux" },
      minimumResources: input.minimumResources,
    };
    const statements: import("../storage/protocol.js").Statement[] = [
      {
        kind: "run",
        sql: "INSERT INTO images(id,name,description,created_at_ms) VALUES(?,?,?,?)",
        params: [imageId, input.name, input.description ?? "", time],
      },
      {
        kind: "run",
        sql: "INSERT INTO image_versions(id,image_id,version,status,manifest_json,created_at_ms,updated_at_ms) VALUES(?,?,?,'draft',?,?,?)",
        params: [
          versionId,
          imageId,
          input.version,
          JSON.stringify(manifest),
          time,
          time,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,requirements_json,access_recipe_json,created_at_ms) VALUES(?,?,'portainer','container',?,'linux',?,?,?,?,?,?,?,?)",
        params: [
          artifactId,
          versionId,
          input.architecture,
          input.artifactRef,
          input.digest,
          input.minimumResources.cpuMillis,
          input.minimumResources.memoryMiB,
          input.minimumResources.scratchMiB,
          JSON.stringify(requirements),
          JSON.stringify(input.access),
          time,
        ],
      },
    ];
    for (const consumerId of new Set(input.authorizedConsumerIds)) {
      const row = await this.db.get<Row>(
        "SELECT authorization_json,version FROM consumers WHERE id=? AND status='active'",
        [consumerId],
      );
      if (!row) throw new RangeError("Authorized consumer not found");
      const authorization = parseJson(String(row.authorization_json));
      const current = Array.isArray(authorization.imageIds)
        ? authorization.imageIds.filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      if (authorization.imageIds !== "all") {
        authorization.imageIds = [...new Set([...current, imageId])];
        statements.push({
          kind: "run",
          sql: "UPDATE consumers SET authorization_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?",
          params: [
            JSON.stringify(authorization),
            time,
            consumerId,
            Number(row.version),
          ],
          expectChanges: 1,
        });
      }
    }
    await this.db.batchTransaction(statements);
    return {
      imageId,
      versionId,
      artifactId,
      status: "draft",
      digest: input.digest,
      architecture: input.architecture,
    };
  }
  async createVersion(input: {
    imageId: string;
    version: string;
    architecture: "amd64" | "arm64";
    artifactRef: string;
    digest: string;
    minimumResources: {
      cpuMillis: number;
      memoryMiB: number;
      scratchMiB: number;
    };
    requirements: unknown;
    access: unknown;
  }) {
    validateArtifact(input.artifactRef, input.digest);
    const requirements = normalizeDraftRequirements(input.requirements);
    validateBootstrapAndAccess(requirements.bootstrap, input.access);
    const image = await this.db.get<Row>(
      "SELECT id FROM images WHERE id=? AND status='active'",
      [input.imageId],
    );
    if (!image) throw new RangeError("Image is unavailable");
    const versionId = randomUUID();
    const artifactId = randomUUID();
    const time = this.now();
    const manifest = {
      requirements,
      access: input.access,
      platform: { architecture: input.architecture, guestOs: "linux" },
      minimumResources: input.minimumResources,
    };
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO image_versions(id,image_id,version,status,manifest_json,created_at_ms,updated_at_ms) VALUES(?,?,?,'draft',?,?,?)",
        params: [
          versionId,
          input.imageId,
          input.version,
          JSON.stringify(manifest),
          time,
          time,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,requirements_json,access_recipe_json,created_at_ms) VALUES(?,?,'portainer','container',?,'linux',?,?,?,?,?,?,?,?)",
        params: [
          artifactId,
          versionId,
          input.architecture,
          input.artifactRef,
          input.digest,
          input.minimumResources.cpuMillis,
          input.minimumResources.memoryMiB,
          input.minimumResources.scratchMiB,
          JSON.stringify(requirements),
          JSON.stringify(input.access),
          time,
        ],
      },
    ]);
    return {
      imageId: input.imageId,
      versionId,
      artifactId,
      status: "draft",
      digest: input.digest,
      architecture: input.architecture,
    };
  }
  async addDraftArtifact(
    versionId: string,
    input: {
      architecture: "amd64" | "arm64";
      artifactRef: string;
      digest: string;
      minimumResources: {
        cpuMillis: number;
        memoryMiB: number;
        scratchMiB: number;
      };
      requirements: unknown;
      access: unknown;
    },
  ) {
    validateArtifact(input.artifactRef, input.digest);
    const requirements = normalizeDraftRequirements(input.requirements);
    validateBootstrapAndAccess(requirements.bootstrap, input.access);
    const version = await this.db.get<Row>(
      "SELECT status,entity_version FROM image_versions WHERE id=?",
      [versionId],
    );
    if (!version || version.status !== "draft")
      throw new RangeError("Only an editable draft version accepts artifacts");
    const id = randomUUID(),
      time = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,requirements_json,access_recipe_json,created_at_ms) VALUES(?,?,'portainer','container',?,'linux',?,?,?,?,?,?,?,?)",
        params: [
          id,
          versionId,
          input.architecture,
          input.artifactRef,
          input.digest,
          input.minimumResources.cpuMillis,
          input.minimumResources.memoryMiB,
          input.minimumResources.scratchMiB,
          JSON.stringify(requirements),
          JSON.stringify(input.access),
          time,
        ],
      },
      {
        kind: "run",
        sql: "UPDATE image_versions SET entity_version=entity_version+1,updated_at_ms=? WHERE id=? AND status='draft' AND entity_version=?",
        params: [time, versionId, Number(version.entity_version)],
        expectChanges: 1,
      },
    ]);
    return {
      artifactId: id,
      versionId,
      digest: input.digest,
      architecture: input.architecture,
    };
  }
  async prewarmImageCache(input: { nodeId: string; artifactId: string }) {
    const target = await this.db.get<Row>(
      "SELECT n.runtime_identity_id,n.id AS node_id,n.admission,m.admission AS machine_admission,pc.current_revision_id,r.id AS revision_id,a.content_digest,a.backend_kind,c.node_id AS cached_node,c.observed_state,c.local_ref,c.digest_verified_at_ms FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=n.runtime_identity_id AND pc.enabled=1 JOIN provider_connection_revisions r ON r.id=pc.current_revision_id AND r.verified_runtime_identity_id=n.runtime_identity_id JOIN image_artifacts a ON a.id=? LEFT JOIN image_caches c ON c.node_id=n.id AND c.image_artifact_id=a.id WHERE n.id=? AND a.backend_kind=n.backend_kind",
      [input.artifactId, input.nodeId],
    );
    if (!target)
      throw new RangeError(
        "Image artifact and node do not share a verified runtime connection",
      );
    if (
      target.admission !== "enabled" ||
      target.machine_admission !== "enabled"
    )
      throw new RangeError(
        "New image cache pulls require an enabled node and machine",
      );
    const pending = await this.db.get<Row>(
      "SELECT id,kind FROM operations WHERE node_id=? AND image_artifact_id=? AND kind IN ('image-cache.pull','image-cache.evict') AND state IN ('planned','running','unknown') ORDER BY created_at_ms DESC LIMIT 1",
      [input.nodeId, input.artifactId],
    );
    if (pending)
      return pending.kind === "image-cache.pull"
        ? { state: "queued", operationId: String(pending.id) }
        : { state: "conflict" as const };
    if (
      target.observed_state === "ready" &&
      target.digest_verified_at_ms !== null &&
      target.local_ref === target.content_digest
    )
      return { state: "ready", operationId: null };
    const operationId = randomUUID(),
      time = this.now(),
      intent = {
        nodeId: input.nodeId,
        artifactId: input.artifactId,
        digest: target.content_digest,
        runtimeIdentityId: target.runtime_identity_id,
        connectionRevisionId: target.revision_id,
      };
    try {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: "INSERT INTO operations(id,node_id,runtime_identity_id,connection_revision_id,image_artifact_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) SELECT ?,n.id,n.runtime_identity_id,r.id,?,i.controller_epoch,'image-cache.pull',?,?,'planned',?,?,?,?,? FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN provider_connections pc ON pc.id=n.provider_connection_id JOIN provider_connection_revisions r ON r.id=pc.current_revision_id JOIN installations i ON i.singleton=1 JOIN image_artifacts a ON a.id=? AND a.backend_kind=n.backend_kind WHERE n.id=? AND n.admission='enabled' AND m.admission='enabled' AND m.source='local' AND pc.enabled=1 AND r.verified_runtime_identity_id=n.runtime_identity_id AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.node_id=n.id AND o.image_artifact_id=a.id AND o.kind IN ('image-cache.pull','image-cache.evict') AND o.state IN ('planned','running','unknown')) AND NOT EXISTS(SELECT 1 FROM image_caches c JOIN image_artifacts ca ON ca.id=c.image_artifact_id WHERE c.node_id=n.id AND ca.content_digest=a.content_digest AND c.observed_state='evicting')",
          params: [
            operationId,
            input.artifactId,
            input.artifactId,
            `image-cache.pull:${operationId}`,
            hash(JSON.stringify(intent)),
            JSON.stringify(intent),
            time,
            time,
            time,
            input.artifactId,
            input.nodeId,
          ],
        },
        {
          kind: "run",
          sql: "INSERT INTO image_caches(node_id,image_artifact_id,desired_state,observed_state) SELECT ?,?,'present','unknown' WHERE EXISTS(SELECT 1 FROM operations WHERE id=? AND state='planned') ON CONFLICT(node_id,image_artifact_id) DO UPDATE SET desired_state='present',observed_state=CASE WHEN image_caches.observed_state='ready' AND image_caches.digest_verified_at_ms IS NOT NULL AND image_caches.local_ref=(SELECT content_digest FROM image_artifacts WHERE id=?) THEN 'ready' ELSE 'unknown' END,last_error_json=NULL",
          params: [
            input.nodeId,
            input.artifactId,
            operationId,
            input.artifactId,
          ],
        },
      ]);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "STORAGE_CAS_FAILED"
      )
        return { state: "conflict" as const };
      throw error;
    }
    const active = await this.db.get<Row>(
      "SELECT id,kind FROM operations WHERE node_id=? AND image_artifact_id=? AND kind IN ('image-cache.pull','image-cache.evict') AND state IN ('planned','running','unknown') ORDER BY created_at_ms DESC LIMIT 1",
      [input.nodeId, input.artifactId],
    );
    if (!active) return { state: "conflict" as const };
    if (active.kind !== "image-cache.pull")
      return { state: "conflict" as const };
    return {
      state: "queued",
      operationId: String(active.id),
      digest: target.content_digest,
    };
  }

  async planCacheEviction(input: { nodeId: string; artifactId: string }) {
    const cached = await this.db.get<Row>(
      "SELECT c.observed_state,c.local_ref,c.digest_verified_at_ms,a.content_digest,n.runtime_identity_id,r.id AS revision_id FROM image_caches c JOIN image_artifacts a ON a.id=c.image_artifact_id JOIN nodes n ON n.id=c.node_id JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=n.runtime_identity_id JOIN provider_connection_revisions r ON r.id=pc.current_revision_id AND r.verified_runtime_identity_id=n.runtime_identity_id WHERE c.node_id=? AND c.image_artifact_id=? AND c.observed_state='ready' AND c.digest_verified_at_ms IS NOT NULL AND c.local_ref=a.content_digest AND (c.pinned_until_ms IS NULL OR c.pinned_until_ms<=?) AND NOT EXISTS(SELECT 1 FROM allocations x JOIN image_artifacts xa ON xa.id=x.image_artifact_id WHERE xa.content_digest=a.content_digest AND x.cleanup_status<>'complete') AND NOT EXISTS(SELECT 1 FROM image_validations v JOIN image_artifacts va ON va.id=v.image_artifact_id WHERE va.content_digest=a.content_digest AND v.state IN ('queued','running','releasing') AND json_extract(v.checks_json,'$.scheduler') IN ('queued','running'))",
      [input.nodeId, input.artifactId, this.now()],
    );
    if (!cached)
      throw new RangeError(
        "Only an unreferenced, verified ready cache can be selected for eviction",
      );
    const current = await this.db.get<Row>(
      "SELECT id FROM operations WHERE node_id=? AND image_artifact_id=? AND kind='image-cache.evict' AND state IN ('planned','running','unknown') ORDER BY created_at_ms DESC LIMIT 1",
      [input.nodeId, input.artifactId],
    );
    if (current)
      return {
        state: "queued",
        operationId: current.id,
        digest: cached.content_digest,
      };
    const conflict = await this.db.get<Row>(
      "SELECT id FROM operations WHERE node_id=? AND image_artifact_id=? AND kind='image-cache.pull' AND state IN ('planned','running','unknown') ORDER BY created_at_ms DESC LIMIT 1",
      [input.nodeId, input.artifactId],
    );
    if (conflict) return { state: "conflict" as const };
    const operationId = randomUUID(),
      time = this.now(),
      intent = {
        nodeId: input.nodeId,
        artifactId: input.artifactId,
        digest: cached.content_digest,
        runtimeIdentityId: cached.runtime_identity_id,
        connectionRevisionId: cached.revision_id,
      };
    try {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: "INSERT INTO operations(id,node_id,runtime_identity_id,connection_revision_id,image_artifact_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) SELECT ?,n.id,n.runtime_identity_id,r.id,?,i.controller_epoch,'image-cache.evict',?,?,'planned',?,?,?,?,? FROM nodes n JOIN provider_connections pc ON pc.id=n.provider_connection_id JOIN provider_connection_revisions r ON r.id=pc.current_revision_id JOIN installations i ON i.singleton=1 JOIN image_caches c ON c.node_id=n.id AND c.image_artifact_id=? AND c.observed_state='ready' AND c.digest_verified_at_ms IS NOT NULL AND c.local_ref=? AND (c.pinned_until_ms IS NULL OR c.pinned_until_ms<=?) JOIN image_artifacts a ON a.id=c.image_artifact_id WHERE n.id=? AND r.verified_runtime_identity_id=n.runtime_identity_id AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.node_id=n.id AND o.image_artifact_id=c.image_artifact_id AND o.kind IN ('image-cache.pull','image-cache.evict') AND o.state IN ('planned','running','unknown')) AND NOT EXISTS(SELECT 1 FROM allocations x JOIN image_artifacts xa ON xa.id=x.image_artifact_id WHERE xa.content_digest=a.content_digest AND x.cleanup_status<>'complete') AND NOT EXISTS(SELECT 1 FROM image_validations v JOIN image_artifacts va ON va.id=v.image_artifact_id WHERE va.content_digest=a.content_digest AND v.state IN ('queued','running','releasing') AND json_extract(v.checks_json,'$.scheduler') IN ('queued','running'))",
          params: [
            operationId,
            input.artifactId,
            input.artifactId,
            `image-cache.evict:${operationId}`,
            hash(JSON.stringify(intent)),
            JSON.stringify(intent),
            time,
            time,
            time,
            input.artifactId,
            String(cached.content_digest),
            time,
            input.nodeId,
          ],
        },
        {
          kind: "run",
          sql: "UPDATE image_caches SET desired_state='absent',observed_state='evicting' WHERE node_id=? AND image_artifact_id=? AND observed_state='ready' AND digest_verified_at_ms IS NOT NULL AND local_ref=? AND (pinned_until_ms IS NULL OR pinned_until_ms<=?) AND NOT EXISTS(SELECT 1 FROM allocations x JOIN image_artifacts xa ON xa.id=x.image_artifact_id WHERE xa.content_digest=(SELECT content_digest FROM image_artifacts WHERE id=image_caches.image_artifact_id) AND x.cleanup_status<>'complete') AND NOT EXISTS(SELECT 1 FROM image_validations v JOIN image_artifacts va ON va.id=v.image_artifact_id WHERE va.content_digest=(SELECT content_digest FROM image_artifacts WHERE id=image_caches.image_artifact_id) AND v.state IN ('queued','running','releasing') AND json_extract(v.checks_json,'$.scheduler') IN ('queued','running')) AND NOT EXISTS(SELECT 1 FROM image_caches other JOIN image_artifacts oa ON oa.id=other.image_artifact_id WHERE oa.content_digest=? AND NOT(other.node_id=image_caches.node_id AND other.image_artifact_id=image_caches.image_artifact_id) AND other.observed_state='ready') AND EXISTS(SELECT 1 FROM operations WHERE id=? AND kind='image-cache.evict' AND state='planned')",
          params: [
            input.nodeId,
            input.artifactId,
            String(cached.content_digest),
            time,
            String(cached.content_digest),
            operationId,
          ],
          expectChanges: 1,
        },
      ]);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "STORAGE_CAS_FAILED"
      )
        return { state: "conflict" as const };
      throw error;
    }
    const active = await this.db.get<Row>(
      "SELECT id,kind FROM operations WHERE node_id=? AND image_artifact_id=? AND kind IN ('image-cache.pull','image-cache.evict') AND state IN ('planned','running','unknown') ORDER BY created_at_ms DESC LIMIT 1",
      [input.nodeId, input.artifactId],
    );
    if (!active) return { state: "conflict" as const };
    if (active.kind !== "image-cache.evict")
      return { state: "conflict" as const };
    return {
      state: "queued",
      operationId: String(active.id),
      digest: cached.content_digest,
    };
  }
}
