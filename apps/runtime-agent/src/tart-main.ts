import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, lstat, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { FileJournal } from "./journal.js";
import { TartLocalDriver } from "./drivers/tart.js";
import {
  createTartRuntimeServer,
  type TartRuntimeServerConfig,
} from "./tart-server.js";
import { listenRuntimeServer } from "./server.js";

const configSchema = z
  .object({
    enabled: z.literal(true),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    installationId: z.string().min(1).max(200),
    runtimeIdentityId: z.string().min(1).max(200),
    executable: z.string().startsWith("/"),
    tartHome: z.string().startsWith("/"),
    manifestDirectory: z.string().startsWith("/"),
    templateRegistryDirectory: z.string().startsWith("/"),
    journalFile: z.string().startsWith("/"),
    namespaceFile: z.string().startsWith("/"),
    tokenFile: z.string().startsWith("/"),
    caFile: z.string().startsWith("/"),
    certFile: z.string().startsWith("/"),
    keyFile: z.string().startsWith("/"),
  })
  .strict();

const namespaceSchema = z
  .object({
    version: z.literal(1),
    nativeRuntimeNamespaceId: z.string().uuid(),
    installationId: z.string().min(1).max(200),
    runtimeIdentityId: z.string().min(1).max(200),
    tartHomePath: z.string().min(1),
    tartHomeDevice: z.string().min(1),
    tartHomeInode: z.string().min(1),
  })
  .strict();

export async function initializeTartNamespace(
  rawConfig: unknown,
): Promise<string> {
  const config = configSchema.parse(rawConfig);
  assertDedicatedTartHome(config.tartHome);
  await mkdir(config.tartHome, { recursive: true, mode: 0o700 });
  const home = await stat(config.tartHome);
  if ((await lstat(config.tartHome)).isSymbolicLink())
    throw new Error("tart_home_symlink_not_allowed");
  assertPrivate(home.mode, "tart_home_permissions_required");
  await mkdir(dirname(config.namespaceFile), { recursive: true, mode: 0o700 });
  const markerDirectory = await stat(dirname(config.namespaceFile));
  if ((await lstat(dirname(config.namespaceFile))).isSymbolicLink())
    throw new Error("namespace_directory_symlink_not_allowed");
  assertPrivate(
    markerDirectory.mode,
    "namespace_directory_permissions_required",
  );
  const marker = namespaceSchema.parse({
    version: 1,
    nativeRuntimeNamespaceId: randomUUID(),
    installationId: config.installationId,
    runtimeIdentityId: config.runtimeIdentityId,
    tartHomePath: config.tartHome,
    tartHomeDevice: String(home.dev),
    tartHomeInode: String(home.ino),
  });
  const handle = await open(config.namespaceFile, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(config.namespaceFile), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return marker.nativeRuntimeNamespaceId;
}

export async function readTartNamespace(rawConfig: unknown): Promise<string> {
  const config = configSchema.parse(rawConfig);
  assertDedicatedTartHome(config.tartHome);
  const marker = namespaceSchema.parse(
    JSON.parse(await readFile(config.namespaceFile, "utf8")),
  );
  const home = await stat(config.tartHome);
  if ((await lstat(config.tartHome)).isSymbolicLink())
    throw new Error("tart_home_symlink_not_allowed");
  if (
    marker.installationId !== config.installationId ||
    marker.runtimeIdentityId !== config.runtimeIdentityId ||
    marker.tartHomePath !== config.tartHome ||
    marker.tartHomeDevice !== String(home.dev) ||
    marker.tartHomeInode !== String(home.ino)
  )
    throw new Error("tart_namespace_binding_mismatch");
  return marker.nativeRuntimeNamespaceId;
}

async function start(): Promise<void> {
  const configPath = process.env.HITCHLET_TART_RUNTIME_CONFIG;
  if (!configPath) throw new Error("tart_runtime_config_required");
  const config = configSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const namespaceId = await readTartNamespace(config);
  const driver = new TartLocalDriver(config);
  const journal = new FileJournal(config.journalFile);
  await journal.initialize();
  const serverConfig: TartRuntimeServerConfig = {
    host: config.host,
    port: config.port,
    installationId: config.installationId,
    runtimeIdentityId: config.runtimeIdentityId,
    nativeRuntimeNamespaceId: namespaceId,
    tokenFile: config.tokenFile,
    caFile: config.caFile,
    certFile: config.certFile,
    keyFile: config.keyFile,
  };
  const server = await createTartRuntimeServer(
    serverConfig,
    driver,
    journal,
    () => driver.facts(namespaceId),
  );
  const address = await listenRuntimeServer(server, config.host, config.port);
  process.stdout.write(
    `Hitchlet Tart Runtime Agent listening on ${address.address}:${address.port}\n`,
  );
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => {
      void driver.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

function assertDedicatedTartHome(path: string): void {
  const home = resolve(path);
  const userTartHome = resolve(homedir(), ".tart");
  if (
    home !== path ||
    home === "/" ||
    home === resolve(homedir()) ||
    home === userTartHome ||
    home.startsWith(`${userTartHome}/`)
  )
    throw new Error("tart_home_must_be_dedicated");
}

function assertPrivate(mode: number, error: string): void {
  if ((mode & 0o077) !== 0) throw new Error(error);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const initialize = process.argv[2] === "--init";
  const sealTemplate = process.argv[2] === "--seal-template";
  const expectedArgCount = initialize ? 3 : sealTemplate ? 4 : 2;
  if (process.argv.length !== expectedArgCount) {
    process.stderr.write(
      "Usage: tart-main [--init | --seal-template <localName>]\n",
    );
    process.exitCode = 2;
  } else if (initialize) {
    void (async () => {
      const configPath = process.env.HITCHLET_TART_RUNTIME_CONFIG;
      if (!configPath) throw new Error("tart_runtime_config_required");
      const config = configSchema.parse(
        JSON.parse(await readFile(configPath, "utf8")),
      );
      const namespaceId = await initializeTartNamespace(config);
      process.stdout.write(`Tart namespace initialized: ${namespaceId}\n`);
    })().catch(() => {
      process.stderr.write("Tart namespace initialization failed\n");
      process.exitCode = 1;
    });
  } else if (sealTemplate) {
    void (async () => {
      const configPath = process.env.HITCHLET_TART_RUNTIME_CONFIG;
      if (!configPath) throw new Error("tart_runtime_config_required");
      const config = configSchema.parse(
        JSON.parse(await readFile(configPath, "utf8")),
      );
      const namespaceId = await readTartNamespace(config);
      const driver = new TartLocalDriver(config);
      try {
        const proof = await driver.sealTemplate(process.argv[3]);
        process.stdout.write(
          `${JSON.stringify({ nativeRuntimeNamespaceId: namespaceId, ...proof })}\n`,
        );
      } finally {
        await driver.close();
      }
    })().catch(() => {
      process.stderr.write("Tart local template sealing failed\n");
      process.exitCode = 1;
    });
  } else {
    void start().catch(() => {
      process.stderr.write("Hitchlet Tart Runtime Agent startup failed\n");
      process.exitCode = 1;
    });
  }
}
