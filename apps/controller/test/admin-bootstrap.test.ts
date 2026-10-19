import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { AdminService } from "../src/application/admin.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
const dbs: Awaited<ReturnType<typeof openStorage>>[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(
    apps.splice(0).map((app) => app.close().catch(() => undefined)),
  );
  await Promise.all(
    dbs.splice(0).map((db) => db.close().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("real empty-install administrator bootstrap", () => {
  it("creates a deny baseline, refuses reset, gates metadata, and authorizes the registering admin for the Node", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-admin-bootstrap-"));
    dirs.push(dir);
    const initializer = join(process.cwd(), "dist/init-admin.js");
    const runInit = () =>
      spawnSync(process.execPath, [initializer], {
        encoding: "utf8",
        env: { ...process.env, DATA_DIR: dir },
      });
    const initial = runInit();
    expect(initial.status).toBe(0);
    const token = initial.stdout.trim();
    expect(token).toMatch(/^hcl_[A-Za-z0-9_-]{43}$/);

    const reset = runInit();
    expect(reset.status).not.toBe(0);
    expect(reset.stdout).toBe("");
    expect(reset.stderr).toContain("Refusing to bootstrap a non-empty");

    const db = await openStorage(dir);
    dbs.push(db);
    const installation = await db.get<{
      installation_id: string;
      controller_epoch: bigint;
      revision_id: string;
      revision: bigint;
      management_deny_rules_json: string;
      reason: string;
    }>(
      "SELECT i.installation_id,i.controller_epoch,r.id AS revision_id,r.revision,r.management_deny_rules_json,r.reason FROM installations i JOIN platform_network_deny_revisions r ON r.id=i.current_network_deny_revision_id WHERE i.singleton=1",
    );
    expect(installation).toMatchObject({
      controller_epoch: 1n,
      revision: 1n,
      management_deny_rules_json: "[]",
    });
    expect(installation?.reason).toMatch(/empty until explicitly configured/);
    const adminId = String(
      (
        await db.get<{ id: string }>(
          "SELECT id FROM consumers WHERE role='admin'",
        )
      )?.id,
    );

    const viewerId = randomUUID();
    const viewerToken = `hcl_${"v".repeat(43)}`;
    const now = Date.now();
    await db.batchTransaction([
      {
        kind: "run",
        sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,'Viewer','human','viewer',?,?,?,?)",
        params: [
          viewerId,
          JSON.stringify({
            imageIds: [],
            nodeIds: [],
            networkProfileIds: [],
            storageProfileIds: [],
          }),
          JSON.stringify({}),
          now,
          now,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
        params: [
          randomUUID(),
          viewerId,
          viewerToken.slice(0, 12),
          createHash("sha256").update(viewerToken).digest("hex"),
          JSON.stringify(["tickets:read", "images:read", "events:read"]),
          now,
        ],
      },
    ]);

    const app = await buildApp(
      loadConfig({ DATA_DIR: dir, HOST: "127.0.0.1", COOKIE_SECURE: "false" }),
      { storage: db },
    );
    apps.push(app);
    const metadata = await app.inject({
      method: "GET",
      url: "/v1/admin/installation",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.headers["cache-control"]).toBe("no-store");
    const body = metadata.json();
    expect(body).toEqual({
      installationId: installation?.installation_id,
      controllerEpoch: 1,
      platformNetworkDeny: {
        revisionId: installation?.revision_id,
        revision: 1,
        managementDenyRules: [],
        reason:
          "Initial manual platform deny baseline; empty until explicitly configured and not evidence of isolation",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /token|secret|private|credential/i,
    );
    const viewerResponse = await app.inject({
      method: "GET",
      url: "/v1/admin/installation",
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerResponse.statusCode).toBe(403);

    const service = new AdminService(db, async () => ({
      engineId: "test-engine-bootstrap",
      dockerVersion: "29.5.2",
      apiVersion: "1.54",
      minimumApiVersion: "1.40",
      os: "linux",
      architecture: "amd64",
      portainerVersion: "2.45.2",
      cpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
      containerCount: 1,
      unmanagedContainerCount: 0,
    }));
    const connection = await service.discover({
      endpointUrl: "https://portainer.test",
      environmentId: "1",
      secretVersionRef: `secret:${"a".repeat(32)}`,
      apiKey: "probe-only",
    });
    const connectionId = String(
      (connection.result as { connectionId: string }).connectionId,
    );
    const machine = await service.createMachine({
      name: "Bootstrap lab",
      hostOs: "linux",
      architecture: "amd64",
      capacity: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
      operatorId: adminId,
    });
    const nodeResponse = await app.inject({
      method: "POST",
      url: "/v1/nodes",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Bootstrap Docker",
        machineId: machine.id,
        connectionId,
      },
    });
    expect(nodeResponse.statusCode).toBe(201);
    const nodeId = String(nodeResponse.json().id);
    const authorization = JSON.parse(
      String(
        (
          await db.get<{ authorization_json: string }>(
            "SELECT authorization_json FROM consumers WHERE id=?",
            [adminId],
          )
        )?.authorization_json,
      ),
    );
    expect(authorization).toMatchObject({
      imageIds: [],
      nodeIds: [nodeId],
      networkProfileIds: [],
      storageProfileIds: [],
    });
    expect(
      await db.get<{ n: bigint }>(
        "SELECT count(*) AS n FROM platform_network_deny_revisions",
      ),
    ).toMatchObject({ n: 1n });
  });
});
