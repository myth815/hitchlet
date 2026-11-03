import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openStorage } from "../dist/storage/index.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { roleScopes } from "../src/domain/role-scopes.js";
import { SQLiteImagePublicationStore } from "../src/storage/image-publication-store.js";
import { ImagePublishingService } from "../src/application/image-publishing.js";
const roots: string[] = [];
const dbs: Awaited<ReturnType<typeof openStorage>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) await db.close();
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-hyperv-draft-"));
  roots.push(dir);
  const db = await openStorage(dir);
  dbs.push(db);
  const adminId = randomUUID(),
    now = Date.now(),
    token = "hcl_" + "a".repeat(43);
  await db.run(
    'INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,\'fixture\',\'human\',\'admin\',\'{"imageIds":"all","nodeIds":"all","networkProfileIds":"all","storageProfileIds":"all"}\',\'{"maxQueuedTickets":10}\',?,?)',
    [adminId, now, now],
  );
  await db.run(
    "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
    [randomUUID(), now],
  );
  await db.run(
    "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
    [
      randomUUID(),
      adminId,
      token.slice(0, 12),
      createHash("sha256").update(token).digest("hex"),
      JSON.stringify(roleScopes("admin")),
      now,
    ],
  );
  const app = await buildApp(
    loadConfig({ DATA_DIR: dir, LOG_LEVEL: "silent" }),
    { storage: db },
  );
  return { dir, db, adminId, token, app };
}
function draft(consumerId: string, os: "windows" | "linux") {
  return {
    name: "Hyper-V " + os,
    version: "v1",
    backendKind: "hyperv",
    kind: "vm",
    architecture: "amd64",
    guestOs: os,
    artifactRef: os + "-test-v1",
    digest: "sha256:" + "b".repeat(64),
    minimumResources: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
    bootstrap: {
      mechanism: "hyperv-guest-bootstrap-v1",
      contractVersion: "1",
      identityReset: true,
    },
    access: {
      accessProtocols: ["ssh"],
      ports: [22],
      account: "workspace",
      allowedSourceCidrs: [],
      discovery: "guest_ipv4",
      readiness: "authenticated_ssh",
    },
    authorizedConsumerIds: [consumerId],
  };
}
it.each(["windows", "linux"] as const)(
  "creates and reads a normal %s Hyper-V draft without publishing or provisioning",
  async (os) => {
    const f = await setup();
    try {
      const headers = { authorization: "Bearer " + f.token };
      const created = await f.app.inject({
        method: "POST",
        url: "/v1/images",
        headers,
        payload: draft(f.adminId, os),
      });
      expect(created.statusCode, created.body).toBe(201);
      const ids = created.json();
      const got = await f.app.inject({
        method: "GET",
        url: "/v1/admin/image-versions/" + ids.versionId,
        headers,
      });
      expect(got.statusCode, got.body).toBe(200);
      expect(got.json()).toMatchObject({
        version: {
          status: "draft",
          manifest: {
            platform: {
              provider: "hyperv",
              kind: "vm",
              architecture: "amd64",
              guestOs: os,
            },
          },
        },
        artifacts: [{ provider: "hyperv", guestOs: os, architecture: "amd64" }],
      });
      const count = await f.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM allocations",
      );
      expect(Number(count?.n)).toBe(0);
      const publish = await new ImagePublishingService(f.db, async () => {
        throw Error("must not probe Docker");
      })
        .publish(ids.versionId, 1)
        .catch(() => undefined);
      expect(publish).toBeUndefined();
      expect(
        (
          await f.db.get<{ status: string }>(
            "SELECT status FROM image_versions WHERE id=?",
            [ids.versionId],
          )
        )?.status,
      ).toBe("draft");
    } finally {
      await f.app.close();
    }
  },
);
it("does not route a native publication verification into a Docker probe", async () => {
  const f = await setup();
  try {
    const docker = vi.fn(async () => {
      throw Error("unexpected");
    });
    vi.spyOn(
      SQLiteImagePublicationStore.prototype,
      "publish",
    ).mockImplementation(async (_id, _version, verify) => {
      expect(await verify({ backendKind: "hyperv" } as never)).toBe(false);
      return undefined;
    });
    await expect(
      new ImagePublishingService(f.db, docker).publish(randomUUID(), 1),
    ).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
  } finally {
    await f.app.close();
  }
});
