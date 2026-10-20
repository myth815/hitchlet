import { AccessService } from "../src/application/access.js";
import {
  HumanUsePolicySchema,
  type PreparedManagementRequest,
} from "@hitchlet/contracts/admin";
import { SQLiteProfileRevocationStore } from "../src/storage/profile-revocation-store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ManagementService } from "../src/application/management.js";
import { TicketService } from "../src/application/tickets.js";
import { SQLiteProfileStore } from "../src/storage/profile-store.js";
import { AdminCommandJournal } from "../src/application/admin-command-journal.js";
import type { ConsumerInput } from "@hitchlet/contracts/admin";
import { OperationWorker } from "../src/application/operations.js";
import { LeaseService } from "../src/application/leases.js";
import { PersistentSimulator } from "../src/providers/simulator.js";
import { HitchletClient } from "../../../packages/sdk/src/index.js";
import { AdminService } from "../src/application/admin.js";
import { NodeCapabilityAttestationReceiptSchema } from "@hitchlet/contracts/admin";
import { LocalSecretStore } from "../src/storage/secret-store.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture(withSecrets = false) {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-d24-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const value = (pattern: RegExp) => {
    const found = stdout.match(pattern)?.[1];
    if (!found) throw new Error("Incomplete fixture");
    return found;
  };
  const token = value(/Bearer token \(shown once\): (\S+)/),
    adminToken = value(/Initial admin bearer token \(shown once\): (\S+)/),
    consumerId = value(/Consumer ID: (\S+)/),
    adminId = value(/Initial admin ID: (\S+)/),
    versionId = value(/Image version: (\S+)/),
    networkId = value(/Network profile: (\S+)/);
  const db = await openStorage(dir);
  cleanups.push(() => db.close());
  let secrets: LocalSecretStore | undefined;
  if (withSecrets) {
    const keyDir = await mkdtemp(join(tmpdir(), "hitchlet-d24-key-"));
    cleanups.push(() => rm(keyDir, { recursive: true, force: true }));
    const keyFile = join(keyDir, "master.key");
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    secrets = await LocalSecretStore.open(dir, keyFile);
  }
  const service = new ManagementService(db),
    tickets = new TicketService({ storage: db });
  const app = await buildApp(
    loadConfig({
      DATA_DIR: dir,
      LOG_LEVEL: "silent",
      HOST: "127.0.0.1",
      COOKIE_SECURE: "false",
    }),
    { storage: db, ...(secrets ? { secrets } : {}) },
  );
  cleanups.push(() => app.close());
  const headers = (tokenValue = adminToken, key?: string) => ({
    authorization: `Bearer ${tokenValue}`,
    ...(key ? { "idempotency-key": key } : {}),
  });
  const owner = (await service.consumers()).find((c) => c.id === consumerId)!;
  const input = (overrides: Partial<ConsumerInput> = {}): ConsumerInput => ({
    name: `fixture-${randomUUID()}`,
    kind: "human",
    role: "consumer",
    status: "active",
    authorization: owner.authorization,
    quota: owner.quota,
    ...overrides,
  });
  const add = async (
    role: ConsumerInput["role"],
    authorization = owner.authorization,
  ) => {
    const c = await service.saveConsumer(
      input({ role, authorization }),
      adminId,
      "fixture",
    );
    return {
      ...c,
      ...(await service.issueCredential(c.id, adminId, "fixture")),
    };
  };
  const acquire = (who = consumerId, key = randomUUID()) =>
    tickets.acquire(who, key, {
      image: { versionId },
      networkProfileId: networkId,
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 1 },
    });
  return {
    dir,
    db,
    secrets,
    app,
    service,
    tickets,
    headers,
    token,
    adminToken,
    consumerId,
    adminId,
    versionId,
    networkId,
    owner,
    input,
    add,
    acquire,
  };
}

describe("profile grant administration and management replay", () => {
  it.each(["queued", "reserved", "provisioning", "ready"])(
    "atomically revokes %s tickets and retains claims until cleanup while paused",
    async (phase) => {
      const f = await fixture(),
        t = await f.acquire(),
        installation = (await f.db.get<{ installation_id: string }>(
          "SELECT installation_id FROM installations",
        ))!.installation_id;
      const worker = new OperationWorker({
        storage: f.db,
        installationId: installation,
        execution: new PersistentSimulator(join(f.dir, "external")),
      });
      if (phase !== "queued") await f.tickets.reserveNext();
      if (phase === "ready") await worker.reconcileBeforeScheduling();
      if (phase === "provisioning")
        await f.db.run("UPDATE tickets SET phase='provisioning' WHERE id=?", [
          t.ticketId,
        ]);
      const revision = (await f.db.get<{ current_revision_id: string }>(
        "SELECT current_revision_id FROM network_profiles WHERE id=?",
        [f.networkId],
      ))!.current_revision_id;
      const input = {
        profileKind: "network",
        profileRevisionId: revision,
        expectedProfileVersion: 1,
        reason: "Emergency incident",
      };
      const preview = await f.app.inject({
        method: "POST",
        url: "/v1/admin/profile-grants/revoke/preview",
        headers: f.headers(),
        payload: input,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        affectedTicketIds: [t.ticketId],
        canRevoke: true,
      });
      expect(
        await f.db.get("SELECT count(*) n FROM profile_grant_revocations"),
      ).toEqual({ n: 0n });
      await f.db.run(
        "UPDATE system_maintenance SET paused=1 WHERE singleton=1",
      );
      const revoke = () =>
        f.app.inject({
          method: "POST",
          url: "/v1/admin/profile-grants/revoke",
          headers: f.headers(undefined, "revoke-grant"),
          payload: input,
        });
      const first = await revoke();
      expect(first.statusCode, first.body).toBe(200);
      expect((await revoke()).json()).toEqual(first.json());
      const row = await f.db.get<{
        phase: string;
        terminal_reason: string;
        scheduling_reason_json: string;
      }>(
        "SELECT phase,terminal_reason,scheduling_reason_json FROM tickets WHERE id=?",
        [t.ticketId],
      );
      expect(row!.terminal_reason).toBe("admin_revoke");
      expect(row!.scheduling_reason_json).toContain("PROFILE_GRANT_REVOKED");
      if (phase !== "queued") {
        expect(row!.phase).toBe("releasing");
        expect(
          await f.db.get(
            "SELECT count(*) n FROM capacity_claims WHERE state<>'released'",
          ),
        ).toEqual({ n: 1n });
        await f.db.run(
          "UPDATE installations SET controller_epoch=2 WHERE singleton=1",
        );
        await new OperationWorker({
          storage: f.db,
          installationId: installation,
          controllerEpoch: 2,
          execution: new PersistentSimulator(join(f.dir, "external")),
        }).reconcileBeforeScheduling();
        expect(
          await f.db.get(
            "SELECT count(*) n FROM capacity_claims WHERE state<>'released'",
          ),
        ).toEqual({ n: 0n });
      }
      expect(
        (await f.db.get<{ phase: string }>(
          "SELECT phase FROM tickets WHERE id=?",
          [t.ticketId],
        ))!.phase,
      ).toBe("released");
      await f.db.run(
        "UPDATE system_maintenance SET paused=0 WHERE singleton=1",
      );
      await expect(f.acquire()).rejects.toBeDefined();
      await f.db.run(
        "UPDATE consumer_credentials SET scopes_json=? WHERE consumer_id=?",
        [JSON.stringify(["tickets:read"]), f.adminId],
      );
      expect((await revoke()).statusCode).toBe(403);
    },
  );
  it("checks full admin, CSRF, CAS and reason before revocation and supports historical revisions", async () => {
    const f = await fixture(),
      profiles = new SQLiteProfileStore(f.db),
      old = (await profiles.listProfiles("network"))[0]!;
    const next = await profiles.newProfileRevision("network", old.id, 1, {
      config: old.config,
    });
    await f.acquire();
    const body = {
      profileKind: "network",
      profileRevisionId: old.currentRevisionId,
      expectedProfileVersion: 2,
      reason: "old revision only",
    };
    const call = (headers: Record<string, string>, payload: unknown = body) =>
      f.app.inject({
        method: "POST",
        url: "/v1/admin/profile-grants/revoke",
        headers,
        payload,
      });
    expect((await call(f.headers(f.token, "not-admin"))).statusCode).toBe(403);
    expect(
      (await call(f.headers(undefined, "no-reason"), { ...body, reason: " " }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call(f.headers(undefined, "stale"), {
          ...body,
          expectedProfileVersion: 1,
        })
      ).statusCode,
    ).toBe(412);
    const session = await f.app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: f.headers(),
    });
    const cookies = session.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    expect(
      (await call({ cookie: cookies, "idempotency-key": "no-csrf" }))
        .statusCode,
    ).toBe(403);
    const result = await call(f.headers(undefined, "historical-revoke"));
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().affectedTicketIds).toEqual([]);
    const history = await f.app.inject({
      url: `/v1/network-profiles/${old.id}/revisions`,
      headers: f.headers(),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([
      expect.objectContaining({
        id: next.revisionId,
        isCurrent: true,
        revokedAt: null,
      }),
      expect.objectContaining({
        id: old.currentRevisionId,
        isCurrent: false,
        revokedAt: expect.any(String),
      }),
    ]);
    await expect(f.acquire()).resolves.toBeDefined();
  });
  it("rejects a reference added after execution enumeration without partial revocation and reports unsupported infrastructure", async () => {
    const f = await fixture();
    await f.acquire();
    const revision = (await f.db.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM network_profiles WHERE id=?",
      [f.networkId],
    ))!.current_revision_id;
    const body = {
      profileKind: "network" as const,
      profileRevisionId: revision,
      expectedProfileVersion: 1,
      reason: "atomic enumeration",
    };
    const store = new SQLiteProfileRevocationStore(f.db);
    const batch = f.db.batchTransaction.bind(f.db);
    let raced = false;
    const intercept = vi
      .spyOn(f.db, "batchTransaction")
      .mockImplementation(async (statements) => {
        if (
          !raced &&
          statements.some((s) =>
            s.sql.includes("INSERT INTO profile_grant_revocations"),
          )
        ) {
          raced = true;
          await f.acquire();
        }
        return batch(statements);
      });
    await expect(store.revoke(body, f.adminId, "race")).rejects.toMatchObject({
      code: "STORAGE_CAS_FAILED",
    });
    intercept.mockRestore();
    expect(
      await f.db.get("SELECT count(*) n FROM profile_grant_revocations"),
    ).toEqual({ n: 0n });
    expect(
      await f.db.get("SELECT count(*) n FROM tickets WHERE phase='queued'"),
    ).toEqual({ n: 2n });
    await f.tickets.reserveNext();
    const allocation = (await f.db.get<{ id: string }>(
      "SELECT id FROM allocations LIMIT 1",
    ))!.id;
    const infrastructure = randomUUID();
    await f.db.run(
      "INSERT INTO allocations(id,purpose,machine_id,node_id,runtime_identity_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms,updated_at_ms) SELECT ?,'infrastructure',machine_id,node_id,runtime_identity_id,image_artifact_id,1,'present','{}',created_at_ms,updated_at_ms FROM allocations WHERE id=?",
      [infrastructure, allocation],
    );
    expect(await store.preview(body)).toMatchObject({
      canRevoke: false,
      affectedInfrastructureAllocationIds: [infrastructure],
      disabledReasons: ["infrastructure_revocation_unsupported"],
    });
    await expect(
      store.revoke(body, f.adminId, "unsupported"),
    ).rejects.toMatchObject({ code: "execution_mode_unsupported" });
    expect(
      await f.db.get("SELECT count(*) n FROM profile_grant_revocations"),
    ).toEqual({ n: 0n });
  });
  it("cancels a pending claim and refuses stale renewal confirmation and private access after revocation", async () => {
    const f = await fixture(),
      t = await f.acquire();
    await f.tickets.reserveNext();
    const installation = (await f.db.get<{ installation_id: string }>(
      "SELECT installation_id FROM installations",
    ))!.installation_id;
    await new OperationWorker({
      storage: f.db,
      installationId: installation,
      execution: new PersistentSimulator(join(f.dir, "external")),
    }).reconcileBeforeScheduling();
    const lease = (await f.db.get<{
      generation: bigint;
      version: bigint;
      expires_at_ms: bigint;
    }>(
      "SELECT generation,version,expires_at_ms FROM leases WHERE ticket_id=?",
      [t.ticketId],
    ))!;
    const leases = new LeaseService(f.db);
    const pending = await leases.renew(
      f.consumerId,
      t.ticketId,
      "original-claim",
      {
        generation: Number(lease.generation),
        expectedLeaseVersion: Number(lease.version),
        requestedTtlSec: 600,
      },
    );
    expect(pending.outcome).toBe("pending");
    const revision = (await f.db.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM network_profiles WHERE id=?",
      [f.networkId],
    ))!.current_revision_id;
    await new SQLiteProfileRevocationStore(f.db).revoke(
      {
        profileKind: "network",
        profileRevisionId: revision,
        expectedProfileVersion: 1,
        reason: "claim race",
      },
      f.adminId,
      "claim-race",
    );
    await leases.reconcilePending();
    expect(
      await f.db.get(
        "SELECT state FROM lease_renewals WHERE lease_id=(SELECT id FROM leases WHERE ticket_id=?)",
        [t.ticketId],
      ),
    ).toEqual({ state: "cancelled" });
    expect(
      (await f.db.get<{ expires_at_ms: bigint }>(
        "SELECT expires_at_ms FROM leases WHERE ticket_id=?",
        [t.ticketId],
      ))!.expires_at_ms,
    ).toBe(lease.expires_at_ms);
    await expect(
      new AccessService(f.db).get(
        f.consumerId,
        t.ticketId,
        "post-revocation-access",
        Number(lease.generation),
      ),
    ).rejects.toMatchObject({ code: "profile_grant_revoked" });
    await expect(
      leases.renew(f.consumerId, t.ticketId, "new-claim", {
        generation: Number(lease.generation),
        expectedLeaseVersion: Number(lease.version),
        requestedTtlSec: 600,
      }),
    ).rejects.toBeDefined();
  });
  it.each(["policy", "admission"])(
    "recovers %s writes through the original SDK command after losing the response",
    async (kind) => {
      const f = await fixture();
      const node = (await f.db.get<{
        id: string;
        version: bigint;
        machine_id: string;
      }>("SELECT id,version,machine_id FROM nodes LIMIT 1"))!;
      const machine = (await f.db.get<{ version: bigint }>(
        "SELECT version FROM machines WHERE id=?",
        [node.machine_id],
      ))!;
      let prepared: PreparedManagementRequest | undefined;
      let lose = true;
      const client = new HitchletClient("https://management.test", {
        auth: { kind: "bearer", token: f.adminToken },
        onManagementPrepared: async (command) => {
          prepared = command;
        },
        fetch: async (input, init) => {
          const result = await f.app.inject({
            method: init!.method as "PUT",
            url: new URL(String(input)).pathname,
            headers: Object.fromEntries(new Headers(init!.headers).entries()),
            payload: String(init!.body),
          });
          if (lose) {
            lose = false;
            expect(result.statusCode, result.body).toBe(200);
            throw new TypeError("lost reply");
          }
          return new Response(result.body, {
            status: result.statusCode,
            headers: { "content-type": "application/json" },
          });
        },
      });
      const zero = { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 };
      const policy = HumanUsePolicySchema.parse({
        blockShutdownForAnyInteractiveSession: true,
        blockShutdownOnUnknownPresence: true,
        maximumObservationAgeSeconds: 30,
        admissionDuringInteraction: "block_new",
        humanReserved: zero,
        systemReserve: zero,
        attendedMaximum: zero,
        unattendedMaximum: zero,
        cpuPressureLimitPercent: 80,
        memoryPressureLimitPercent: 80,
      });
      await expect(
        kind === "policy"
          ? client.admin.updateHumanUsePolicy(
              node.machine_id,
              { expectedVersion: Number(machine.version), policy },
              "lost-policy",
            )
          : client.admin.updateNodeAdmissionMode(
              node.id,
              {
                expectedVersion: Number(node.version),
                mode: "constant_online_manual_inventory",
                reason: "explicit trial",
              },
              "lost-admission",
            ),
      ).rejects.toBeDefined();
      expect(prepared).toBeDefined();
      const saved = prepared!;
      expect(await client.admin.resumeManagement(saved)).toMatchObject({
        version: Number(kind === "policy" ? machine.version : node.version) + 1,
      });
      await f.db.run(
        "UPDATE consumer_credentials SET scopes_json=? WHERE consumer_id=?",
        [JSON.stringify(["tickets:read"]), f.adminId],
      );
      await expect(client.admin.resumeManagement(saved)).rejects.toMatchObject({
        statusCode: 403,
      });
    },
  );
});

describe("D24 management and safe consumer directory", () => {
  it.each(["injected JSON parser", "real loopback HTTP"])(
    "parses the actual SQLite capability receipt through SDK and %s with the unchanged bare-hex fingerprint",
    async (transport) => {
      const f = await fixture(true),
        evidence = {
          engineId: "receipt-engine",
          dockerVersion: "29.5.2",
          apiVersion: "1.54",
          minimumApiVersion: "1.44",
          portainerVersion: "2.45.2",
          os: "linux",
          architecture: "amd64" as const,
          cpuCount: 4,
          memoryBytes: 8 * 1024 ** 3,
          containerCount: 0,
          unmanagedContainerCount: 0,
        },
        admin = new AdminService(f.db, async () => evidence),
        secret = await f.secrets!.put("temporary-runtime-reference"),
        discovery = await admin.discover({
          endpointUrl: "https://receipt-portainer.test",
          environmentId: "1",
          secretVersionRef: secret,
          apiKey: "fixture-only",
        });
      if (
        !discovery.result?.connectionId ||
        !discovery.result.connectionRevisionId
      )
        throw new Error("Fixture discovery did not complete");
      const address =
        transport === "real loopback HTTP"
          ? await f.app.listen({ host: "127.0.0.1", port: 0 })
          : "http://receipt.test";
      const client = new HitchletClient(address, {
        auth: { kind: "bearer", token: f.adminToken },
        ...(transport === "injected JSON parser"
          ? {
              fetch: async (
                input: string | URL | Request,
                init?: RequestInit,
              ) => {
                const url = new URL(String(input)),
                  response = await f.app.inject({
                    method: (init?.method ?? "GET") as "GET" | "POST" | "PUT",
                    url: url.pathname + url.search,
                    headers: Object.fromEntries(new Headers(init?.headers)),
                    ...(typeof init?.body === "string"
                      ? { payload: init.body }
                      : {}),
                  });
                return new Response(response.body, {
                  status: response.statusCode,
                  headers: { "Content-Type": "application/json" },
                });
              },
            }
          : {}),
      });
      const machine = await client.admin.inventory.createMachine(
          {
            name: "Receipt fixture",
            hostOs: "linux",
            architecture: "amd64",
            capacity: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 1024 },
          },
          "receipt-machine",
        ),
        node = await client.admin.inventory.createNode(
          {
            name: "Receipt node",
            machineId: machine.id,
            connectionId: discovery.result.connectionId,
          },
          "receipt-node",
        ),
        installation = await client.admin.inventory.installation();
      const configured = await client.admin.inventory.configureRuntime(
        node.id,
        {
          accessHost: "192.0.2.10",
          networkCidrBase: "172.28.0.0/16",
          userlandProxy: false,
          managementDenyRevisionId:
            installation.platformNetworkDeny!.revisionId,
          managementDenyRules: [],
          runtimeAgent: {
            id: randomUUID(),
            baseUrl: "https://receipt-agent.test",
            tokenSecretRef: secret,
            caSecretRef: secret,
            clientCertSecretRef: secret,
            clientKeySecretRef: secret,
          },
        },
        1,
        "receipt-runtime",
      );
      const revision = (await f.db.get<{ current_revision_id: string }>(
          "SELECT current_revision_id FROM network_profiles WHERE id=?",
          [f.networkId],
        ))!.current_revision_id,
        report = {
          runId: randomUUID(),
          sha256: "b".repeat(64),
          scopes: Object.fromEntries(
            [
              "resourceLimits",
              "firewallInput",
              "firewallForward",
              "ipv6",
              "sshBootstrap",
              "cleanupRecovery",
            ].map((scope) => [
              scope,
              {
                status: "passed" as const,
                summary: `Fixture evidence for ${scope}`,
                evidenceRef: `fixture:${scope}`,
              },
            ]),
          ),
        },
        body = {
          expectedEngineId: evidence.engineId,
          expectedDockerVersion: evidence.dockerVersion,
          expectedPortainerVersion: evidence.portainerVersion,
          architecture: "amd64" as const,
          checkedAt: new Date().toISOString(),
          report,
          networkProfileRevisionIds: [revision],
          storageProfileRevisionIds: [],
        },
        receipt = await client.admin.inventory.attestCapabilities(
          node.id,
          body,
          configured.version,
          "receipt-attest",
        ),
        expected = createHash("sha256")
          .update(
            JSON.stringify({
              engineId: evidence.engineId,
              connectionRevisionId: discovery.result.connectionRevisionId,
              dockerVersion: evidence.dockerVersion,
              portainerVersion: evidence.portainerVersion,
              architecture: body.architecture,
              checkedAt: body.checkedAt,
              networkProfileRevisionIds: [revision],
              storageProfileRevisionIds: [],
              report,
            }),
          )
          .digest("hex");
      expect(receipt).toMatchObject({
        nodeId: node.id,
        admission: "enabled",
        observedHealth: "healthy",
        capabilityFingerprint: expected,
        version: 3,
      });
      expect(
        NodeCapabilityAttestationReceiptSchema.safeParse({
          ...receipt,
          capabilityFingerprint: `sha256:${expected}`,
        }).success,
      ).toBe(false);
      const saved = (await f.db.get<{
        admission: string;
        capabilities_json: string;
        version: bigint;
      }>("SELECT admission,capabilities_json,version FROM nodes WHERE id=?", [
        node.id,
      ]))!;
      expect(saved.admission).toBe("enabled");
      expect(JSON.parse(saved.capabilities_json).capabilityFingerprint).toBe(
        expected,
      );
      expect(
        await client.admin.inventory.attestCapabilities(
          node.id,
          body,
          configured.version,
          "receipt-attest",
        ),
      ).toEqual(receipt);
      expect(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM audit_entries WHERE action='node.capabilities_attested' AND target_id=?",
          [node.id],
        ))!.n,
      ).toBe(1n);
    },
  );
  it("reads a real init-simulator seed through HTTP and SDK inventory without projecting its synthetic binding as Portainer evidence", async () => {
    const f = await fixture();
    expect(
      (await f.db.get<{ n: bigint }>(
        "SELECT count(*) AS n FROM provider_connection_revisions WHERE endpoint_ref='simulator://local' AND provider_endpoint_id='simulator'",
      ))!.n,
    ).toBe(1n);
    const response = await f.app.inject({
      url: "/v1/provider-connections",
      headers: f.headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    const client = new HitchletClient("http://m0.test", {
      auth: { kind: "bearer", token: f.adminToken },
      fetch: async (input, init) => {
        const url = new URL(String(input)),
          reply = await f.app.inject({
            method: (init?.method ?? "GET") as "GET" | "POST",
            url: url.pathname + url.search,
            headers: Object.fromEntries(new Headers(init?.headers)),
            ...(typeof init?.body === "string" ? { payload: init.body } : {}),
          });
        return new Response(reply.body, {
          status: reply.statusCode,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    expect(await client.admin.inventory.connections()).toEqual([]);
    const machine = await client.admin.inventory.createMachine(
      {
        name: "M0 disabled registration",
        hostOs: "linux",
        architecture: "arm64",
        capacity: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 1024 },
      },
      "m0-disabled-machine",
    );
    expect(machine).toMatchObject({
      admission: "disabled",
      observedPower: "unknown",
      powerEnabled: false,
    });
    expect(await client.admin.inventory.connections()).toEqual([]);
  });
  it("executes the actual documented JS consumer sequence against the initialized M0 ledger, HTTP JSON parser and durable Simulator", async () => {
    const f = await fixture(),
      installation = (await f.db.get<{ installation_id: string }>(
        "SELECT installation_id FROM installations WHERE singleton=1",
      ))!.installation_id;
    const worker = new OperationWorker({
        storage: f.db,
        installationId: installation,
        execution: new PersistentSimulator(join(f.dir, "external")),
      }),
      leases = new LeaseService(f.db);
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input)),
          headers = Object.fromEntries(new Headers(init?.headers).entries());
        const result = await f.app.inject({
          method: (init?.method ?? "GET") as "GET" | "POST",
          url: `${url.pathname}${url.search}`,
          headers,
          ...(typeof init?.body === "string" ? { payload: init.body } : {}),
        });
        await f.tickets.reserveNext();
        await worker.reconcileBeforeScheduling();
        await leases.reconcilePending();
        return new Response(result.body, {
          status: result.statusCode,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubEnv("HITCHLET_ORIGIN", "https://m0-documentation.test");
    vi.stubEnv("HITCHLET_TOKEN", f.token);
    vi.stubEnv("HITCHLET_COMMAND_FILE", join(f.dir, "original-command.json"));
    const document = await readFile(resolve("../../docs/api-sdk.md"), "utf8"),
      blocks = [...document.matchAll(/```js\n([\s\S]*?)```/g)],
      block = blocks
        .map((match) => match[1]!)
        .find((code) => code.includes("HITCHLET_COMMAND_FILE"))!;
    const source = block.replace(
      '"./packages/sdk/dist/index.js"',
      JSON.stringify(
        pathToFileURL(resolve("../../packages/sdk/dist/index.js")).href,
      ),
    );
    await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM tickets WHERE phase='released'",
        ))!.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
        ))!.n,
      ),
    ).toBe(0);
    await expect(
      access(join(f.dir, "original-command.json")),
    ).rejects.toThrow();
  });
  it("filters catalog grants and immutable versions, keeps each architecture's true minimum, and never exposes source/secret refs", async () => {
    const f = await fixture();
    const storage = await new SQLiteProfileStore(f.db).createProfile(
      "storage",
      {
        name: "Authorized safe data",
        protocol: "local",
        config: {
          sourceRef: "/private/fixture-root",
          allowedSubpaths: ["team/work"],
          allowedModes: ["read_only"],
        },
        secretVersionRef: `secret:${"a".repeat(32)}`,
        authorizedConsumerIds: [f.consumerId],
      },
    );
    await new SQLiteProfileStore(f.db).createProfile("storage", {
      name: "Other data",
      protocol: "local",
      config: {
        sourceRef: "/other-private-root",
        allowedSubpaths: ["other"],
        allowedModes: ["read_write"],
      },
      authorizedConsumerIds: [f.adminId],
    });
    await f.db.run(
      "INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,access_recipe_json,created_at_ms) VALUES(?,?,'portainer','container','arm64','linux','fixture:arm','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',5000,6000,1,'{\"accessProtocols\":[\"ssh\"]}',?)",
      [randomUUID(), f.versionId, Date.now()],
    );
    const response = await f.app.inject({
      url: "/v1/catalog",
      headers: f.headers(f.token),
    });
    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    expect(catalog.storage.map((p: { id: string }) => p.id)).toEqual([
      storage.id,
    ]);
    expect(
      catalog.versions[0].platforms
        .map(
          (p: { minimumResources: { cpuMillis: number } }) =>
            p.minimumResources.cpuMillis,
        )
        .sort((a: number, b: number) => a - b),
    ).toEqual([1, 5000]);
    expect(response.body).not.toMatch(
      /sourceRef|secretVersionRef|private\/fixture|other-private/,
    );
  });
  it("previews using the real normalization/capability/profile eligibility and creates no Ticket, operation or idempotency key", async () => {
    const f = await fixture(),
      body = {
        image: { versionId: f.versionId },
        networkProfileId: f.networkId,
        resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 1 },
      };
    const request = () =>
      f.app.inject({
        method: "POST",
        url: "/v1/catalog/preview",
        headers: f.headers(f.token),
        payload: body,
      });
    const first = await request();
    expect(first.statusCode).toBe(200);
    expect(first.json().eligibleNodeIds).toHaveLength(1);
    expect(first.json().capacityGuaranteed).toBe(false);
    await f.db.run(
      "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.networkPolicyEnforcement','unsupported')",
    );
    expect((await request()).json().eligibleNodeIds).toEqual([]);
    for (const table of ["tickets", "operations", "idempotency_keys"])
      expect(
        Number(
          (await f.db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`))!
            .n,
        ),
      ).toBe(0);
  });
  it("applies viewer/operator/restricted-admin read scopes independently of revocation permission", async () => {
    const f = await fixture(),
      ticket = await f.acquire(),
      viewer = await f.add("viewer"),
      operator = await f.add("operator"),
      denied = await f.add("admin", {
        imageIds: [],
        nodeIds: [],
        networkProfileIds: [],
        storageProfileIds: [],
      });
    await f.db.run(
      'UPDATE consumer_credentials SET scopes_json=\'["tickets:read","images:read","events:read"]\' WHERE consumer_id=?',
      [denied.id],
    );
    for (const actor of [viewer, operator]) {
      const page = await f.app.inject({
        url: "/v1/admin/tickets",
        headers: f.headers(actor.token),
      });
      expect(page.statusCode).toBe(200);
      expect(page.json().items.map((t: { id: string }) => t.id)).toContain(
        ticket.ticketId,
      );
      expect(
        (
          await f.app.inject({
            url: `/v1/admin/tickets/${ticket.ticketId}`,
            headers: f.headers(actor.token),
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await f.app.inject({
          url: "/v1/admin/tickets",
          headers: f.headers(denied.token),
        })
      ).json().items,
    ).toEqual([]);
    expect(
      (
        await f.app.inject({
          url: "/v1/admin/consumers",
          headers: f.headers(denied.token),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          url: "/v1/admin/tickets",
          headers: f.headers(f.token),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `/v1/tickets/${ticket.ticketId}/revoke`,
          headers: f.headers(viewer.token, "viewer-revoke"),
          payload: {
            expectedTicketVersion: 1,
            generation: null,
            reason: "forbidden",
          },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("CAS edits preserve limited bearer scopes, narrow on downgrade, invalidate sessions and never rewrite accepted Tickets", async () => {
    const f = await fixture(),
      ticket = await f.acquire(),
      before = await f.db.get<{ request_json: string }>(
        "SELECT request_json FROM tickets WHERE id=?",
        [ticket.ticketId],
      );
    await f.db.run(
      "UPDATE consumer_credentials SET scopes_json='[\"tickets:read\"]' WHERE consumer_id=?",
      [f.consumerId],
    );
    const update = {
      ...f.input({
        name: "Updated owner",
        quota: { ...f.owner.quota, maxLeaseTtlSeconds: 100 },
      }),
      expectedVersion: f.owner.version,
    };
    const saved = await f.app.inject({
      method: "PUT",
      url: `/v1/admin/consumers/${f.consumerId}`,
      headers: f.headers(undefined, "edit-owner"),
      payload: update,
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (await f.db.get<{ scopes_json: string }>(
        "SELECT scopes_json FROM consumer_credentials WHERE consumer_id=?",
        [f.consumerId],
      ))!.scopes_json,
    ).toBe('["tickets:read"]');
    expect(
      (await f.db.get<{ request_json: string }>(
        "SELECT request_json FROM tickets WHERE id=?",
        [ticket.ticketId],
      ))!.request_json,
    ).toBe(before!.request_json);
    const stale = await f.app.inject({
      method: "PUT",
      url: `/v1/admin/consumers/${f.consumerId}`,
      headers: f.headers(undefined, "stale-owner"),
      payload: update,
    });
    expect([409, 412]).toContain(stale.statusCode);
    const oldAdmin = (await f.service.consumers()).find(
      (c) => c.id === f.adminId,
    )!;
    const { id, version, updatedAtMs, ...adminInput } = oldAdmin;
    await expect(
      f.service.saveConsumer(
        { ...adminInput, role: "viewer", expectedVersion: version },
        f.adminId,
        "last-admin",
        id,
      ),
    ).rejects.toThrow();
    const uncredentialed = await f.service.saveConsumer(
      f.input({ role: "admin" }),
      f.adminId,
      "new-admin",
    );
    await expect(
      f.service.saveConsumer(
        { ...adminInput, status: "disabled", expectedVersion: version },
        f.adminId,
        "last-admin",
        id,
      ),
    ).rejects.toThrow();
    await f.service.issueCredential(uncredentialed.id, f.adminId, "explicit");
    await f.service.saveConsumer(
      { ...adminInput, role: "viewer", expectedVersion: version },
      f.adminId,
      "now-safe",
      id,
    );
    const scopes = JSON.parse(
      (await f.db.get<{ scopes_json: string }>(
        "SELECT scopes_json FROM consumer_credentials WHERE consumer_id=?",
        [id],
      ))!.scopes_json,
    );
    expect(scopes).not.toContain("tickets:revoke");
    expect(scopes).not.toContain("tickets:write");
  });
  it("journals one create, replays without duplicate, enforces current role before replay and keeps a crash unknown", async () => {
    const f = await fixture(),
      payload = {
        name: "One machine",
        hostOs: "linux",
        architecture: "amd64",
        capacity: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 1 },
      };
    const request = () =>
      f.app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: f.headers(undefined, "single-create"),
        payload,
      });
    const first = await request(),
      again = await request();
    expect(first.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM machines WHERE name='One machine'",
        ))!.n,
      ),
    ).toBe(1);
    const receipts = await f.app.inject({
      url: "/v1/admin/commands",
      headers: f.headers(),
    });
    expect(
      receipts.json().find((r: { key: string }) => r.key === "single-create")
        .state,
    ).toBe("completed");
    await f.db.run("UPDATE consumers SET role='operator' WHERE id=?", [
      f.adminId,
    ]);
    expect((await request()).statusCode).toBe(403);
    const journal = new AdminCommandJournal(f.db);
    await journal.prepare(f.adminId, "crash-key", "POST /v1/machines", {
      name: "unknown",
    });
    await expect(
      journal.prepare(f.adminId, "crash-key", "POST /v1/machines", {
        name: "unknown",
      }),
    ).rejects.toThrow();
    expect(
      (await journal.receipts(f.adminId)).find((r) => r.key === "crash-key")!
        .state,
    ).toBe("unknown");
    await journal.review(
      f.adminId,
      {
        key: "crash-key",
        path: "POST /v1/machines",
        evidenceTargetId: first.json().id,
        reason: "Investigated original durable target; no capacity released",
      },
      "review",
    );
    expect(
      (await journal.receipts(f.adminId)).find((r) => r.key === "crash-key")!
        .state,
    ).toBe("unknown");
  });
  it("issues a credential once with safe atomic metadata, and rejects cookie writes lacking CSRF", async () => {
    const f = await fixture(),
      target = await f.service.saveConsumer(f.input(), f.adminId, "create");
    const issue = () =>
      f.app.inject({
        method: "POST",
        url: "/v1/admin/credentials",
        headers: f.headers(undefined, "issue-once"),
        payload: { consumerId: target.id },
      });
    const first = await issue();
    expect(first.statusCode).toBe(201);
    const token = first.json().token;
    expect(token).toHaveLength(47);
    expect((await issue()).statusCode).toBe(409);
    const journal = await f.db.all<{ safe_response_json: string }>(
      "SELECT safe_response_json FROM idempotency_keys WHERE route_scope LIKE 'admin:%'",
    );
    expect(JSON.stringify(journal)).not.toContain(token);
    expect(journal[0]!.safe_response_json).toContain("tokenOmitted");
    const session = await f.app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: f.headers(),
    });
    expect(session.statusCode).toBe(201);
    const cookies = session.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/admin/policies",
          headers: { cookie: cookies, "idempotency-key": "csrf-block" },
          payload: { name: "nope" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      await f.db.get("SELECT 1 FROM policies WHERE name='nope'"),
    ).toBeUndefined();
  });
  it("counts beyond the first page and has contract-backed OpenAPI paths", async () => {
    const f = await fixture();
    await f.db.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxQueuedTickets',200) WHERE id=?",
      [f.consumerId],
    );
    for (let i = 0; i < 105; i++) await f.acquire(f.consumerId, `many-${i}`);
    const response = await f.app.inject({
      url: "/v1/admin/overview",
      headers: f.headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().phases.queued).toBe(105);
    const doc = (await f.app.inject({ url: "/v1/openapi.json" })).json();
    expect(doc.paths["/v1/catalog"]).toBeDefined();
    expect(doc.paths["/v1/admin/consumers/{id}"]).toBeDefined();
  });
  it("retries an old failed operation by ID even after more than 200 newer operations", async () => {
    const f = await fixture(),
      ticket = await f.acquire();
    await f.tickets.reserveNext();
    const original = (await f.db.get<{ id: string; version: bigint }>(
      "SELECT o.id,o.version FROM operations o JOIN allocations a ON a.id=o.allocation_id WHERE a.ticket_id=? AND o.kind='allocation.provision'",
      [ticket.ticketId],
    ))!;
    await f.db.run("UPDATE operations SET state='failed' WHERE id=?", [
      original.id,
    ]);
    const newer = Date.now() + 1000;
    await f.db.batchTransaction(
      Array.from({ length: 201 }, (_, i) => ({
        kind: "run" as const,
        sql: "INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) SELECT ?,installation_id,1,'provider.discover',?,?,'succeeded',?,'{}',?,?,? FROM installations",
        params: [
          randomUUID(),
          `new-${i}`,
          `new-${i}`,
          "a".repeat(64),
          newer + i,
          newer + i,
          newer + i,
        ],
      })),
    );
    const operator = await f.add("operator");
    expect(
      (
        await f.service.operations({
          consumerId: f.adminId,
          role: "admin",
          scopes: [
            "tickets:read",
            "tickets:write",
            "tickets:revoke",
            "images:read",
            "events:read",
          ],
        })
      ).some((o) => o.id === original.id),
    ).toBe(false);
    const retry = (key: string) =>
      f.app.inject({
        method: "POST",
        url: `/v1/admin/operations/${original.id}/retry`,
        headers: f.headers(operator.token, key),
        payload: {
          expectedVersion: Number(original.version),
          reason: "Investigated the original operation outside the recent list",
        },
      });
    const response = await retry("old-operation");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: original.id,
      state: "unknown",
      version: Number(original.version) + 1,
    });
    expect((await retry("stale-operation")).statusCode).toBe(409);
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
        ))!.n,
      ),
    ).toBe(1);
  });
  it("reviews an unknown command outside the recent 100 receipts without resolving its outcome", async () => {
    const f = await fixture(),
      journal = new AdminCommandJournal(f.db, () => Date.now() - 10000),
      path = "POST /v1/machines";
    await journal.prepare(f.adminId, "old-unknown", path, { name: "original" });
    await f.db.batchTransaction(
      Array.from({ length: 101 }, (_, i) => ({
        kind: "run" as const,
        sql: "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,created_at_ms,retain_until_ms) VALUES(?,?,?,?,?,?)",
        params: [
          f.adminId,
          `admin:${path}`,
          `new-command-${i}`,
          "a".repeat(64),
          Date.now() + i,
          Date.now() + 86400000,
        ],
      })),
    );
    expect(
      (await journal.receipts(f.adminId)).some((r) => r.key === "old-unknown"),
    ).toBe(false);
    const response = await f.app.inject({
      method: "POST",
      url: "/v1/admin/commands/review",
      headers: f.headers(),
      payload: {
        key: "old-unknown",
        path,
        evidenceTargetId: f.consumerId,
        reason:
          "Confirmed original target independently; do not manufacture success",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      key: "old-unknown",
      path,
      state: "unknown",
      status: null,
    });
    expect(response.json().reviewedAtMs).toEqual(expect.any(Number));
    await expect(
      journal.prepare(f.adminId, "old-unknown", path, { name: "original" }),
    ).rejects.toMatchObject({ code: "management_result_unknown" });
  });
  it("aggregates the same bounded scope as point authorization with a constant number of SQLite calls", async () => {
    const f = await fixture(),
      node = (await f.db.get<{ id: string }>("SELECT id FROM nodes LIMIT 1"))!
        .id;
    await f.db.run(
      "UPDATE consumers SET quota_json=json_set(quota_json,'$.maxQueuedTickets',200) WHERE id=?",
      [f.consumerId],
    );
    const viewer = await f.add("viewer", {
        ...f.owner.authorization,
        nodeIds: [node],
      }),
      denied = await f.add("viewer", {
        ...f.owner.authorization,
        imageIds: [],
      }),
      actor = {
        consumerId: viewer.id,
        role: "viewer" as const,
        scopes: ["tickets:read", "images:read", "events:read"],
      };
    await f.acquire(); // An unplaced request with no explicit Node bound is hidden from a bounded observer.
    const visible = await f.tickets.acquire(f.consumerId, "bounded-visible", {
      image: { versionId: f.versionId },
      networkProfileId: f.networkId,
      allowedNodeIds: [node],
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 1 },
    });
    await f.tickets.reserveNext(); // The oldest request becomes visible through its actual allocated Node.
    const operation = (await f.db.get<{ id: string }>(
      "SELECT id FROM operations WHERE allocation_id IS NOT NULL LIMIT 1",
    ))!;
    await f.db.run("UPDATE operations SET state='unknown' WHERE id=?", [
      operation.id,
    ]);
    const at = Date.now();
    await f.db.run(
      "INSERT INTO operations(id,node_id,image_artifact_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) SELECT ?,?,id,1,'image-cache.prewarm','cache-count','cache-count','unknown',?,'{}',?,?,? FROM image_artifacts WHERE image_version_id=? LIMIT 1",
      [randomUUID(), node, "a".repeat(64), at, at, at, f.versionId],
    );
    await f.db.run(
      "INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) SELECT ?,installation_id,1,'provider.discover','private-count','private-count','unknown',?,'{}',?,?,? FROM installations",
      [randomUUID(), "a".repeat(64), at, at, at],
    );
    await f.db.run("UPDATE tickets SET cleanup_status='blocked' WHERE id=?", [
      visible.ticketId,
    ]);
    await expect(
      f.service.ticket(actor, visible.ticketId),
    ).resolves.toBeDefined();
    const get = vi.spyOn(f.db, "get"),
      all = vi.spyOn(f.db, "all");
    const first = await f.service.overview(actor),
      queryCount = get.mock.calls.length + all.mock.calls.length;
    expect(first.phases).toEqual({ queued: 1, reserved: 1 });
    expect(first.cleanupBlocked).toBe(1);
    expect(first.unknownOperations).toBe(2);
    get.mockClear();
    all.mockClear();
    for (let i = 0; i < 105; i++)
      await f.tickets.acquire(f.consumerId, `bounded-${i}`, {
        image: { versionId: f.versionId },
        networkProfileId: f.networkId,
        allowedNodeIds: [node],
        resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 1 },
      });
    get.mockClear();
    all.mockClear();
    const large = await f.service.overview(actor);
    expect(large.phases).toEqual({ queued: 106, reserved: 1 });
    expect(get.mock.calls.length + all.mock.calls.length).toBe(queryCount);
    expect(
      all.mock.calls.some(([sql]) => sql.includes("SELECT t.id,t.phase")),
    ).toBe(false);
    expect(
      all.mock.calls.some(([sql]) => sql.includes("FROM operations")),
    ).toBe(false);
    const deniedOverview = await f.service.overview({
      ...actor,
      consumerId: denied.id,
    });
    expect(deniedOverview.phases).toEqual({});
    expect(deniedOverview.cleanupBlocked).toBe(0);
    expect(deniedOverview.unknownOperations).toBe(0);
    const full = await f.app.inject({
      url: "/v1/admin/overview",
      headers: f.headers(),
    });
    expect(full.statusCode).toBe(200);
    expect(full.json().unknownOperations).toBe(3);
  });
  it("rejects same-key changed body/If-Match and protects management denies until all Claims are released", async () => {
    const f = await fixture(),
      policy = {
        allowedEgress: [],
        allowedIngressSourceCidrs: [],
        ipv6: "disabled",
      };
    const revise = (match: string, body = policy) =>
      f.app.inject({
        method: "POST",
        url: `/v1/network-profiles/${f.networkId}/revisions`,
        headers: { ...f.headers(undefined, "one-revision"), "if-match": match },
        payload: { policy: body },
      });
    expect((await revise('"1"')).statusCode).toBe(201);
    expect((await revise('"2"')).statusCode).toBe(409);
    expect(
      (
        await revise('"1"', {
          ...policy,
          allowedIngressSourceCidrs: ["192.0.2.0/24"],
        })
      ).statusCode,
    ).toBe(409);
    const baseline = (await f.db.get<{
      current_network_deny_revision_id: string;
    }>("SELECT current_network_deny_revision_id FROM installations"))!
      .current_network_deny_revision_id;
    const rules = [{ cidr: "192.0.2.10/32", protocol: "any", ports: "any" }],
      update = await f.app.inject({
        method: "PUT",
        url: "/v1/admin/network-deny",
        headers: f.headers(undefined, "deny-baseline"),
        payload: {
          expectedRevisionId: baseline,
          rules,
          reason: "Inventory management endpoints",
        },
      });
    expect(update.statusCode).toBe(200);
    // Restore the original verified network revision for the M0 fixture before reserving.
    await f.db.run(
      "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.verifiedNetworkProfileRevisionIds',json_array((SELECT current_revision_id FROM network_profiles WHERE id=?)))",
      [f.networkId],
    );
    await f.acquire();
    await f.tickets.reserveNext();
    const before = Number(
      (await f.db.get<{ n: bigint }>(
        "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
      ))!.n,
    );
    expect(before).toBe(1);
    const current = update.json().platformNetworkDeny.revisionId,
      loosen = await f.app.inject({
        method: "PUT",
        url: "/v1/admin/network-deny",
        headers: f.headers(undefined, "unsafe-loosening"),
        payload: {
          expectedRevisionId: current,
          rules: [{ cidr: "192.0.2.20/32", protocol: "tcp", ports: [443] }],
          reason: "Must wait for actual cleanup",
        },
      });
    expect([409, 412]).toContain(loosen.statusCode);
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
        ))!.n,
      ),
    ).toBe(before);
  });
  it("retries an authorized failed cleanup with CAS, keeps capacity until actual deletion and traces the retry event", async () => {
    const f = await fixture(),
      ticket = await f.acquire(),
      installation = (await f.db.get<{ installation_id: string }>(
        "SELECT installation_id FROM installations",
      ))!.installation_id,
      worker = new OperationWorker({
        storage: f.db,
        installationId: installation,
        execution: new PersistentSimulator(join(f.dir, "external")),
      });
    await f.tickets.reserveNext();
    await worker.reconcileBeforeScheduling();
    await f.tickets.cancel(ticket.ticketId, f.consumerId);
    const op = (await f.db.get<{ id: string; version: bigint }>(
      "SELECT o.id,o.version FROM operations o JOIN allocations a ON a.id=o.allocation_id WHERE a.ticket_id=? AND o.kind='allocation.cleanup'",
      [ticket.ticketId],
    ))!;
    await f.db.run("UPDATE operations SET state='failed' WHERE id=?", [op.id]);
    const operator = await f.add("operator"),
      request = () =>
        f.app.inject({
          method: "POST",
          url: `/v1/admin/operations/${op.id}/retry`,
          headers: f.headers(operator.token, "retry-cleanup"),
          payload: {
            expectedVersion: Number(op.version),
            reason: "Investigated original cleanup failure",
          },
        });
    const first = await request();
    expect(first.statusCode).toBe(200);
    expect(first.json().state).toBe("unknown");
    expect((await request()).json()).toEqual(first.json());
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
        ))!.n,
      ),
    ).toBe(1);
    const timeline = await f.app.inject({
      url: `/v1/admin/tickets/${ticket.ticketId}/timeline`,
      headers: f.headers(operator.token),
    });
    expect(timeline.body).toContain("operation.retry_requested");
    expect(timeline.body).not.toMatch(
      /intent_json|result_json|privateKey|access_secret/,
    );
    await worker.reconcileBeforeScheduling();
    expect(
      (await f.db.get<{ phase: string }>(
        "SELECT phase FROM tickets WHERE id=?",
        [ticket.ticketId],
      ))!.phase,
    ).toBe("released");
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) AS n FROM capacity_claims WHERE state<>'released'",
        ))!.n,
      ),
    ).toBe(0);
  });
});
