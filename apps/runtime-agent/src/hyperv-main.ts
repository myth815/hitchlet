import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { hyperVAbsolutePathSchema } from "@hitchlet/contracts/internal";
import {
  HyperVLocalDriver,
  type HyperVNativeRunner,
} from "./drivers/hyperv.js";
import type { HyperVGuestBootstrapPort } from "./drivers/hyperv-guest.js";
import { FileJournal } from "./journal.js";
import { HyperVTemplateRegistry } from "./hyperv-templates.js";
import { createPowerShellDirectBootstrap } from "./drivers/hyperv-powershell-direct.js";
import { createHyperVRuntimeServer } from "./hyperv-server.js";
import { listenRuntimeServer } from "./server.js";

const localPath = z
  .string()
  .min(1)
  .refine(isAbsolute, "Absolute local state/credential path required");
const configSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65535),
    installationId: z.string().min(1).max(200),
    runtimeIdentityId: z.string().min(1).max(200),
    stateDirectory: localPath,
    workRoot: hyperVAbsolutePathSchema,
    tokenFile: localPath,
    caFile: localPath,
    certFile: localPath,
    keyFile: localPath,
    guestBootstrap: z
      .object({
        kind: z.literal("powershell_direct_windows_v1"),
        credentialFile: localPath,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (win32.normalize(c.workRoot) === win32.parse(c.workRoot).root)
      ctx.addIssue({
        code: "custom",
        message: "Hyper-V work root must be a dedicated directory",
        path: ["workRoot"],
      });
    if (resolve(c.stateDirectory) === resolve(c.stateDirectory, ".."))
      ctx.addIssue({
        code: "custom",
        message: "Runtime state must have a dedicated directory",
        path: ["stateDirectory"],
      });
  });
export const parseHyperVRuntimeConfig = (value: unknown) =>
  configSchema.parse(value);
export type HyperVRuntimeConfig = z.infer<typeof configSchema>;
const rootSchema = z
  .object({
    path: z.string().min(1),
    device: z.string().min(1),
    inode: z.string().min(1),
  })
  .strict();
type RootIdentity = z.infer<typeof rootSchema>;
/** Narrow filesystem seam for tests on a non-Windows development host. */
type InspectWorkRoot = (path: string, create: boolean) => Promise<RootIdentity>;
const namespaceSchema = z
  .object({
    version: z.literal(1),
    nativeRuntimeNamespaceId: z.string().uuid(),
    installationId: z.string().min(1),
    runtimeIdentityId: z.string().min(1),
    configuredWorkRoot: hyperVAbsolutePathSchema,
    root: rootSchema,
  })
  .strict();
async function inspectWorkRoot(
  path: string,
  create: boolean,
): Promise<RootIdentity> {
  if (!isAbsolute(path))
    throw Error("Windows absolute work root is unavailable on this host");
  if (create) await mkdir(path, { recursive: true });
  const actual = await realpath(path),
    info = await stat(actual, { bigint: true });
  if (!info.isDirectory()) throw Error("Hyper-V work root is not a directory");
  return {
    path: actual.toLowerCase(),
    device: String(info.dev),
    inode: String(info.ino),
  };
}
/** Explicit identity initialization, never called automatically by server startup. No credentials are generated. */
export async function initializeHyperVNamespace(
  raw: unknown,
  inspectRoot: InspectWorkRoot = inspectWorkRoot,
): Promise<string> {
  const c = parseHyperVRuntimeConfig(raw);
  const root = rootSchema.parse(await inspectRoot(c.workRoot, true));
  await mkdir(c.stateDirectory, { recursive: true, mode: 0o700 });
  const file = await open(
    join(c.stateDirectory, "namespace.json"),
    "wx",
    0o600,
  );
  const marker = namespaceSchema.parse({
    version: 1,
    nativeRuntimeNamespaceId: randomUUID(),
    installationId: c.installationId,
    runtimeIdentityId: c.runtimeIdentityId,
    configuredWorkRoot: win32.normalize(c.workRoot).toLowerCase(),
    root,
  });
  try {
    await file.writeFile(JSON.stringify(marker) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  return marker.nativeRuntimeNamespaceId;
}
export async function readHyperVNamespace(
  raw: unknown,
  inspectRoot: InspectWorkRoot = inspectWorkRoot,
): Promise<string> {
  const c = parseHyperVRuntimeConfig(raw);
  const marker = namespaceSchema.parse(
    JSON.parse(
      await readFile(join(c.stateDirectory, "namespace.json"), "utf8"),
    ),
  );
  const root = rootSchema.parse(await inspectRoot(c.workRoot, false));
  if (
    marker.installationId !== c.installationId ||
    marker.runtimeIdentityId !== c.runtimeIdentityId ||
    marker.configuredWorkRoot !== win32.normalize(c.workRoot).toLowerCase() ||
    marker.root.path !== root.path ||
    marker.root.device !== root.device ||
    marker.root.inode !== root.inode
  )
    throw Error("hyperv_namespace_binding_mismatch");
  return marker.nativeRuntimeNamespaceId;
}
export async function createHyperVRuntimeApplication(
  raw: unknown,
  dependencies: {
    inspectRoot?: InspectWorkRoot;
    nativeRunner?: HyperVNativeRunner;
    guestBootstrap?: HyperVGuestBootstrapPort;
  } = {},
) {
  const config = parseHyperVRuntimeConfig(raw);
  const namespaceId = await readHyperVNamespace(
    config,
    dependencies.inspectRoot,
  );
  const guestBootstrap =
    dependencies.guestBootstrap ??
    (config.guestBootstrap
      ? createPowerShellDirectBootstrap(config.guestBootstrap)
      : undefined);
  const driver = new HyperVLocalDriver({
    manifestDirectory: join(config.stateDirectory, "allocations"),
    workRoot: config.workRoot,
    ...(dependencies.nativeRunner ? { run: dependencies.nativeRunner } : {}),
    ...(guestBootstrap ? { guestBootstrap } : {}),
  });
  const journal = new FileJournal(join(config.stateDirectory, "journal.json"));
  await journal.initialize();
  const server = await createHyperVRuntimeServer(
    { ...config, nativeRuntimeNamespaceId: namespaceId },
    driver,
    journal,
    () =>
      new HyperVTemplateRegistry(
        join(config.stateDirectory, "templates"),
        namespaceId,
      ).facts(),
  );
  return { server, driver, journal, config, namespaceId };
}
async function start() {
  const file = process.env.HITCHLET_HYPERV_RUNTIME_CONFIG;
  if (!file) throw Error("hyperv_runtime_config_required");
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  if (process.argv[2] === "--init") {
    const id = await initializeHyperVNamespace(raw);
    process.stdout.write(`Hyper-V namespace initialized: ${id}\n`);
    return;
  }
  if (process.argv[2] === "--seal-template") {
    const c = parseHyperVRuntimeConfig(raw),
      namespace = await readHyperVNamespace(c);
    const proof = await new HyperVTemplateRegistry(
      join(c.stateDirectory, "templates"),
      namespace,
    ).seal(JSON.parse(await readFile(process.argv[3]!, "utf8")));
    process.stdout.write(JSON.stringify(proof) + "\n");
    return;
  }
  const app = await createHyperVRuntimeApplication(raw);
  const address = await listenRuntimeServer(
    app.server,
    app.config.host,
    app.config.port,
  );
  process.stdout.write(
    `Hitchlet Hyper-V Runtime Agent listening on ${address.address}:${address.port}\n`,
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    app.server.close(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (
    process.argv.length > 4 ||
    (process.argv.length === 3 && process.argv[2] !== "--init") ||
    (process.argv.length === 4 && process.argv[2] !== "--seal-template")
  ) {
    process.stderr.write(
      "Usage: hyperv-main [--init | --seal-template descriptor.json]\n",
    );
    process.exitCode = 1;
  } else
    void start().catch(() => {
      process.stderr.write(
        "Hitchlet Hyper-V Runtime initialization/startup failed\n",
      );
      process.exitCode = 1;
    });
}
