import { randomUUID } from "node:crypto";
import type { Storage } from "./index.js";
import {
  hash,
  integer,
  parseJson,
  projectCapabilities,
  type Row,
} from "./admin-store-utils.js";

export class SQLiteMachineNodeStore {
  constructor(
    private readonly db: Storage,
    private readonly now = Date.now,
  ) {}
  async getInstallation() {
    const row = await this.db.get<Row>(
      "SELECT i.installation_id,i.controller_epoch,r.id AS revision_id,r.revision,r.management_deny_rules_json,r.reason FROM installations i LEFT JOIN platform_network_deny_revisions r ON r.id=i.current_network_deny_revision_id WHERE i.singleton=1",
    );
    if (!row) return undefined;
    const revision =
      row.revision_id === null
        ? null
        : {
            revisionId: String(row.revision_id),
            revision: integer(row.revision),
            managementDenyRules: JSON.parse(
              String(row.management_deny_rules_json),
            ) as unknown,
            reason: String(row.reason),
          };
    return {
      installationId: String(row.installation_id),
      controllerEpoch: integer(row.controller_epoch),
      platformNetworkDeny: revision,
    };
  }
  async listNodes() {
    const rows = await this.db.all<Row>(
      "SELECT id,machine_id,name,backend_kind,provider_connection_id,runtime_identity_id,pool_id,admission,observed_health,capabilities_json,observed_at_ms,version FROM nodes ORDER BY created_at_ms",
    );
    return rows.map((r) => ({
      id: String(r.id),
      machineId: String(r.machine_id),
      name: String(r.name),
      backendKind: String(r.backend_kind),
      providerConnectionId: String(r.provider_connection_id),
      runtimeIdentityId: String(r.runtime_identity_id),
      poolId: String(r.pool_id),
      admission: String(r.admission),
      observedHealth: String(r.observed_health),
      capabilities: projectCapabilities(String(r.capabilities_json)),
      observedAtMs:
        r.observed_at_ms === null ? null : integer(r.observed_at_ms),
      version: integer(r.version),
    }));
  }
  async duePortainerObservations(
    now: number,
    minimumAgeMs = 45_000,
    limit = 16,
  ) {
    const rows = await this.db.all<Row>(
      `SELECT n.id AS node_id,n.version AS node_version,n.admission,n.config_json,n.capabilities_json,n.observed_at_ms,
        n.provider_connection_id,n.runtime_identity_id,ri.native_id AS engine_id,m.architecture,
        p.total_cpu_millis,p.total_memory_mib,c.version AS connection_version,c.current_revision_id,
        r.id AS revision_id,r.endpoint_ref,r.provider_endpoint_id,r.secret_version_ref,r.verified_runtime_identity_id
       FROM nodes n
       JOIN runtime_identities ri ON ri.id=n.runtime_identity_id AND ri.backend_kind='portainer'
       JOIN machines m ON m.id=n.machine_id
       JOIN capacity_pools p ON p.id=n.pool_id
       JOIN provider_connections c ON c.id=n.provider_connection_id AND c.enabled=1
       JOIN provider_connection_revisions r ON r.id=c.current_revision_id AND r.connection_id=c.id
         AND r.verified_runtime_identity_id=n.runtime_identity_id
       WHERE n.backend_kind='portainer' AND n.admission='enabled'
         AND json_extract(n.config_json,'$.executionMode')='portainer'
         AND (n.observed_at_ms IS NULL OR n.observed_at_ms<=?)
       ORDER BY n.updated_at_ms,n.observed_at_ms,n.id LIMIT ?`,
      [now - minimumAgeMs, limit],
    );
    return rows.map((row) => ({
      nodeId: String(row.node_id),
      nodeVersion: integer(row.node_version),
      admission: String(row.admission),
      configJson: String(row.config_json),
      capabilitiesJson: String(row.capabilities_json),
      observedAtMs:
        row.observed_at_ms === null ? null : integer(row.observed_at_ms),
      connectionId: String(row.provider_connection_id),
      connectionVersion: integer(row.connection_version),
      currentRevisionId: String(row.current_revision_id),
      revisionId: String(row.revision_id),
      endpointUrl: String(row.endpoint_ref),
      environmentId: String(row.provider_endpoint_id),
      apiKeyRef:
        row.secret_version_ref === null ? null : String(row.secret_version_ref),
      verifiedRuntimeIdentityId: String(row.verified_runtime_identity_id),
      runtimeIdentityId: String(row.runtime_identity_id),
      engineId: String(row.engine_id),
      architecture: String(row.architecture),
      cpuMillis: integer(row.total_cpu_millis),
      memoryMiB: integer(row.total_memory_mib),
    }));
  }
  async recordPortainerObservation(
    snapshot: Awaited<
      ReturnType<SQLiteMachineNodeStore["duePortainerObservations"]>
    >[number],
    result: "healthy" | "degraded" | "unknown",
    observedAtMs?: number,
  ) {
    const time = this.now();
    const changes = await this.db.run(
      `UPDATE nodes SET observed_health=?,observed_at_ms=CASE WHEN ?='healthy' THEN ? ELSE observed_at_ms END,updated_at_ms=?
       WHERE id=? AND version=? AND admission='enabled' AND config_json=? AND capabilities_json=? AND observed_at_ms IS ?
         AND provider_connection_id=? AND runtime_identity_id=?
         AND EXISTS(
           SELECT 1 FROM provider_connections c JOIN provider_connection_revisions r
             ON r.id=c.current_revision_id AND r.connection_id=c.id
           WHERE c.id=nodes.provider_connection_id AND c.enabled=1 AND c.version=? AND c.current_revision_id=?
             AND c.runtime_identity_id=nodes.runtime_identity_id AND r.id=?
             AND r.verified_runtime_identity_id=nodes.runtime_identity_id
             AND r.endpoint_ref=? AND r.provider_endpoint_id=? AND r.secret_version_ref IS ?
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
        snapshot.connectionVersion,
        snapshot.currentRevisionId,
        snapshot.revisionId,
        snapshot.endpointUrl,
        snapshot.environmentId,
        snapshot.apiKeyRef,
      ],
    );
    return changes.changes === 1n;
  }
  async createMachine(input: {
    id?: string;
    name: string;
    hostOs: "linux" | "windows" | "macos";
    architecture: "amd64" | "arm64";
    capacity: { cpuMillis: number; memoryMiB: number; scratchMiB: number };
    operatorId: string;
  }) {
    const id = input.id ?? randomUUID(),
      poolId = randomUUID(),
      time = this.now();
    if (
      !input.name.trim() ||
      input.capacity.cpuMillis < 1 ||
      input.capacity.memoryMiB < 1 ||
      input.capacity.scratchMiB < 0 ||
      !Object.values(input.capacity).every(Number.isSafeInteger)
    )
      throw new RangeError("Invalid conservative machine budget");
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO machines(id,name,source,usage_mode,host_os,architecture,admission,desired_power,observed_power,power_lifecycle,capabilities_json,management_json,created_at_ms,updated_at_ms) VALUES(?,?,'local','shared',?,?,'disabled','on','unknown','unknown','{}','{}',?,?)",
        params: [id, input.name, input.hostOs, input.architecture, time, time],
      },
      {
        kind: "run",
        sql: "INSERT INTO capacity_pools(id,machine_id,total_cpu_millis,total_memory_mib,total_scratch_mib,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)",
        params: [
          poolId,
          id,
          input.capacity.cpuMillis,
          input.capacity.memoryMiB,
          input.capacity.scratchMiB,
          time,
          time,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO holds(id,machine_id,kind,reason,created_by_consumer_id,created_at_ms) VALUES(?,?,'infrastructure','External always-on Docker base runtime dependency',?,?)",
        params: [randomUUID(), id, input.operatorId, time],
      },
    ]);
    return {
      id,
      poolId,
      admission: "disabled",
      observedPower: "unknown",
      offline: false,
      powerEnabled: false,
      capacity: input.capacity,
    };
  }
  async registerNode(input: {
    name: string;
    machineId: string;
    connectionId: string;
    operatorId: string;
  }) {
    const connection = await this.db.get<Row>(
      "SELECT c.backend_kind,c.runtime_identity_id,c.current_revision_id,r.provider_endpoint_id,r.evidence_json FROM provider_connections c JOIN provider_connection_revisions r ON r.id=c.current_revision_id AND r.verified_runtime_identity_id=c.runtime_identity_id WHERE c.id=? AND c.enabled=1",
      [input.connectionId],
    );
    const machine = await this.db.get<Row>(
      "SELECT id,architecture,host_os FROM machines WHERE id=? AND admission='disabled'",
      [input.machineId],
    );
    const pool = await this.db.get<Row>(
      "SELECT id,total_cpu_millis,total_memory_mib,total_scratch_mib FROM capacity_pools WHERE machine_id=? AND parent_allocation_id IS NULL",
      [input.machineId],
    );
    if (!connection || !machine || !pool)
      throw new RangeError(
        "Node requires an existing disabled manual machine and verified connection revision",
      );
    const id = randomUUID(),
      time = this.now();
    const evidence = parseJson(String(connection.evidence_json));
    if (
      evidence.architecture !== machine.architecture ||
      evidence.os !== "linux" ||
      Number(pool.total_cpu_millis) > Number(evidence.cpuCount) * 1000 ||
      Number(pool.total_memory_mib) >
        Math.floor(Number(evidence.memoryBytes) / 1024 ** 2)
    )
      throw new RangeError(
        "Machine budget or Engine platform exceeds verified Linux runtime hardware evidence",
      );
    const operator = await this.db.get<Row>(
      "SELECT authorization_json,version FROM consumers WHERE id=? AND status='active'",
      [input.operatorId],
    );
    if (!operator)
      throw new RangeError("Active node registering operator not found");
    const authorization = parseJson(String(operator.authorization_json));
    const existingNodeIds = authorization.nodeIds;
    if (
      existingNodeIds !== "all" &&
      (!Array.isArray(existingNodeIds) ||
        existingNodeIds.some((value) => typeof value !== "string"))
    )
      throw new TypeError("Operator node authorization is invalid");
    const statements: import("./protocol.js").Statement[] = [
      {
        kind: "run",
        sql: "INSERT INTO nodes(id,machine_id,name,backend_kind,provider_connection_id,runtime_identity_id,pool_id,admission,observed_health,capabilities_json,config_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,'disabled','unknown','{}',?,?,?)",
        params: [
          id,
          input.machineId,
          input.name,
          String(connection.backend_kind),
          input.connectionId,
          String(connection.runtime_identity_id),
          String(pool.id),
          JSON.stringify({
            providerEndpointId: connection.provider_endpoint_id,
          }),
          time,
          time,
        ],
      },
    ];
    if (
      typeof evidence.unmanagedContainerCount === "number" &&
      evidence.unmanagedContainerCount > 0
    )
      statements.push({
        kind: "run",
        sql: "INSERT INTO holds(id,machine_id,kind,reason,created_by_consumer_id,created_at_ms) VALUES(?,?,'unmanaged_work',?,?,?)",
        params: [
          randomUUID(),
          input.machineId,
          `${evidence.unmanagedContainerCount} unowned Docker containers observed; manual inventory required`,
          input.operatorId,
          time,
        ],
      });
    if (existingNodeIds !== "all")
      statements.push({
        kind: "run",
        sql: "UPDATE consumers SET authorization_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND status='active'",
        params: [
          JSON.stringify({
            ...authorization,
            nodeIds: [...new Set([...existingNodeIds, id])],
          }),
          time,
          input.operatorId,
          Number(operator.version),
        ],
        expectChanges: 1,
      });
    await this.db.batchTransaction(statements);
    return {
      id,
      machineId: input.machineId,
      connectionId: input.connectionId,
      admission: "disabled",
      observedHealth: "unknown",
      capabilities: { verified: false },
      offline: false,
    };
  }

  async configureRuntime(input: {
    nodeId: string;
    expectedVersion: number;
    config: Readonly<Record<string, unknown>>;
    operatorId: string;
    requestId: string;
  }) {
    const node = await this.db.get<Row>(
      "SELECT n.machine_id,n.runtime_identity_id,n.backend_kind,n.config_json,n.version,r.native_id FROM nodes n JOIN runtime_identities r ON r.id=n.runtime_identity_id WHERE n.id=? AND n.backend_kind='portainer' AND n.admission='disabled'",
      [input.nodeId],
    );
    if (!node || Number(node.version) !== input.expectedVersion)
      throw new Error(
        "Node version changed or is not a disabled Portainer Node",
      );
    const oldConfig = parseJson(String(node.config_json)) as Record<
      string,
      unknown
    >;
    const time = this.now();
    const config = {
      ...oldConfig,
      executionMode: "portainer",
      runtimeProfile: input.config,
      admissionMode: "constant_online_manual_inventory",
    };
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE nodes SET config_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND admission='disabled'",
        params: [
          JSON.stringify(config),
          time,
          input.nodeId,
          input.expectedVersion,
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
            runtimeAgentId: (
              input.config.runtimeAgent as Record<string, unknown>
            ).id,
            accessHost: input.config.accessHost,
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

  async attestCapabilities(input: {
    nodeId: string;
    expectedVersion: number;
    engineId: string;
    dockerVersion: string;
    portainerVersion: string;
    architecture: "amd64" | "arm64";
    checkedAt: string;
    report: Readonly<{
      runId: string;
      sha256: string;
      scopes: Readonly<
        Record<
          string,
          Readonly<{ status: "passed"; summary: string; evidenceRef: string }>
        >
      >;
    }>;
    networkProfileRevisionIds: readonly string[];
    operatorId: string;
    requestId: string;
  }) {
    const node = await this.db.get<Row>(
      "SELECT n.machine_id,n.runtime_identity_id,n.pool_id,n.config_json,n.version,m.architecture,m.admission AS machine_admission,pc.current_revision_id,ri.native_id,r.evidence_json FROM nodes n JOIN machines m ON m.id=n.machine_id JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=n.runtime_identity_id JOIN runtime_identities ri ON ri.id=n.runtime_identity_id JOIN provider_connection_revisions r ON r.id=pc.current_revision_id AND r.verified_runtime_identity_id=n.runtime_identity_id WHERE n.id=? AND n.backend_kind='portainer' AND n.admission='disabled'",
      [input.nodeId],
    );
    const checkedAt = Date.parse(input.checkedAt),
      now = this.now();
    if (
      !node ||
      Number(node.version) !== input.expectedVersion ||
      typeof node.current_revision_id !== "string"
    )
      throw new Error(
        "Node version changed or Node is not ready for manual capability attestation",
      );
    const providerEvidence = parseJson(String(node.evidence_json)) as Record<
      string,
      unknown
    >;
    if (
      String(node.native_id) !== input.engineId ||
      providerEvidence.dockerVersion !== input.dockerVersion ||
      providerEvidence.portainerVersion !== input.portainerVersion ||
      String(node.architecture) !== input.architecture ||
      input.checkedAt === "" ||
      !Number.isFinite(checkedAt) ||
      checkedAt > now + 30_000 ||
      checkedAt < now - 30 * 60_000 ||
      Object.keys(input.report.scopes).length !== 6
    )
      throw new RangeError(
        "Manual test report must match the current Engine and include all six passed test scopes",
      );
    const revisions = await this.db.all<Row>(
      `SELECT id FROM network_profile_revisions WHERE id IN (${input.networkProfileRevisionIds.map(() => "?").join(",")})`,
      [...input.networkProfileRevisionIds],
    );
    if (revisions.length !== input.networkProfileRevisionIds.length)
      throw new RangeError(
        "Capability report references an unknown network revision",
      );
    const config = parseJson(String(node.config_json)) as Record<
      string,
      unknown
    >;
    if (config.executionMode !== "portainer" || !config.runtimeProfile)
      throw new RangeError(
        "Runtime Agent and network baseline must be configured before capability attestation",
      );
    if (node.pool_id === undefined || node.pool_id === null)
      throw new Error("Node capacity pool is unavailable");
    const pool = await this.db.get<Row>(
      "SELECT total_cpu_millis,total_memory_mib,total_scratch_mib FROM capacity_pools WHERE id=?",
      [node.pool_id],
    );
    if (!pool) throw new Error("Node capacity pool is unavailable");
    const capabilityFingerprint = hash(
      JSON.stringify({
        engineId: input.engineId,
        connectionRevisionId: String(node.current_revision_id),
        dockerVersion: input.dockerVersion,
        portainerVersion: input.portainerVersion,
        architecture: input.architecture,
        checkedAt: input.checkedAt,
        networkProfileRevisionIds: input.networkProfileRevisionIds,
        report: input.report,
      }),
    );
    const capability = {
      cpuHardLimit: "verified",
      memoryHardLimit: "verified",
      scratchHardLimit: "unsupported",
      networkPolicyEnforcement: "verified",
      storagePolicyEnforcement: "unsupported",
      supportedAccess: ["ssh"],
      resourceKinds: ["container"],
      architectures: [input.architecture],
      guestOs: ["linux"],
      capacity: {
        cpuMillis: integer(pool.total_cpu_millis),
        memoryMiB: integer(pool.total_memory_mib),
        scratchMiB: integer(pool.total_scratch_mib),
      },
      verifiedNetworkProfileRevisionIds: [...input.networkProfileRevisionIds],
      verifiedStorageProfileRevisionIds: [],
      providerVersion: `Portainer/${input.portainerVersion}; Docker/${input.dockerVersion}`,
      expiresAt: new Date(checkedAt + 60 * 60_000).toISOString(),
      observedAt: new Date(checkedAt).toISOString(),
      capabilityFingerprint,
      admissionMode: "constant_online_manual_inventory",
      connectionRevisionId: String(node.current_revision_id),
      offline: false,
      powerEnabled: false,
      manualReport: input.report,
    };
    const time = this.now();
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE machines SET admission='enabled',desired_power='on',observed_power='on',power_lifecycle='idle',version=version+1,updated_at_ms=? WHERE id=? AND admission='disabled'",
        params: [time, String(node.machine_id)],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE nodes SET admission='enabled',observed_health='healthy',capabilities_json=?,observed_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND admission='disabled' AND runtime_identity_id=(SELECT id FROM runtime_identities WHERE native_id=?)",
        params: [
          JSON.stringify(capability),
          checkedAt,
          time,
          input.nodeId,
          input.expectedVersion,
          input.engineId,
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
            engineId: input.engineId,
            capabilityFingerprint,
            reportRunId: input.report.runId,
            reportSha256: input.report.sha256,
            admissionMode: "constant_online_manual_inventory",
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
