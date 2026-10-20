import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeNetworkCommand,
  RuntimeNetworkResult,
  RuntimeStorageRequest,
  RuntimeStorageResult,
} from "@hitchlet/contracts/internal";
import { PortainerExecutionProvider } from "../src/providers/portainer-provider.js";
import { hashRuntimeNetworkRules } from "../src/providers/runtime-network-client.js";
import type {
  ProvisionPlan,
  OwnedResource,
  CreateEffect,
} from "../src/providers/port.js";

const plan: ProvisionPlan = {
  deadlineMs: Date.now() + 60_000,
  executionPhase: "cleanup",
  identity: {
    installationId: "test-installation",
    allocationId: "test-allocation",
    generation: 1,
    operationId: "create-operation",
    controlVersion: 2,
    purpose: "validation",
    runtimeIdentityId: "test-runtime",
    connectionRevisionId: "frozen-revision",
  },
  artifact: {
    id: "test-artifact",
    ref: `docker.io/example/node@sha256:${"a".repeat(64)}`,
    digest: `sha256:${"a".repeat(64)}`,
  },
  resources: {
    request: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 0 },
    limit: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 0 },
    scratchEnforcement: "best_effort",
    isolation: "shared_kernel",
    accelerators: [],
  },
  resolved: {
    id: "test-contract",
    contractHash: "b".repeat(64),
    selectionHash: "c".repeat(64),
    mounts: [],
    network: {
      grantId: "test-grant",
      revisionId: "test-network",
      frozenPlatformDenyRevisionId: "test-deny",
      platformDenyRevisionId: "test-deny",
      mode: "isolated_bridge",
      ipv6: "disabled",
      allowedEgress: [],
      allowedIngressSourceCidrs: [],
      managementDenyRules: [],
      enforcement: "docker_iptables",
      verificationRequired: true,
    },
  },
  accessProtocol: "ssh",
  bootstrap: {
    mechanism: "hitchlet-node-ssh-v1",
    contractVersion: "1",
    identityReset: true,
  },
  access: {
    accessProtocols: ["ssh"],
    ports: [22],
    account: "workspace",
    allowedSourceCidrs: [],
    discovery: "portainer-published-port",
    readiness: "ssh-public-key-authenticated-fingerprint",
  },
};
const owned = (id: string, kind: OwnedResource["kind"]): OwnedResource => ({
  id,
  kind,
  ownership: "owned",
  identity: plan.identity,
  contractHash: plan.resolved.contractHash,
  evidence: {
    artifactDigest: plan.artifact.digest,
    resourcesHash: "",
    networkHash: "",
    mountsHash: "",
    accessProtocol: "ssh",
  },
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function provider(options?: {
  storageFacts?: (
    request: RuntimeStorageRequest,
  ) => Promise<RuntimeStorageResult>;
  getOrCreate?: () => Promise<{
    privateKey: string;
    publicKey: string;
    fingerprint: string;
    secretRef: string;
  }>;
  ensure?: () => Promise<never>;
  networkInspect?: () => Promise<RuntimeNetworkResult>;
  revoke?: (command: RuntimeNetworkCommand) => Promise<RuntimeNetworkResult>;
  remove?: (command: RuntimeNetworkCommand) => Promise<RuntimeNetworkResult>;
}) {
  const unused = async () => {
    throw new Error("Unexpected access material or network action");
  };
  return new PortainerExecutionProvider(
    async () => ({
      endpointUrl: "https://portainer.test",
      environmentId: "1",
      apiKey: "unit-fixture",
      engineId: "test-engine",
      providerEvidence: { dockerVersion: "29.0.0", portainerVersion: "2.45.2" },
      agentId: "test-agent",
      controllerEpoch: 1,
      networkCidrBase: "172.30.0.0/16",
      ingressSourceCidrs: [],
      effectiveDenyRevisionId: "test-deny",
      accessHost: "192.0.2.1",
      userlandProxy: false,
      managementDenyRules: [],
      storageFacts:
        options?.storageFacts ??
        (async (request) => ({
          ...request,
          observedAtMs: Date.now(),
          controllerEpoch: 1,
          imageStore: { root: "/var/lib/docker", availableMiB: 100000 },
          mounts: [],
          inventory: null,
        })),
      runtimeNetwork: {
        ensure: options?.ensure ?? unused,
        inspect: options?.networkInspect ?? unused,
        revoke: options?.revoke ?? unused,
        remove: options?.remove ?? unused,
      },
    }),
    { getOrCreate: options?.getOrCreate ?? unused },
  );
}
describe("Portainer partial cleanup recovery", () => {
  it("never sends persistent references to any delete transport", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      provider().destroy(plan, {
        ...owned("persistent", "storage_reference"),
        ownership: "reference",
      }),
    ).rejects.toThrow("never destroy");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["low", "unknown"])(
    "requires actual runtime capacity before creating even without mounts (%s)",
    async (state) => {
      const fetch = vi.fn(
        async (input: RequestInfo | URL, _init?: RequestInit) =>
          String(input).includes("system/version")
            ? Response.json({ ServerVersion: "2.45.2" })
            : Response.json({ ID: "test-engine", ServerVersion: "29.0.0" }),
      );
      vi.stubGlobal("fetch", fetch);
      const getOrCreate = vi.fn();
      const execution = provider({
        getOrCreate,
        storageFacts: async (request) => {
          if (state === "unknown") throw new Error("capacity unknown");
          return {
            ...request,
            observedAtMs: Date.now(),
            controllerEpoch: 1,
            imageStore: { root: "/var/lib/docker", availableMiB: 0 },
            mounts: [],
            inventory: null,
          };
        },
      });
      await expect(
        execution.create(plan, { recordCreated: async () => {} }),
      ).rejects.toThrow(
        state === "unknown" ? "capacity unknown" : "below admission reserve",
      );
      expect(getOrCreate).not.toHaveBeenCalled();
      expect(
        fetch.mock.calls.every(
          ([, init]) => !init || (init as RequestInit).method === "GET",
        ),
      ).toBe(true);
    },
  );
  it.each(["container", "volume"] as const)(
    "accepts journaled %s absence from a complete same-Engine inventory while the network remains",
    async (kind) => {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ ID: "test-engine" }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetcher);
      const execution = provider();
      vi.spyOn(execution, "inspect").mockResolvedValue({
        presence: "present",
        evidence: {
          completeness: "complete",
          runtime: plan.identity,
          identity: plan.identity,
          objects: [owned("remaining-network", "network_policy")],
        },
      });
      const receipt = await execution.destroy(
        plan,
        owned("already-deleted", kind),
      );
      expect(receipt).toMatchObject({
        resourceId: "already-deleted",
        kind,
        presence: "absent",
        networkRules: "not_applicable",
        runtime: { connectionRevisionId: "frozen-revision" },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]?.[0])).toContain("/docker/info");
    },
  );
  it("keeps unknown inventory and wrong Engine identity blocked instead of treating either as absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ID: "test-engine" }), { status: 200 }),
      ),
    );
    const execution = provider();
    vi.spyOn(execution, "inspect").mockResolvedValue({
      presence: "unknown",
      reason: "inventory_incomplete",
    });
    await expect(
      execution.destroy(plan, owned("journaled-container", "container")),
    ).rejects.toThrow("ownership is unknown");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ID: "different-engine" }), {
            status: 200,
          }),
      ),
    );
    await expect(
      provider().destroy(plan, owned("journaled-container", "container")),
    ).rejects.toThrow("different Docker Engine");
  });
  it("ignores another allocation's same-installation inventory but treats this allocation's conflicting owner labels as unknown", async () => {
    const expectedName = "hitchlet-test-allocation-1";
    const sharedLabels = {
      "io.hitchlet.purpose": "validation",
      "io.hitchlet.installation": plan.identity.installationId,
      "io.hitchlet.runtime": plan.identity.runtimeIdentityId,
      "io.hitchlet.generation": String(plan.identity.generation),
      "io.hitchlet.operation": plan.identity.operationId,
      "io.hitchlet.contract": plan.resolved.contractHash,
    };
    const fetcher = vi.fn(async (input: URL) => {
      const url = new URL(String(input));
      const path = (url.pathname.split("/docker/")[1] ?? "") + url.search;
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (path === "info") return json({ ID: "test-engine" });
      if (path === "containers/json?all=true" || path === "networks")
        return json([]);
      if (path === "volumes")
        return json({
          Volumes: [
            {
              Name: "hitchlet-other-allocation-1-workspace",
              Labels: {
                ...sharedLabels,
                "io.hitchlet.allocation": "other-allocation",
              },
            },
          ],
        });
      throw new Error(`Unexpected inventory request ${path}`);
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await provider().inspect(plan)).toMatchObject({
      presence: "absent",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const url = new URL(String(input));
        const path = (url.pathname.split("/docker/")[1] ?? "") + url.search;
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), { status: 200 });
        if (path === "info") return json({ ID: "test-engine" });
        if (path === "containers/json?all=true" || path === "networks")
          return json([]);
        if (path === "volumes")
          return json({
            Volumes: [
              {
                Name: `${expectedName}-workspace`,
                Labels: {
                  ...sharedLabels,
                  "io.hitchlet.allocation": plan.identity.allocationId,
                  "io.hitchlet.installation": "different-installation",
                },
              },
            ],
          });
        throw new Error(`Unexpected inventory request ${path}`);
      }),
    );
    expect(await provider().inspect(plan)).toMatchObject({
      presence: "unknown",
      reason: "inventory_incomplete",
    });
  });
  it.each(["docker", "portainer"] as const)(
    "blocks create and ready on live %s version drift while same-Engine cleanup remains available",
    async (drift) => {
      const mutations: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (init?.method !== "GET") mutations.push(url.pathname);
          return new Response(
            JSON.stringify(
              url.pathname === "/api/system/version"
                ? { ServerVersion: drift === "portainer" ? "2.46.0" : "2.45.2" }
                : {
                    ID: "test-engine",
                    ServerVersion: drift === "docker" ? "30.0.0" : "29.0.0",
                  },
            ),
            { status: 200 },
          );
        }),
      );
      const execution = provider();
      const inventory = {
        completeness: "complete" as const,
        runtime: plan.identity,
        identity: plan.identity,
        objects: [],
      };
      await expect(
        execution.create(
          { ...plan, executionPhase: "provision" },
          { recordCreated: async () => {} },
        ),
      ).rejects.toThrow("version differs");
      await expect(execution.ready(plan, inventory)).rejects.toThrow(
        "version differs",
      );
      vi.spyOn(execution, "inspect").mockResolvedValue({
        presence: "absent",
        evidence: inventory,
      });
      await expect(
        execution.destroy(plan, owned("already-deleted", "container")),
      ).resolves.toMatchObject({ presence: "absent" });
      expect(mutations).toEqual([]);
    },
  );
  it("journals all three fixed native create calls before POST and gives the container a stable native name", async () => {
    const effects: CreateEffect[] = [];
    const records: OwnedResource[] = [];
    let containerBody: Record<string, unknown> = {};
    let labels: Record<string, unknown> = {};
    const networkId = "a".repeat(64),
      name = "hitchlet-test-allocation-1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL, init?: RequestInit) => {
        const url = new URL(String(input)),
          path = url.pathname.split("/docker/")[1] ?? "",
          method = init?.method ?? "GET";
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), { status: 200 });
        if (url.pathname === "/api/system/version")
          return json({ ServerVersion: "2.45.2" });
        if (path === "info")
          return json({
            ID: "test-engine",
            Architecture: "amd64",
            ServerVersion: "29.0.0",
          });
        if (path === "containers/json" || path === "networks") return json([]);
        if (path === "volumes") return json({ Volumes: [] });
        if (path.startsWith("distribution/"))
          return json({
            Descriptor: {
              digest: plan.artifact.digest,
              mediaType: "application/vnd.docker.distribution.manifest.v2+json",
            },
            Platforms: [{ architecture: "amd64", os: "linux" }],
          });
        if (path.startsWith("images/"))
          return json({
            Id: "image-id",
            RepoDigests: [plan.artifact.ref],
            Architecture: "amd64",
            Os: "linux",
          });
        if (
          method === "POST" &&
          ["networks/create", "volumes/create", "containers/create"].includes(
            path,
          )
        ) {
          const kind = path.startsWith("networks")
            ? "network_policy"
            : path.startsWith("volumes")
              ? "volume"
              : "container";
          labels = JSON.parse(String(init!.body)).Labels;
          const effect = effects.find((item) => item.kind === kind);
          expect(effect).toBeDefined();
          expect(effect!.requestHash).toMatch(/^[a-f0-9]{64}$/);
          if (kind === "container") {
            containerBody = JSON.parse(String(init!.body));
            expect(url.searchParams.get("name")).toBe(name);
            return json({ Id: "container-id" });
          }
          return kind === "network_policy"
            ? json({ Id: networkId })
            : json({ Name: `${name}-workspace` });
        }
        if (method === "PUT" && path.includes("/archive")) return json({});
        if (path === `networks/${networkId}`)
          return json({
            Id: networkId,
            Name: name,
            Labels: labels,
            Options: { "com.docker.network.bridge.name": "br-aaaaaaaaaaaa" },
            IPAM: {
              Config: [{ Subnet: "172.30.1.0/24", Gateway: "172.30.1.1" }],
            },
          });
        if (path === `volumes/${name}-workspace`)
          return json({ Name: `${name}-workspace`, Labels: labels });
        if (path === "containers/container-id/json")
          return json({
            Id: "container-id",
            Name: `/${name}`,
            Config: containerBody,
            HostConfig: containerBody.HostConfig,
            State: { Running: false },
            NetworkSettings: { Ports: {} },
          });
        throw new Error(`Unexpected fixture request ${method} ${path}`);
      }),
    );
    const execution = provider({
      getOrCreate: async () => ({
        privateKey: "private-fixture",
        publicKey: "public-fixture",
        fingerprint: "test-fingerprint",
        secretRef: "test-secret",
      }),
      ensure: async () => {
        throw new Error("stop after fixed creates");
      },
    });
    await expect(
      execution.create(
        {
          ...plan,
          executionPhase: "provision",
          deadlineMs: Date.now() + 60_000,
        },
        {
          beforeCreate: async (effect) => {
            effects.push(effect);
          },
          recordCreated: async (item) => {
            records.push(item);
          },
        },
      ),
    ).rejects.toThrow("stop after fixed creates");
    expect(effects.map((e) => [e.kind, e.name])).toEqual([
      ["network_policy", name],
      ["volume", `${name}-workspace`],
      ["container", name],
    ]);
    for (const effect of effects)
      expect(
        records.some(
          (item) =>
            item.kind === effect.kind &&
            item.details?.nativeName === effect.name,
        ),
      ).toBe(true);
    expect(JSON.stringify(effects)).not.toContain("private-fixture");
  });

  it("treats a bound Agent unknown/null-hash inspection as lost network assurance", async () => {
    const name = "hitchlet-test-allocation-1";
    const labels = {
      "io.hitchlet.purpose": "validation",
      "io.hitchlet.installation": plan.identity.installationId,
      "io.hitchlet.runtime": plan.identity.runtimeIdentityId,
      "io.hitchlet.allocation": plan.identity.allocationId,
      "io.hitchlet.generation": "1",
      "io.hitchlet.operation": plan.identity.operationId,
      "io.hitchlet.contract": plan.resolved.contractHash,
    };
    const containerId = "container-1";
    const volumeName = `${name}-workspace`;
    const hostPort =
      30_000 +
      (createHash("sha256")
        .update(`${plan.identity.allocationId}:${plan.identity.generation}`)
        .digest()
        .readUInt16BE(0) %
        20_000);
    const container = {
      Id: containerId,
      Name: `/${name}`,
      Config: { Labels: labels },
      State: { Running: true, Status: "running" },
      Image: "sha256:local-image",
      HostConfig: {
        NetworkMode: name,
        RestartPolicy: { Name: "no" },
        CpuQuota: 100_000,
        CpuPeriod: 100_000,
        Memory: 1_048_576_000,
        MemorySwap: 1_048_576_000,
        Privileged: false,
        Sysctls: {
          "net.ipv6.conf.all.disable_ipv6": "1",
          "net.ipv6.conf.default.disable_ipv6": "1",
        },
        Binds: [],
        CapDrop: ["ALL"],
        CapAdd: [
          "CHOWN",
          "DAC_OVERRIDE",
          "FOWNER",
          "SETGID",
          "SETUID",
          "SYS_CHROOT",
          "NET_BIND_SERVICE",
        ],
        PortBindings: {
          "22/tcp": [{ HostIp: "0.0.0.0", HostPort: String(hostPort) }],
        },
      },
      Mounts: [
        {
          Destination: "/workspace",
          Type: "volume",
          Name: volumeName,
          RW: true,
        },
      ],
      NetworkSettings: {
        Ports: {
          "22/tcp": [{ HostIp: "0.0.0.0", HostPort: String(hostPort) }],
        },
      },
    };
    const network = {
      Id: "network-1",
      Name: name,
      Labels: labels,
      Options: { "com.docker.network.bridge.name": "br-hitchlet1" },
      IPAM: { Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.1" }] },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/system/version")
        return new Response(JSON.stringify({ ServerVersion: "2.45.2" }));
      if (url.pathname.endsWith("/docker/info"))
        return new Response(
          JSON.stringify({
            ID: "test-engine",
            ServerVersion: "29.0.0",
            Architecture: "aarch64",
          }),
        );
      if (url.pathname.endsWith("/docker/containers/json"))
        return new Response(
          JSON.stringify([
            { Id: containerId, Names: [`/${name}`], Labels: labels },
          ]),
        );
      if (url.pathname.endsWith(`/docker/containers/${containerId}/json`))
        return new Response(JSON.stringify(container));
      if (url.pathname.endsWith("/docker/networks"))
        return new Response(
          JSON.stringify([{ Id: "network-1", Name: name, Labels: labels }]),
        );
      if (url.pathname.endsWith("/docker/networks/network-1"))
        return new Response(JSON.stringify(network));
      if (url.pathname.endsWith("/docker/volumes"))
        return new Response(
          JSON.stringify({ Volumes: [{ Name: volumeName, Labels: labels }] }),
        );
      if (url.pathname.endsWith(`/docker/volumes/${volumeName}`))
        return new Response(
          JSON.stringify({ Name: volumeName, Labels: labels }),
        );
      if (url.pathname.includes("/docker/images/"))
        return new Response(
          JSON.stringify({
            Id: "sha256:local-image",
            RepoDigests: [plan.artifact.ref],
            Architecture: "arm64",
            Os: "linux",
          }),
        );
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const execution = provider({
      networkInspect: async () => ({
        commandId: "command-1",
        operationId: plan.identity.operationId,
        allocationId: plan.identity.allocationId,
        generation: plan.identity.generation,
        nativeEngineId: "test-engine",
        status: "unknown",
        rulesetHash: null,
        verifiedAt: new Date().toISOString(),
      }),
    });

    const inspection = await execution.inspect({
      ...plan,
      executionPhase: "observe",
    });

    expect(inspection).toMatchObject({
      presence: "present",
      integrity: { state: "lost", reason: "NETWORK_GUARANTEE_UNVERIFIED" },
    });
  });

  it("stops exactly owned containers even when Agent revoke is rejected, while keeping cleanup blocked", async () => {
    const labels = {
      "io.hitchlet.purpose": "validation",
      "io.hitchlet.installation": plan.identity.installationId,
      "io.hitchlet.runtime": plan.identity.runtimeIdentityId,
      "io.hitchlet.allocation": plan.identity.allocationId,
      "io.hitchlet.generation": "1",
      "io.hitchlet.operation": plan.identity.operationId,
      "io.hitchlet.contract": plan.resolved.contractHash,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/docker/info"))
        return new Response(JSON.stringify({ ID: "test-engine" }));
      if (url.pathname.endsWith("/docker/networks/network-1"))
        return new Response(
          JSON.stringify({
            Id: "network-1",
            Name: "hitchlet-test-allocation-1",
            Labels: labels,
            Options: { "com.docker.network.bridge.name": "br-hitchlet1" },
            IPAM: {
              Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.1" }],
            },
          }),
        );
      if (url.pathname.endsWith("/docker/containers/container-1/json"))
        return new Response(
          JSON.stringify({
            Id: "container-1",
            HostConfig: { PortBindings: {} },
          }),
        );
      if (url.pathname.endsWith("/docker/containers/container-1/stop"))
        return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const execution = provider({
      revoke: async () => {
        throw new Error("Agent cannot verify firewall readback");
      },
    });
    vi.spyOn(execution, "inspect").mockResolvedValue({
      presence: "present",
      evidence: {
        completeness: "complete",
        runtime: plan.identity,
        identity: plan.identity,
        objects: [
          owned("container-1", "container"),
          owned("network-1", "network_policy"),
        ],
      },
    });
    const cleanupPlan = {
      ...plan,
      cleanupResources: [owned("network-1", "network_policy")],
    };

    await expect(execution.revokeStop(cleanupPlan)).rejects.toThrow(
      "Agent cannot verify firewall readback",
    );

    expect(
      fetcher.mock.calls.some(
        ([input, init]) =>
          String(input).includes("/docker/containers/container-1/stop") &&
          init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("resumes cleanup with historical ports after containers disappear and Agent revoke rejects", async () => {
    const name = "hitchlet-test-allocation-1";
    const labels = {
      "io.hitchlet.purpose": "validation",
      "io.hitchlet.installation": plan.identity.installationId,
      "io.hitchlet.runtime": plan.identity.runtimeIdentityId,
      "io.hitchlet.allocation": plan.identity.allocationId,
      "io.hitchlet.generation": "1",
      "io.hitchlet.operation": plan.identity.operationId,
      "io.hitchlet.contract": plan.resolved.contractHash,
    };
    const publishedPorts = [
      {
        containerId: "container-1",
        protocol: "tcp" as const,
        hostPort: 30022,
        containerPort: 22,
        hostAddress: "0.0.0.0",
      },
    ];
    const networkResource: OwnedResource = {
      ...owned("network-1", "network_policy"),
      details: {
        networkName: name,
        networkSubnet: "172.30.0.0/24",
        bridgeGateway: "172.30.0.1",
        bridgeName: "br-hitchlet1",
        publishedPorts,
      },
    };
    const containerResource = owned("container-1", "container");
    const networkDetail = {
      Id: "network-1",
      Name: name,
      Labels: labels,
      Options: { "com.docker.network.bridge.name": "br-hitchlet1" },
      IPAM: { Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.1" }] },
      Containers: { "container-1": { Name: name } },
    };
    const steps: string[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/docker/info"))
          return new Response(JSON.stringify({ ID: "test-engine" }));
        if (
          url.pathname.endsWith("/docker/networks/network-1") &&
          init?.method === "DELETE"
        ) {
          steps.push("docker-network-delete");
          return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith("/docker/networks/network-1"))
          return new Response(
            JSON.stringify({ ...networkDetail, Containers: {} }),
          );
        if (url.pathname.endsWith("/docker/containers/container-1/json"))
          return new Response(
            JSON.stringify({
              Id: "container-1",
              HostConfig: { PortBindings: {} },
            }),
          );
        if (url.pathname.endsWith("/docker/containers/container-1/stop"))
          return new Response(null, { status: 204 });
        return new Response("not found", { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetcher);

    const firstProvider = provider({
      revoke: async (command) => ({
        commandId: command.commandId,
        operationId: command.operationId,
        allocationId: command.allocationId,
        generation: command.generation,
        nativeEngineId: "test-engine",
        status: "revoked",
        rulesetHash: hashRuntimeNetworkRules(command.plan, true),
        verifiedAt: new Date().toISOString(),
      }),
    });
    vi.spyOn(firstProvider, "inspect").mockResolvedValue({
      presence: "present",
      evidence: {
        completeness: "complete",
        runtime: plan.identity,
        identity: plan.identity,
        objects: [containerResource, networkResource],
      },
    });
    const cleanupPlan = {
      ...plan,
      cleanupResources: [networkResource, containerResource],
    };
    await firstProvider.revokeStop(cleanupPlan);
    steps.push("container-delete-and-controller-restart");

    const resumedProvider = provider({
      revoke: async (command) => {
        expect(command.plan.publishedPorts).toEqual(publishedPorts);
        steps.push("agent-revoke-rejected");
        throw new Error(
          "HTTP 409: current containers no longer match historical published ports",
        );
      },
      remove: async (command) => {
        expect(command.plan.publishedPorts).toEqual(publishedPorts);
        steps.push("agent-remove-verified");
        return {
          commandId: command.commandId,
          operationId: command.operationId,
          allocationId: command.allocationId,
          generation: command.generation,
          nativeEngineId: "test-engine",
          status: "removed",
          rulesetHash: null,
          verifiedAt: new Date().toISOString(),
        };
      },
    });
    vi.spyOn(resumedProvider, "inspect").mockResolvedValue({
      presence: "present",
      evidence: {
        completeness: "complete",
        runtime: plan.identity,
        identity: plan.identity,
        objects: [networkResource],
      },
    });

    const receipt = await resumedProvider.destroy(cleanupPlan, networkResource);

    expect(receipt).toMatchObject({
      presence: "absent",
      networkRules: "removed",
    });
    expect(steps).toEqual([
      "container-delete-and-controller-restart",
      "agent-revoke-rejected",
      "docker-network-delete",
      "agent-remove-verified",
    ]);
  });
});
