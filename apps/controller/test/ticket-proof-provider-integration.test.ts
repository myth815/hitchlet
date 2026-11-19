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

function dockerTransport(artifactRef: string, digest: string) {
  type Json = Record<string, any>;
  let network: Json | undefined,
    volume: Json | undefined,
    container: Json | undefined;
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
          Id: "a".repeat(64),
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
          Id: "synthetic-container",
          Name: "/" + url.searchParams.get("name"),
          Image: "synthetic-image",
          Config: body,
          HostConfig: body.HostConfig,
          State: { Running: false, Status: "created" },
          NetworkSettings: {
            Ports: { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "42022" }] },
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
        container!.State = { Running: true, Status: "running" };
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

async function fixture(referenceCount: number) {
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
          mechanism: "hitchlet-node-ssh-v1",
          contractVersion: "1",
          identityReset: true,
        },
      }),
      JSON.stringify({
        accessProtocols: ["ssh"],
        ports: [22],
        account: "workspace",
        allowedSourceCidrs: [],
        discovery: "portainer-published-port",
        readiness: "ssh-public-key-authenticated-fingerprint",
      }),
    ],
  );
  const transport = dockerTransport(artifactRef, digest);
  vi.stubGlobal("fetch", transport.fetcher);
  const networkResult = async (
    command: RuntimeNetworkCommand,
  ): Promise<RuntimeNetworkResult> => ({
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
  });
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
    {
      getOrCreate: async () => ({
        privateKey: "synthetic-private",
        publicKey: "synthetic-public",
        fingerprint: "synthetic-fingerprint",
        secretRef: "synthetic-secret",
      }),
    },
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
  };
}

it.each([0, 2])(
  "ordinary Provider -> real SQLite journal -> both proof readers (%i references)",
  async (referenceCount) => {
    const f = await fixture(referenceCount),
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
