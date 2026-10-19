import { readFile } from "node:fs/promises";
import { z } from "zod";
import { FileJournal } from "./journal.js";
import { LocalEngine } from "./engine.js";
import { IptablesFirewall, IptablesRunner } from "./firewall.js";
import { NetworkWorker } from "./worker.js";
import { createRuntimeServer, listenRuntimeServer } from "./server.js";

const configSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    installationId: z.string().min(1),
    runtimeIdentityId: z.string().min(1),
    nativeEngineId: z.string().min(1),
    agentId: z.string().min(1),
    dockerHost: z.string().startsWith("unix://"),
    ipv6SysctlRoot: z.string().min(1),
    journalFile: z.string().min(1),
    tokenFile: z.string().min(1),
    caFile: z.string().min(1),
    certFile: z.string().min(1),
    keyFile: z.string().min(1),
  })
  .strict();

async function start(): Promise<void> {
  const configPath = process.env.HITCHLET_RUNTIME_AGENT_CONFIG;
  if (!configPath)
    throw new Error(
      "HITCHLET_RUNTIME_AGENT_CONFIG must point to the mounted configuration file",
    );
  const parsed = configSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const engine = new LocalEngine({
    dockerHost: parsed.dockerHost,
    nativeEngineId: parsed.nativeEngineId,
    ipv6SysctlRoot: parsed.ipv6SysctlRoot,
  });
  await engine.assertEngine();
  await new IptablesRunner().requireChain("DOCKER-USER");
  const journal = new FileJournal(parsed.journalFile);
  await journal.initialize();
  const worker = new NetworkWorker(
    {
      installationId: parsed.installationId,
      runtimeIdentityId: parsed.runtimeIdentityId,
      agentId: parsed.agentId,
    },
    journal,
    engine,
    new IptablesFirewall(),
  );
  const server = await createRuntimeServer(parsed, worker);
  const address = await listenRuntimeServer(server, parsed.host, parsed.port);
  process.stdout.write(
    `Hitchlet Runtime Agent listening on ${address.address}:${address.port}\n`,
  );
  const close = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

start().catch(() => {
  process.stderr.write("Hitchlet Runtime Agent startup failed\n");
  process.exitCode = 1;
});
