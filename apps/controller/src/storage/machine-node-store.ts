import { randomUUID } from "node:crypto";
import { StorageError, type Storage } from "./index.js";
import { ApplicationError } from "../application/errors.js";
import {
  evaluateMachineAdmission,
  resourceKeys,
  zeroResources,
} from "../domain/human-use.js";
import {
  loadMachineAdmission,
  machineAdmissionFence,
  policyContext,
  type MachineAdmissionSnapshot,
} from "./human-use-guard.js";
import {
  HumanUsePolicySchema,
  type HumanUsePolicy,
} from "@hitchlet/contracts/admin";
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
  async updateNodeAdmissionMode(input: {
    nodeId: string;
    expectedVersion: number;
    mode: "observed_host" | "constant_online_manual_inventory";
    reason: string;
    operatorId: string;
    requestId: string;
  }) {
    const row = await this.db.get<Row>(
      "SELECT capabilities_json,version FROM nodes WHERE id=? AND admission<>'retired'",
      [input.nodeId],
    );
    if (!row) throw new ApplicationError("not_found");
    if (integer(row.version) !== input.expectedVersion)
      throw new ApplicationError("conflict");
    const capabilities = parseJson(String(row.capabilities_json)),
      time = this.now();
    try {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: "UPDATE nodes SET capabilities_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=? AND capabilities_json=? AND admission<>'retired'",
          params: [
            JSON.stringify({ ...capabilities, admissionMode: input.mode }),
            time,
            input.nodeId,
            input.expectedVersion,
            String(row.capabilities_json),
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'node.admission_mode_updated','node',?,?,?,?)",
          params: [
            input.operatorId,
            input.nodeId,
            input.requestId,
            time,
            JSON.stringify({ mode: input.mode, reason: input.reason }),
          ],
        },
      ]);
    } catch (error) {
      if (error instanceof StorageError && error.code === "STORAGE_CAS_FAILED")
        throw new ApplicationError("conflict");
      throw error;
    }
    return {
      nodeId: input.nodeId,
      version: input.expectedVersion + 1,
      mode: input.mode,
    };
  }
  async listMachineDependencies() {
    const rows = await this.db.all<Row>(
      "SELECT id FROM machines ORDER BY created_at_ms,id",
    );
    const now = this.now();
    return Promise.all(
      rows.map(async (row) =>
        projectMachine(
          await loadMachineAdmission(this.db, String(row.id), now),
          now,
        ),
      ),
    );
  }
  async machineDryRun(machineId: string) {
    const now = this.now();
    return projectMachine(
      await loadMachineAdmission(this.db, machineId, now),
      now,
    );
  }
  async machinePolicyDryRun(input: {
    machineId: string;
    expectedVersion: number;
    policy: HumanUsePolicy;
  }) {
    const policy = HumanUsePolicySchema.parse(input.policy),
      now = this.now();
    const snapshot = await loadMachineAdmission(this.db, input.machineId, now);
    if (snapshot.data.machine?.version !== input.expectedVersion)
      throw new ApplicationError("conflict");
    const proposed = { ...snapshot, context: policyContext(snapshot, policy) };
    const updateDisabledReasons = policyUpdateReasons(proposed);
    return {
      machine: projectMachine(proposed, now),
      canApply: updateDisabledReasons.length === 0,
      updateDisabledReasons,
    };
  }
  async updateHumanUsePolicy(input: {
    machineId: string;
    expectedVersion: number;
    policy: HumanUsePolicy;
    operatorId: string;
    requestId: string;
  }) {
    const policy = HumanUsePolicySchema.parse(input.policy),
      time = this.now();
    const snapshot = await loadMachineAdmission(this.db, input.machineId, time);
    if (snapshot.data.machine?.version !== input.expectedVersion)
      throw new ApplicationError("conflict");
    if (
      policyUpdateReasons({
        ...snapshot,
        context: policyContext(snapshot, policy),
      }).length
    )
      throw new ApplicationError("invalid_request");
    try {
      await this.db.batchTransaction([
        machineAdmissionFence(snapshot),
        {
          kind: "run",
          sql: "UPDATE machines SET management_json=?,version=version+1,updated_at_ms=? WHERE id=? AND version=?",
          params: [
            JSON.stringify({
              ...snapshot.data.machine.management,
              humanUsePolicy: policy,
            }),
            time,
            input.machineId,
            input.expectedVersion,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "UPDATE capacity_pools SET system_cpu_millis=?,system_memory_mib=?,system_scratch_mib=?,version=version+1,updated_at_ms=? WHERE machine_id=? AND parent_allocation_id IS NULL",
          params: [
            policy.systemReserve.cpuMillis,
            policy.systemReserve.memoryMiB,
            policy.systemReserve.scratchMiB,
            time,
            input.machineId,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json) VALUES('consumer',?,'machine.human_use_policy_updated','machine',?,?,?,?)",
          params: [
            input.operatorId,
            input.machineId,
            input.requestId,
            time,
            JSON.stringify({ version: input.expectedVersion + 1, policy }),
          ],
        },
      ]);
    } catch (error) {
      if (error instanceof StorageError && error.code === "STORAGE_CAS_FAILED")
        throw new ApplicationError("conflict");
      throw error;
    }
    return {
      machineId: input.machineId,
      version: input.expectedVersion + 1,
      policy,
    };
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

/** Policy ceilings can be reduced below existing use: those claims remain charged and new
 * admission stops. A new physical reserve may not confiscate already occupied capacity. */
function policyUpdateReasons(snapshot: MachineAdmissionSnapshot): string[] {
  const roots = snapshot.context.pools.filter(
    (p) => p.parentAllocationId === null,
  );
  const root = roots[0],
    policy = snapshot.context.policy;
  if (!root || roots.length !== 1 || !policy)
    return ["One physical root pool and valid policy are required"];
  const used = snapshot.context.claims
    .filter((c) => c.poolId === root.id && c.state !== "released")
    .reduce(
      (sum, c) => ({
        cpuMillis: sum.cpuMillis + c.resources.cpuMillis,
        memoryMiB: sum.memoryMiB + c.resources.memoryMiB,
        scratchMiB: sum.scratchMiB + c.resources.scratchMiB,
      }),
      zeroResources(),
    );
  return resourceKeys.flatMap((k) =>
    policy.systemReserve[k] + policy.unattendedMaximum[k] > root.capacity[k] ||
    policy.systemReserve[k] + policy.attendedMaximum[k] > root.capacity[k]
      ? [`Policy ${k} ceiling plus reserve exceeds root capacity`]
      : used[k] + policy.systemReserve[k] > root.capacity[k]
        ? [`Reserve ${k} conflicts with unreleased physical claims`]
        : [],
  );
}
function projectMachine(snapshot: MachineAdmissionSnapshot, now: number) {
  const { context, data } = snapshot,
    machine = data.machine!;
  const nodes = context.nodes.map((n) => {
    const result = evaluateMachineAdmission(context, now, n.id);
    const pool = context.pools.find((p) => p.id === n.poolId);
    return {
      id: n.id,
      name: n.name,
      version: data.nodes.find((row) => row.id === n.id)!.version,
      admission: n.admission,
      observedHealth: n.observedHealth,
      poolId: n.poolId,
      parentAllocationId: pool?.parentAllocationId ?? null,
      dependencies: [`machine:${machine.id}`, `pool:${n.poolId}`],
      admissionMode: n.manualInventory
        ? ("constant_online_manual_inventory" as const)
        : ("observed_host" as const),
      admissionAssurance: result.admissionAssurance,
      limitations: result.limitations,
      canAdmit: result.allowed,
      disabledReasons: result.reasons,
      available: result.available,
    };
  });
  const first = nodes.find((n) => n.canAdmit) ?? nodes[0];
  const result = evaluateMachineAdmission(context, now, first?.id);
  const root = context.pools.find((p) => p.parentAllocationId === null);
  const tree: {
    key: string;
    parentKey: string | null;
    kind: "machine" | "pool" | "node" | "allocation";
    id: string;
    name: string;
    purpose: string | null;
    claimed: ReturnType<typeof zeroResources>;
  }[] = [
    {
      key: `machine:${machine.id}`,
      parentKey: null,
      kind: "machine",
      id: machine.id,
      name: machine.name,
      purpose: null,
      claimed: result.physicalUsage,
    },
    ...context.pools.map((p) => ({
      key: `pool:${p.id}`,
      parentKey:
        p.parentAllocationId === null
          ? `machine:${machine.id}`
          : `allocation:${p.parentAllocationId}`,
      kind: "pool" as const,
      id: p.id,
      name:
        p.parentAllocationId === null
          ? "Physical root pool"
          : "Infrastructure child pool",
      purpose: null,
      claimed: result.usage.get(p.id) ?? zeroResources(),
    })),
    ...context.nodes.map((n) => ({
      key: `node:${n.id}`,
      parentKey: `pool:${n.poolId}`,
      kind: "node" as const,
      id: n.id,
      name: n.name,
      purpose: null,
      claimed: zeroResources(),
    })),
    ...context.allocations.map((a) => ({
      key: `allocation:${a.id}`,
      parentKey: `node:${a.nodeId}`,
      kind: "allocation" as const,
      id: a.id,
      name: `${a.purpose} · ${a.observedState} / ${a.cleanupStatus}`,
      purpose: a.purpose,
      claimed: context.claims
        .filter((c) => c.allocationId === a.id && c.state !== "released")
        .reduce(
          (sum, c) => ({
            cpuMillis: sum.cpuMillis + c.resources.cpuMillis,
            memoryMiB: sum.memoryMiB + c.resources.memoryMiB,
            scratchMiB: sum.scratchMiB + c.resources.scratchMiB,
          }),
          zeroResources(),
        ),
    })),
  ];
  return {
    machineId: machine.id,
    name: machine.name,
    usageMode: machine.usageMode,
    admission: machine.admission,
    version: machine.version,
    hostObservation: result.hostObservation,
    capacity: root?.capacity ?? zeroResources(),
    systemReserve: root?.reserve ?? zeroResources(),
    humanUsePolicy: result.policy,
    policySource: context.policy
      ? ("configured" as const)
      : result.manual
        ? ("manual_inventory_frozen_budget" as const)
        : ("missing" as const),
    physicalUsage: result.physicalUsage,
    workloadUsage: result.workloadUsage,
    holds: context.holds.map(({ id, kind, reason }) => ({ id, kind, reason })),
    dependencyTree: tree,
    shutdownDisabledReasons: result.shutdownReasons,
    canAdmitTenants: nodes.some((n) => n.canAdmit),
    disabledReasons: nodes.some((n) => n.canAdmit) ? [] : result.reasons,
    nodes,
  };
}
