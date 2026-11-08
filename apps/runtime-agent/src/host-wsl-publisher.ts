/** Runs as the unchanged original ComputeNode S4U owner; no password, bearer or listener. */
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { collectHostWsl } from "./host-wsl-client.js";
import {
  wslBindingSchema,
  wslKeeperProofSchema,
  type WslKeeperProof,
} from "./host-wsl.js";
import { wslReceiptSchema } from "./host-wsl-receipt.js";
const configSchema = z
  .object({
    file: z.string(),
    ownerSid: z.string(),
    bindings: z.array(wslBindingSchema).min(1).max(16),
  })
  .strict();
async function main() {
  if (process.platform !== "win32") throw Error("windows_user_observer_only");
  const c = configSchema.parse(
    JSON.parse(await readFile(z.string().parse(process.argv[2]), "utf8")),
  );
  const ps = (s: string) =>
    new Promise<string>((resolve, reject) =>
      execFile(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(s, "utf16le").toString("base64"),
        ],
        { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 65536 },
        (e, out) =>
          e
            ? reject(Error("native_user_identity_unavailable"))
            : resolve(out.trim()),
      ),
    );
  const identity = JSON.parse(
    await ps(
      `[ordered]@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;ticks=(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`,
    ),
  );
  if (identity.sid !== c.ownerSid) throw Error("wsl_owner_context_mismatch");
  // Preserve precisely the original task's keeper, not an arbitrary user command.
  if (c.bindings[0]!.name !== "ComputeNode")
    throw Error("unsupported_keeper_distribution");
  const nativeKeeper = c.bindings[0]!.keeper;
  const keeper = spawn(
    "C:\\Windows\\System32\\wsl.exe",
    [
      "-d",
      "ComputeNode",
      "-u",
      "openclaw",
      "--cd",
      "/",
      ...(nativeKeeper
        ? [
            "--exec",
            nativeKeeper.nodeExecutable,
            posix.dirname(c.bindings[0]!.collectorPath) + "/host-wsl-keeper.js",
          ]
        : ["--", "/usr/bin/sleep", "infinity"]),
    ],
    {
      stdio: nativeKeeper ? ["pipe", "pipe", "ignore"] : "ignore",
      windowsHide: true,
    },
  );
  if (!keeper.pid) throw Error("keeper_not_started");
  let keeperProof: WslKeeperProof | undefined;
  const stopKeeper = () => (nativeKeeper ? keeper.stdin?.end() : keeper.kill());
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      stopping = true;
      stopKeeper();
    });
  try {
    if (nativeKeeper) {
      keeperProof = await new Promise<WslKeeperProof>((resolve, reject) => {
        let raw = "";
        const timer = setTimeout(() => {
          stopKeeper();
          reject(Error("keeper_handshake_timeout"));
        }, 10000);
        const fail = () => {
          clearTimeout(timer);
          reject(Error("keeper_handshake_closed"));
        };
        keeper.once("error", fail);
        keeper.once("exit", fail);
        const line = (chunk: Buffer) => {
          raw += chunk.toString("utf8");
          if (raw.length > 8192) {
            clearTimeout(timer);
            stopKeeper();
            reject(Error("keeper_handshake_limit"));
            return;
          }
          if (!raw.includes("\n")) return;
          clearTimeout(timer);
          keeper.stdout?.off("data", line);
          keeper.off("error", fail);
          keeper.off("exit", fail);
          try {
            const value = wslKeeperProofSchema.parse(JSON.parse(raw.trim()));
            if (
              value.uid !== nativeKeeper.uid ||
              value.executable !== nativeKeeper.nodeExecutable ||
              value.nodeSha256 !== nativeKeeper.nodeSha256 ||
              value.helperSha256 !== nativeKeeper.helperSha256
            )
              throw Error("keeper_identity_mismatch");
            resolve(value);
          } catch {
            stopKeeper();
            reject(Error("keeper_handshake_invalid"));
          }
        };
        keeper.stdout!.on("data", line);
      });
    }
    const ticks = await ps(
      `(Get-Process -Id ${keeper.pid}).StartTime.ToUniversalTime().Ticks.ToString()`,
    );
    await mkdir(dirname(c.file), { recursive: true });
    while (
      !stopping &&
      keeper.exitCode === null &&
      keeper.signalCode === null
    ) {
      try {
        const value = JSON.parse(
          await ps(
            `$n=@(& wsl.exe --list --running --quiet|ForEach-Object{($_ -replace "\u00600",'').Trim()}|Where-Object{$_});$r=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'|ForEach-Object{Get-ItemProperty $_.PSPath});@($n|ForEach-Object{$name=$_;$m=@($r|Where-Object{$_.DistributionName -ceq $name});if($m.Count -ne 1){throw 'registration_unknown'};@{name=$name;registrationId=([guid]$m[0].PSChildName).ToString()}})|ConvertTo-Json -Compress`,
          ),
        );
        const live = Array.isArray(value) ? value : value ? [value] : [];
        const started = new Date().toISOString();
        const workloads = await Promise.all(
          live.map(async (l: { name: string; registrationId: string }) => {
            const b = c.bindings.find(
              (b) => b.name === l.name && b.registrationId === l.registrationId,
            );
            if (!b) return null;
            try {
              return await collectHostWsl(
                b,
                b.keeper ? keeperProof : undefined,
              );
            } catch {
              return null;
            }
          }),
        );
        const receipt = wslReceiptSchema.parse({
          observedAt: started,
          producerPid: process.pid,
          producerStartedTicks: identity.ticks,
          ownerSid: c.ownerSid,
          runningDistributions: live,
          workloads,
          keeper: {
            pid: keeper.pid,
            startedTicks: ticks,
            ...(keeperProof ? { native: keeperProof } : {}),
          },
        });
        const temp = c.file + "." + process.pid + ".tmp";
        await writeFile(temp, JSON.stringify(receipt) + "\n");
        await rename(temp, c.file);
      } catch {
        /* Leave the preceding sample to expire; never publish a fresh fabricated idle. */
      }
      await delay(2000);
    }
  } finally {
    stopKeeper();
  }
}
main().catch(() => {
  process.stderr.write("wsl_user_observer_failed\n");
  process.exitCode = 1;
});
