import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  runtimeStorageResultSchema,
  type RuntimeStorageRequest,
} from "@hitchlet/contracts/internal";

const state = vi.hoisted(() => ({
  config: "",
  imageRoot: "",
  result: undefined as unknown,
  error: undefined as unknown,
  failEnginePreflight: false,
  finished: () => {},
  request: undefined as RuntimeStorageRequest | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
      if (args[0] === "/fixture/runtime-agent.json")
        return Promise.resolve(state.config);
      if (args[0] === "/proc/self/mountinfo" || args[0] === "/proc/1/mountinfo")
        return Promise.resolve("1 0 1:2 / / rw - ext4 /dev/fixture rw\n");
      return actual.readFile(...args);
    }),
  };
});
vi.mock("../src/engine.js", () => {
  class EnginePreflightError extends Error {
    constructor(
      readonly code: "DOCKER_ENGINE_INFO_UNVERIFIABLE",
      message: string,
    ) {
      super(message);
    }
  }
  class LocalEngine {
    mode = "unknown";
    async assertEngine() {
      if (state.failEnginePreflight)
        throw new EnginePreflightError(
          "DOCKER_ENGINE_INFO_UNVERIFIABLE",
          "PRIVATE_DOCKER_DETAIL",
        );
      return "fixture-engine";
    }
    async imageStoreRoot() {
      return state.imageRoot;
    }
  }
  return { EnginePreflightError, LocalEngine };
});
vi.mock("../src/firewall.js", () => ({
  IptablesFirewall: class {},
  IptablesRunner: class {
    async requireChain() {}
  },
}));
vi.mock("../src/journal.js", () => ({
  FileJournal: class {
    epoch = 47;
    async initialize() {}
  },
}));
vi.mock("../src/worker.js", () => ({ NetworkWorker: class {} }));
vi.mock("../src/server.js", () => ({
  createRuntimeServer: vi.fn(
    async (
      _config: unknown,
      _worker: unknown,
      storage: { inspect(request: RuntimeStorageRequest): Promise<unknown> },
    ) => {
      try {
        state.result = await storage.inspect(state.request!);
      } catch (error) {
        state.error = error;
      }
      return {};
    },
  ),
  listenRuntimeServer: vi.fn(async () => {
    // Resolve after main has registered its shutdown handlers, so test cleanup
    // can remove exactly those listeners before the worker exits.
    setImmediate(() => state.finished());
    return { address: "127.0.0.1", port: 17222 };
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
});

it("projects only storage identity from the complete deployed Agent configuration at the real entry point", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "hitchlet-main-storage-")),
  );
  const before = new Map(
    ["SIGTERM", "SIGINT"].map((event) => [event, process.listeners(event)]),
  );
  try {
    state.imageRoot = join(directory, "docker-root");
    await mkdir(state.imageRoot);
    const config = {
      host: "127.0.0.1",
      port: 17222,
      installationId: "fixture-installation",
      runtimeIdentityId: "fixture-runtime",
      nativeEngineId: "fixture-engine",
      agentId: "fixture-agent",
      dockerHost: "unix:///var/run/docker.sock",
      ipv6SysctlRoot: "/run/host-ipv6-conf",
      journalFile: "/fixture/journal.json",
      tokenFile: "/fixture/token",
      caFile: "/fixture/ca.pem",
      certFile: "/fixture/cert.pem",
      keyFile: "/fixture/key.pem",
      storageRoots: [
        {
          sourceRef: directory,
          protocol: "local",
          secretVersionRef: null,
          mountPoint: "/",
          mountSource: "/dev/fixture",
        },
      ],
    };
    state.config = JSON.stringify(config);
    state.error = undefined;
    state.result = undefined;
    state.request = {
      requestId: "00000000-0000-4000-8000-000000000001",
      installationId: config.installationId,
      runtimeIdentityId: config.runtimeIdentityId,
      nativeEngineId: config.nativeEngineId,
      inventory: false,
      mounts: [],
    };
    vi.stubEnv("HITCHLET_RUNTIME_AGENT_CONFIG", "/fixture/runtime-agent.json");
    const started = new Promise<void>((resolve) => {
      state.finished = resolve;
    });
    await import("../src/main.js");
    await started;
    expect(state.error).toBeUndefined();
    const result = runtimeStorageResultSchema.parse(state.result);
    expect(result).toMatchObject({
      installationId: config.installationId,
      runtimeIdentityId: config.runtimeIdentityId,
      nativeEngineId: config.nativeEngineId,
      controllerEpoch: 47,
      imageStore: { root: state.imageRoot },
    });
    expect(Object.keys(result).sort()).toEqual([
      "controllerEpoch",
      "imageStore",
      "installationId",
      "inventory",
      "mounts",
      "nativeEngineId",
      "observedAtMs",
      "requestId",
      "runtimeIdentityId",
    ]);
    expect(
      runtimeStorageResultSchema.safeParse({
        ...result,
        agentId: config.agentId,
      }).success,
    ).toBe(false);
  } finally {
    for (const event of ["SIGTERM", "SIGINT"])
      for (const listener of process.listeners(event))
        if (!before.get(event)?.includes(listener))
          process.removeListener(event, listener);
    await rm(directory, { recursive: true, force: true });
  }
});

it("prints a fixed Engine-info diagnostic without exposing raw daemon details", async () => {
  const config = {
    host: "127.0.0.1",
    port: 17222,
    installationId: "fixture-installation",
    runtimeIdentityId: "fixture-runtime",
    nativeEngineId: "fixture-engine",
    agentId: "fixture-agent",
    dockerHost: "unix:///var/run/docker.sock",
    ipv6SysctlRoot: "/run/host-ipv6-conf",
    journalFile: "/fixture/journal.json",
    tokenFile: "/fixture/token",
    caFile: "/fixture/ca.pem",
    certFile: "/fixture/cert.pem",
    keyFile: "/fixture/key.pem",
    storageRoots: [],
  };
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const previousExitCode = process.exitCode;
  try {
    state.config = JSON.stringify(config);
    state.failEnginePreflight = true;
    vi.stubEnv("HITCHLET_RUNTIME_AGENT_CONFIG", "/fixture/runtime-agent.json");
    await vi.resetModules();
    await import("../src/main.js");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stderr).toHaveBeenCalledWith(
      "Hitchlet Runtime Agent startup failed: Docker Engine info cannot be verified\n",
    );
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(
      "PRIVATE_DOCKER_DETAIL",
    );
    expect(process.exitCode).toBe(1);
  } finally {
    state.failEnginePreflight = false;
    process.exitCode = previousExitCode;
    stderr.mockRestore();
  }
});
