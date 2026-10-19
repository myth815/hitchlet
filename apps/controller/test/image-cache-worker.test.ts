import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImageCacheWorker,
  type ImageCacheOperationStore,
} from "../src/application/image-cache.js";
import type { ClaimedImageCacheOperation } from "../src/storage/image-cache-store.js";
import type { ImageCacheExecutionPort } from "../src/providers/image-cache-port.js";
import { PortainerImageCacheProvider } from "../src/providers/portainer-cache.js";

const operation: ClaimedImageCacheOperation = {
  operationId: "op-cache",
  nodeId: "node-cache",
  artifactId: "artifact-cache",
  kind: "image-cache.pull",
  ownerToken: "owner-token",
  version: 2,
  attemptCount: 1,
  controllerEpoch: 3,
  runtimeIdentityId: "runtime-identity",
  nativeEngineId: "engine-id",
  connectionRevisionId: "connection-revision",
  endpointRef: "endpoint-ref",
  providerEndpointId: "endpoint-1",
  secretVersionRef: "secret-ref",
  connectionConfig: {},
  artifactRef: `docker.io/library/tooling@sha256:${"b".repeat(64)}`,
  digest: `sha256:${"b".repeat(64)}`,
  architecture: "amd64",
  sizeMiB: null,
  deleteAttempted: false,
  deleteConfirmed: false,
  deleteImageId: null,
};

afterEach(() => vi.unstubAllGlobals());

function store(overrides: Partial<ImageCacheOperationStore> = {}) {
  return {
    claimDue: vi.fn(async () => [operation]),
    assertCurrent: vi.fn(async () => true),
    pullAllowed: vi.fn(async () => true),
    evictionBlock: vi.fn(async () => undefined),
    recordReady: vi.fn(async () => true),
    recordAbsent: vi.fn(async () => true),
    markDeleteStarted: vi.fn(async () => true),
    markDeleteConfirmed: vi.fn(async () => true),
    finish: vi.fn(async () => undefined),
    finishKnownFailure: vi.fn(async () => undefined),
    ...overrides,
  } satisfies ImageCacheOperationStore;
}

function provider(overrides: Partial<ImageCacheExecutionPort> = {}) {
  let pulled = false;
  const adapter: ImageCacheExecutionPort = {
    inspectLocal: vi.fn(async () =>
      pulled
        ? {
            presence: "present" as const,
            localRef: operation.digest,
            imageId: "sha256:image-id",
            sizeMiB: 17,
            architecture: "amd64",
            os: "linux",
          }
        : { presence: "absent" as const },
    ),
    verifyRegistryManifest: vi.fn(async () => undefined),
    pullPinned: vi.fn(async () => {
      pulled = true;
    }),
    imageInUse: vi.fn(async () => false),
    removePinned: vi.fn(async () => undefined),
    ...overrides,
  };
  return adapter;
}

describe("image cache operation worker", () => {
  it("fails closed before a pull without fresh verified disk capacity evidence", async () => {
    const sql = store();
    const port = provider();
    const worker = new ImageCacheWorker(
      sql,
      port,
      async () => undefined,
      () => 100_000,
    );
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      deferred: 1,
    });
    expect(port.verifyRegistryManifest).not.toHaveBeenCalled();
    expect(port.pullPinned).not.toHaveBeenCalled();
    expect(sql.finishKnownFailure).toHaveBeenCalledWith(
      operation,
      "capacity_unverified",
      "missing",
    );
  });

  it("verifies a fixed digest and platform, pulls only after capacity proof, and records readback", async () => {
    const sql = store();
    const port = provider();
    const worker = new ImageCacheWorker(
      sql,
      port,
      async () => ({
        verified: true,
        evidenceId: "host-disk-snapshot",
        observedAtMs: 99_999,
        availableMiB: 1200,
        requiredMiB: 800,
        lowWaterMiB: 200,
      }),
      () => 100_000,
    );
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      deferred: 0,
    });
    expect(port.verifyRegistryManifest).toHaveBeenCalledWith(operation);
    expect(port.pullPinned).toHaveBeenCalledWith(operation);
    expect(sql.recordReady).toHaveBeenCalledWith(
      operation,
      operation.digest,
      17,
    );
  });

  it("adopts a local exact-digest image only after registry manifest proof and admission recheck", async () => {
    const sql = store();
    const port = provider({
      inspectLocal: vi.fn(async () => ({
        presence: "present" as const,
        localRef: operation.digest,
        imageId: "sha256:image-id",
        sizeMiB: 17,
        architecture: "amd64",
        os: "linux",
      })),
    });
    const worker = new ImageCacheWorker(sql, port, async () => undefined);
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      deferred: 0,
    });
    expect(port.verifyRegistryManifest).toHaveBeenCalledWith(operation);
    expect(port.pullPinned).not.toHaveBeenCalled();
    expect(sql.pullAllowed).toHaveBeenCalledTimes(2);
    expect(sql.recordReady).toHaveBeenCalledWith(
      operation,
      operation.digest,
      17,
    );
  });

  it("does not adopt an already-local image after admission is disabled", async () => {
    const sql = store({ pullAllowed: vi.fn(async () => false) });
    const port = provider({
      inspectLocal: vi.fn(async () => ({
        presence: "present" as const,
        localRef: operation.digest,
        imageId: "sha256:image-id",
        sizeMiB: 17,
        architecture: "amd64",
        os: "linux",
      })),
    });
    const worker = new ImageCacheWorker(sql, port, async () => undefined);
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      deferred: 1,
    });
    expect(port.verifyRegistryManifest).not.toHaveBeenCalled();
    expect(sql.recordReady).not.toHaveBeenCalled();
  });

  it("releases eviction fencing only after a fresh, known reference blocker", async () => {
    const evict = { ...operation, kind: "image-cache.evict" as const };
    const sql = store({
      claimDue: vi.fn(async () => [evict]),
      evictionBlock: vi.fn(async () => "cache_referenced" as const),
    });
    const port = provider({
      inspectLocal: vi.fn(async () => ({
        presence: "present" as const,
        localRef: operation.digest,
        imageId: "sha256:image-id",
        sizeMiB: 17,
        architecture: "amd64",
        os: "linux",
      })),
    });
    const worker = new ImageCacheWorker(sql, port, async () => undefined);
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      deferred: 1,
    });
    expect(port.removePinned).not.toHaveBeenCalled();
    expect(sql.finishKnownFailure).toHaveBeenCalledWith(
      evict,
      "cache_referenced",
      "ready",
    );
  });

  it("does not release an unknown delete after an empty inspect until a fresh delete receipt", async () => {
    const evict: ClaimedImageCacheOperation = {
      ...operation,
      kind: "image-cache.evict",
      deleteAttempted: true,
      deleteImageId: "sha256:image-id",
    };
    const sql = store({ claimDue: vi.fn(async () => [evict]) });
    const port = provider({
      inspectLocal: vi.fn(async () => ({ presence: "absent" as const })),
    });
    const worker = new ImageCacheWorker(sql, port, async () => undefined);
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      deferred: 0,
    });
    expect(port.removePinned).toHaveBeenCalledWith(evict);
    expect(sql.markDeleteConfirmed).toHaveBeenCalledWith(evict);
    expect(sql.recordAbsent).toHaveBeenCalledWith(evict);
  });

  it("treats a missing exact-digest image as absent and fails a pull closed without capacity proof", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/docker/info"))
          return Response.json({ ID: operation.nativeEngineId });
        if (url.includes("/docker/images/"))
          return Response.json({ message: "No such image" }, { status: 404 });
        throw new Error("unexpected request");
      }),
    );
    const sql = store();
    const port = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: operation.providerEndpointId,
      apiKey: "unit-test-api-key",
      engineId: operation.nativeEngineId,
    }));
    const worker = new ImageCacheWorker(sql, port, async () => undefined);
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      deferred: 1,
    });
    expect(sql.finishKnownFailure).toHaveBeenCalledWith(
      operation,
      "capacity_unverified",
      "missing",
    );
  });

  it("completes GC after a known exact-image delete and post-delete inspect 404", async () => {
    const evict: ClaimedImageCacheOperation = {
      ...operation,
      kind: "image-cache.evict",
      deleteAttempted: false,
      deleteConfirmed: false,
      deleteImageId: null,
    };
    let imageInspects = 0;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/docker/info"))
          return Response.json({ ID: evict.nativeEngineId });
        if (url.includes("/docker/containers/json?all=1"))
          return Response.json([]);
        if (url.includes("/docker/images/") && init?.method === "GET") {
          imageInspects++;
          if (imageInspects === 1) {
            return Response.json({
              Id: "sha256:local-image-id",
              RepoDigests: [evict.artifactRef],
              Architecture: "amd64",
              Os: "linux",
              Size: 17 * 1024 * 1024,
            });
          }
          return Response.json({ message: "No such image" }, { status: 404 });
        }
        if (url.includes("/docker/images/") && init?.method === "DELETE")
          return new Response(null, { status: 204 });
        throw new Error("unexpected request");
      }),
    );
    const sql = store({ claimDue: vi.fn(async () => [evict]) });
    const port = new PortainerImageCacheProvider(async () => ({
      endpointUrl: "https://portainer.example",
      environmentId: evict.providerEndpointId,
      apiKey: "unit-test-api-key",
      engineId: evict.nativeEngineId,
    }));
    const worker = new ImageCacheWorker(sql, port, async () => undefined);
    await expect(worker.reconcile()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      deferred: 0,
    });
    expect(imageInspects).toBe(2);
    expect(
      calls.some(
        (call) =>
          call.startsWith("DELETE ") &&
          call.includes("?force=false&noprune=true"),
      ),
    ).toBe(true);
    expect(sql.markDeleteConfirmed).toHaveBeenCalledWith(evict);
    expect(sql.recordAbsent).toHaveBeenCalledWith(evict);
  });
});
