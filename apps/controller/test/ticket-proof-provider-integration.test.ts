// Synthetic Portainer/SSH/Runtime transports; real ordinary Ticket, Provider,
// OperationWorker, migrated SQLite journal and proof readers. No host operations.
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { HitchletClient } from "../../../packages/sdk/dist/index.js";
import { SQLiteImagePublicationStore } from "../src/storage/image-publication-store.js";
import { TicketReadyInventoryReader } from "../src/application/ticket-ready-inventory.js";
import { TicketCleanupProofReader } from "../src/application/ticket-cleanup-proof.js";
import { PortainerExecutionProvider } from "../src/providers/portainer-provider.js";
import { hashRuntimeNetworkRules } from "../src/providers/runtime-network-client.js";
import type {
  RuntimeNetworkCommand,
  RuntimeNetworkResult,
  NetworkDestination,
  ContainerGroup,
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

function dockerTransport(
  artifactRef: string,
  digest: string,
  starts = true,
  gateway?: { artifactRef: string; digest: string },
  faults: {
    loseGatewayCreateResponse: boolean;
    rejectGatewayImage?: boolean;
    gatewayCapabilities?: string[];
    skipProvision?: boolean;
    skipReserve?: boolean;
    dockerBridge?: boolean;
    extraAttachment?: boolean;
    publishedHostPort?: boolean;
    networkDriver?: string;
    gatewayMissingTun?: boolean;
    gatewayForwardingDisabled?: boolean;
  } = { loseGatewayCreateResponse: false },
) {
  type Json = Record<string, any>;
  const networks = new Map<string, Json>(),
    volumes = new Map<string, Json>(),
    containers = new Map<string, Json>();
  let networkSequence = 0,
    containerSequence = 0;
  const deletes: string[] = [];
  const fetcher = vi.fn(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input)),
        path = url.pathname.split("/docker/")[1] ?? "",
        method = init?.method ?? "GET";
      const json = (value: unknown) => Response.json(value);
      const parts = path.split("/"),
        id = decodeURIComponent(parts[1] ?? "");
      const container = containers.get(id),
        network =
          networks.get(id) ?? [...networks.values()].find((n) => n.Name === id);
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
        if (path.startsWith("containers/")) containers.delete(id);
        else if (path.startsWith("volumes/")) volumes.delete(id);
        else if (path.startsWith("networks/"))
          networks.delete(network?.Id ?? id);
        else throw new Error("Unexpected synthetic delete");
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && path === "networks/create") {
        const body = JSON.parse(String(init!.body)),
          sequence = ++networkSequence;
        const n = {
          ...body,
          Id: "a".repeat(63) + String(sequence),
          Options: {
            "com.docker.network.bridge.name": "br-fixture" + sequence,
          },
          IPAM: {
            Config: [
              {
                Subnet: `172.30.${sequence}.0/24`,
                Gateway: `172.30.${sequence}.1`,
              },
            ],
          },
        };
        if (faults.networkDriver) n.Driver = faults.networkDriver;
        networks.set(n.Id, n);
        return json({ Id: n.Id });
      }
      if (method === "POST" && path === "volumes/create") {
        const v = JSON.parse(String(init!.body));
        volumes.set(v.Name, v);
        return json({ Name: v.Name });
      }
      if (method === "POST" && path === "containers/create") {
        const body = JSON.parse(String(init!.body));
        if (
          body.Labels["io.hitchlet.member"] === "gateway" &&
          faults.gatewayCapabilities
        )
          body.HostConfig.CapAdd = [...faults.gatewayCapabilities];
        if (body.Labels["io.hitchlet.member"] === "gateway") {
          if (faults.gatewayMissingTun) body.HostConfig.Devices = [];
          if (faults.gatewayForwardingDisabled)
            body.HostConfig.Sysctls["net.ipv4.ip_forward"] = "0";
        }
        const image =
          gateway && body.Image === gateway.artifactRef
            ? "synthetic-gateway-image"
            : "synthetic-image";
        const c = {
          Id: "synthetic-container-" + ++containerSequence,
          Name: "/" + url.searchParams.get("name"),
          Image: image,
          Config: body,
          HostConfig: body.HostConfig,
          State: { Running: false, Status: "created" },
          NetworkSettings: {
            Ports: Object.fromEntries(
              Object.keys(body.ExposedPorts).map((p) => [
                p,
                body.HostConfig.PortBindings[p],
              ]),
            ),
            Networks: Object.fromEntries(
              Object.entries(body.NetworkingConfig.EndpointsConfig).map(
                ([name, endpoint]) => {
                  const n = [...networks.values()].find(
                    (x) => x.Name === name,
                  )!;
                  return [
                    name,
                    { ...(endpoint as Json), NetworkID: n.Id, IPAddress: "" },
                  ];
                },
              ),
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
        if (faults.extraAttachment)
          c.NetworkSettings.Networks.foreign = {
            NetworkID: "foreign-network",
            IPAddress: "198.51.100.2",
          };
        if (faults.publishedHostPort)
          c.HostConfig.PortBindings = {
            "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }],
          };
        containers.set(c.Id, c);
        if (
          body.Labels["io.hitchlet.member"] === "gateway" &&
          faults.loseGatewayCreateResponse
        ) {
          faults.loseGatewayCreateResponse = false;
          throw new Error(
            "Synthetic lost create response after Engine committed gateway",
          );
        }
        return json({ Id: c.Id });
      }
      if (method === "POST" && path.endsWith("/start")) {
        container!.State = {
          Running: starts,
          Status: starts ? "running" : "exited",
        };
        for (const endpoint of Object.values(
          container!.NetworkSettings.Networks,
        ) as Json[])
          endpoint.IPAddress =
            endpoint.IPAMConfig?.IPv4Address ??
            [...networks.values()]
              .find((n) => n.Id === endpoint.NetworkID)!
              .IPAM.Config[0].Subnet.replace(".0/24", ".2");
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
          [...containers.values()].map((c) => ({
            Id: c.Id,
            Names: [c.Name],
            Labels: c.Config.Labels,
          })),
        );
      if (path === "networks") return json([...networks.values()]);
      if (path === "volumes") return json({ Volumes: [...volumes.values()] });
      if (path.startsWith("networks/"))
        return network
          ? json({
              ...network,
              Containers: Object.fromEntries(
                [...containers.values()]
                  .filter((c) => c.HostConfig.NetworkMode === network.Name)
                  .map((c) => [
                    c.Id,
                    {
                      Name: c.Name.slice(1),
                      IPv4Address: Object.values(
                        c.NetworkSettings.Networks as Json,
                      )[0].IPAddress,
                    },
                  ]),
              ),
            })
          : new Response(null, { status: 404 });
      if (path.startsWith("volumes/"))
        return volumes.has(id)
          ? json(volumes.get(id))
          : new Response(null, { status: 404 });
      if (path.endsWith("/json") && path.startsWith("containers/"))
        return container
          ? json(container)
          : new Response(null, { status: 404 });
      const isGateway =
        gateway && decodeURIComponent(path).includes(gateway.digest);
      const wanted = isGateway ? gateway! : { artifactRef, digest };
      if (
        path.startsWith("distribution/") &&
        isGateway &&
        faults.rejectGatewayImage
      )
        return new Response(null, { status: 503 });
      if (path.startsWith("distribution/"))
        return json({
          Descriptor: {
            digest: wanted.digest,
            mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          },
          Platforms: [{ architecture: "amd64", os: "linux" }],
        });
      if (path.startsWith("images/"))
        return json({
          Id: isGateway ? "synthetic-gateway-image" : "synthetic-image",
          RepoDigests: [wanted.artifactRef],
          Architecture: "amd64",
          Os: "linux",
        });
      throw new Error(`Unexpected synthetic Docker request ${method} ${path}`);
    },
  );
  return { fetcher, deletes, containers, networks };
}

async function fixture(
  referenceCount: number,
  accessMode: "ssh" | "none" = "ssh",
  starts = true,
  networkEgress: readonly NetworkDestination[] = [],
  containerGroup?: ContainerGroup,
  faults: {
    loseGatewayCreateResponse: boolean;
    rejectGatewayImage?: boolean;
    gatewayCapabilities?: string[];
    skipProvision?: boolean;
    skipReserve?: boolean;
    dockerBridge?: boolean;
    extraAttachment?: boolean;
    publishedHostPort?: boolean;
    networkDriver?: string;
    gatewayMissingTun?: boolean;
    gatewayForwardingDisabled?: boolean;
  } = { loseGatewayCreateResponse: false },
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
    seedNetworkId = stdout.match(/Network profile: (\S+)/)![1]!,
    consumerToken = stdout.match(/Bearer token \(shown once\): (\S+)/)![1]!;
  const storage = await openStorage(dir);
  cleanup.push(() => storage.close());
  const installation = (await storage.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations WHERE singleton=1",
  ))!;
  let now = Date.now();
  const clock = () => now;
  const losesResponse = faults.loseGatewayCreateResponse;
  const networkProfile =
    networkEgress.length || faults.dockerBridge
      ? await new SQLiteProfileStore(storage, clock).createProfile("network", {
          name: "synthetic explicit host endpoints",
          config: {
            ...(faults.dockerBridge ? { dockerMode: "bridge" } : {}),
            allowedEgress: networkEgress,
            allowedIngressSourceCidrs: [],
            ipv6: "disabled",
          },
          authorizedConsumerIds: [consumerId],
        })
      : null;
  const networkId = networkProfile?.id ?? seedNetworkId;
  const profile = await new SQLiteProfileStore(storage, clock).createProfile(
    "storage",
    {
      name: "synthetic dynamic source",
      protocol: "local",
      secretVersionRef: null,
      config: {
        sourceRef: "/approved",
        allowedSubpaths: ["mounts"],
        allowedModes: ["read_write", "read_only"],
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
  // Synthetic node qualification for this newly created fixture revision only.
  if (faults.dockerBridge) {
    const node = (await storage.get<{ id: string; version: bigint }>(
      "SELECT id,version FROM nodes",
    ))!;
    const adminId = (await storage.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='admin'",
    ))!.id;
    const evidence = {
      engineId: "hitchlet-simulator",
      dockerVersion: "29.0.0",
      portainerVersion: "2.45.2",
      architecture: "amd64",
      os: "linux",
      cpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
      containerCount: 0,
      unmanagedContainerCount: 0,
      apiVersion: "1.54",
      minimumApiVersion: "1.44",
    };
    await storage.run(
      "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,secret_version_ref,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) SELECT ?,connection_id,revision+1,'https://portainer.test','1',?,verified_runtime_identity_id,?, ?,? FROM provider_connection_revisions",
      [
        randomUUID(),
        "secret:" + "a".repeat(32),
        now,
        JSON.stringify(evidence),
        now,
      ],
    );
    await storage.run(
      "UPDATE provider_connections SET current_revision_id=(SELECT id FROM provider_connection_revisions ORDER BY revision DESC LIMIT 1)",
    );
    await storage.run(
      "UPDATE nodes SET admission='disabled',config_json=json_set(config_json,'$.runtimeProfile',json('{}'))",
    );
    const admin = new AdminService(
      storage,
      async () => evidence,
      clock,
      false,
      async () => "synthetic-only",
    );
    await admin.attestNodeCapabilities({
      nodeId: node.id,
      expectedVersion: Number(node.version),
      engineId: evidence.engineId,
      dockerVersion: evidence.dockerVersion,
      portainerVersion: evidence.portainerVersion,
      architecture: "amd64",
      checkedAt: new Date(now).toISOString(),
      networkProfileRevisionIds: [networkProfile!.revisionId],
      storageProfileRevisionIds: [profile.revisionId],
      operatorId: adminId,
      requestId: randomUUID(),
      report: {
        runId: randomUUID(),
        sha256: "a".repeat(64),
        scopes: {
          resourceLimits: {
            status: "passed",
            summary: "synthetic CPU/memory enforcement",
            evidenceRef: "fixture:limits",
          },
        },
        storageScopes: {
          readOnly: "passed",
          independentWrite: "passed",
          sourceBoundary: "passed",
          persistentSurvival: "passed",
        },
      },
    });
    await storage.run("UPDATE nodes SET observed_at_ms=?", [now - 46000]);
    expect(await admin.refreshPortainerObservations()).toMatchObject({
      checked: 1,
      refreshed: 1,
      unhealthy: 0,
    });
    expect((await admin.listNodes())[0]!.capabilities).toMatchObject({
      verified: true,
      supportedAccess: [],
    });
    const capability = JSON.parse(
      (await storage.get<{ capabilities_json: string }>(
        "SELECT capabilities_json FROM nodes",
      ))!.capabilities_json,
    );
    expect(capability.networkPolicyEnforcement).toBe("unsupported");
    expect(capability.verifiedNetworkProfileRevisionIds).toEqual([]);
    expect(Object.keys(capability.manualReport.scopes)).toEqual([
      "resourceLimits",
    ]);
  } else if (networkProfile)
    await storage.run(
      "UPDATE nodes SET capabilities_json=json_set(capabilities_json,'$.verifiedNetworkProfileRevisionIds',json(?))",
      [JSON.stringify([networkProfile.revisionId])],
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
          mechanism: containerGroup
            ? "hitchlet-container-group-entrypoint-v1"
            : accessMode === "none"
              ? "hitchlet-container-entrypoint-v1"
              : "hitchlet-node-ssh-v1",
          contractVersion: "1",
          identityReset: true,
        },
        ...(containerGroup === undefined ? {} : { containerGroup }),
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
  const transport = dockerTransport(
    artifactRef,
    digest,
    starts,
    containerGroup?.gateway,
    faults,
  );
  vi.stubGlobal("fetch", transport.fetcher);
  const networkResult = vi.fn(
    async (command: RuntimeNetworkCommand): Promise<RuntimeNetworkResult> => {
      if (faults.dockerBridge)
        throw new Error(
          "Ordinary bridge must never call Runtime network actions",
        );
      return {
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
      };
    },
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
      authorizedSubpath:
        "mounts/borrow/" +
        (n === 0 ? "project" : n === 1 ? "home" : "gateway-config"),
      mountPath:
        n === 0 ? "/work" : n === 1 ? "/persist/home" : "/persist/gateway",
      mode: n === 2 ? "read_only" : "read_write",
    })),
  });
  if (!faults.skipReserve) await tickets.reserveNext();
  if (!faults.skipProvision && !faults.skipReserve) await worker.reconcile();
  const queries = new TicketQueries(storage, clock),
    ready = await queries.get(consumerId, receipt.ticketId);
  if (
    starts &&
    !losesResponse &&
    !faults.rejectGatewayImage &&
    faults.gatewayCapabilities === undefined &&
    !faults.extraAttachment &&
    !faults.publishedHostPort &&
    !faults.networkDriver &&
    !faults.gatewayMissingTun &&
    !faults.gatewayForwardingDisabled &&
    !faults.skipProvision &&
    !faults.skipReserve
  )
    expect(
      ready?.phase,
      JSON.stringify({
        ready,
        operations: await storage.all(
          "SELECT kind,state,result_json FROM operations",
        ),
      }),
    ).toBe("ready");
  if (ready!.lease) expect(ready!.lease!.claimedAt).toBeNull();
  return {
    dir,
    consumerToken,
    storage,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    tickets,
    worker,
    queries,
    ready: ready!,
    consumerId,
    transport,
    getOrCreate,
    networkResult,
    networkId,
    networkProfile,
  };
}

it.each([
  [0, "ssh", false],
  [2, "ssh", false],
  [0, "none", false],
  [2, "none", false],
  [0, "none", true],
  [2, "none", true],
] as const)(
  "ordinary Provider -> real SQLite journal -> both proof readers (%i references, %s, bridge=%s)",
  async (referenceCount, accessMode, dockerBridge = false) => {
    const f = await fixture(referenceCount, accessMode, true, [], undefined, {
        loseGatewayCreateResponse: false,
        dockerBridge,
      }),
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
    if (dockerBridge) expect(f.networkResult).not.toHaveBeenCalled();
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
  expect(
    await new TicketCleanupProofReader(f.storage, f.clock).read(
      f.consumerId,
      f.ready.id,
      { leaseId: f.ready.lease!.id, generation: f.ready.lease!.generation },
    ),
  ).toMatchObject({
    version: "1.1",
    outcome: "reclaimed",
    objects: expect.any(Array),
  });
});

const groupRecipe: ContainerGroup = {
  gateway: {
    artifactRef: "docker.io/example/gateway@sha256:" + "b".repeat(64),
    digest: "sha256:" + "b".repeat(64),
    resources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
    mountPaths: ["/persist/gateway"],
    stateMountPath: "/var/lib/gateway",
    networkCapability: "tun",
    ipv4Forwarding: true,
    environment: {
      GATEWAY_CONFIG_FILE: "/persist/gateway/gateway.json",
      GATEWAY_KEY_FILE: "/persist/gateway/setup-key",
    },
  },
  links: [
    { from: "gateway", to: "workload", protocol: "tcp", ports: [3000] },
    { from: "workload", to: "gateway", protocol: "tcp", ports: [18080] },
  ],
};
it.each([false, true])(
  "delivers a two-member lease before claim and proves complete group cleanup without deleting persistent references (bridge=%s)",
  async (dockerBridge) => {
    const f = await fixture(3, "none", true, [], groupRecipe, {
      loseGatewayCreateResponse: false,
      dockerBridge,
    });
    const query = {
      leaseId: f.ready.lease!.id,
      generation: f.ready.lease!.generation,
    };
    const inventory = await new TicketReadyInventoryReader(
      f.storage,
      f.clock,
    ).read(f.consumerId, f.ready.id, query);
    expect(inventory!.objects).toHaveLength(5);
    expect(
      inventory!.objects.filter((o) => o.kind === "container"),
    ).toHaveLength(2);
    expect(f.ready.lease!.claimedAt).toBeNull();
    const native = [...f.transport.containers.values()];
    expect(
      native.map((c) => c.Config.Labels["io.hitchlet.member"]).sort(),
    ).toEqual(["gateway", "workload"]);
    expect(native.reduce((n, c) => n + c.HostConfig.CpuQuota, 0)).toBe(50000);
    expect(native.reduce((n, c) => n + c.HostConfig.Memory, 0)).toBe(
      512 * 1024 * 1024,
    );
    expect(
      native.every(
        (c) => !c.HostConfig.Privileged && c.HostConfig.NetworkMode !== "host",
      ),
    ).toBe(true);
    const gateway = native.find(
      (c) => c.Config.Labels["io.hitchlet.member"] === "gateway",
    )!;
    const workload = native.find(
      (c) => c.Config.Labels["io.hitchlet.member"] === "workload",
    )!;
    expect(gateway.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(gateway.HostConfig.CapAdd).toEqual(["NET_ADMIN", "NET_RAW"]);
    expect(workload.Config.User).toBe("1000:1000");
    expect(workload.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(workload.HostConfig.CapAdd).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "SETGID",
      "SETUID",
      "SYS_CHROOT",
      "NET_BIND_SERVICE",
    ]);
    expect(workload.HostConfig.Devices).toBeUndefined();
    expect(gateway.HostConfig.Devices).toEqual([
      {
        PathOnHost: "/dev/net/tun",
        PathInContainer: "/dev/net/tun",
        CgroupPermissions: "rw",
      },
    ]);
    expect(
      gateway.Mounts.find(
        (m: { Destination: string }) => m.Destination === "/persist/gateway",
      ),
    ).toMatchObject({ Type: "bind", RW: false });
    expect(
      workload.Mounts.some(
        (m: { Destination: string }) => m.Destination === "/persist/gateway",
      ),
    ).toBe(false);
    expect(
      inventory!.containerGroup!.members.find((m) => m.name === "gateway"),
    ).toMatchObject({
      artifactDigest: groupRecipe.gateway.digest,
      stateVolume: { target: "/var/lib/gateway", ownership: "owned" },
    });
    if (dockerBridge) expect(f.networkResult).not.toHaveBeenCalled();
    else {
      const ensured = f.networkResult.mock.calls.find(
        ([c]) => c.kind === "network.ensure",
      )![0].plan;
      expect(ensured.containerIds).toHaveLength(2);
      expect(ensured.memberLinks).toMatchObject([
        { fromIpv4: "172.30.1.3", toIpv4: "172.30.1.2", ports: [3000] },
        { fromIpv4: "172.30.1.2", toIpv4: "172.30.1.3", ports: [18080] },
      ]);
    }
    expect(f.getOrCreate).not.toHaveBeenCalled();
    expect(probeSsh).not.toHaveBeenCalled();
    const leases = new LeaseService(f.storage, f.clock);
    await leases.renew(f.consumerId, f.ready.id, "group-auto-claim", {
      generation: query.generation,
      expectedLeaseVersion: f.ready.lease!.version,
    });
    await leases.reconcilePending();
    await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_release", {
      expectedGeneration: query.generation,
    });
    await f.worker.reconcileCleanupLane();
    expect((await f.queries.get(f.consumerId, f.ready.id))!.phase).toBe(
      "released",
    );
    const proof = (await new TicketCleanupProofReader(f.storage, f.clock).read(
      f.consumerId,
      f.ready.id,
      query,
    ))!;
    expect(proof.receipts).toHaveLength(5);
    expect(
      proof.receipts.find((r) => r.kind === "network_policy")!.networkRules,
    ).toBe(dockerBridge ? "not_applicable" : "removed");
    if (dockerBridge) expect(f.networkResult).not.toHaveBeenCalled();
    expect(f.transport.deletes).toHaveLength(5);
    expect(f.transport.containers.size).toBe(0);
    expect(f.transport.networks.size).toBe(0);
  },
);

it("reclaims both group members when startup fails without claiming ready or waiting for business registration", async () => {
  const f = await fixture(3, "none", false, [], groupRecipe);
  expect(f.ready.phase).not.toBe("ready");
  await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_cancel", {
    expectedGeneration: f.ready.lease!.generation,
  });
  await f.worker.reconcileCleanupLane();
  expect((await f.queries.get(f.consumerId, f.ready.id))!.phase).toBe(
    "released",
  );
  expect(f.transport.deletes).toHaveLength(5);
});

it("freezes explicit host scope through Provider and cleanup despite a newer empty profile revision", async () => {
  const endpoints: NetworkDestination[] = [
    {
      cidr: "203.0.113.10/32",
      protocol: "tcp",
      ports: [8443],
      destinationScope: "host",
    },
    {
      cidr: "203.0.113.11/32",
      protocol: "tcp",
      ports: [22],
      destinationScope: "host",
    },
  ];
  const f = await fixture(2, "none", true, endpoints);
  const query = {
    leaseId: f.ready.lease!.id,
    generation: f.ready.lease!.generation,
  };
  expect(
    await new TicketReadyInventoryReader(f.storage, f.clock).read(
      f.consumerId,
      f.ready.id,
      query,
    ),
  ).toMatchObject({ completeness: "complete" });
  const frozen = await f.storage.get<{ accepted_contract_json: string }>(
    "SELECT accepted_contract_json FROM tickets WHERE id=?",
    [f.ready.id],
  );
  const resolved = await f.storage.get<{
    contract_hash: string;
    network_binding_json: string;
  }>(
    "SELECT r.contract_hash,r.network_binding_json FROM resolved_provision_contracts r JOIN allocations a ON a.resolved_provision_contract_id=r.id WHERE a.ticket_id=?",
    [f.ready.id],
  );
  expect(
    JSON.parse(frozen!.accepted_contract_json).network.allowedEgress,
  ).toEqual(endpoints);
  expect(JSON.parse(resolved!.network_binding_json).allowedEgress).toEqual(
    endpoints,
  );
  const ensure = f.networkResult.mock.calls.find(
    ([c]) => c.kind === "network.ensure",
  )![0];
  expect(ensure.plan.egress).toEqual(endpoints);
  expect(
    hashRuntimeNetworkRules({
      ...ensure.plan,
      egress: endpoints.map(({ destinationScope: _, ...r }) => r),
    }),
  ).not.toBe(ensure.plan.expectedRulesetHash);
  const leases = new LeaseService(f.storage, f.clock);
  await leases.renew(f.consumerId, f.ready.id, "synthetic-host-claim", {
    generation: query.generation,
    expectedLeaseVersion: f.ready.lease!.version,
  });
  await leases.reconcilePending();
  await new SQLiteProfileStore(f.storage, f.clock).newProfileRevision(
    "network",
    f.networkId,
    f.networkProfile!.version,
    {
      config: {
        allowedEgress: [],
        allowedIngressSourceCidrs: [],
        ipv6: "disabled",
      },
    },
  );
  await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_release", {
    expectedGeneration: query.generation,
  });
  await f.worker.reconcileCleanupLane();
  expect(
    f.networkResult.mock.calls.every(
      ([c]) => JSON.stringify(c.plan.egress) === JSON.stringify(endpoints),
    ),
  ).toBe(true);
  expect(
    f.networkResult.mock.calls.some(([c]) => c.kind === "network.revoke"),
  ).toBe(true);
  expect(
    f.networkResult.mock.calls.some(([c]) => c.kind === "network.remove"),
  ).toBe(true);
  expect(
    await new TicketCleanupProofReader(f.storage, f.clock).read(
      f.consumerId,
      f.ready.id,
      query,
    ),
  ).toMatchObject({ providerCleanup: "complete" });
  expect(f.transport.deletes).toHaveLength(3);
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "registers, validates and publishes an entrypoint artifact through the ordinary image path (group=%s, bridge=%s)",
  async (group, dockerBridge) => {
    const validationGroup = {
      ...groupRecipe,
      gateway: { ...groupRecipe.gateway, mountPaths: [] },
    };
    const f = await fixture(
      0,
      "none",
      true,
      [],
      group ? validationGroup : undefined,
      { loseGatewayCreateResponse: false, dockerBridge },
    );
    await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_release", {
      expectedGeneration: f.ready.lease!.generation,
    });
    await f.worker.reconcileCleanupLane();
    const adminId = (await f.storage.get<{ id: string }>(
      "SELECT id FROM consumers WHERE role='admin'",
    ))!.id;
    const nodeId = (await f.storage.get<{ id: string }>(
      "SELECT id FROM nodes",
    ))!.id;
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
    if (group) {
      const companion = await admin.createDraft({
        name: "synthetic gateway source",
        version: "1",
        architecture: "amd64",
        artifactRef: validationGroup.gateway.artifactRef,
        digest: validationGroup.gateway.digest,
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
      Object.assign(validationGroup.gateway, {
        imageVersionId: companion.versionId,
        imageArtifactId: companion.artifactId,
      });
    }
    const draft = await admin.createDraft({
      name: "synthetic entrypoint publication",
      ...(group ? { containerGroup: validationGroup } : {}),
      version: "1",
      architecture: "amd64",
      artifactRef: "docker.io/example/node@sha256:" + "a".repeat(64),
      digest: "sha256:" + "a".repeat(64),
      minimumResources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
      bootstrap: {
        mechanism: group
          ? "hitchlet-container-group-entrypoint-v1"
          : "hitchlet-container-entrypoint-v1",
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
    const validationRequest: Parameters<AdminService["scheduleValidation"]>[0] =
      {
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
      };
    if (dockerBridge && !group) {
      const original = (await f.storage.get<{ capabilities_json: string }>(
        "SELECT capabilities_json FROM nodes",
      ))!.capabilities_json;
      const filtered = await admin.createProfile("network", {
        name: "synthetic filtered revision",
        config: {
          allowedEgress: [],
          allowedIngressSourceCidrs: [],
          ipv6: "disabled",
        },
        authorizedConsumerIds: [adminId, f.consumerId],
      });
      for (const missing of [
        "cpuHardLimit",
        "memoryHardLimit",
        "capacity",
        "expiresAt",
        "filtered",
      ] as const) {
        const caps = JSON.parse(original);
        if (missing === "expiresAt")
          caps.expiresAt = new Date(f.clock() - 1).toISOString();
        else if (missing !== "filtered") delete caps[missing];
        await f.storage.run("UPDATE nodes SET capabilities_json=?", [
          JSON.stringify(caps),
        ]);
        const networkProfileId =
          missing === "filtered" ? filtered.id : f.networkId;
        const blocked = await admin.scheduleValidation({
          ...validationRequest,
          networkProfileId,
        });
        expect(blocked).toMatchObject({
          scheduler: "blocked",
          blockReason: "node_capacity_or_network_capability_unverified",
        });
        expect(
          await f.storage.get(
            "SELECT id FROM allocations WHERE image_validation_id=?",
            [blocked.validationId],
          ),
        ).toBeUndefined();
        await admin.cancelValidation(blocked.validationId);
        if (missing !== "capacity") {
          const preview = await f.tickets.preview(f.consumerId, {
            image: { versionId: f.ready.pinnedImageVersionId },
            networkProfileId,
            resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
            access: { protocol: "none" },
          });
          expect(preview.eligibleNodeIds, missing).toEqual([]);
          expect(preview.reasons).toContain(
            missing === "expiresAt"
              ? "capabilities_expired"
              : missing === "filtered"
                ? "network_profile_unverified"
                : "capabilities_unavailable",
          );
        }
      }
      await f.storage.run("UPDATE nodes SET capabilities_json=?", [original]);
    }
    const run = await admin.scheduleValidation(validationRequest);
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
    if (dockerBridge) expect(f.networkResult).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "keeps another two-member lease running when one line returns (bridge=%s)",
  async (dockerBridge) => {
    const f = await fixture(3, "none", true, [], groupRecipe, {
      loseGatewayCreateResponse: false,
      dockerBridge,
    });
    const accepted = await f.storage.get<{ request_json: string }>(
      "SELECT request_json FROM tickets WHERE id=?",
      [f.ready.id],
    );
    const request = JSON.parse(accepted!.request_json);
    request.storage = request.storage.map((m: Record<string, unknown>) => ({
      ...m,
      authorizedSubpath: String(m.authorizedSubpath).replace(
        "borrow/",
        "borrow-b/",
      ),
    }));
    const second = await f.tickets.acquire(f.consumerId, "second-group-line", {
      image: { versionId: f.ready.pinnedImageVersionId },
      resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
      access: { protocol: "none" },
      networkProfileId: f.networkId,
      lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
      storage: request.storage,
    });
    await f.tickets.reserveNext();
    await f.worker.reconcile();
    const b = (await f.queries.get(f.consumerId, second.ticketId))!;
    expect(b.phase).toBe("ready");
    const reader = new TicketReadyInventoryReader(f.storage, f.clock);
    const aQuery = {
      leaseId: f.ready.lease!.id,
      generation: f.ready.lease!.generation,
    };
    const bQuery = { leaseId: b.lease!.id, generation: b.lease!.generation };
    const aInventory = (await reader.read(f.consumerId, f.ready.id, aQuery))!;
    const bInventory = (await reader.read(f.consumerId, b.id, bQuery))!;
    expect(
      aInventory.containerGroup!.members.every((a) =>
        bInventory.containerGroup!.members.every(
          (b) =>
            a.containerId !== b.containerId &&
            a.ipv4 !== b.ipv4 &&
            a.stateVolume.id !== b.stateVolume.id,
        ),
      ),
    ).toBe(true);
    await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_release", {
      expectedGeneration: aQuery.generation,
    });
    await f.worker.reconcileCleanupLane();
    const aProof = (await new TicketCleanupProofReader(f.storage, f.clock).read(
      f.consumerId,
      f.ready.id,
      aQuery,
    ))!;
    expect(aProof.objects.map((o) => o.id).sort()).toEqual(
      aInventory.objects.map((o) => o.id).sort(),
    );
    expect(
      aProof.receipts.every((r) =>
        aInventory.objects.some((o) => o.id === r.resourceId),
      ),
    ).toBe(true);
    expect(await reader.read(f.consumerId, b.id, bQuery)).toMatchObject({
      completeness: "complete",
    });
    expect(f.transport.containers.size).toBe(2);
    expect(
      [...f.transport.containers.values()].every((c) => c.State.Running),
    ).toBe(true);
    expect(f.transport.networks.size).toBe(1);
    await f.tickets.cancel(b.id, f.consumerId, "consumer_release", {
      expectedGeneration: bQuery.generation,
    });
    await f.worker.reconcileCleanupLane();
    expect(
      (await new TicketCleanupProofReader(f.storage, f.clock).read(
        f.consumerId,
        b.id,
        bQuery,
      ))!.receipts,
    ).toHaveLength(5);
    if (dockerBridge) expect(f.networkResult).not.toHaveBeenCalled();
    expect(f.transport.deletes).toHaveLength(10);
    expect(f.transport.containers.size).toBe(0);
  },
);

it("recovers a committed gateway whose create response was lost without duplicating it", async () => {
  const f = await fixture(3, "none", true, [], groupRecipe, {
    loseGatewayCreateResponse: true,
  });
  expect(f.ready.phase).not.toBe("ready");
  expect(f.transport.containers.size).toBe(2);
  f.advance(10000);
  await f.worker.reconcile();
  const ready = (await f.queries.get(f.consumerId, f.ready.id))!;
  expect(
    ready.phase,
    JSON.stringify(
      await f.storage.all("SELECT state,result_json FROM operations"),
    ),
  ).toBe("ready");
  expect(
    f.transport.fetcher.mock.calls.filter(
      ([input, init]) =>
        new URL(String(input)).pathname.endsWith("/containers/create") &&
        JSON.parse(String(init!.body)).Labels["io.hitchlet.member"] ===
          "gateway",
    ),
  ).toHaveLength(1);
  const query = {
    leaseId: ready.lease!.id,
    generation: ready.lease!.generation,
  };
  expect(
    await new TicketReadyInventoryReader(f.storage, f.clock).read(
      f.consumerId,
      ready.id,
      query,
    ),
  ).toMatchObject({ completeness: "complete" });
  await f.tickets.cancel(ready.id, f.consumerId, "consumer_release", {
    expectedGeneration: query.generation,
  });
  await f.worker.reconcileCleanupLane();
  expect(
    (await new TicketCleanupProofReader(f.storage, f.clock).read(
      f.consumerId,
      ready.id,
      query,
    ))!.receipts,
  ).toHaveLength(5);
});

it("rejects mutated member image, role and state facts from the actual persisted Provider inventory", async () => {
  const f = await fixture(3, "none", true, [], groupRecipe);
  const query = {
    leaseId: f.ready.lease!.id,
    generation: f.ready.lease!.generation,
  };
  const original = (await f.storage.get<{ actual_resources_json: string }>(
    "SELECT actual_resources_json FROM allocations WHERE ticket_id=?",
    [f.ready.id],
  ))!.actual_resources_json;
  const reader = new TicketReadyInventoryReader(f.storage, f.clock);
  for (const change of [
    { artifactDigest: "sha256:" + "c".repeat(64) },
    { memberName: "workload" },
    { ipv4: "172.30.1.77" },
  ]) {
    const altered = JSON.parse(original);
    const object = altered.objects.find(
      (o: any) => o.kind === "container" && o.details?.memberName === "gateway",
    );
    Object.assign(object.details, change);
    await f.storage.run(
      "UPDATE allocations SET actual_resources_json=? WHERE ticket_id=?",
      [JSON.stringify(altered), f.ready.id],
    );
    await expect(
      reader.read(f.consumerId, f.ready.id, query),
    ).rejects.toMatchObject({ code: "conflict" });
  }
  await f.storage.run(
    "UPDATE allocations SET actual_resources_json=? WHERE ticket_id=?",
    [original, f.ready.id],
  );
  expect(await reader.read(f.consumerId, f.ready.id, query)).toMatchObject({
    completeness: "complete",
  });
  await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_release", {
    expectedGeneration: query.generation,
  });
  await f.worker.reconcileCleanupLane();
});

it.each([
  ["startup_failed", false],
  ["partial_create", false],
  ["reserved_never_started", false],
  ["queued_never_reserved", false],
  ["startup_failed", true],
  ["partial_create", true],
  ["reserved_never_started", true],
  ["queued_never_reserved", true],
] as const)(
  "pre-ready %s returns terminal cleanup evidence without fabricating ready (bridge=%s)",
  async (caseName, dockerBridge) => {
    const faults = {
      loseGatewayCreateResponse: false,
      dockerBridge,
      rejectGatewayImage: caseName === "partial_create",
      skipProvision: caseName === "reserved_never_started",
      skipReserve: caseName === "queued_never_reserved",
    };
    const f = await fixture(
      3,
      "none",
      caseName !== "startup_failed",
      [],
      groupRecipe,
      faults,
    );
    expect(f.ready.phase).not.toBe("ready");
    expect(
      await f.storage.get(
        "SELECT 1 FROM events WHERE aggregate_id=? AND event_type='ticket.ready'",
        [f.ready.id],
      ),
    ).toBeUndefined();
    const lease = f.ready.lease;
    if (lease)
      await expect(
        new TicketCleanupProofReader(f.storage, f.clock).read(
          f.consumerId,
          f.ready.id,
          { leaseId: lease.id, generation: lease.generation },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    await f.tickets.cancel(
      f.ready.id,
      f.consumerId,
      "consumer_cancel",
      lease ? { expectedGeneration: lease.generation } : undefined,
    );
    await f.worker.reconcileCleanupLane();
    if (dockerBridge) expect(f.networkResult).not.toHaveBeenCalled();
    const ticket = (await f.queries.get(f.consumerId, f.ready.id))!;
    expect(ticket.phase).toBe("released");
    const expectedObjects =
      caseName === "startup_failed" ? 5 : caseName === "partial_create" ? 4 : 0;
    expect(f.transport.deletes).toHaveLength(expectedObjects);
    expect(f.transport.containers.size).toBe(0);
    expect(f.transport.networks.size).toBe(0);
    if (!lease) {
      expect(ticket.cleanupStatus).toBe("not_needed");
      expect(
        await f.storage.get("SELECT id FROM allocations WHERE ticket_id=?", [
          ticket.id,
        ]),
      ).toBeUndefined();
      return;
    }
    const allocation = (await f.storage.get<any>(
      "SELECT manifest_id,manifest_complete,cleanup_status,observed_state,actual_resources_json FROM allocations WHERE ticket_id=?",
      [ticket.id],
    ))!;
    expect(allocation).toMatchObject({
      manifest_id: null,
      manifest_complete: 0n,
      cleanup_status: "complete",
      observed_state: "absent",
    });
    const cleanup = (await f.storage.get<any>(
      "SELECT state,result_json FROM operations WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.cleanup'",
      [ticket.id],
    ))!;
    expect(cleanup.state).toBe("succeeded");
    const evidence = JSON.parse(cleanup.result_json);
    if (caseName === "reserved_never_started")
      expect(evidence.noExternalCreate).toBe(true);
    else {
      expect(evidence.resources).toHaveLength(expectedObjects);
      expect(evidence.destructionReceipts).toHaveLength(expectedObjects);
      expect(evidence.inventory.completeness).toBe("complete");
      expect(
        evidence.destructionReceipts.every((r: any) => r.presence === "absent"),
      ).toBe(true);
    }
    expect(
      await f.storage.get(
        "SELECT 1 FROM capacity_claims WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND state<>'released'",
        [ticket.id],
      ),
    ).toBeUndefined();
    const query = { leaseId: lease.id, generation: lease.generation };
    const reader = new TicketCleanupProofReader(f.storage, f.clock);
    const proof = (await reader.read(f.consumerId, ticket.id, query))!;
    expect(proof).toMatchObject({
      version: "1.1",
      basis: "pre_ready_cleanup",
      outcome: expectedObjects ? "reclaimed" : "not_created",
      ticketId: ticket.id,
      leaseId: lease.id,
      generation: lease.generation,
      claimState: "released",
      leaseState: "revoked",
      providerCleanup: "complete",
    });
    expect(proof).not.toHaveProperty("manifest");
    expect(proof).not.toHaveProperty("containerGroup");
    expect(proof.objects).toHaveLength(expectedObjects);
    expect(proof.receipts).toHaveLength(expectedObjects);
    if (proof.version !== "1.1") throw new Error("Expected pre-ready proof");
    expect(proof.createJournal.effects).toHaveLength(expectedObjects);
    expect(proof.objects.some((o) => o.id.startsWith("storage:"))).toBe(false);
    expect(
      proof.objects
        .filter((o) => o.kind === "container")
        .map((o) => o.memberName)
        .sort(),
    ).toEqual(
      caseName === "startup_failed"
        ? ["gateway", "workload"]
        : caseName === "partial_create"
          ? ["workload"]
          : [],
    );

    if (expectedObjects)
      expect(proof.after).toMatchObject({
        presence: "absent",
        completeness: "complete",
      });
    else expect(proof.after).toBeNull();
    expect(
      await reader.read(f.consumerId, ticket.id, {
        ...query,
        expected: {
          manifestId: proof.cleanupManifest.id,
          manifestHash: proof.cleanupManifest.hash,
        },
      }),
    ).toEqual(proof);
    const app = await buildApp(
      loadConfig({
        DATA_DIR: f.dir,
        LOG_LEVEL: "silent",
        EXECUTION_MODE: "portainer",
        HITCHLET_SECRET_KEY_FILE: join(f.dir, "synthetic-unused.key"),
      }),
      { storage: f.storage },
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/tickets/${ticket.id}/cleanup-proof?${new URLSearchParams({ leaseId: lease.id, generation: String(lease.generation) })}`,
        headers: { authorization: `Bearer ${f.consumerToken}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        version: "1.1",
        cleanupManifest: proof.cleanupManifest,
        objects: proof.objects,
        receipts: proof.receipts,
      });
      // A new SDK instance represents original-ticket re-entry; no saved ready inventory is supplied.
      const sdk = new HitchletClient("https://controller.test", {
        auth: { kind: "bearer", token: f.consumerToken },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const headers: Record<string, string> = {};
          new Headers(init?.headers).forEach((v, k) => {
            headers[k] = v;
          });
          const read = await app.inject({
            method: "GET",
            url: url.pathname + url.search,
            headers,
          });
          return new Response(read.body, {
            status: read.statusCode,
            headers: { "content-type": "application/json" },
          });
        },
      });
      expect(await sdk.tickets.cleanupProof(ticket.id, query)).toMatchObject({
        version: "1.1",
        cleanupManifest: proof.cleanupManifest,
        objects: proof.objects,
        receipts: proof.receipts,
      });
    } finally {
      await app.close();
    }
    if (caseName === "startup_failed") {
      const provision = (await f.storage.get<any>(
        "SELECT id,result_json FROM operations WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.provision'",
        [ticket.id],
      ))!;
      for (const change of [
        "unknown_effect",
        "wrong_created_id",
        "missing_receipt",
        "wrong_runtime",
        "false_no_create",
        "wrong_network_rules",
      ] as const) {
        if (change === "unknown_effect" || change === "wrong_created_id") {
          const bad = JSON.parse(provision.result_json);
          if (change === "unknown_effect")
            bad.createEffects.container_gateway.state = "unknown";
          else
            bad.createEffects.container_gateway.resourceId =
              "foreign-container";
          await f.storage.run(
            "UPDATE operations SET result_json=? WHERE id=?",
            [JSON.stringify(bad), provision.id],
          );
        } else {
          const bad = JSON.parse(cleanup.result_json);
          if (change === "missing_receipt") bad.destructionReceipts.pop();
          else if (change === "wrong_runtime")
            bad.inventory.runtime.runtimeIdentityId = "foreign-runtime";
          else if (change === "wrong_network_rules")
            bad.destructionReceipts.find(
              (r: any) => r.kind === "network_policy",
            ).networkRules = dockerBridge ? "removed" : "not_applicable";
          else bad.noExternalCreate = true;
          await f.storage.run(
            "UPDATE operations SET result_json=? WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.cleanup'",
            [JSON.stringify(bad), ticket.id],
          );
        }
        await expect(
          reader.read(f.consumerId, ticket.id, query),
          change,
        ).rejects.toMatchObject({ code: "conflict" });
        await f.storage.run("UPDATE operations SET result_json=? WHERE id=?", [
          provision.result_json,
          provision.id,
        ]);
        await f.storage.run(
          "UPDATE operations SET result_json=? WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.cleanup'",
          [cleanup.result_json, ticket.id],
        );
      }
      expect(
        await reader.read("foreign-consumer", ticket.id, query),
      ).toBeNull();
      expect(
        await reader.read(f.consumerId, ticket.id, {
          ...query,
          generation: query.generation + 1,
        }),
      ).toBeNull();
      expect(await reader.read(f.consumerId, ticket.id, query)).toEqual(proof);
    }
  },
);

it.each([
  ["missing NET_RAW", ["NET_ADMIN"], false],
  ["extra SYS_ADMIN", ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"], false],
  ["missing NET_RAW", ["NET_ADMIN"], true],
  ["extra SYS_ADMIN", ["NET_ADMIN", "NET_RAW", "SYS_ADMIN"], true],
] as const)(
  "rejects gateway capability readback with %s before starting either member (capabilities=%s, bridge=%s)",
  async (_name, capabilities, dockerBridge) => {
    const f = await fixture(3, "none", true, [], groupRecipe, {
      loseGatewayCreateResponse: false,
      gatewayCapabilities: [...capabilities],
      dockerBridge,
    });
    expect(f.ready.phase).not.toBe("ready");
    expect(f.transport.containers.size).toBe(2);
    expect(
      f.transport.fetcher.mock.calls.some(([input]) =>
        new URL(String(input)).pathname.endsWith("/start"),
      ),
    ).toBe(false);
    expect(
      f.networkResult.mock.calls.some(([c]) => c.kind === "network.ensure"),
    ).toBe(false);
    const query = {
      leaseId: f.ready.lease!.id,
      generation: f.ready.lease!.generation,
    };
    await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_cancel", {
      expectedGeneration: query.generation,
    });
    await f.worker.reconcileCleanupLane();
    const proof = await new TicketCleanupProofReader(f.storage, f.clock).read(
      f.consumerId,
      f.ready.id,
      query,
    );
    expect(proof).toMatchObject({
      version: "1.1",
      outcome: "reclaimed",
      providerCleanup: "complete",
    });
    expect(proof!.objects).toHaveLength(5);
    expect(proof!.receipts).toHaveLength(5);
    expect(f.transport.containers.size).toBe(0);
    expect(f.transport.deletes).toHaveLength(5);
  },
);

it("keeps the accepted native bridge mode through a newer filtered profile and rejects incompatible proof receipts", async () => {
  const f = await fixture(3, "none", true, [], groupRecipe, {
    loseGatewayCreateResponse: false,
    dockerBridge: true,
  });
  const query = {
    leaseId: f.ready.lease!.id,
    generation: f.ready.lease!.generation,
  };
  const frozen = (await f.storage.get<{ accepted_contract_json: string }>(
    "SELECT accepted_contract_json FROM tickets WHERE id=?",
    [f.ready.id],
  ))!;
  expect(JSON.parse(frozen.accepted_contract_json).network).toMatchObject({
    enforcement: "docker_bridge",
    verificationRequired: false,
  });
  await new SQLiteProfileStore(f.storage, f.clock).newProfileRevision(
    "network",
    f.networkId,
    f.networkProfile!.version,
    {
      config: {
        dockerMode: "filtered",
        allowedEgress: [],
        allowedIngressSourceCidrs: [],
        ipv6: "disabled",
      },
    },
  );
  await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_release", {
    expectedGeneration: query.generation,
  });
  await f.worker.reconcileCleanupLane();
  const reader = new TicketCleanupProofReader(f.storage, f.clock);
  const proof = (await reader.read(f.consumerId, f.ready.id, query))!;
  expect(
    proof.receipts.find((r) => r.kind === "network_policy")!.networkRules,
  ).toBe("not_applicable");
  expect(f.networkResult).not.toHaveBeenCalled();
  const op = (await f.storage.get<{ id: string; result_json: string }>(
    "SELECT id,result_json FROM operations WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.cleanup'",
    [f.ready.id],
  ))!;
  const altered = JSON.parse(op.result_json);
  altered.destructionReceipts.find(
    (r: any) => r.kind === "network_policy",
  ).networkRules = "removed";
  await f.storage.run("UPDATE operations SET result_json=? WHERE id=?", [
    JSON.stringify(altered),
    op.id,
  ]);
  await expect(
    reader.read(f.consumerId, f.ready.id, query),
  ).rejects.toMatchObject({ code: "conflict" });
});

it.each(["extraAttachment", "publishedHostPort"] as const)(
  "rejects %s on ordinary bridge readback and proves actual pre-ready cleanup",
  async (fault) => {
    const f = await fixture(2, "none", true, [], undefined, {
      loseGatewayCreateResponse: false,
      dockerBridge: true,
      [fault]: true,
    });
    expect(f.ready.phase).not.toBe("ready");
    const query = {
      leaseId: f.ready.lease!.id,
      generation: f.ready.lease!.generation,
    };
    await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_cancel", {
      expectedGeneration: query.generation,
    });
    await f.worker.reconcileCleanupLane();
    expect(
      await new TicketCleanupProofReader(f.storage, f.clock).read(
        f.consumerId,
        f.ready.id,
        query,
      ),
    ).toMatchObject({
      version: "1.1",
      outcome: "reclaimed",
      receipts: expect.any(Array),
    });
    expect(f.transport.deletes).toHaveLength(3);
    expect(f.networkResult).not.toHaveBeenCalled();
  },
);

it.each([
  "networkDriver",
  "gatewayMissingTun",
  "gatewayForwardingDisabled",
] as const)(
  "keeps required ordinary bridge/gateway %s readback and failed-start cleanup",
  async (fault) => {
    const f = await fixture(3, "none", true, [], groupRecipe, {
      loseGatewayCreateResponse: false,
      dockerBridge: true,
      ...(fault === "networkDriver"
        ? { networkDriver: "macvlan" }
        : { [fault]: true }),
    });
    expect(f.ready.phase).not.toBe("ready");
    const query = {
      leaseId: f.ready.lease!.id,
      generation: f.ready.lease!.generation,
    };
    await f.tickets.cancel(f.ready.id, f.consumerId, "consumer_cancel", {
      expectedGeneration: query.generation,
    });
    await f.worker.reconcileCleanupLane();
    expect(
      await new TicketCleanupProofReader(f.storage, f.clock).read(
        f.consumerId,
        f.ready.id,
        query,
      ),
    ).toMatchObject({
      version: "1.1",
      outcome: "reclaimed",
      providerCleanup: "complete",
    });
    expect(f.networkResult).not.toHaveBeenCalled();
  },
);
