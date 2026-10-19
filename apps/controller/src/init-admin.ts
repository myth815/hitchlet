import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openStorage } from "./storage/index.js";

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error("Set DATA_DIR");
const db = await openStorage(dataDir);
try {
  const initialized = await db.get<{ n: bigint }>(
    "SELECT count(*) AS n FROM installations",
  );
  const consumers = await db.get<{ n: bigint }>(
    "SELECT count(*) AS n FROM consumers",
  );
  if (Number(initialized?.n ?? 0n) !== 0 || Number(consumers?.n ?? 0n) !== 0)
    throw new Error("Refusing to bootstrap a non-empty Hitchlet installation");
  const now = Date.now(),
    installationId = randomUUID(),
    adminId = randomUUID(),
    credentialId = randomUUID(),
    policyId = randomUUID();
  const token = `hcl_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const quota = {
    maxQueuedTickets: 10,
    maxActiveTickets: 2,
    maxLeaseTtlSeconds: 1800,
    maxLifetimeSeconds: 86400,
    maxResources: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 4096 },
    defaultExpiryPolicyId: policyId,
  };
  await db.batchTransaction([
    {
      kind: "run",
      sql: "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES(?,'Initial administrator expiry policy','lifecycle','{}',?,?)",
      params: [policyId, now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,'Initial Hitchlet administrator','human','admin',?,?,?,?)",
      params: [
        adminId,
        JSON.stringify({
          imageIds: [],
          nodeIds: [],
          networkProfileIds: [],
          storageProfileIds: [],
        }),
        JSON.stringify(quota),
        now,
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
      params: [installationId, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      params: [
        credentialId,
        adminId,
        token.slice(0, 12),
        tokenHash,
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
  ]);
  process.stdout.write(`${token}\n`);
} finally {
  await db.close();
}
