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
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-admin-"));
  dirs.push(dir);
  const db = await openStorage(dir);
  dbs.push(db);
  const adminId = randomUUID(),
    now = Date.now();
  await db.batchTransaction([
    {
      kind: "run",
      sql: "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES(?,'test admin','consumer','{}',?,?)",
      params: [randomUUID(), now, now],
    },
    {
      kind: "run",
      sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,'test admin','human','admin',?,?,?,?)",
      params: [
        adminId,
        JSON.stringify({
          imageIds: [],
          nodeIds: [],
          networkProfileIds: [],
          storageProfileIds: [],
        }),
        JSON.stringify({ maxQueuedTickets: 10 }),
        now,
        now,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
      params: [randomUUID(), now],
    },
  ]);
  return { dir, db, adminId };
}
afterEach(async () => {
  await Promise.all(
    dbs.splice(0).map((db) => db.close().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const evidence = (engineId: string) => ({
  engineId,
  dockerVersion: "29.5.2",
  apiVersion: "1.54",
  minimumApiVersion: "1.40",
  os: "linux",
  architecture: "amd64",
  portainerVersion: "2.45.2",
  cpuCount: 8,
  memoryBytes: 16 * 1024 ** 3,
  containerCount: 2,
  unmanagedContainerCount: 2,
});
const secret = `secret:${"a".repeat(32)}`;

describe("D10 Portainer identity and D11a catalog", () => {
  it("persists discovery before probing, rejects failed evidence, deduplicates Engine identity, and CAS-activates same-Engine revisions", async () => {
    const { dir, db, adminId } = await fixture();
    const failed = new AdminService(db, async () => {
      throw new Error("401");
    });
    const failedReceipt = await failed.discover({
      endpointUrl: "https://portainer.test",
      environmentId: "1",
      secretVersionRef: secret,
      apiKey: "x",
    });
    expect(failedReceipt).toMatchObject({ state: "unknown", retryable: true });
    const failedOp = await db.get<{
      id: string;
      state: string;
      intent_json: string;
    }>(
      "SELECT id,state,intent_json FROM operations WHERE kind='provider.discover'",
    );
    expect(failedOp?.state).toBe("unknown");
    expect(JSON.parse(failedOp!.intent_json)).not.toHaveProperty("apiKey");
    expect(
      Number(
        (
          await db.get<{ n: bigint }>(
            "SELECT count(*) n FROM runtime_identities",
          )
        )?.n,
      ),
    ).toBe(0);
    const service = new AdminService(db, async () => evidence("engine-unique"));
    const first = await service.discover({
      endpointUrl: "https://portainer.test",
      environmentId: "1",
      secretVersionRef: secret,
      apiKey: "x",
      operationId: failedOp!.id,
    });
    expect(first.result).toMatchObject({
      duplicateRuntime: false,
      engineId: "engine-unique",
    });
    const second = await service.discover({
      endpointUrl: "https://other-portainer.test",
      environmentId: "9",
      secretVersionRef: secret,
      apiKey: "x",
    });
    expect(second.result).toMatchObject({
      duplicateRuntime: true,
      engineId: "engine-unique",
    });
    expect(
      Number(
        (
          await db.get<{ n: bigint }>(
            "SELECT count(*) n FROM provider_connections",
          )
        )?.n,
      ),
    ).toBe(1);
    const connectionId = String(
      (first.result as { connectionId: string }).connectionId,
    );
    const mismatchProbe = new AdminService(db, async () =>
      evidence("different-engine"),
    );
    const mismatchReceipt = await mismatchProbe.proposeConnectionRevision({
      connectionId,
      endpointUrl: "https://wrong.test",
      environmentId: "2",
      secretVersionRef: secret,
      apiKey: "x",
    });
    expect(mismatchReceipt).toMatchObject({
      state: "unknown",
      retryable: true,
    });
    const current = await db.get<{
      current_revision_id: string;
      version: bigint;
    }>(
      "SELECT current_revision_id,version FROM provider_connections WHERE id=?",
      [connectionId],
    );
    expect(
      Number(
        (
          await db.get<{ n: bigint }>(
            "SELECT count(*) n FROM provider_connection_revisions WHERE connection_id=?",
            [connectionId],
          )
        )?.n,
      ),
    ).toBe(1);
    expect(current?.current_revision_id).toBe(
      (first.result as { connectionRevisionId: string }).connectionRevisionId,
    );
    const revisionReceipt = await service.proposeConnectionRevision({
      connectionId,
      endpointUrl: "https://right.test",
      environmentId: "2",
      secretVersionRef: secret,
      apiKey: "x",
    });
    const revision = (
      revisionReceipt as {
        result: { connectionRevisionId: string; revision: number };
      }
    ).result;
    await expect(
      service.activateConnectionRevision(
        connectionId,
        revision.connectionRevisionId,
        1,
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    expect(
      await service.activateConnectionRevision(
        connectionId,
        revision.connectionRevisionId,
        Number(current!.version),
      ),
    ).toMatchObject({ currentRevisionId: revision.connectionRevisionId });
    const profile = await service.createProfile("network", {
      name: "frozen",
      config: {
        allowedEgress: [],
        allowedIngressSourceCidrs: [],
        ipv6: "disabled",
      },
      authorizedConsumerIds: [adminId],
    });
    const oldRevision = await db.get<{ policy_json: string }>(
      "SELECT policy_json FROM network_profile_revisions WHERE id=?",
      [profile.revisionId],
    );
    const nextPolicy = {
      allowedEgress: [
        { cidr: "198.51.100.0/24", protocol: "tcp", ports: [443] },
      ],
      allowedIngressSourceCidrs: [],
      ipv6: "disabled",
    };
    await service.newProfileRevision("network", profile.id, profile.version, {
      config: nextPolicy,
    });
    await expect(
      service.newProfileRevision("network", profile.id, profile.version, {
        config: {
          allowedEgress: [],
          allowedIngressSourceCidrs: [],
          ipv6: "disabled",
        },
      }),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
    expect(JSON.parse(oldRevision!.policy_json)).toEqual({
      allowedEgress: [],
      allowedIngressSourceCidrs: [],
      ipv6: "disabled",
    });
    expect(
      (
        await db.get<{ current_revision_id: string }>(
          "SELECT current_revision_id FROM network_profiles WHERE id=?",
          [profile.id],
        )
      )?.current_revision_id,
    ).not.toBe(profile.revisionId);
    let reached = 0,
      release!: () => void,
      allReached!: () => void;
    const probeGate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      bothProbed = new Promise<void>((resolve) => {
        allReached = resolve;
      });
    const racing = new AdminService(db, async () => {
      if (++reached === 2) allReached();
      await probeGate;
      return evidence("engine-race");
    });
    const raceA = racing.discover({
      endpointUrl: "https://race-a.test",
      environmentId: "1",
      secretVersionRef: secret,
      apiKey: "x",
    });
    const raceB = racing.discover({
      endpointUrl: "https://race-b.test",
      environmentId: "2",
      secretVersionRef: secret,
      apiKey: "x",
    });
    await bothProbed;
    release();
    const raceResults = await Promise.all([raceA, raceB]);
    expect(
      raceResults.filter((result) => result.result?.duplicateRuntime === false),
    ).toHaveLength(1);
    expect(
      raceResults.filter((result) => result.result?.duplicateRuntime === true),
    ).toHaveLength(1);
    expect(
      Number(
        (
          await db.get<{ n: bigint }>(
            "SELECT count(*) n FROM provider_connections",
          )
        )?.n,
      ),
    ).toBe(2);
  });

  it("keeps validation unavailable without verified capabilities and prevents concurrent over-reservation", async () => {
    const { dir, db, adminId } = await fixture();
    const service = new AdminService(db, async () =>
      evidence("engine-validation"),
    );
    const discovery = (await service.discover({
      endpointUrl: "https://portainer.test",
      environmentId: "1",
      secretVersionRef: secret,
      apiKey: "x",
    })) as { result: { connectionId: string } };
    const machine = await service.createMachine({
      name: "Lab",
      hostOs: "linux",
      architecture: "amd64",
      capacity: { cpuMillis: 3500, memoryMiB: 3500, scratchMiB: 3500 },
      operatorId: adminId,
    });
    const node = await service.registerNode({
      name: "Docker experiment",
      machineId: machine.id,
      connectionId: discovery.result.connectionId,
      operatorId: adminId,
    });
    expect(node).toMatchObject({
      admission: "disabled",
      observedHealth: "unknown",
      offline: false,
    });
    const blockedProfile = await service.createProfile("network", {
      name: "baseline",
      config: {
        allowedEgress: [],
        allowedIngressSourceCidrs: [],
        ipv6: "disabled",
      },
      authorizedConsumerIds: [adminId],
    });
    const draft = await service.createDraft({
      name: "tooling",
      version: "1",
      architecture: "amd64",
      artifactRef: `docker.io/library/tooling@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
      minimumResources: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 1000 },
      bootstrap: {
        mechanism: "entrypoint",
        contractVersion: "1",
        identityReset: true,
      },
      access: {
        accessProtocols: ["ssh"],
        ports: [22],
        account: "workspace",
        allowedSourceCidrs: ["10.0.0.0/8"],
        discovery: "ssh endpoint",
        readiness: "authenticated ssh probe",
      },
      authorizedConsumerIds: [adminId],
    });
    const validationRequest = {
      versionId: draft.versionId,
      imageArtifactId: draft.artifactId,
      nodeId: node.id,
      networkProfileId: blockedProfile.id,
      storage: [],
      resources: {
        request: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 1000 },
        limit: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 1000 },
        scratchEnforcement: "best_effort" as const,
        isolation: "shared_kernel" as const,
        accelerators: [],
      },
      deadlineSeconds: 1800,
      requestedBy: adminId,
    };
    const blocked = await service.scheduleValidation(validationRequest);
    expect(blocked).toMatchObject({
      scheduler: "blocked",
      allocationId: null,
      operationId: null,
    });
    await db.run(
      "UPDATE machines SET admission='enabled',observed_power='on' WHERE id=?",
      [machine.id],
    );
    await db.run(
      "UPDATE nodes SET admission='enabled',observed_health='healthy',observed_at_ms=?,capabilities_json=? WHERE id=?",
      [
        Date.now(),
        JSON.stringify({
          cpuHardLimit: "verified",
          memoryHardLimit: "verified",
          networkPolicyEnforcement: "verified",
          capacity: { cpuMillis: 3500, memoryMiB: 3500, scratchMiB: 3500 },
          verifiedNetworkProfileRevisionIds: [blockedProfile.revisionId],
          architectures: ["amd64"],
          guestOs: ["linux"],
          resourceKinds: ["container"],
          supportedAccess: ["ssh"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        node.id,
      ],
    );
    const firstScheduled = await service.scheduleValidation(validationRequest);
    const secondScheduled = await service.scheduleValidation(validationRequest);
    expect(firstScheduled.scheduler).toBe("queued");
    expect(secondScheduled.scheduler).toBe("queued");
    const schedules = await Promise.all(
      [0, 1].map(() => service.scheduleValidation(validationRequest)),
    );
    expect(
      schedules.filter((item) => item.scheduler === "queued"),
    ).toHaveLength(1);
    expect(
      schedules.filter((item) => item.scheduler === "blocked"),
    ).toHaveLength(1);
    const ledger = await db.get<{ n: bigint; cpu: bigint }>(
      "SELECT count(*) n,coalesce(sum(cpu_millis),0) cpu FROM capacity_claims WHERE state IN ('reserved','committed','quarantined')",
    );
    expect(Number(ledger?.n)).toBe(3);
    expect(Number(ledger?.cpu)).toBeLessThanOrEqual(3500);
    const storageProfile = await service.createProfile("storage", {
      name: "unverified local storage",
      protocol: "local",
      config: {
        sourceRef: "/review",
        allowedModes: ["read_only"],
        allowedSubpaths: ["fixture"],
      },
      secretVersionRef: null,
      authorizedConsumerIds: [adminId],
    });
    const secondVersion = await service.createVersion({
      imageId: draft.imageId,
      version: "storage-test",
      architecture: "amd64",
      artifactRef: `docker.io/library/tooling@sha256:${"c".repeat(64)}`,
      digest: `sha256:${"c".repeat(64)}`,
      minimumResources: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 1000 },
      requirements: {
        bootstrap: {
          mechanism: "entrypoint",
          contractVersion: "1",
          identityReset: true,
        },
      },
      access: {
        accessProtocols: ["ssh"],
        ports: [22],
        account: "workspace",
        allowedSourceCidrs: ["10.0.0.0/8"],
        discovery: "ssh endpoint",
        readiness: "authenticated ssh probe",
      },
      authorizedConsumerIds: [adminId],
    });
    const storageValidation = await service.scheduleValidation({
      ...validationRequest,
      versionId: secondVersion.versionId,
      imageArtifactId: secondVersion.artifactId,
      storage: [
        {
          storageProfileId: storageProfile.id,
          authorizedSubpath: "fixture",
          mountPath: "/workspace/input",
          mode: "read_only",
        },
      ],
    });
    expect(storageValidation).toMatchObject({
      scheduler: "blocked",
      allocationId: null,
      blockReason: "node_storage_capability_unverified",
    });
    const cache = await service.prewarmImageCache({
      nodeId: node.id,
      artifactId: draft.artifactId,
    });
    expect(cache).toMatchObject({
      state: "queued",
      digest: `sha256:${"b".repeat(64)}`,
    });
    const cached = await db.get<{
      desired_state: string;
      observed_state: string;
    }>(
      "SELECT desired_state,observed_state FROM image_caches WHERE node_id=? AND image_artifact_id=?",
      [node.id, draft.artifactId],
    );
    expect(cached).toEqual({
      desired_state: "present",
      observed_state: "unknown",
    });
    expect(
      await db.get<{ state: string; kind: string }>(
        "SELECT state,kind FROM operations WHERE id=?",
        [cache.operationId],
      ),
    ).toEqual({ state: "planned", kind: "image-cache.pull" });
    expect(
      await db.get<{ image_artifact_id: string }>(
        "SELECT image_artifact_id FROM operations WHERE id=?",
        [cache.operationId],
      ),
    ).toEqual({ image_artifact_id: draft.artifactId });
    const repeatedCachePlans = await Promise.all(
      [0, 1, 2].map(() =>
        service.prewarmImageCache({
          nodeId: node.id,
          artifactId: draft.artifactId,
        }),
      ),
    );
    expect(
      new Set(repeatedCachePlans.map((item) => item.operationId)).size,
    ).toBe(1);
    expect(
      Number(
        (
          await db.get<{ n: bigint }>(
            "SELECT count(*) n FROM operations WHERE node_id=? AND image_artifact_id=? AND kind='image-cache.pull' AND state IN ('planned','running','unknown')",
            [node.id, draft.artifactId],
          )
        )?.n,
      ),
    ).toBe(1);
    await expect(
      service.planCacheEviction({
        nodeId: node.id,
        artifactId: draft.artifactId,
      }),
    ).rejects.toThrow(/ready cache/);

    const extraVersion = (version: string, digestChar: string) =>
      service.createVersion({
        imageId: draft.imageId,
        version,
        architecture: "amd64",
        artifactRef: `docker.io/library/tooling@sha256:${digestChar.repeat(64)}`,
        digest: `sha256:${digestChar.repeat(64)}`,
        minimumResources: {
          cpuMillis: 1000,
          memoryMiB: 1000,
          scratchMiB: 1000,
        },
        requirements: {
          bootstrap: {
            mechanism: "entrypoint",
            contractVersion: "1",
            identityReset: true,
          },
        },
        access: {
          accessProtocols: ["ssh"],
          ports: [22],
          account: "workspace",
          allowedSourceCidrs: ["10.0.0.0/8"],
          discovery: "ssh endpoint",
          readiness: "authenticated ssh probe",
        },
        authorizedConsumerIds: [adminId],
      });
    const readyCache = async (artifactId: string, digest: string) =>
      db.run(
        "INSERT INTO image_caches(node_id,image_artifact_id,desired_state,observed_state,local_ref,digest_verified_at_ms) VALUES(?,?,'present','ready',?,?)",
        [node.id, artifactId, digest, Date.now()],
      );
    const evictionVersion = await extraVersion("cache-eviction", "d");
    await readyCache(evictionVersion.artifactId, `sha256:${"d".repeat(64)}`);
    const eviction = await service.planCacheEviction({
      nodeId: node.id,
      artifactId: evictionVersion.artifactId,
    });
    expect(eviction.state).toBe("queued");
    expect(
      await service.prewarmImageCache({
        nodeId: node.id,
        artifactId: evictionVersion.artifactId,
      }),
    ).toEqual({ state: "conflict" });
    const conflictToken = `hcl_${"c".repeat(43)}`;
    await db.run(
      "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      [
        randomUUID(),
        adminId,
        conflictToken.slice(0, 12),
        createHash("sha256").update(conflictToken).digest("hex"),
        JSON.stringify([
          "tickets:read",
          "tickets:write",
          "tickets:revoke",
          "images:read",
          "events:read",
        ]),
        Date.now(),
      ],
    );
    const conflictApp = await buildApp(loadConfig({ DATA_DIR: dir }), {
      storage: db,
    });
    try {
      const response = await conflictApp.inject({
        method: "POST",
        url: `/v1/nodes/${node.id}/image-cache/prewarm`,
        headers: { authorization: `Bearer ${conflictToken}` },
        payload: { artifactId: evictionVersion.artifactId },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await conflictApp.close();
    }

    const raceVersion = await extraVersion("cache-reference-race", "e");
    await readyCache(raceVersion.artifactId, `sha256:${"e".repeat(64)}`);
    await db.run(
      "UPDATE capacity_pools SET total_cpu_millis=5000,total_memory_mib=5000,total_scratch_mib=5000 WHERE machine_id=?",
      [machine.id],
    );
    await db.run(
      "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.capacity.cpuMillis',5000,'$.capacity.memoryMiB',5000,'$.capacity.scratchMiB',5000) WHERE id=?",
      [node.id],
    );
    let duringGc:
      | Awaited<ReturnType<typeof service.scheduleValidation>>
      | undefined;
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === "batchTransaction")
          return async (
            statements: Parameters<typeof db.batchTransaction>[0],
          ) => {
            if (
              statements.some((statement) =>
                statement.sql.includes("'image-cache.evict'"),
              )
            )
              duringGc = await service.scheduleValidation({
                ...validationRequest,
                versionId: raceVersion.versionId,
                imageArtifactId: raceVersion.artifactId,
              });
            return target.batchTransaction(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racingAdmin = new AdminService(raceDb, async () =>
      evidence("engine-validation"),
    );
    const racingEviction = await racingAdmin.planCacheEviction({
      nodeId: node.id,
      artifactId: raceVersion.artifactId,
    });
    expect(duringGc).toMatchObject({ scheduler: "queued" });
    expect(racingEviction).toEqual({ state: "conflict" });
    expect(
      Number(
        (
          await db.get<{ n: bigint }>(
            "SELECT count(*) n FROM operations WHERE node_id=? AND image_artifact_id=? AND kind='image-cache.evict'",
            [node.id, raceVersion.artifactId],
          )
        )?.n,
      ),
    ).toBe(0);
  });

  it("rejects an admin bearer with restricted scopes at new management routes", async () => {
    const { dir, db } = await fixture();
    const token = `hcl_${"r".repeat(43)}`;
    await db.run(
      "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      [
        randomUUID(),
        (await db.get<{ id: string }>(
          "SELECT id FROM consumers WHERE role='admin'",
        ))!.id,
        token.slice(0, 12),
        createHash("sha256").update(token).digest("hex"),
        JSON.stringify(["tickets:read"]),
        Date.now(),
      ],
    );
    const app = await buildApp(loadConfig({ DATA_DIR: dir }), { storage: db });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: "forbidden",
          hostOs: "linux",
          architecture: "amd64",
          capacity: { cpuMillis: 1, memoryMiB: 1, scratchMiB: 0 },
        },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("returns a projected administrator DTO and documents validation from the same request schema", async () => {
    const { dir, db } = await fixture();
    const token = `hcl_${"f".repeat(43)}`;
    const admin = (await db.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='admin'",
    ))!.id;
    await db.run(
      "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      [
        randomUUID(),
        admin,
        token.slice(0, 12),
        createHash("sha256").update(token).digest("hex"),
        JSON.stringify([
          "tickets:read",
          "tickets:write",
          "tickets:revoke",
          "images:read",
          "events:read",
        ]),
        Date.now(),
      ],
    );
    const service = new AdminService(db, async () =>
      evidence("engine-safe-view"),
    );
    await service.discover({
      endpointUrl: "https://portainer.test",
      environmentId: "1",
      secretVersionRef: secret,
      apiKey: "never-return-this",
    });
    const app = await buildApp(loadConfig({ DATA_DIR: dir }), { storage: db });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/provider-connections",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      const [connection] = response.json() as Array<Record<string, unknown>>;
      expect(connection).toMatchObject({
        backendKind: "portainer",
        evidence: { engineId: "engine-safe-view", architecture: "amd64" },
      });
      expect(JSON.stringify(connection)).not.toContain("never-return-this");
      expect(JSON.stringify(connection)).not.toContain("secretVersionRef");
      const openapi = (
        await app.inject({ method: "GET", url: "/v1/openapi.json" })
      ).json();
      expect(
        openapi.paths["/v1/image-versions/{versionId}/validate"].post
          .requestBody.content["application/json"].schema.properties,
      ).toHaveProperty("imageArtifactId");
      expect(openapi.paths["/v1/images"].get).toBeDefined();
      expect(openapi.paths["/v1/images"].post).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
