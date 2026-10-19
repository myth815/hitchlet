import { StorageError, type Storage } from "./index.js";
import type { Statement } from "./protocol.js";
import { parseJson, type Row } from "./admin-store-utils.js";

type Report = {
  row: Row;
  contract: Record<string, unknown>;
  snapshot: Record<string, unknown>;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Publication reads evidence and rechecks every read dependency inside its CAS transaction. */
export class SQLiteImagePublicationStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async publish(
    versionId: string,
    expected: number,
    verifyRuntime: (target: {
      endpointUrl: string;
      environmentId: string;
      secretVersionRef: string;
      expected: Record<string, unknown>;
    }) => Promise<boolean>,
  ) {
    const version = await this.db.get<Row>(
      "SELECT * FROM image_versions WHERE id=?",
      [versionId],
    );
    if (!version) return undefined;
    if (Number(version.entity_version) !== expected)
      throw new StorageError(
        "STORAGE_CAS_FAILED",
        "Image version changed before publication",
      );
    const artifacts = await this.db.all<Row>(
      "SELECT * FROM image_artifacts WHERE image_version_id=? ORDER BY id",
      [versionId],
    );
    if (!artifacts.length) return undefined;
    const selected: Report[] = [];
    for (const artifact of artifacts) {
      const candidates = await this.db.all<Row>(
        `SELECT v.*,n.capabilities_json AS current_capabilities,n.config_json AS current_config,n.version AS current_node_version,n.admission AS node_admission,pc.current_revision_id,cr.evidence_json AS current_provider,cr.endpoint_ref,cr.provider_endpoint_id,cr.secret_version_ref,np.current_revision_id AS current_network,d.id AS current_deny FROM image_validations v JOIN nodes n ON n.id=v.node_id JOIN provider_connections pc ON pc.id=n.provider_connection_id JOIN provider_connection_revisions cr ON cr.id=pc.current_revision_id JOIN network_profiles np ON np.id=json_extract(v.accepted_contract_json,'$.networkProfileId') JOIN platform_network_deny_revisions d ON d.revision=(SELECT max(revision) FROM platform_network_deny_revisions) WHERE v.image_artifact_id=? AND v.state='succeeded' AND v.test_outcome='passed' AND v.cleanup_status='complete' AND v.report_id IS NOT NULL AND (v.evidence_expires_at_ms IS NULL OR v.evidence_expires_at_ms>?) AND pc.enabled=1 AND np.status='active' AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=np.current_revision_id) ORDER BY v.finished_at_ms DESC`,
        [String(artifact.id), this.now()],
      );
      let report: Report | undefined;
      for (const row of candidates) {
        const contract = parseJson(String(row.accepted_contract_json));
        const checks = parseJson(String(row.checks_json));
        const evidence = checks.testedEvidence as
          | Record<string, unknown>
          | undefined;
        const snapshot = evidence?.executionSnapshot as
          | Record<string, unknown>
          | undefined;
        const caps = parseJson(String(row.current_capabilities));
        if (
          !snapshot ||
          evidence?.source !== "provider_execution" ||
          !checks.cleanupEvidence ||
          contract.imageVersionId !== versionId ||
          contract.imageArtifactId !== artifact.id ||
          contract.backendKind !== artifact.backend_kind ||
          contract.environmentKind !== artifact.environment_kind ||
          contract.variant !== artifact.variant ||
          contract.digest !== artifact.content_digest ||
          contract.artifactRef !== artifact.artifact_ref ||
          contract.architecture !== artifact.architecture ||
          contract.guestOs !== artifact.guest_os ||
          !same(contract.minimumResources, {
            cpuMillis: Number(artifact.minimum_cpu_millis),
            memoryMiB: Number(artifact.minimum_memory_mib),
            scratchMiB: Number(artifact.minimum_scratch_mib),
          }) ||
          !same(contract.manifest, parseJson(String(version.manifest_json))) ||
          !same(
            contract.requirements,
            parseJson(String(artifact.requirements_json)),
          ) ||
          !same(
            contract.access,
            parseJson(String(artifact.access_recipe_json)),
          ) ||
          !same(snapshot.capabilities, caps) ||
          !same(snapshot.config, parseJson(String(row.current_config))) ||
          !same(
            snapshot.providerEvidence,
            parseJson(String(row.current_provider)),
          ) ||
          snapshot.nodeVersion !== Number(row.current_node_version) ||
          row.node_admission !== "enabled" ||
          contract.connectionRevisionId !== row.current_revision_id ||
          contract.networkRevisionId !== row.current_network ||
          contract.platformDenyRevisionId !== row.current_deny ||
          typeof caps.expiresAt !== "string" ||
          Date.parse(caps.expiresAt) <= this.now()
        )
          continue;
        report = { row, contract, snapshot };
        break;
      }
      if (!report) return undefined;
      selected.push(report);
    }
    for (const { row } of selected) {
      if (
        !(await verifyRuntime({
          endpointUrl: String(row.endpoint_ref),
          environmentId: String(row.provider_endpoint_id),
          secretVersionRef: String(row.secret_version_ref),
          expected: parseJson(String(row.current_provider)),
        }))
      )
        return undefined;
    }
    const statements: Statement[] = selected.map(({ row, contract }) => ({
      kind: "run",
      sql: `UPDATE image_validations SET version=version WHERE id=? AND EXISTS(SELECT 1 AS matched FROM image_validations v JOIN nodes n ON n.id=v.node_id JOIN provider_connections pc ON pc.id=n.provider_connection_id JOIN provider_connection_revisions cr ON cr.id=pc.current_revision_id JOIN network_profiles np ON np.id=? WHERE v.id=? AND v.version=? AND v.state='succeeded' AND v.cleanup_status='complete' AND n.version=? AND n.capabilities_json=? AND n.config_json=? AND n.admission='enabled' AND pc.enabled=1 AND pc.current_revision_id=? AND cr.evidence_json=? AND np.status='active' AND np.current_revision_id=? AND ?=(SELECT id FROM platform_network_deny_revisions ORDER BY revision DESC LIMIT 1) AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=np.current_revision_id))`,
      params: [
        String(row.id),
        String(contract.networkProfileId),
        String(row.id),
        Number(row.version),
        Number(row.current_node_version),
        String(row.current_capabilities),
        String(row.current_config),
        String(row.current_revision_id),
        String(row.current_provider),
        String(row.current_network),
        String(row.current_deny),
      ],
      expectChanges: 1,
    }));
    statements.push({
      kind: "run",
      sql: "UPDATE image_versions SET status='published',entity_version=entity_version+1,published_at_ms=?,updated_at_ms=? WHERE id=? AND entity_version=? AND status IN ('draft','validating') AND manifest_json=? AND (SELECT count(*) FROM image_artifacts WHERE image_version_id=?)=?",
      params: [
        this.now(),
        this.now(),
        versionId,
        expected,
        String(version.manifest_json),
        versionId,
        artifacts.length,
      ],
      expectChanges: 1,
    });
    for (const a of artifacts)
      statements.push({
        kind: "run",
        sql: "UPDATE image_artifacts SET id=id WHERE id=? AND artifact_ref=? AND content_digest=? AND requirements_json=? AND access_recipe_json=? AND minimum_cpu_millis=? AND minimum_memory_mib=? AND minimum_scratch_mib=? AND architecture=? AND guest_os=? AND image_version_id=? AND backend_kind=? AND environment_kind=? AND variant=?",
        params: [
          String(a.id),
          String(a.artifact_ref),
          String(a.content_digest),
          String(a.requirements_json),
          String(a.access_recipe_json),
          Number(a.minimum_cpu_millis),
          Number(a.minimum_memory_mib),
          Number(a.minimum_scratch_mib),
          String(a.architecture),
          String(a.guest_os),
          versionId,
          String(a.backend_kind),
          String(a.environment_kind),
          String(a.variant),
        ],
        expectChanges: 1,
      });
    await this.db.batchTransaction(statements);
    return {
      versionId,
      status: "published" as const,
      entityVersion: expected + 1,
    };
  }

  async moveAlias(
    imageId: string,
    alias: string,
    versionId: string,
    expectedVersion: number,
  ) {
    const statement: Statement =
      expectedVersion === 0
        ? {
            kind: "run",
            sql: "INSERT INTO image_aliases(image_id,alias,image_version_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM image_versions WHERE id=? AND image_id=? AND status='published')",
            params: [imageId, alias, versionId, versionId, imageId],
            expectChanges: 1,
          }
        : {
            kind: "run",
            sql: "UPDATE image_aliases SET image_version_id=?,version=version+1 WHERE image_id=? AND alias=? AND version=? AND EXISTS(SELECT 1 FROM image_versions WHERE id=? AND image_id=? AND status='published')",
            params: [
              versionId,
              imageId,
              alias,
              expectedVersion,
              versionId,
              imageId,
            ],
            expectChanges: 1,
          };
    await this.db.batchTransaction([statement]);
    return { imageId, alias, versionId, version: expectedVersion + 1 };
  }
}
