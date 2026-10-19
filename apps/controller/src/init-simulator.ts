import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openStorage } from "./storage/index.js";

const dataDir = process.env.DATA_DIR;
if (!dataDir)
  throw new Error("Set DATA_DIR to the explicit simulator database directory");
const storage = await openStorage(dataDir);
const now = Date.now();
const ids = {
  installation: randomUUID(),
  consumer: randomUUID(),
  credential: randomUUID(),
  admin: randomUUID(),
  adminCredential: randomUUID(),
  image: randomUUID(),
  version: randomUUID(),
  artifact: randomUUID(),
  imageAlias: "latest",
  network: randomUUID(),
  networkRevision: randomUUID(),
  machine: randomUUID(),
  pool: randomUUID(),
  node: randomUUID(),
  runtime: randomUUID(),
  connection: randomUUID(),
  connectionRevision: randomUUID(),
  denyRevision: randomUUID(),
  policy: randomUUID(),
};
const token = `hcl_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const adminToken = `hcl_${randomBytes(32).toString("base64url")}`;
const adminTokenHash = createHash("sha256").update(adminToken).digest("hex");
const auth = {
  imageIds: [ids.image],
  nodeIds: [ids.node],
  networkProfileIds: [ids.network],
  storageProfileIds: [],
};
const quota = {
  maxQueuedTickets: 10,
  maxActiveTickets: 2,
  maxLeaseTtlSeconds: 1800,
  maxLifetimeSeconds: 86400,
  maxResources: { cpuMillis: 3000, memoryMiB: 4096, scratchMiB: 8192 },
  defaultExpiryPolicyId: ids.policy,
};
try {
  const existing = await storage.get<{ count: bigint }>(
    "SELECT count(*) AS count FROM consumers",
  );
  const seeded = await storage.get<{ count: bigint }>(
    "SELECT count(*) AS count FROM installations",
  );
  if (Number(existing?.count ?? 0n) || Number(seeded?.count ?? 0n))
    throw new Error(
      "Refusing to initialize a non-empty Hitchlet data directory",
    );
  await storage.batchTransaction([
    {
      kind: "run",
      sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,?,'service','consumer',?,?,?,?)",
      params: [
        ids.consumer,
        "Simulator sample consumer",
        JSON.stringify(auth),
        JSON.stringify(quota),
        now,
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,?,'human','admin',?,?,?,?)",
      params: [
        ids.admin,
        "Initial Hitchlet administrator",
        JSON.stringify({
          imageIds: "all",
          nodeIds: "all",
          networkProfileIds: "all",
          storageProfileIds: "all",
        }),
        JSON.stringify(quota),
        now,
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
      params: [ids.installation, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      params: [
        ids.credential,
        ids.consumer,
        token.slice(0, 12),
        tokenHash,
        JSON.stringify([
          "tickets:read",
          "tickets:write",
          "images:read",
          "events:read",
        ]),
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      params: [
        ids.adminCredential,
        ids.admin,
        adminToken.slice(0, 12),
        adminTokenHash,
        JSON.stringify([
          "tickets:read",
          "tickets:write",
          "tickets:revoke",
          "images:read",
          "events:read",
        ]),
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO images(id,name,description,created_at_ms) VALUES(?,?,?,?)",
      params: [
        ids.image,
        "Simulator Linux",
        "Explicit local Simulator image fixture",
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO image_versions(id,image_id,version,status,manifest_json,created_at_ms,published_at_ms) VALUES(?,?,'1','published','{}',?,?)",
      params: [ids.version, ids.image, now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO image_aliases(image_id,alias,image_version_id) VALUES(?,?,?)",
      params: [ids.image, ids.imageAlias, ids.version],
    },
    {
      kind: "run",
      sql: "INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,access_recipe_json,created_at_ms) VALUES(?,?,'portainer','container','amd64','linux','simulator:sample','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,0,'{\"accessProtocols\":[\"ssh\"]}',?)",
      params: [ids.artifact, ids.version, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO network_profiles(id,name,created_at_ms) VALUES(?,?,?)",
      params: [ids.network, "Simulator isolated network", now],
    },
    {
      kind: "run",
      sql: 'INSERT INTO network_profile_revisions(id,profile_id,revision,policy_json,created_at_ms) VALUES(?,?,1,\'{"allowedEgress":[],"allowedIngressSourceCidrs":[],"ipv6":"disabled"}\',?)',
      params: [ids.networkRevision, ids.network, now],
    },
    {
      kind: "run",
      sql: "UPDATE network_profiles SET current_revision_id=? WHERE id=?",
      params: [ids.networkRevision, ids.network],
    },
    {
      kind: "run",
      sql: "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES(?,?,'lifecycle','{}',?,?)",
      params: [ids.policy, "Simulator lifecycle", now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO platform_network_deny_revisions(id,revision,management_deny_rules_json,reason,created_by_consumer_id,created_at_ms) VALUES(?,1,'[]','explicit simulator seed',?,?)",
      params: [ids.denyRevision, ids.consumer, now],
    },
    {
      kind: "run",
      sql: "UPDATE installations SET current_network_deny_revision_id=? WHERE singleton=1",
      params: [ids.denyRevision],
    },
    {
      kind: "run",
      sql: "INSERT INTO runtime_identities(id,backend_kind,native_kind,native_id,created_at_ms) VALUES(?,'portainer','docker_engine','hitchlet-simulator',?)",
      params: [ids.runtime, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO provider_connections(id,backend_kind,runtime_identity_id,created_at_ms,updated_at_ms) VALUES(?,'portainer',?,?,?)",
      params: [ids.connection, ids.runtime, now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) VALUES(?,?,1,'simulator://local','simulator',?,?,?,?)",
      params: [
        ids.connectionRevision,
        ids.connection,
        ids.runtime,
        now,
        JSON.stringify({ executionMode: "simulator" }),
        now,
      ],
    },
    {
      kind: "run",
      sql: "UPDATE provider_connections SET current_revision_id=? WHERE id=?",
      params: [ids.connectionRevision, ids.connection],
    },
    {
      kind: "run",
      sql: "INSERT INTO machines(id,name,usage_mode,host_os,architecture,admission,observed_power,labels_json,created_at_ms,updated_at_ms) VALUES(?,?,'dedicated','linux','amd64','enabled','on','{}',?,?)",
      params: [ids.machine, "Simulator node", now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO capacity_pools(id,machine_id,total_cpu_millis,total_memory_mib,total_scratch_mib,system_cpu_millis,system_memory_mib,system_scratch_mib,created_at_ms,updated_at_ms) VALUES(?,?,4000,8192,12000,1000,1024,1000,?,?)",
      params: [ids.pool, ids.machine, now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO nodes(id,machine_id,name,backend_kind,provider_connection_id,runtime_identity_id,pool_id,admission,observed_health,capabilities_json,config_json,observed_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,'Simulator node','portainer',?,?,?,'enabled','healthy',?,?, ?,?,?)",
      params: [
        ids.node,
        ids.machine,
        ids.connection,
        ids.runtime,
        ids.pool,
        JSON.stringify({
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 3600000).toISOString(),
          providerVersion: "simulator",
          resourceKinds: ["container"],
          guestOs: ["linux"],
          architectures: ["amd64"],
          cpuHardLimit: "verified",
          memoryHardLimit: "verified",
          scratchHardLimit: "unverified",
          offlineLeaseEnforcement: "unsupported",
          networkPolicyEnforcement: "verified",
          supportedAccess: ["ssh"],
          verifiedNetworkProfileRevisionIds: [ids.networkRevision],
          verifiedStorageProfileRevisionIds: [],
          accelerators: [],
          reportId: randomUUID(),
        }),
        JSON.stringify({
          executionMode: "simulator",
          simulatorFixtureInstallationId: ids.installation,
        }),
        now,
        now,
        now,
      ],
    },
  ]);
  console.log(`Simulator initialized. Consumer ID: ${ids.consumer}`);
  console.log(`Bearer token (shown once): ${token}`);
  console.log(`Initial admin ID: ${ids.admin}`);
  console.log(`Initial admin bearer token (shown once): ${adminToken}`);
  console.log(`Image version: ${ids.version}`);
  console.log(`Image alias: ${ids.image}/latest`);
  console.log(`Network profile: ${ids.network}`);
} finally {
  await storage.close();
}
