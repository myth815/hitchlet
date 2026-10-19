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
}
