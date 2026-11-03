import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { HyperVNativeCommand } from "../src/drivers/hyperv.js";
import {
  initializeHyperVNamespace,
  readHyperVNamespace,
  parseHyperVRuntimeConfig,
  createHyperVRuntimeApplication,
} from "../src/hyperv-main.js";
import { listenRuntimeServer } from "../src/server.js";
import { RuntimeAgentHttpTransport } from "../../controller/src/providers/runtime-network-client.js";
import { HyperVRuntimeHttpClient } from "../../controller/src/providers/hyperv-runtime-client.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-hyperv-main-"));
  roots.push(root);
  return {
    root,
    config: {
      host: "127.0.0.1",
      port: 4430,
      installationId: "install",
      runtimeIdentityId: "runtime",
      stateDirectory: join(root, "state"),
      workRoot: "E:\\ComputeNode\\Hitchlet",
      tokenFile: join(root, "token"),
      caFile: join(root, "cert.pem"),
      certFile: join(root, "cert.pem"),
      keyFile: join(root, "key.pem"),
    },
    inspectRoot: vi.fn(async (_path: string, _create: boolean) => ({
      path: "e:\\computenode\\hitchlet",
      device: "41",
      inode: "1024",
    })),
  };
}
it("initializes one durable namespace explicitly, retaining the same ID through normal startup reads", async () => {
  const f = await fixture();
  const id = await initializeHyperVNamespace(f.config, f.inspectRoot);
  expect(await readHyperVNamespace(f.config, f.inspectRoot)).toBe(id);
  await expect(
    initializeHyperVNamespace(f.config, f.inspectRoot),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(
    await readHyperVNamespace(
      { ...f.config, workRoot: "e:\\computenode\\HITCHLET" },
      f.inspectRoot,
    ),
  ).toBe(id);
  expect(f.inspectRoot.mock.calls.some((c) => c[1] === false)).toBe(true);
});
it("never generates a replacement identity when normal startup has no marker", async () => {
  const f = await fixture();
  await expect(
    readHyperVNamespace(f.config, f.inspectRoot),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.inspectRoot).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual([]);
});
it("binds the persistent identity to installation/runtime and actual directory instance", async () => {
  const f = await fixture();
  await initializeHyperVNamespace(f.config, f.inspectRoot);
  for (const config of [
    { ...f.config, installationId: "other" },
    { ...f.config, runtimeIdentityId: "other" },
    { ...f.config, workRoot: "E:\\AnotherRoot" },
  ])
    await expect(readHyperVNamespace(config, f.inspectRoot)).rejects.toThrow(
      "namespace_binding_mismatch",
    );
  await expect(
    readHyperVNamespace(f.config, async () => ({
      path: "e:\\computenode\\hitchlet",
      device: "41",
      inode: "changed",
    })),
  ).rejects.toThrow("namespace_binding_mismatch");
});
it("does not overwrite malformed marker data or pretend its namespace is fresh", async () => {
  const f = await fixture();
  await initializeHyperVNamespace(f.config, f.inspectRoot);
  const path = join(f.config.stateDirectory, "namespace.json");
  await writeFile(path, "{broken");
  await expect(readHyperVNamespace(f.config, f.inspectRoot)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("{broken");
});
it("requires concrete local roots/credential references without introducing an enable switch", async () => {
  const f = await fixture();
  expect(parseHyperVRuntimeConfig(f.config).host).toBe("127.0.0.1");
  expect(parseHyperVRuntimeConfig({ ...f.config, host: undefined }).host).toBe(
    "127.0.0.1",
  );
  expect(() =>
    parseHyperVRuntimeConfig({ ...f.config, workRoot: "E:\\" }),
  ).toThrow("dedicated directory");
  expect(() =>
    parseHyperVRuntimeConfig({ ...f.config, stateDirectory: "/" }),
  ).toThrow("dedicated directory");
  expect(() =>
    parseHyperVRuntimeConfig({ ...f.config, tokenFile: "relative" }),
  ).toThrow();
  expect(() =>
    parseHyperVRuntimeConfig({ ...f.config, enabled: true }),
  ).toThrow();
});
it("requires existing TLS/token files and does not manufacture credentials on startup", async () => {
  const f = await fixture();
  await initializeHyperVNamespace(f.config, f.inspectRoot);
  const run = vi.fn();
  await expect(
    createHyperVRuntimeApplication(f.config, {
      inspectRoot: f.inspectRoot,
      nativeRunner: run,
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["state"]);
});
it("serves authenticated facts from the bound namespace without running VM or host configuration actions", async () => {
  const f = await fixture();
  const id = await initializeHyperVNamespace(f.config, f.inspectRoot);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      f.config.keyFile,
      "-out",
      f.config.certFile,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  await writeFile(f.config.tokenFile, "fixture-token", { mode: 0o600 });
  const run = vi.fn(
    async (_command: HyperVNativeCommand, _timeout: number) => ({
      available: false,
      reason: "hyperv_cmdlets_unavailable",
      hostArchitecture: "AMD64",
      implementedOperations: [],
    }),
  );
  const app = await createHyperVRuntimeApplication(f.config, {
    inspectRoot: f.inspectRoot,
    nativeRunner: run,
  });
  expect(run).not.toHaveBeenCalled();
  const address = await listenRuntimeServer(app.server, "127.0.0.1", 0);
  try {
    const [ca, cert, key] = await Promise.all([
      readFile(f.config.caFile),
      readFile(f.config.certFile),
      readFile(f.config.keyFile),
    ]);
    const transport = new RuntimeAgentHttpTransport({
      baseUrl: `https://127.0.0.1:${address.port}`,
      timeoutMs: 2000,
      loadCredentials: async () => ({ token: "fixture-token", ca, cert, key }),
    });
    const client = new HyperVRuntimeHttpClient({
      transport,
      installationId: "install",
      runtimeIdentityId: "runtime",
      controllerEpoch: 1,
      deadlineMs: Date.now() + 2000,
    });
    expect(await client.facts()).toMatchObject({
      nativeRuntimeNamespaceId: id,
      available: false,
    });
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0]![0].action).toBe("facts");
    expect(await readdir(f.config.stateDirectory)).toEqual(["namespace.json"]);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});
it("loads the compiled entry module without initializing directories or starting a service", () => {
  const module = pathToFileURL(resolve("dist/hyperv-main.js")).href;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toBe("");
});
