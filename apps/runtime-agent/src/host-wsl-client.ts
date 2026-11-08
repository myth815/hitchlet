import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runtimeNativeContextSchema } from "@hitchlet/contracts/internal";
import {
  wslWorkloadSchema,
  type WslBinding,
  type WslKeeperProof,
} from "./host-wsl.js";

/** Fixed code, not a caller-supplied shell command. Verify the artifact before importing it. */
export const wslObservationBootstrap = `
import { readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
let raw = "";
for await (const chunk of process.stdin) {
  raw += String(chunk);
  if (raw.length > 65536) throw Error("wsl_input_limit");
}
const request = JSON.parse(raw), path = request.binding.collectorPath;
if (!/^\\/opt\\/hitchlet-observers\\/[A-Za-z0-9._-]+\\/host-wsl-linux\\.js$/.test(path) ||
    !/^[a-f0-9]{64}$/.test(request.collectorSha256)) throw Error("wsl_collector_input_invalid");
if (createHash("sha256").update(await readFile(path)).digest("hex") !== request.collectorSha256)
  throw Error("wsl_collector_identity_changed");
const before = {
  distributionMachineId: (await readFile("/etc/machine-id", "utf8")).trim(),
  bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
  pidNamespace: await readlink("/proc/1/ns/pid"),
};
if (before.distributionMachineId !== request.binding.distributionMachineId)
  throw Error("wsl_distribution_identity_changed");
const collector = await import(pathToFileURL(path));
await collector.collectWslObservation({ binding: request.binding, before,
  ...(request.keeperProof ? { keeperProof: request.keeperProof } : {}) });
`;

/** Elapsed time is supplied by the caller's monotonic clock; never retimestamp old facts. */
export const remainingWslPollDelayMs = (elapsedMs: number) =>
  Math.max(0, 2000 - elapsedMs);

/** Uses the installed Windows Host identity, not a new bearer or Hyper-V credential. */
export async function collectHostWsl(
  binding: WslBinding,
  keeperProof?: WslKeeperProof,
) {
  if (process.platform !== "win32") throw Error("native_windows_wsl_only");
  const executable = "C:\\Windows\\System32\\wsl.exe";
  const call = (args: string[], stdin?: string) =>
    new Promise<string>((resolve, reject) => {
      const c = execFile(
        executable,
        args,
        {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
        },
        (e, out) =>
          e
            ? reject(Error("wsl_native_read_failed"))
            : resolve(out.replaceAll("\u0000", "").trim()),
      );
      c.stdin?.end(stdin);
    });
  const running = async () =>
    (await call(["--list", "--running", "--quiet"]))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .includes(binding.name);
  if (!(await running())) throw Error("wsl_distribution_not_running");
  const prefix = ["--distribution", binding.name, "--user", "root", "--exec"];
  const local = fileURLToPath(new URL("./host-wsl-linux.js", import.meta.url));
  const hash = createHash("sha256")
    .update(await readFile(local))
    .digest("hex");
  const result = wslWorkloadSchema.parse(
    JSON.parse(
      await call(
        [
          ...prefix,
          "/usr/local/bin/node",
          "--input-type=module",
          "--eval",
          wslObservationBootstrap,
        ],
        JSON.stringify({
          binding,
          collectorSha256: hash,
          ...(keeperProof ? { keeperProof } : {}),
        }),
      ),
    ),
  );
  runtimeNativeContextSchema.parse(result.before);
  if (result.before.distributionMachineId !== binding.distributionMachineId)
    throw Error("wsl_distribution_identity_changed");
  if (!(await running())) throw Error("wsl_distribution_changed");
  return result;
}
