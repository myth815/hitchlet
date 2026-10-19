import { afterEach, describe, expect, it, vi } from "vitest";
import { PortainerImageCacheProvider } from "../src/providers/portainer-cache.js";
import type { ClaimedImageCacheOperation } from "../src/storage/image-cache-store.js";

const digest = `sha256:${"c".repeat(64)}`;
const operation: ClaimedImageCacheOperation = {
  operationId: "op-image-cache",
  nodeId: "node-image-cache",
  artifactId: "artifact-image-cache",
  kind: "image-cache.evict",
  ownerToken: "lease-token",
  version: 2,
  attemptCount: 1,
  controllerEpoch: 3,
  runtimeIdentityId: "runtime-id",
  nativeEngineId: "expected-engine",
  connectionRevisionId: "frozen-revision",
  endpointRef: "frozen-endpoint-ref",
  providerEndpointId: "8",
  secretVersionRef: "encrypted-version-reference",
  connectionConfig: {},
  artifactRef: `registry.example/library/tool@${digest}`,
  digest,
  architecture: "arm64",
  sizeMiB: null,
  deleteAttempted: false,
  deleteConfirmed: false,
  deleteImageId: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("Portainer image-cache adapter", () => {
  it("requires the frozen engine identity and inspects exact digest, platform, and actual size", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/docker/info"))
          return Response.json({ ID: "expected-engine" });
        return Response.json({
          Id: "sha256:local-image-id",
          RepoDigests: [operation.artifactRef],
          Architecture: "arm64",
          Os: "linux",
          Size: 18 * 1024 * 1024,
        });
      }),
    );
    const provider = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: "8",
      apiKey: "unit-test-api-key",
      engineId: "expected-engine",
    }));
    await expect(provider.inspectLocal(operation)).resolves.toEqual({
      presence: "present",
      localRef: digest,
      imageId: "sha256:local-image-id",
      sizeMiB: 18,
      architecture: "arm64",
      os: "linux",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/api/endpoints/8/docker/info");
    expect(calls[1]).toContain("/api/endpoints/8/docker/images/");
  });

  it("removes only the digest with force disabled and verifies engine identity again", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/docker/info"))
          return Response.json({ ID: "expected-engine" });
        if (init?.method === "DELETE")
          return new Response(null, { status: 204 });
        throw new Error("unexpected request");
      }),
    );
    const provider = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: "8",
      apiKey: "unit-test-api-key",
      engineId: "expected-engine",
    }));
    await provider.removePinned(operation);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain(
      "/docker/images/registry.example/library/tool%40sha256%3A",
    );
    expect(calls[1]).toContain("?force=false&noprune=true");
    expect(calls[0]).toContain("/docker/info");
    expect(calls[2]).toContain("/docker/info");
  });

  it("treats an unmanaged container in Docker's array inventory as an image reference", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/docker/info"))
          return Response.json({ ID: "expected-engine" });
        if (url.includes("/docker/containers/json?all=1")) {
          return Response.json([
            { Id: "unmanaged-container", ImageID: "sha256:unmanaged-image" },
            { Id: "tenant-container", ImageID: "sha256:target-image" },
          ]);
        }
        throw new Error("unexpected request");
      }),
    );
    const provider = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: "8",
      apiKey: "unit-test-api-key",
      engineId: "expected-engine",
    }));
    await expect(
      provider.imageInUse(operation, "sha256:target-image"),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/docker/containers/json?all=1");
  });

  it("accepts a valid empty container array as unused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        if (String(input).endsWith("/docker/info"))
          return Response.json({ ID: "expected-engine" });
        return Response.json([]);
      }),
    );
    const provider = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: "8",
      apiKey: "unit-test-api-key",
      engineId: "expected-engine",
    }));
    await expect(
      provider.imageInUse(operation, "sha256:target-image"),
    ).resolves.toBe(false);
  });

  it.each([
    ["object", { Containers: [] }],
    ["container without ImageID", [{ Id: "incomplete-container" }]],
  ])(
    "rejects a %s response instead of treating it as an empty inventory",
    async (_label, inventory) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: URL | RequestInfo) => {
          if (String(input).endsWith("/docker/info"))
            return Response.json({ ID: "expected-engine" });
          return Response.json(inventory);
        }),
      );
      const provider = new PortainerImageCacheProvider(async () => ({
        endpointUrl: "https://portainer.example",
        environmentId: "8",
        apiKey: "unit-test-api-key",
        engineId: "expected-engine",
      }));
      await expect(
        provider.imageInUse(operation, "sha256:target-image"),
      ).rejects.toMatchObject({
        code: "provider_error",
      });
    },
  );

  it("accepts Docker's 200 array response for an exact digest removal", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/docker/info"))
          return Response.json({ ID: "expected-engine" });
        if (init?.method === "DELETE")
          return Response.json([{ Untagged: "sha256:old-tag" }]);
        throw new Error("unexpected request");
      }),
    );
    const provider = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: "8",
      apiKey: "unit-test-api-key",
      engineId: "expected-engine",
    }));
    await expect(provider.removePinned(operation)).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("?force=false&noprune=true");
  });

  it("rejects a different live engine before an image read", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        calls.push(String(input));
        return Response.json({ ID: "other-engine" });
      }),
    );
    const provider = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: "8",
      apiKey: "unit-test-api-key",
      engineId: "expected-engine",
    }));
    await expect(provider.inspectLocal(operation)).rejects.toMatchObject({
      code: "runtime_identity_mismatch",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/docker/info");
  });

  it("does not treat a Docker Engine info 404 as an absent image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "Not found" }, { status: 404 }),
      ),
    );
    const provider = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: "8",
      apiKey: "unit-test-api-key",
      engineId: "expected-engine",
    }));
    await expect(provider.inspectLocal(operation)).rejects.toMatchObject({
      code: "provider_error",
    });
  });
});
