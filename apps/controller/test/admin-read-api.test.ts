import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { AdminService } from "../src/application/admin.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
const dbs: Awaited<ReturnType<typeof openStorage>>[] = [];
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-admin-read-"));
  dirs.push(dir);
  const db = await openStorage(dir);
  dbs.push(db);
  const adminId = randomUUID();
  const now = Date.now();
  await db.run(
    "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,'admin','human','admin',?,?,?,?)",
    [
      adminId,
      JSON.stringify({
        imageIds: "all",
        nodeIds: "all",
        networkProfileIds: "all",
        storageProfileIds: "all",
      }),
      JSON.stringify({ maxQueuedTickets: 10 }),
      now,
      now,
    ],
  );
  await db.run(
    "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
    [randomUUID(), now],
  );
  const token = `hcl_${"a".repeat(43)}`;
  await db.run(
    "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
    [
      randomUUID(),
      adminId,
      token.slice(0, 12),
      createHash("sha256").update(token).digest("hex"),
      JSON.stringify([
        "tickets:read",
        "tickets:write",
        "tickets:revoke",
        "images:read",
        "events:read",
      ]),
      now,
    ],
  );
  return { dir, db, adminId, token };
}

afterEach(async () => {
  await Promise.all(
    dbs.splice(0).map((db) => db.close().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("administrator read projections", () => {
  it("lists every version status, validation history, and alias CAS state under full admin auth", async () => {
    const { dir, db, adminId, token } = await setup();
    const admin = new AdminService(db, async () => {
      throw new Error("unused");
    });
    const draft = await admin.createDraft({
      name: "Admin image",
      description: "read projection fixture",
      version: "v1",
      architecture: "amd64",
      artifactRef: `registry.test/image@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
      minimumResources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
      bootstrap: {
        mechanism: "cloud-init",
        contractVersion: "1",
        identityReset: true,
      },
      access: {
        accessProtocols: ["ssh"],
        ports: [22],
        account: "worker",
        allowedSourceCidrs: [],
        discovery: "test",
        readiness: "test",
      },
      authorizedConsumerIds: [adminId],
    });
    await db.run(
      "INSERT INTO image_aliases(image_id,alias,image_version_id,version) VALUES(?,'latest',?,3)",
      [draft.imageId, draft.versionId],
    );
    const app = await buildApp(loadConfig({ DATA_DIR: dir }), { storage: db });
    try {
      const headers = { authorization: `Bearer ${token}` };
      const listed = await app.inject({
        method: "GET",
        url: "/v1/admin/image-versions",
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toHaveLength(1);
      expect(listed.json()[0]).toMatchObject({
        id: draft.versionId,
        status: "draft",
        entityVersion: 1,
        artifacts: [{ digest: draft.digest }],
      });
      expect(listed.body).not.toContain("secretVersionRef");
      expect(listed.body).not.toContain("tokenSecretRef");

      const history = await app.inject({
        method: "GET",
        url: `/v1/admin/image-versions/${draft.versionId}/validations`,
        headers,
      });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toEqual([]);
      const missingHistory = await app.inject({
        method: "GET",
        url: `/v1/admin/image-versions/${randomUUID()}/validations`,
        headers,
      });
      expect(missingHistory.statusCode).toBe(404);

      const aliases = await app.inject({
        method: "GET",
        url: `/v1/admin/images/${draft.imageId}/aliases`,
        headers,
      });
      expect(aliases.statusCode).toBe(200);
      expect(aliases.json()).toEqual([
        {
          imageId: draft.imageId,
          alias: "latest",
          versionId: draft.versionId,
          version: 3,
        },
      ]);
      const missingAliases = await app.inject({
        method: "GET",
        url: `/v1/admin/images/${randomUUID()}/aliases`,
        headers,
      });
      expect(missingAliases.statusCode).toBe(404);
      const missingCacheOperation = await app.inject({
        method: "GET",
        url: `/v1/nodes/${randomUUID()}/image-cache/operations/${randomUUID()}`,
        headers,
      });
      expect(missingCacheOperation.statusCode).toBe(404);

      const openapi = (
        await app.inject({ method: "GET", url: "/v1/openapi.json" })
      ).json();
      for (const path of [
        "/v1/admin/image-versions",
        "/v1/admin/image-versions/{versionId}/validations",
        "/v1/admin/images/{imageId}/aliases",
        "/v1/nodes/{nodeId}/image-cache/operations/{operationId}",
      ])
        expect(openapi.paths[path].get).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("rejects restricted credentials at the new admin read routes", async () => {
    const { dir, db, adminId } = await setup();
    const token = `hcl_${"r".repeat(43)}`;
    await db.run(
      "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      [
        randomUUID(),
        adminId,
        token.slice(0, 12),
        createHash("sha256").update(token).digest("hex"),
        JSON.stringify(["tickets:read"]),
        Date.now(),
      ],
    );
    const app = await buildApp(loadConfig({ DATA_DIR: dir }), { storage: db });
    try {
      for (const url of [
        "/v1/admin/image-versions",
        `/v1/admin/image-versions/${randomUUID()}/validations`,
        `/v1/admin/images/${randomUUID()}/aliases`,
        `/v1/nodes/${randomUUID()}/image-cache/operations/${randomUUID()}`,
      ]) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });
});
