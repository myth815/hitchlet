import { StorageError, type Storage } from "./index.js";
import { ApplicationError } from "../application/errors.js";
import { hash, integer, parseJson, type Row } from "./admin-store-utils.js";
import type { HyperVRuntimeFacts } from "@hitchlet/contracts/internal";
export class SQLiteHyperVAdminStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async dueObservations(now: number, minimumAgeMs = 45_000, limit = 16) {
    const rows = await this.db.all<Row>(
      `SELECT n.id AS node_id,n.version AS node_version,n.config_json,n.capabilities_json,n.observed_at_ms,
        n.provider_connection_id,n.runtime_identity_id,ri.native_id AS native_namespace_id,m.architecture,m.host_os,
        p.total_cpu_millis,p.total_memory_mib,c.version AS connection_version,c.current_revision_id,
        r.id AS revision_id,r.verified_runtime_identity_id,i.installation_id
       FROM nodes n
       JOIN runtime_identities ri ON ri.id=n.runtime_identity_id AND ri.backend_kind='hyperv'
       JOIN machines m ON m.id=n.machine_id
       JOIN capacity_pools p ON p.id=n.pool_id
       JOIN provider_connections c ON c.id=n.provider_connection_id AND c.enabled=1 AND c.backend_kind='hyperv'
       JOIN provider_connection_revisions r ON r.id=c.current_revision_id AND r.connection_id=c.id
         AND r.verified_runtime_identity_id=n.runtime_identity_id
       JOIN installations i ON i.singleton=1
       WHERE n.backend_kind='hyperv' AND n.admission='enabled'
         AND json_extract(n.config_json,'$.executionMode')='hyperv'
         AND (n.observed_at_ms IS NULL OR n.observed_at_ms<=?)
       ORDER BY n.updated_at_ms,n.observed_at_ms,n.id LIMIT ?`,
      [now - minimumAgeMs, limit],
    );
    return rows.map((row) => ({
      nodeId: String(row.node_id),
      nodeVersion: integer(row.node_version),
      configJson: String(row.config_json),
      capabilitiesJson: String(row.capabilities_json),
      observedAtMs:
        row.observed_at_ms === null ? null : integer(row.observed_at_ms),
      connectionId: String(row.provider_connection_id),
      connectionVersion: integer(row.connection_version),
      currentRevisionId: String(row.current_revision_id),
      revisionId: String(row.revision_id),
      verifiedRuntimeIdentityId: String(row.verified_runtime_identity_id),
      runtimeIdentityId: String(row.runtime_identity_id),
      nativeNamespaceId: String(row.native_namespace_id),
      installationId: String(row.installation_id),
      architecture: String(row.architecture),
      hostOs: String(row.host_os),
      cpuMillis: integer(row.total_cpu_millis),
      memoryMiB: integer(row.total_memory_mib),
    }));
  }
  async recordObservation(
    snapshot: Awaited<
      ReturnType<SQLiteHyperVAdminStore["dueObservations"]>
    >[number],
    result: "healthy" | "degraded" | "unknown",
    observedAtMs?: number,
  ) {
    const time = this.now();
    const changes = await this.db.run(
      `UPDATE nodes SET observed_health=?,observed_at_ms=CASE WHEN ?='healthy' THEN ? ELSE observed_at_ms END,updated_at_ms=?
       WHERE id=? AND version=? AND backend_kind='hyperv' AND admission='enabled'
         AND config_json=? AND capabilities_json=? AND observed_at_ms IS ?
         AND provider_connection_id=? AND runtime_identity_id=?
         AND EXISTS(SELECT 1 FROM machines m JOIN capacity_pools p ON p.id=nodes.pool_id
           WHERE m.id=nodes.machine_id AND m.architecture=? AND m.host_os=?
             AND p.total_cpu_millis=? AND p.total_memory_mib=?)
         AND EXISTS(
           SELECT 1 FROM runtime_identities ri JOIN provider_connections c
             ON c.runtime_identity_id=ri.id AND c.id=nodes.provider_connection_id
           JOIN provider_connection_revisions r ON r.id=c.current_revision_id AND r.connection_id=c.id
           WHERE ri.id=nodes.runtime_identity_id AND ri.backend_kind='hyperv'
             AND ri.native_id=? AND c.enabled=1 AND c.backend_kind='hyperv' AND c.version=?
             AND c.current_revision_id=? AND r.id=?
             AND r.verified_runtime_identity_id=nodes.runtime_identity_id
         )`,
      [
        result,
        result,
        observedAtMs ?? null,
        time,
        snapshot.nodeId,
        snapshot.nodeVersion,
        snapshot.configJson,
        snapshot.capabilitiesJson,
        snapshot.observedAtMs,
        snapshot.connectionId,
        snapshot.runtimeIdentityId,
        snapshot.architecture,
        snapshot.hostOs,
        snapshot.cpuMillis,
        snapshot.memoryMiB,
        snapshot.nativeNamespaceId,
        snapshot.connectionVersion,
        snapshot.currentRevisionId,
        snapshot.revisionId,
      ],
    );
    return changes.changes === 1n;
  }

  async configureRuntime(input: {
    nodeId: string;
    expectedVersion: number;
    config: Readonly<Record<string, unknown>>;
    operatorId: string;
    requestId: string;
  }) {
    const node = await this.db.get<Row>(
      "SELECT n.config_json,n.version,r.native_id FROM nodes n JOIN runtime_identities r ON r.id=n.runtime_identity_id WHERE n.id=? AND n.backend_kind='hyperv' AND n.admission='disabled'",
      [input.nodeId],
    );
    if (!node) throw new ApplicationError("not_found");
    if (Number(node.version) !== input.expectedVersion)
      throw new StorageError("STORAGE_CAS_FAILED", "Node version conflict");
    const time = this.now();
    const config = {
      ...parseJson(String(node.config_json)),
      executionMode: "hyperv",
      runtimeProfile: input.config,
      admissionMode: "constant_online_manual_inventory",
    };
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE nodes SET config_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND admission='disabled' AND backend_kind='hyperv' AND runtime_identity_id=(SELECT id FROM runtime_identities WHERE native_id=?)",
        params: [
          JSON.stringify(config),
          time,
          input.nodeId,
          input.expectedVersion,
          String(node.native_id),
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'node.runtime_configured','node',?,?,?,?)",
        params: [
          input.operatorId,
          input.nodeId,
          input.requestId,
          time,
          JSON.stringify({
            backendKind: "hyperv",
            runtimeAgentId: (
              input.config.runtimeAgent as Record<string, unknown>
            ).id,
            managementDenyRevisionId: input.config.managementDenyRevisionId,
          }),
        ],
      },
    ]);
    return {
      nodeId: input.nodeId,
      runtimeConfigured: true,
      admission: "disabled",
      version: input.expectedVersion + 1,
    };
  }

  attestationTarget(nodeId: string) {
    return this.db.get<Row>(
      "SELECT n.runtime_identity_id,n.config_json,n.version,pc.current_revision_id,ri.native_id,(SELECT installation_id FROM installations WHERE singleton=1) AS installation_id FROM nodes n JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=n.runtime_identity_id JOIN runtime_identities ri ON ri.id=n.runtime_identity_id AND ri.backend_kind='hyperv' WHERE n.id=? AND n.backend_kind='hyperv' AND n.admission='disabled'",
      [nodeId],
    );
  }

  async attestCapabilities(input: {
    nodeId: string;
    expectedVersion: number;
    expectedConnectionRevisionId: string;
    expectedNamespaceId: string;
    expectedHyperVVersion: string;
    templateRef: string;
    templateDigest: string;
    guestOs: "linux" | "windows";
    architecture: "amd64";
    checkedAt: string;
    validForSeconds?: number | undefined;
    report: Readonly<{
      runId: string;
      sha256: string;
      scopes: Readonly<
        Record<
          string,
          | Readonly<{ status: "passed"; summary: string; evidenceRef: string }>
          | undefined
        >
      >;
    }>;
    networkProfileRevisionIds: readonly string[];
    operatorId: string;
    requestId: string;
    facts: HyperVRuntimeFacts;
  }) {
    const networkMode = "trusted_nat";
    if (
      !input.facts.available ||
      !input.facts.hostCpuCount ||
      !input.facts.hostMemoryBytes ||
      !input.facts.hyperVVersion
    )
      throw new RangeError("Hyper-V host facts unavailable");
    const requiredScopes = [
      "resourceLimits",
      "sshBootstrap",
      "cleanupRecovery",
    ];
    const node = await this.db.get<Row>(
      "SELECT n.machine_id,n.runtime_identity_id,n.pool_id,n.config_json,n.version,n.backend_kind,m.architecture,m.host_os,pc.current_revision_id,ri.native_id,r.evidence_json FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=n.runtime_identity_id AND pc.enabled=1 JOIN runtime_identities ri ON ri.id=n.runtime_identity_id AND ri.backend_kind='hyperv' JOIN provider_connection_revisions r ON r.id=pc.current_revision_id AND r.verified_runtime_identity_id=n.runtime_identity_id WHERE n.id=? AND n.backend_kind='hyperv' AND n.admission='disabled'",
      [input.nodeId],
    );
    const checkedAt = Date.parse(input.checkedAt),
      now = this.now(),
      validForSeconds = input.validForSeconds ?? 3600,
      proof = input.facts.templates.find(
        (item) => item.name === input.templateRef,
      );
    if (
      !node ||
      Number(node.version) !== input.expectedVersion ||
      typeof node.current_revision_id !== "string" ||
      String(node.current_revision_id) !== input.expectedConnectionRevisionId
    )
      throw new Error(
        "Hyper-V Node version changed or Node is not ready for capability attestation",
      );
    const storedFacts = parseJson(String(node.evidence_json));
    const config = parseJson(String(node.config_json));
    if (
      String(node.native_id) !== input.expectedNamespaceId ||
      String(node.backend_kind) !== "hyperv" ||
      String(node.architecture) !== "amd64" ||
      String(node.host_os) !== "windows" ||
      config.executionMode !== "hyperv" ||
      !config.runtimeProfile ||
      input.architecture !== "amd64" ||
      input.facts.nativeRuntimeNamespaceId !== input.expectedNamespaceId ||
      input.facts.hostOS !== "windows" ||
      input.facts.hostArchitecture !== "AMD64" ||
      input.facts.hyperVVersion !== input.expectedHyperVVersion ||
      storedFacts.nativeRuntimeNamespaceId !== input.expectedNamespaceId ||
      storedFacts.hyperVVersion !== input.expectedHyperVVersion ||
      !proof ||
      proof.proofKind !== "sealed_export_bundle_v1" ||
      proof.artifactDigest !== input.templateDigest ||
      proof.template.architecture !== "amd64" ||
      proof.template.guestOs !== input.guestOs ||
      input.checkedAt === "" ||
      !Number.isFinite(checkedAt) ||
      checkedAt > now + 30_000 ||
      checkedAt < now - 30 * 60_000 ||
      !Number.isSafeInteger(validForSeconds) ||
      validForSeconds < 3600 ||
      validForSeconds > 30 * 24 * 3600 ||
      requiredScopes.some(
        (name) => input.report.scopes[name]?.status !== "passed",
      )
    )
      throw new RangeError(
        "Hyper-V attestation must match the current namespace, sealed template and the required qualification scopes",
      );
    const revisions = await this.db.all<Row>(
      `SELECT id FROM network_profile_revisions WHERE id IN (${input.networkProfileRevisionIds.map(() => "?").join(",")})`,
      [...input.networkProfileRevisionIds],
    );
    if (revisions.length !== input.networkProfileRevisionIds.length)
      throw new RangeError(
        "Hyper-V capability report references an unknown network revision",
      );
    if (node.pool_id === undefined || node.pool_id === null)
      throw new Error("Hyper-V Node capacity pool is unavailable");
    const pool = await this.db.get<Row>(
      "SELECT total_cpu_millis,total_memory_mib,total_scratch_mib FROM capacity_pools WHERE id=?",
      [node.pool_id],
    );
    if (!pool) throw new Error("Hyper-V Node capacity pool is unavailable");
    if (
      input.facts.hostCpuCount < 1 ||
      Number(pool.total_cpu_millis) > input.facts.hostCpuCount * 1000 ||
      Number(pool.total_memory_mib) >
        Math.floor(input.facts.hostMemoryBytes / 1024 ** 2)
    )
      throw new RangeError(
        "Hyper-V capability capacity exceeds authenticated raw host capacity facts",
      );
    const capabilityFingerprint = hash(
      JSON.stringify({
        backendKind: "hyperv",
        namespaceId: input.expectedNamespaceId,
        connectionRevisionId: String(node.current_revision_id),
        hyperVVersion: input.expectedHyperVVersion,
        templateRef: input.templateRef,
        templateDigest: input.templateDigest,
        guestOs: input.guestOs,
        checkedAt: input.checkedAt,
        networkMode,
        networkProfileRevisionIds: input.networkProfileRevisionIds,
        report: input.report,
      }),
    );
    const capability = {
      cpuHardLimit: "verified",
      memoryHardLimit: "verified",
      scratchHardLimit: "unsupported",
      networkMode,
      networkPolicyEnforcement: "unsupported",
      storagePolicyEnforcement: "unsupported",
      supportedAccess: ["ssh"],
      resourceKinds: ["vm"],
      architectures: ["amd64"],
      guestOs: [input.guestOs],
      capacity: {
        cpuMillis: integer(pool.total_cpu_millis),
        memoryMiB: integer(pool.total_memory_mib),
        scratchMiB: integer(pool.total_scratch_mib),
      },
      verifiedNetworkProfileRevisionIds: [...input.networkProfileRevisionIds],
      verifiedStorageProfileRevisionIds: [],
      providerVersion: `Hyper-V/${input.expectedHyperVVersion}`,
      expiresAt: new Date(checkedAt + validForSeconds * 1000).toISOString(),
      observedAt: new Date(checkedAt).toISOString(),
      evidenceValidForSeconds: validForSeconds,
      capabilityFingerprint,
      admissionMode: "constant_online_manual_inventory",
      connectionRevisionId: String(node.current_revision_id),
      nativeNamespaceId: input.expectedNamespaceId,
      hyperVVersion: input.expectedHyperVVersion,
      templateRef: input.templateRef,
      templateDigest: input.templateDigest,
      architecture: "amd64",
      offline: false,
      powerEnabled: false,
      manualReport: input.report,
    };
    const time = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE machines SET admission='enabled',desired_power='on',observed_power='on',power_lifecycle='idle',version=version+1,updated_at_ms=? WHERE id=? AND admission IN('disabled','enabled')",
        params: [time, String(node.machine_id)],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE nodes SET capabilities_json=?,admission='enabled',observed_health='healthy',observed_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND admission='disabled' AND backend_kind='hyperv' AND runtime_identity_id=(SELECT id FROM runtime_identities WHERE native_id=? AND backend_kind='hyperv') AND EXISTS(SELECT 1 FROM provider_connections pc WHERE pc.id=nodes.provider_connection_id AND pc.enabled=1 AND pc.runtime_identity_id=nodes.runtime_identity_id AND pc.current_revision_id=?)",
        params: [
          JSON.stringify(capability),
          checkedAt,
          time,
          input.nodeId,
          input.expectedVersion,
          input.expectedNamespaceId,
          input.expectedConnectionRevisionId,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'node.capabilities_attested','node',?,?,?,?)",
        params: [
          input.operatorId,
          input.nodeId,
          input.requestId,
          time,
          JSON.stringify({
            backendKind: "hyperv",
            nativeNamespaceId: input.expectedNamespaceId,
            hyperVVersion: input.expectedHyperVVersion,
            templateDigest: input.templateDigest,
            capabilityFingerprint,
          }),
        ],
      },
    ]);
    return {
      nodeId: input.nodeId,
      admission: "enabled",
      observedHealth: "healthy",
      capabilityFingerprint,
      offline: false,
      powerEnabled: false,
      version: input.expectedVersion + 1,
    };
  }
}
