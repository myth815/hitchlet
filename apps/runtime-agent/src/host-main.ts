import { readFile, rename, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { arch, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hostPairingReceiptSchema } from "@hitchlet/contracts/internal";
import { HostClient } from "./host-client.js";
import { HostObservationService, HostTransientError } from "./host-service.js";
import { collectHostEvidence } from "./host-probes.js";

const bindingSchema = z
  .object({
    agentId: z.string().uuid(),
    machineId: z.string().uuid(),
    installationId: z.string().uuid(),
    credential: z.string().regex(/^hch_[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const configSchema = z
  .object({
    controllerOrigin: z.string().url(),
    hostIdentity: z.string().uuid(),
    bindingFile: z.string().min(1),
    caFile: z.string().min(1).optional(),
    pairingFile: z.string().min(1).optional(),
    intervalMs: z.number().int().min(1000).max(15_000).default(10_000),
  })
  .strict();
async function privateRead(file: string) {
  const info = await stat(file);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Error("host_secret_permissions");
  return readFile(file, "utf8");
}
async function main() {
  if (process.argv[2] === "identity") {
    process.stdout.write(`${randomUUID()}\n`);
    return;
  }
  const configPath = process.env.HITCHLET_HOST_AGENT_CONFIG;
  if (!configPath) throw new Error("host_config_required");
  const config = configSchema.parse(JSON.parse(await privateRead(configPath)));
  const client = new HostClient(
    new URL(config.controllerOrigin),
    config.caFile ? await readFile(config.caFile) : undefined,
  );
  if (process.argv[2] === "enroll") {
    if (!config.pairingFile) throw new Error("host_pairing_file_required");
    // Refuse overwriting any existing enrollment. Administrator revocation/re-pair is recovery.
    try {
      await stat(config.bindingFile);
      throw new Error("host_binding_exists");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const pairing = hostPairingReceiptSchema.parse(
      JSON.parse(await privateRead(config.pairingFile)),
    );
    const hostOs =
      platform() === "darwin"
        ? "macos"
        : platform() === "win32"
          ? "windows"
          : platform() === "linux"
            ? "linux"
            : undefined;
    const architecture =
      arch() === "x64" ? "amd64" : arch() === "arm64" ? "arm64" : undefined;
    if (!hostOs || !architecture) throw new Error("host_platform_unsupported");
    const enrolled = await client.enroll({
      agentId: pairing.agentId,
      machineId: pairing.machineId,
      installationId: pairing.installationId,
      pairingToken: pairing.pairingToken,
      hostIdentity: config.hostIdentity,
      hostOs,
      architecture,
      protocolVersion: 1,
      role: "physical_host",
    });
    const binding = bindingSchema.parse({
      agentId: enrolled.agentId,
      machineId: enrolled.machineId,
      installationId: enrolled.installationId,
      credential: enrolled.credential,
    });
    await mkdir(dirname(config.bindingFile), { recursive: true, mode: 0o700 });
    const temporary = `${config.bindingFile}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(binding));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, config.bindingFile);
    process.stdout.write("Host enrollment stored\n");
    return;
  }
  const binding = bindingSchema.parse(
    JSON.parse(await privateRead(config.bindingFile)),
  );
  const service = new HostObservationService(binding, client, () =>
    collectHostEvidence(platform()),
  );
  await service.initialize();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  while (!stopped) {
    try {
      await service.tick();
    } catch (error) {
      if (!(error instanceof HostTransientError)) throw error;
      process.stderr.write("Host observation temporarily unavailable\n");
    }
    if (!stopped)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, config.intervalMs);
        function done() {
          clearTimeout(timer);
          process.off("SIGTERM", done);
          process.off("SIGINT", done);
          resolve();
        }
        process.once("SIGTERM", done);
        process.once("SIGINT", done);
      });
  }
}
void main().catch(() => {
  process.stderr.write(
    "Host Agent failed; inspect controller status and local permissions\n",
  );
  process.exitCode = 1;
});
