import { setTimeout as delay } from "node:timers/promises";
import { powerExecutorHash } from "./host-power-fingerprint.js";
import { NativeShutdownWatchdog } from "./host-power-watchdog.js";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  nativeBootId,
  acquirePowerLock,
  savePowerJournal,
  saveNativePowerFailure,
  NativeBootRecordSchema,
  saveNativeShutdownAttemptFailure,
  type NativeShutdownCheckpoint,
} from "./host-power-storage.js";
import {
  HostPowerDirectiveSchema,
  type HostPowerEvent,
} from "@hitchlet/contracts/internal";
import {
  HostClient,
  HostRequestError,
  HostTransientError,
} from "./host-client.js";
import { HostObservationService } from "./host-service.js";
import { collectHostEvidence } from "./host-probes.js";
import {
  WorkloadGuardSchema,
  WorkloadInventorySchema,
  guardHash,
  workloadReasons,
  NativePowerExecutor,
  powerEvidence,
  type PowerJournal,
  runNativePowerLifecycle,
  nativePowerCommandFailure,
  nativePowerDiagnostic,
  cancelBeforeNativePowerRetry,
  type NativePowerAction,
  type NativePowerPhase,
  type NativeSafetySample,
  nativePowerEvidenceIsSafe,
  isFreshNativeSafetySample,
  nativeUptimeMs,
  type NativeOwnedWatchProcess,
} from "./host-power.js";
const configSchema = z
  .object({
    controllerOrigin: z.string().url(),
    bindingFile: z.string(),
    caFile: z.string().optional(),
    guardFile: z.string(),
    journalFile: z.string(),
    enableNormalPower: z.literal(true),
  })
  .strict();
async function privateJson(path: string) {
  const s = await stat(path);
  if (process.platform !== "win32" && (s.mode & 0o077) !== 0)
    throw new Error("power_file_permissions");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
let nativeCacheFile = "";
let executorStartedTicks = "";
let failurePhase: NativePowerPhase = "startup";
let failureJournalFile: string | undefined;
function native(
  action: NativePowerAction,
  protectedPath?: string,
  permit?: {
    notAfterUptimeMs: number;
    controllerNotAfterMs: number;
    cycleId: string;
    leaseFile: string;
  },
  ownedWatch: readonly NativeOwnedWatchProcess[] = [],
  trackSubmission?: (child: import("node:child_process").ChildProcess) => void,
): Promise<{ text: string; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./host-power-windows.ps1", import.meta.url)),
        "-Action",
        action,
        "-ExecutorPid",
        String(process.pid),
        ...(executorStartedTicks
          ? ["-ExecutorStartedTicks", executorStartedTicks]
          : []),
        ...(permit
          ? [
              "-NotAfterUptimeMs",
              String(permit.notAfterUptimeMs),
              "-ControllerNotAfterMs",
              String(permit.controllerNotAfterMs),
              "-CycleId",
              permit.cycleId,
              "-LeaseFile",
              permit.leaseFile,
            ]
          : []),
        ...(nativeCacheFile ? ["-CacheFile", nativeCacheFile] : []),
        ...(ownedWatch.length === 2
          ? [
              "-WatchLauncherPid",
              String(ownedWatch[0]!.pid),
              "-WatchLauncherStartedTicks",
              ownedWatch[0]!.creationTicks,
              "-WatchHelperPid",
              String(ownedWatch[1]!.pid),
              "-WatchHelperStartedTicks",
              ownedWatch[1]!.creationTicks,
            ]
          : []),
        ...(protectedPath ? ["-ProtectedPath", protectedPath] : []),
      ],
      {
        shell: false,
        timeout: action === "inventory" ? 60000 : 15000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (e, stdout) =>
        e
          ? reject(nativePowerCommandFailure(action, e))
          : resolve({ text: stdout, pid: child.pid ?? -1 }),
    );
    trackSubmission?.(child);
    child.stdin?.end();
  });
}
async function main() {
  if (process.argv[2] === "executor-hash") {
    process.stdout.write((await powerExecutorHash()) + "\n");
    return;
  }
  if (process.argv[2] === "guard-hash") {
    process.stdout.write(
      guardHash(
        WorkloadGuardSchema.parse(
          await privateJson(z.string().parse(process.argv[3])),
        ),
      ) + "\n",
    );
    return;
  }
  if (process.platform !== "win32")
    throw new Error("native_windows_power_only");
  if (process.argv[2] === "inventory") {
    nativeCacheFile = process.argv[3] ?? "";
    process.stdout.write((await native("inventory")).text);
    return;
  }
  const configPath =
    process.env.HITCHLET_HOST_POWER_CONFIG ??
    (process.argv[2] === "run" ? process.argv[3] : undefined);
  if (!configPath) throw new Error("explicit_power_config_required");
  failurePhase = "config";
  const config = configSchema.parse(await privateJson(configPath)),
    guard = WorkloadGuardSchema.parse(await privateJson(config.guardFile));
  failurePhase = "permissions";
  for (const file of [
    configPath,
    config.bindingFile,
    config.guardFile,
    dirname(config.journalFile),
    fileURLToPath(new URL("./host-power-windows.ps1", import.meta.url)),
  ])
    await native("permissions", file);
  // No diagnostic file is written until the configured installation/directory boundary is trusted.
  failureJournalFile = config.journalFile;
  nativeCacheFile = `${config.journalFile}.inventory-cache.json`;
  failurePhase = "boot";
  const boot = NativeBootRecordSchema.extend({
    executorStartedTicks: z.string().regex(/^[0-9]+$/),
  }).parse(JSON.parse((await native("boot")).text));
  executorStartedTicks = boot.executorStartedTicks;
  const bootId = nativeBootId(boot.bootRecordId, boot.bootTime);
  failurePhase = "config";
  const binding = z
    .object({
      agentId: z.string().uuid(),
      machineId: z.string().uuid(),
      installationId: z.string().uuid(),
      credential: z.string().regex(/^hch_[A-Za-z0-9_-]{43}$/),
    })
    .strict()
    .parse(await privateJson(config.bindingFile));
  const client = new HostClient(
    new URL(config.controllerOrigin),
    config.caFile ? await readFile(config.caFile) : undefined,
    4000,
  );
  failurePhase = "artifact";
  const hash = guardHash(guard),
    executorHash = await powerExecutorHash();
  const watchdog = new NativeShutdownWatchdog(
    `${config.journalFile}.watchdog-lease.json`,
  );
  let latestSafetySample: NativeSafetySample | null = null;
  async function collect() {
    // An interrupted/failed sample cannot leave an older safety result reusable.
    latestSafetySample = null;
    const startedAtMonotonicMs = nativeUptimeMs();
    const ownedWatch = watchdog.ownedProcesses;
    const i = await native("inventory", undefined, undefined, ownedWatch),
      e = await collectHostEvidence("win32");
    const inventory = WorkloadInventorySchema.parse(JSON.parse(i.text));
    if (nativeBootId(inventory.bootRecordId, inventory.bootTime) !== bootId)
      throw new Error("native_boot_evidence_changed");
    const reasons = workloadReasons(
      guard,
      inventory,
      process.pid,
      i.pid,
      ownedWatch,
    );
    if ((await powerExecutorHash()) !== executorHash)
      reasons.push("executor_artifact_changed");
    const evidence = powerEvidence(e, reasons.length === 0);
    latestSafetySample = {
      safe: nativePowerEvidenceIsSafe(evidence),
      startedAtMonotonicMs,
    };
    return evidence;
  }
  async function check() {
    // Prepare and commit each call this independently; steady observation never replaces their checks.
    await collect();
    return isFreshNativeSafetySample(latestSafetySample, nativeUptimeMs());
  }
  const journalSchema = z
    .object({
      bootEvidence: z.literal("system-event-v1"),
      bootId: z.string().uuid(),
      cycleId: z.string().uuid(),
      token: z.string().uuid().nullable(),
      expiresAtUptimeMs: z.number().int().nonnegative(),
      state: z.enum([
        "prepared",
        "executing",
        "accepted",
        "cancelled",
        "unknown",
      ]),
      machineEpoch: z.number().int().positive(),
      cancelReportPending: z.boolean().default(false),
    })
    .strict();
  const executor = new NativePowerExecutor({
    load: async () => {
      try {
        return journalSchema.parse(await privateJson(config.journalFile));
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT")
          return null;
        throw e;
      }
    },
    save: async (j: PowerJournal) => savePowerJournal(config.journalFile, j),
    bootId,
    check,
    shutdown: async ({ notAfterUptimeMs, controllerNotAfterMs, cycleId }) => {
      const started = nativeUptimeMs(),
        checkpoints: NativeShutdownCheckpoint[] = [];
      let phase: NativeShutdownCheckpoint["phase"] = "watch_arm";
      const snapshot = (): NativeShutdownCheckpoint => ({
        phase,
        elapsedMs: nativeUptimeMs() - started,
        remainingUptimeMs: notAfterUptimeMs - nativeUptimeMs(),
        controllerRemainingMs: controllerNotAfterMs - Date.now(),
      });
      try {
        await watchdog.arm(cycleId, notAfterUptimeMs);
        checkpoints.push(snapshot());
        phase = "preflight";
        if (
          nativeUptimeMs() >= notAfterUptimeMs ||
          Date.now() >= controllerNotAfterMs
        )
          throw new Error("prepared_window_expired");
        watchdog.assertHealthy();
        checkpoints.push(snapshot());
        phase = "native_shutdown";
        const trackSubmission = watchdog.beginSubmission(cycleId);
        const result = await native(
          "shutdown",
          undefined,
          {
            notAfterUptimeMs,
            controllerNotAfterMs,
            cycleId,
            leaseFile: watchdog.leaseFile,
          },
          [],
          trackSubmission,
        );
        z.object({ accepted: z.literal(true) })
          .strict()
          .parse(JSON.parse(result.text));
      } catch (error) {
        // Keep the first failing attempt independent of later abort/disarm failures. No diagnostic I/O
        // runs before the API path settles, and failed logging cannot replace its original error.
        await saveNativeShutdownAttemptFailure(config.journalFile, {
          at: new Date().toISOString(),
          cycleId,
          code: nativePowerDiagnostic("shutdown", error).code,
          ...snapshot(),
          checkpoints,
        }).catch(() => {});
        throw error;
      }
    },
    abort: async () => {
      await watchdog.disarm(executorStartedTicks, async () => {
        const result = z
          .object({ accepted: z.boolean() })
          .parse(JSON.parse((await native("abort")).text));
        if (!result.accepted) throw new Error("native_abort_unconfirmed");
      });
    },
  });
  const observation = new HostObservationService(
    binding,
    client,
    collect,
    Date.now,
    bootId,
  );
  let stopped = false;
  const stopSignal = new AbortController();
  const stop = () => {
    stopped = true;
    stopSignal.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const wait = async (milliseconds: number) => {
    try {
      await delay(milliseconds, undefined, { signal: stopSignal.signal });
    } catch (error) {
      if (!stopped) throw error;
    }
  };
  try {
    failurePhase = "journal";
    const releaseLock = await acquirePowerLock(config.journalFile, bootId);
    await runNativePowerLifecycle({
      executor,
      observation: {
        initialize: async () => {
          failurePhase = "bootstrap";
          await observation.initialize();
        },
      },
      releaseLock: async () => {
        try {
          await releaseLock();
        } catch (error) {
          failurePhase = "cleanup";
          throw error;
        }
      },
      stopped: () => stopped,
      wait,
      onTransient: () =>
        process.stderr.write(
          JSON.stringify({
            phase: "bootstrap",
            code: "controller_unavailable",
          }) + "\n",
        ),
      run: async () => {
        while (!stopped) {
          try {
            failurePhase = "observation";
            if (!(await observation.tick())) {
              latestSafetySample = null;
              await executor.abort();
              if (!stopped) await wait(1000);
              continue;
            }
            await executor.watchdog(latestSafetySample);
            failurePhase = "session";
            const s = await client.session(binding.agentId, binding.credential);
            if (!s.bootId) throw new Error("power_session_missing");
            let event: HostPowerEvent = {
              ...(executor.pendingCancellation() ?? { event: "poll" as const }),
              bootId: s.bootId,
              osBootId: bootId,
              controllerEpoch: s.controllerEpoch,
              sessionEpoch: s.sessionEpoch,
              guardHash: hash,
              executorHash,
              powerProtocolVersion: 1,
            };
            failurePhase = "power";
            for (let step = 0; step < 3; step++) {
              const d = HostPowerDirectiveSchema.parse(
                await client
                  .request(
                    `/v1/agents/${binding.agentId}/power`,
                    event,
                    binding.credential,
                  )
                  .catch((error: unknown) => {
                    if (
                      error instanceof HostRequestError &&
                      error.status === 409
                    )
                      throw new HostTransientError();
                    throw error;
                  }),
              );
              // A lost response keeps this fact durable. Only this valid none response acknowledges
              // its exact original cycle; a different directive must not clear it.
              if (event.event === "cancelled" && event.cycleId)
                await executor.acknowledgeCancellation(event.cycleId, d);
              // New local evidence and a controller response are both required before renewing.
              // A commit replaces latestSafetySample with its own independent, newer collection.
              await executor.watchdog(latestSafetySample);
              await watchdog.refresh();
              const result = await executor.directive(d);
              if (!result) break;
              event = { ...event, ...result };
            }
          } catch (error) {
            await cancelBeforeNativePowerRetry(error, () => executor.abort());
            process.stderr.write(
              JSON.stringify(nativePowerDiagnostic(failurePhase, error)) + "\n",
            );
          }
          if (!stopped) await wait(1000);
        }
      },
    });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
void main().catch(async (error: unknown) => {
  const diagnostic = nativePowerDiagnostic(failurePhase, error);
  process.stderr.write(JSON.stringify(diagnostic) + "\n");
  if (failureJournalFile) {
    // Diagnostic I/O cannot supersede the original failure or change lock/abort responsibility.
    await saveNativePowerFailure(failureJournalFile, diagnostic).catch(
      () => {},
    );
  }
  process.exitCode = 1;
});
