import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeTartNamespace,
  readTartNamespace,
} from "../src/tart-main.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("initializes one durable namespace only on explicit init and binds it to home and configured runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-tart-main-"));
  roots.push(root);
  const config = configFor(root);
  const id = await initializeTartNamespace(config);
  expect(await readTartNamespace(config)).toBe(id);
  await expect(initializeTartNamespace(config)).rejects.toMatchObject({
    code: "EEXIST",
  });
  await expect(
    readTartNamespace({ ...config, runtimeIdentityId: "another-runtime" }),
  ).rejects.toThrow("tart_namespace_binding_mismatch");
});

it("does not auto-initialize an empty namespace path during normal startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-tart-main-empty-"));
  roots.push(root);
  const config = configFor(root);
  await expect(readTartNamespace(config)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

function configFor(root: string) {
  return {
    enabled: true as const,
    host: "127.0.0.1",
    port: 4430,
    installationId: "installation-1",
    runtimeIdentityId: "runtime-1",
    executable: "/opt/homebrew/bin/tart",
    tartHome: join(root, "private-tart-home"),
    manifestDirectory: join(root, "manifests"),
    templateRegistryDirectory: join(root, "template-registry"),
    journalFile: join(root, "journal.json"),
    namespaceFile: join(root, "state", "namespace.json"),
    tokenFile: join(root, "token"),
    caFile: join(root, "ca.pem"),
    certFile: join(root, "cert.pem"),
    keyFile: join(root, "key.pem"),
  };
}
