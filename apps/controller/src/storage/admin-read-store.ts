import type { Storage } from "./index.js";
import { integer, type Row } from "./admin-store-utils.js";

/** Safe, read-only projections used by the administrator workflow UI. */
export class SQLiteAdminReadStore {
  constructor(private readonly db: Storage) {}

  async listImageVersions() {
    const rows = await this.db.all<Row>(
      "SELECT v.id,v.image_id,v.version,v.status,v.entity_version,v.created_at_ms,v.updated_at_ms,v.published_at_ms,i.name,i.description FROM image_versions v JOIN images i ON i.id=v.image_id ORDER BY v.updated_at_ms DESC,v.id",
    );
    const artifactsByVersion = new Map<string, Row[]>();
    for (const artifact of await this.db.all<Row>(
      "SELECT id,image_version_id,architecture,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib FROM image_artifacts ORDER BY image_version_id,architecture,id",
    )) {
      const versionId = String(artifact.image_version_id);
      const artifacts = artifactsByVersion.get(versionId) ?? [];
      artifacts.push(artifact);
      artifactsByVersion.set(versionId, artifacts);
    }
    return rows.map((row) => ({
      id: String(row.id),
      imageId: String(row.image_id),
      imageName: String(row.name),
      description: String(row.description),
      version: String(row.version),
      status: String(row.status),
      entityVersion: integer(row.entity_version),
      createdAtMs: integer(row.created_at_ms),
      updatedAtMs: integer(row.updated_at_ms),
      publishedAtMs:
        row.published_at_ms === null ? null : integer(row.published_at_ms),
      artifacts: (artifactsByVersion.get(String(row.id)) ?? []).map(
        (artifact) => ({
          id: String(artifact.id),
          architecture: String(artifact.architecture),
          digest: String(artifact.content_digest),
          minimumResources: {
            cpuMillis: integer(artifact.minimum_cpu_millis),
            memoryMiB: integer(artifact.minimum_memory_mib),
            scratchMiB: integer(artifact.minimum_scratch_mib),
          },
        }),
      ),
    }));
  }

  async listValidationHistory(versionId: string) {
    const version = await this.db.get<Row>(
      "SELECT id FROM image_versions WHERE id=?",
      [versionId],
    );
    if (!version) return undefined;
    const rows = await this.db.all<Row>(
      "SELECT v.id,v.image_artifact_id,v.node_id,v.state,v.test_outcome,v.cleanup_status,v.report_id,v.deadline_ms,v.finished_at_ms,v.version,v.created_at_ms,v.updated_at_ms FROM image_validations v JOIN image_artifacts a ON a.id=v.image_artifact_id WHERE a.image_version_id=? ORDER BY v.created_at_ms DESC,v.id",
      [versionId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      imageArtifactId: String(row.image_artifact_id),
      nodeId: String(row.node_id),
      state: String(row.state),
      testOutcome: String(row.test_outcome),
      cleanupStatus: String(row.cleanup_status),
      reportId: typeof row.report_id === "string" ? row.report_id : null,
      deadlineMs: integer(row.deadline_ms),
      finishedAtMs:
        row.finished_at_ms === null ? null : integer(row.finished_at_ms),
      version: integer(row.version),
      createdAtMs: integer(row.created_at_ms),
      updatedAtMs: integer(row.updated_at_ms),
    }));
  }

  async listImageAliases(imageId: string) {
    const image = await this.db.get<Row>("SELECT id FROM images WHERE id=?", [
      imageId,
    ]);
    if (!image) return undefined;
    const rows = await this.db.all<Row>(
      "SELECT image_id,alias,image_version_id,version FROM image_aliases WHERE image_id=? ORDER BY alias",
      [imageId],
    );
    return rows.map((row) => ({
      imageId: String(row.image_id),
      alias: String(row.alias),
      versionId: String(row.image_version_id),
      version: integer(row.version),
    }));
  }
}
