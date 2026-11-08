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
  const [machine, boot, pid] = await Promise.all([
    call([...prefix, "/bin/cat", "/etc/machine-id"]),
    call([...prefix, "/bin/cat", "/proc/sys/kernel/random/boot_id"]),
    call([...prefix, "/usr/bin/readlink", "/proc/1/ns/pid"]),
  ]);
  const before = runtimeNativeContextSchema.parse({
    distributionMachineId: machine,
    bootId: boot,
    pidNamespace: pid,
  });
  if (machine !== binding.distributionMachineId)
    throw Error("wsl_distribution_identity_changed");
  const local = fileURLToPath(new URL("./host-wsl-linux.js", import.meta.url));
  const path = binding.collectorPath;
  const hash = createHash("sha256")
    .update(await readFile(local))
    .digest("hex");
  if (
    (await call([...prefix, "/usr/bin/sha256sum", path])).split(/\s+/)[0] !==
    hash
  )
    throw Error("wsl_collector_identity_changed");
  const result = wslWorkloadSchema.parse(
    JSON.parse(
      await call(
        [...prefix, "/usr/local/bin/node", path],
        JSON.stringify({
          binding,
          before,
          ...(keeperProof ? { keeperProof } : {}),
        }),
      ),
    ),
  );
  if (!(await running())) throw Error("wsl_distribution_changed");
  return result;
}
