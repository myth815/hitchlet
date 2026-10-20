import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { z } from "zod";

export const watchPowerShell =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export const NativeWatchReadySchema = z
  .object({
    event: z.literal("ready"),
    launcherPid: z.number().int().positive(),
    launcherStartedTicks: z.string().regex(/^[1-9][0-9]{0,18}$/),
    watchPid: z.number().int().positive(),
    watchStartedTicks: z.string().regex(/^[1-9][0-9]{0,18}$/),
  })
  .strict();

/** Relay only the actual fixed PS helper's bounded protocol. A lost parent pipe never kills it. */
export function superviseNativeWatch(
  child: ChildProcess,
  launcherPid: number,
  output: Writable,
): Promise<number> {
  output.on("error", () => {});
  const send = (message: object) => {
    try {
      output.write(JSON.stringify(message) + "\n");
    } catch {
      /* parent may already be dead */
    }
  };
  return new Promise((resolve) => {
    let buffer = "",
      bytes = 0,
      ready = false,
      invalid = false;
    const fail = () => {
      if (!invalid) {
        invalid = true;
        send({ event: "failed" });
      }
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 512) {
        fail();
        return;
      }
      buffer += String(chunk);
      for (let end; (end = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (invalid) continue;
        try {
          const raw: unknown = JSON.parse(line);
          if (!ready) {
            const r = NativeWatchReadySchema.parse(raw);
            if (
              r.launcherPid !== launcherPid ||
              r.watchPid !== child.pid ||
              r.watchPid === r.launcherPid
            ) {
              fail();
              continue;
            }
            ready = true;
            send(r);
          } else if (
            raw !== null &&
            typeof raw === "object" &&
            "event" in raw &&
            raw.event === "aborting" &&
            Object.keys(raw).length === 1
          )
            send({ event: "aborting" });
          else fail();
        } catch {
          fail();
        }
      }
    });
    child.stdout?.on("error", fail);
    child.once("error", () => {
      fail();
      resolve(1);
    });
    child.once("exit", (code) => {
      if (!ready || buffer.trim()) fail();
      resolve(ready && !invalid && code === 0 ? 0 : 1);
    });
  });
}

async function main() {
  if (process.platform !== "win32" || process.argv.length !== 4)
    throw new Error("fixed_watch_launcher_only");
  const leaseFile = z.string().min(1).parse(process.argv[2]);
  if (!/^[1-9][0-9]{0,9}$/.test(process.argv[3] ?? ""))
    throw new Error("fixed_watch_parent_invalid");
  const executorPid = Number(process.argv[3]);
  // Node supports DETACHED_PROCESS; Windows PowerShell's console host does not in this deployment.
  // This launcher owns the attached PS job, independently of the original Node's lifetime.
  const child = spawn(
    watchPowerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      fileURLToPath(new URL("./host-power-windows.ps1", import.meta.url)),
      "-Action",
      "watch",
      "-LeaseFile",
      leaseFile,
      "-ExecutorPid",
      String(executorPid),
      "-WatchLauncherPid",
      String(process.pid),
    ],
    { windowsHide: true, detached: false, stdio: ["ignore", "pipe", "ignore"] },
  );
  const limit = setTimeout(() => process.exit(1), 130000);
  try {
    process.exitCode = await superviseNativeWatch(
      child,
      process.pid,
      process.stdout,
    );
  } finally {
    clearTimeout(limit);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.exitCode = 1;
  });
