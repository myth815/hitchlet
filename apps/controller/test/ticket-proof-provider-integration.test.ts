// Synthetic Portainer/SSH/Runtime transports; real ordinary Ticket, Provider,
// OperationWorker, migrated SQLite journal and proof readers. No host operations.
import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { SQLiteProfileStore } from "../src/storage/profile-store.js";
import { TicketService } from "../src/application/tickets.js";
import { TicketQueries } from "../src/application/queries.js";
import { OperationWorker } from "../src/application/operations.js";
import { LeaseService } from "../src/application/leases.js";
import { AccessService } from "../src/application/access.js";
import { probeSsh } from "../src/providers/ssh-readiness.js";
import { AdminService } from "../src/application/admin.js";
import { SQLiteImagePublicationStore } from "../src/storage/image-publication-store.js";
import { TicketReadyInventoryReader } from "../src/application/ticket-ready-inventory.js";
import { TicketCleanupProofReader } from "../src/application/ticket-cleanup-proof.js";
import { PortainerExecutionProvider } from "../src/providers/portainer-provider.js";
import { hashRuntimeNetworkRules } from "../src/providers/runtime-network-client.js";
import type {
  RuntimeNetworkCommand,
  RuntimeNetworkResult,
} from "@hitchlet/contracts/internal";

vi.mock("../src/providers/ssh-readiness.js", () => ({
  probeSsh: vi.fn(async () => {}),
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (cleanup.length) await cleanup.pop()!();
});

function hostKeyArchive() {
  const text = Buffer.from(
    "ssh-ed25519 " +
      Buffer.from("synthetic-host-key").toString("base64") +
      " fixture\n",
  );
  const header = Buffer.alloc(512);
  header.write("ssh_host_ed25519_key.pub");
  header.write(text.length.toString(8).padStart(11, "0"), 124, "ascii");
  return Buffer.concat([header, text, Buffer.alloc(512 - text.length + 1024)]);
}

function dockerTransport(artifactRef: string, digest: string, starts = true) {
  type Json = Record<string, any>;
  let network: Json | undefined,
    volume: Json | undefined,
    container: Json | undefined;
  let sequence = 0;
  const deletes: string[] = [];
  const fetcher = vi.fn(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input)),
        path = url.pathname.split("/docker/")[1] ?? "",
        method = init?.method ?? "GET";
      const json = (value: unknown) => Response.json(value);
      if (url.pathname === "/api/system/version")
        return json({ ServerVersion: "2.45.2" });
      if (path === "info")
        return json({
          ID: "hitchlet-simulator",
          Architecture: "amd64",
          ServerVersion: "29.0.0",
        });
      if (method === "DELETE") {
        deletes.push(path);
        if (path.startsWith("containers/")) container = undefined;
        else if (path.startsWith("volumes/")) volume = undefined;
        else if (path.startsWith("networks/")) network = undefined;
        else throw new Error("Unexpected synthetic delete");
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === "networks/create") {
        const body = JSON.parse(String(init!.body));
        network = {
          ...body,
          Id: "a".repeat(63) + String(++sequence),
          Options: { "com.docker.network.bridge.name": "br-aaaaaaaaaaaa" },
          IPAM: {
            Config: [{ Subnet: "172.30.1.0/24", Gateway: "172.30.1.1" }],
          },
        };
        return json({ Id: network.Id });
      }
      if (method === "POST" && path === "volumes/create") {
        volume = JSON.parse(String(init!.body));
        return json({ Name: volume!.Name });
      }
      if (method === "POST" && path === "containers/create") {
        const body = JSON.parse(String(init!.body));
        container = {
          Id: "synthetic-container-" + sequence,
          Name: "/" + url.searchParams.get("name"),
          Image: "synthetic-image",
          Config: body,
          HostConfig: body.HostConfig,
          State: { Running: false, Status: "created" },
          NetworkSettings: {
            Ports: Object.fromEntries(
              Object.keys(body.ExposedPorts).map((port) => [
                port,
                body.HostConfig.PortBindings[port],
              ]),
            ),
          },
          Mounts: body.HostConfig.Mounts.map((m: Json) => ({
            Type: m.Type,
            Source: m.Source,
            Name: m.Type === "volume" ? m.Source : undefined,
            Destination: m.Target,
            RW: !m.ReadOnly,
            Propagation: "rprivate",
          })),
        };
        return json({ Id: container.Id });
      }
      if (method === "POST" && path.endsWith("/start")) {
        container!.State = {
          Running: starts,
          Status: starts ? "running" : "exited",
        };
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path.endsWith("/stop")) {
        container!.State = { Running: false, Status: "exited" };
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/archive"))
        return method === "GET"
          ? new Response(hostKeyArchive())
          : new Response(null, { status: 200 });
      if (path === "containers/json")
        return json(
          container
            ? [
                {
                  Id: container.Id,
                  Names: [container.Name],
                  Labels: container.Config.Labels,
                },
              ]
            : [],
        );
      if (path === "networks") return json(network ? [network] : []);
      if (path === "volumes") return json({ Volumes: volume ? [volume] : [] });
      if (path.startsWith("networks/"))
        return network
          ? json({
              ...network,
              Containers: container ? { [container.Id]: {} } : {},
            })
          : new Response(null, { status: 404 });
      if (path.startsWith("volumes/"))
        return volume ? json(volume) : new Response(null, { status: 404 });
      if (path.endsWith("/json") && path.startsWith("containers/"))
        return container
          ? json(container)
          : new Response(null, { status: 404 });
      if (path.startsWith("distribution/"))
        return json({
          Descriptor: {
            digest,
            mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          },
          Platforms: [{ architecture: "amd64", os: "linux" }],
        });
      if (path.startsWith("images/"))
        return json({
          Id: "synthetic-image",
          RepoDigests: [artifactRef],
          Architecture: "amd64",
          Os: "linux",
        });
      throw new Error(`Unexpected synthetic Docker request ${method} ${path}`);
    },
  );
  return { fetcher, deletes };
}

async function fixture(
  referenceCount: number,
  accessMode: "ssh" | "none" = "ssh",
  starts = true,
) {
  vi.clearAllMocks();
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-proof-provider-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const consumerId = stdout.match(/Consumer ID: (\S+)/)![1]!,
    versionId = stdout.match(/Image version: (\S+)/)![1]!,
    networkId = stdout.match(/Network profile: (\S+)/)![1]!;
  const storage = await openStorage(dir);
  cleanup.push(() => storage.close());
  const installation = (await storage.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations WHERE singleton=1",
  ))!;
  const now = Date.now(),
    clock = () => now;
  const profile = await new SQLiteProfileStore(storage, clock).createProfile(
    "storage",
    {
      name: "synthetic dynamic source",
      protocol: "local",
      secretVersionRef: null,
      config: {
        sourceRef: "/approved",
        allowedSubpaths: ["mounts"],
        allowedModes: ["read_write"],
      },
      authorizedConsumerIds: [consumerId],
    },
  );
  const digest = "sha256:" + "a".repeat(64),
    artifactRef = "docker.io/example/node@" + digest;
  await storage.run(
    "UPDATE nodes SET config_json=json_object('executionMode','portainer'),capabilities_json=json_set(capabilities_json,'$.verifiedStorageProfileRevisionIds',json(?))",
    [JSON.stringify([profile.revisionId])],
  );
  await storage.run(
    "UPDATE system_maintenance SET runtime_disks_json=json_object((SELECT id FROM nodes),json(?)) WHERE singleton=1",
    [
      JSON.stringify({
        state: "healthy",
        observedAtMs: now,
        availableMiB: 100000,
        reserveMiB: 128,
      }),
    ],
  );
  await storage.run(
    "UPDATE image_artifacts SET artifact_ref=?,content_digest=?,requirements_json=?,access_recipe_json=?",
    [
      artifactRef,
      digest,
      JSON.stringify({
        bootstrap: {
          mechanism:
            accessMode === "none"
              ? "hitchlet-container-entrypoint-v1"
              : "hitchlet-node-ssh-v1",
          contractVersion: "1",
          identityReset: true,
        },
      }),
      JSON.stringify({
        accessProtocols: accessMode === "none" ? [] : ["ssh"],
        ports: accessMode === "none" ? [] : [22],
        account: "workspace",
        allowedSourceCidrs: [],
        discovery: accessMode === "none" ? "none" : "portainer-published-port",
        readiness:
          accessMode === "none"
            ? "container-running"
            : "ssh-public-key-authenticated-fingerprint",
      }),
    ],
  );
  const transport = dockerTransport(artifactRef, digest, starts);
  vi.stubGlobal("fetch", transport.fetcher);
  const networkResult = vi.fn(
    async (command: RuntimeNetworkCommand): Promise<RuntimeNetworkResult> => ({
      commandId: command.commandId,
      operationId: command.operationId,
      allocationId: command.allocationId,
      generation: command.generation,
      nativeEngineId: "hitchlet-simulator",
      status:
        command.kind === "network.ensure"
          ? "installed"
          : command.kind === "network.revoke"
            ? "revoked"
            : command.kind === "network.remove"
              ? "removed"
              : "present",
      rulesetHash:
        command.kind === "network.remove"
          ? null
          : command.kind === "network.revoke"
            ? hashRuntimeNetworkRules(command.plan, true)
            : command.plan.expectedRulesetHash,
      verifiedAt: new Date(now).toISOString(),
    }),
  );
  const getOrCreate = vi.fn(async () => ({
    privateKey: "synthetic-private",
    publicKey: "synthetic-public",
    fingerprint: "synthetic-fingerprint",
    secretRef: "synthetic-secret",
  }));
  const execution = new PortainerExecutionProvider(
    async () => ({
      endpointUrl: "https://portainer.test",
      environmentId: "1",
      apiKey: "synthetic-only",
      engineId: "hitchlet-simulator",
      providerEvidence: { dockerVersion: "29.0.0", portainerVersion: "2.45.2" },
      agentId: "synthetic-agent",
      controllerEpoch: 1,
      networkCidrBase: "172.30.0.0/16",
      ingressSourceCidrs: [],
      effectiveDenyRevisionId: "synthetic-deny",
      accessHost: "192.0.2.1",
      userlandProxy: false,
      managementDenyRules: [],
      runtimeNetwork: {
        ensure: networkResult,
        inspect: networkResult,
        revoke: networkResult,
        remove: networkResult,
      },
      storageFacts: async (request) => ({
        requestId: request.requestId,
        installationId: request.installationId,
        runtimeIdentityId: request.runtimeIdentityId,
        nativeEngineId: request.nativeEngineId,
        observedAtMs: now,
        controllerEpoch: 1,
        inventory: null,
        imageStore: { root: "/var/lib/docker", availableMiB: 100000 },
        mounts: request.mounts.map((m) => ({
          grantId: m.grantId,
          resolvedSourceRef: resolve(m.approvedSourceRef, m.authorizedSubpath),
          sourceValidationEvidenceId: "synthetic:" + m.grantId,
        })),
      }),
    }),
    { getOrCreate },
    clock,
  );
  const tickets = new TicketService({
    storage,
    installationId: installation.installation_id,
    now: clock,
    enabledExecutionMode: "portainer",
  });
  const worker = new OperationWorker({
    storage,
    execution,
    installationId: installation.installation_id,
    now: clock,
    enabledExecutionMode: "portainer",
  });
  const receipt = await tickets.acquire(consumerId, "synthetic-acquire", {
    image: { versionId },
    resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
    networkProfileId: networkId,
    lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
    ...(accessMode === "none" ? { access: { protocol: "none" as const } } : {}),
    storage: Array.from({ length: referenceCount }, (_, n) => ({
      storageProfileId: profile.id,
      authorizedSubpath: "mounts/borrow/" + (n === 0 ? "project" : "home"),
      mountPath: n === 0 ? "/work" : "/persist/home",
      mode: "read_write",
    })),
  });
  await tickets.reserveNext();
  await worker.reconcile();
  const queries = new TicketQueries(storage, clock),
    ready = await queries.get(consumerId, receipt.ticketId);
  if (starts)
    expect(
      ready?.phase,
      JSON.stringify({
        ready,
        operations: await storage.all(
          "SELECT kind,state,result_json FROM operations",
        ),
      }),
    ).toBe("ready");
  expect(ready!.lease!.claimedAt).toBeNull();
  return {
    storage,
    clock,
    tickets,
    worker,
    queries,
    ready: ready!,
    consumerId,
    transport,
    getOrCreate,
    networkResult,
    networkId,
  };
}

it.each([
  [0, "ssh"],
  [2, "ssh"],
  [0, "none"],
  [2, "none"],
] as const)(
  "ordinary Provider -> real SQLite journal -> both proof readers (%i references, %s)",
  async (referenceCount, accessMode) => {
    const f = await fixture(referenceCount, accessMode),
      ticketId = f.ready.id,
      query = {
        leaseId: f.ready.lease!.id,
        generation: f.ready.lease!.generation,
      };
    const rows = await f.storage.all<{ kind: string; ownership: string }>(
      "SELECT kind,ownership FROM managed_resources ORDER BY ownership,kind",
    );
    expect(rows.filter((r) => r.ownership === "reference")).toEqual(
      Array.from({ length: referenceCount }, () => ({
        kind: "volume",
        ownership: "reference",
      })),
    );
    const rejected: unknown[] = [];
    const before = await new TicketReadyInventoryReader(
      f.storage,
      f.clock,
      (d) => rejected.push(d),
    )
      .read(f.consumerId, ticketId, query)
      .then(
        (value) => ({ value }),
        (error) => ({ error: error.code, rejected }),
      );
    expect
      .soft(before)
      .toMatchObject({ value: { ticketId, completeness: "complete" } });
    if ("value" in before) expect(before.value!.objects).toHaveLength(3);
    const leases = new LeaseService(f.storage, f.clock);
    const mismatch = await f.tickets.preview(f.consumerId, {
      image: { versionId: f.ready.pinnedImageVersionId },
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      networkProfileId: f.networkId,
      access: { protocol: accessMode === "none" ? "ssh" : "none" },
    });
    expect(mismatch.availability).toBe("unsupported");
    await leases.renew(f.consumerId, ticketId, "synthetic-claim", {
      generation: query.generation,
      expectedLeaseVersion: f.ready.lease!.version,
    });
    await leases.reconcilePending();
    expect(
      (await f.queries.get(f.consumerId, ticketId))!.lease!.claimedAt,
    ).not.toBeNull();
    if (accessMode === "none") {
      const createCall = f.transport.fetcher.mock.calls.find(([input]) =>
        new URL(String(input)).pathname.endsWith("/containers/create"),
      )!;
      const body = JSON.parse(String(createCall[1]!.body));
      expect(body.ExposedPorts).toEqual({});
      expect(body.HostConfig.PortBindings).toEqual({});
      expect(body.Entrypoint).toBeUndefined();
      expect(body.Cmd).toEqual([]);
      expect(body.User).toBe("1000:1000");
      if (referenceCount)
        expect(
          body.HostConfig.Mounts.map((m: { Target: string }) => m.Target),
        ).toEqual(["/work", "/persist/home", "/workspace"]);
      expect(f.getOrCreate).not.toHaveBeenCalled();
      expect(probeSsh).not.toHaveBeenCalled();
      expect(
        f.transport.fetcher.mock.calls.some(([input]) =>
          new URL(String(input)).pathname.endsWith("/archive"),
        ),
      ).toBe(false);
      expect(
        f.networkResult.mock.calls.every(
          ([command]) => command.plan.publishedPorts.length === 0,
        ),
      ).toBe(true);
      await expect(
        new AccessService(f.storage, f.clock).get(
          f.consumerId,
          ticketId,
          "synthetic-access",
          query.generation,
        ),
      ).rejects.toMatchObject({ code: "access_not_applicable" });
      const persisted = await f.storage.get<{
        actual_resources_json: string;
        access_secret_ref: string | null;
      }>(
        "SELECT actual_resources_json,access_secret_ref FROM allocations WHERE ticket_id=?",
        [ticketId],
      );
      expect(persisted!.access_secret_ref).toBeNull();
      expect(
        JSON.parse(persisted!.actual_resources_json).receipt.access,
      ).toBeUndefined();
    }
    await f.tickets.cancel(ticketId, f.consumerId, "consumer_release", {
      expectedGeneration: query.generation,
    });
    await f.worker.reconcileCleanupLane();
    expect((await f.queries.get(f.consumerId, ticketId))?.phase).toBe(
      "released",
    );
    const after = await new TicketCleanupProofReader(f.storage, f.clock)
      .read(f.consumerId, ticketId, query)
      .then(
        (value) => ({ value }),
        (error) => ({ error: error.code }),
      );
    expect
      .soft(after)
      .toMatchObject({ value: { ticketId, providerCleanup: "complete" } });
    if ("value" in after) expect(after.value!.receipts).toHaveLength(3);
    expect(f.transport.deletes).toHaveLength(3);
    expect(
      f.transport.deletes.every((path) => !path.includes("storage:")),
    ).toBe(true);
  },
);

it("does not mark an exited entrypoint ready and still reclaims its actual owned resources", async () => {
  const f = await fixture(2, "none", false);
  expect(f.ready.phase).not.toBe("ready");
  expect(f.getOrCreate).not.toHaveBeenCalled();
  expect(probeSsh).not.toHaveBeenCalled();
  await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_cancel", {
    expectedGeneration: f.ready.lease!.generation,
  });
  await f.worker.reconcileCleanupLane();
  expect((await f.queries.get(f.consumerId, f.ready.id))!.phase).toBe(
    "released",
  );
  expect(f.transport.deletes).toHaveLength(3);
});

it("registers, validates and publishes an entrypoint artifact through the ordinary image path", async () => {
  const f = await fixture(0, "none");
  await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_release", {
    expectedGeneration: f.ready.lease!.generation,
  });
  await f.worker.reconcileCleanupLane();
  const adminId = (await f.storage.get<{ id: string }>(
    "SELECT id FROM consumers WHERE role='admin'",
  ))!.id;
  const nodeId = (await f.storage.get<{ id: string }>("SELECT id FROM nodes"))!
    .id;
  await f.storage.run(
    "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.capacity',json(?))",
    [JSON.stringify({ cpuMillis: 3000, memoryMiB: 4096, scratchMiB: 8192 })],
  );
  const admin = new AdminService(
    f.storage,
    async () => {
      throw new Error("Unexpected external discovery");
    },
    f.clock,
  );
  const draft = await admin.createDraft({
    name: "synthetic entrypoint publication",
    version: "1",
    architecture: "amd64",
    artifactRef: "docker.io/example/node@sha256:" + "a".repeat(64),
    digest: "sha256:" + "a".repeat(64),
    minimumResources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
    bootstrap: {
      mechanism: "hitchlet-container-entrypoint-v1",
      contractVersion: "1",
      identityReset: true,
    },
    access: {
      accessProtocols: [],
      ports: [],
      account: "workspace",
      allowedSourceCidrs: [],
      discovery: "none",
      readiness: "container-running",
    },
    authorizedConsumerIds: [adminId, f.consumerId],
  });
  const run = await admin.scheduleValidation({
    versionId: draft.versionId,
    requestedBy: adminId,
    imageArtifactId: draft.artifactId,
    nodeId,
    networkProfileId: f.networkId,
    storage: [],
    deadlineSeconds: 120,
    resources: {
      request: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      limit: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      isolation: "shared_kernel",
      scratchEnforcement: "best_effort",
      accelerators: [],
    },
  });
  expect(run).toMatchObject({ scheduler: "queued" });
  await f.worker.reconcile();
  await f.worker.reconcileCleanupLane();
  expect(
    await f.storage.get(
      "SELECT state,test_outcome,cleanup_status FROM image_validations WHERE id=?",
      [run.validationId],
    ),
    JSON.stringify(
      await f.storage.all(
        "SELECT kind,state,result_json FROM operations WHERE allocation_id IN(SELECT id FROM allocations WHERE image_validation_id=?)",
        [run.validationId],
      ),
    ),
  ).toMatchObject({
    state: "succeeded",
    test_outcome: "passed",
    cleanup_status: "complete",
  });
  const entity = (await f.storage.get<{ entity_version: bigint }>(
    "SELECT entity_version FROM image_versions WHERE id=?",
    [draft.versionId],
  ))!;
  // The publication store is real; only its authenticated external Engine probe is synthetic.
  expect(
    await new SQLiteImagePublicationStore(f.storage, f.clock).publish(
      draft.versionId,
      Number(entity.entity_version),
      async () => true,
    ),
  ).toMatchObject({ status: "published" });
  expect(f.getOrCreate).not.toHaveBeenCalled();
  expect(probeSsh).not.toHaveBeenCalled();
});
