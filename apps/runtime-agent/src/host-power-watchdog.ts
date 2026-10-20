import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nativeUptimeMs, type NativeOwnedWatchProcess } from "./host-power.js";
import {
  NativeWatchReadySchema,
  watchPowerShell,
} from "./host-power-watch-launcher.js";
import type { z } from "zod";
export type WatchdogLease = {
  cycleId: string;
  expiresAtUptimeMs: number;
  state: "armed" | "cancelled" | "settled_cancelled";
  executorPid?: number;
  executorStartedTicks?: string;
};
type ShutdownSubmission = {
  child?: ChildProcess;
  closed: boolean;
  close?: Promise<void>;
};
/** Fixed helper protocol: short leases can only retain/abort one normal local shutdown. */
export class NativeShutdownWatchdog {
  private child: ChildProcess | undefined;
  private lease: WatchdogLease | undefined;
  private ready: z.infer<typeof NativeWatchReadySchema> | undefined;
  private failed = false;
  private activeFile = "";
  private cancelling = false;
  private submission: ShutdownSubmission | undefined;
  constructor(
    private readonly file: string,
    private readonly launch: (file: string, pid: number) => ChildProcess = (
      file: string,
      pid: number,
    ) =>
      spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./host-power-watch-launcher.js", import.meta.url),
          ),
          file,
          String(pid),
        ],
        {
          windowsHide: true,
          detached: true,
          timeout: 135000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    private readonly uptimeMs = nativeUptimeMs,
  ) {}
  async arm(cycleId: string, notAfterUptimeMs = this.uptimeMs() + 5000) {
    if (this.child || this.lease?.cycleId === cycleId)
      throw new Error("native_watchdog_already_armed");
    const expiresAtUptimeMs = Math.min(
      this.uptimeMs() + 5000,
      notAfterUptimeMs,
    );
    if (
      !Number.isFinite(expiresAtUptimeMs) ||
      expiresAtUptimeMs <= this.uptimeMs()
    )
      throw new Error("native_watchdog_permit_expired");
    this.failed = false;
    this.cancelling = false;
    this.submission = undefined;
    this.ready = undefined;
    this.activeFile = `${this.file}.${cycleId}.json`;
    this.lease = { cycleId, expiresAtUptimeMs, state: "armed" };
    await this.write();
    const child = this.launch(this.activeFile, process.pid);
    this.child = child;
    child.once("exit", () => {
      if (
        this.child === child &&
        this.lease?.state !== "cancelled" &&
        this.lease?.state !== "settled_cancelled"
      )
        this.failed = true;
    });
    await new Promise<void>((resolve, reject) => {
      let output = "",
        bytes = 0;
      const timeout = setTimeout(
        () => reject(new Error("native_watchdog_not_ready")),
        4000,
      );
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (this.child !== child) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512) {
          this.failed = true;
          clearTimeout(timeout);
          reject(new Error("native_watchdog_output_invalid"));
          return;
        }
        output += String(chunk);
        for (let end; (end = output.indexOf("\n")) >= 0; ) {
          const line = output.slice(0, end).trim();
          output = output.slice(end + 1);
          try {
            const raw: unknown = JSON.parse(line);
            if (this.ready) {
              this.failed = true;
              continue;
            }
            const r = NativeWatchReadySchema.parse(raw);
            if (r.launcherPid !== child.pid || r.launcherPid === r.watchPid)
              throw new Error("watch_identity_invalid");
            this.ready = r;
            clearTimeout(timeout);
            resolve();
          } catch {
            this.failed = true;
            clearTimeout(timeout);
            reject(new Error("native_watchdog_output_invalid"));
          }
        }
      });
      child.once("error", () => {
        clearTimeout(timeout);
        if (this.child === child) this.failed = true;
        reject(new Error("native_watchdog_start_failed"));
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("native_watchdog_exited"));
      });
    });
    this.assertHealthy();
  }
  get leaseFile() {
    return this.activeFile;
  }
  get ownedProcesses(): readonly NativeOwnedWatchProcess[] {
    const child = this.child,
      ready = this.ready;
    if (
      !child ||
      !ready ||
      this.failed ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return [];
    return [
      {
        pid: ready.launcherPid,
        parentPid: process.pid,
        creationTicks: ready.launcherStartedTicks,
        path: process.execPath,
      },
      {
        pid: ready.watchPid,
        parentPid: ready.launcherPid,
        creationTicks: ready.watchStartedTicks,
        path: watchPowerShell,
      },
    ];
  }
  get pid() {
    return this.ownedProcesses[1]?.pid;
  }
  assertHealthy() {
    if (this.child && this.failed)
      throw new Error("native_watchdog_lease_failed");
  }
  /** Reserve the only submission before execFile is called. Its callback/error is not exit proof. */
  beginSubmission(cycleId: string): (child: ChildProcess) => void {
    this.assertHealthy();
    if (
      this.cancelling ||
      this.submission ||
      this.lease?.state !== "armed" ||
      this.lease.cycleId !== cycleId
    )
      throw new Error("native_shutdown_submission_invalid");
    const submission: ShutdownSubmission = { closed: false };
    this.submission = submission;
    return (child) => {
      if (this.submission !== submission || submission.child)
        throw new Error("native_shutdown_submission_invalid");
      submission.child = child;
      // Do not infer exit from callback, error, killed, exitCode or a timeout. Node can callback
      // before close on an error. A failed spawn also emits close, proving no later API call.
      submission.close = new Promise<void>((resolve) => {
        child.once("close", () => {
          submission.closed = true;
          resolve();
        });
      });
    };
  }
  private async submissionSettled(): Promise<boolean> {
    const submission = this.submission;
    if (!submission || submission.closed) return true; // No call was started, or close was seen.
    if (!submission.close) return false; // Spawn threw before yielding a ChildProcess: unknown.
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      void submission.close!.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
  async refresh() {
    if (this.cancelling && this.child)
      throw new Error("native_watchdog_lease_failed");
    if (
      this.lease?.state === "armed" &&
      this.uptimeMs() >= this.lease.expiresAtUptimeMs
    )
      this.failed = true;
    this.assertHealthy();
    if (this.lease?.state === "armed") {
      this.lease.expiresAtUptimeMs = this.uptimeMs() + 5000;
      await this.write();
    }
  }
  /** Serialize settlement before Abort, then publish a terminal proof; never re-arm this cycle. */
  async disarm(executorStartedTicks: string, abort: () => Promise<void>) {
    this.cancelling = true;
    const child = this.child;
    const settled = await this.submissionSettled();
    // Even an unknown submission still needs a best-effort Abort. It must not stop the helper:
    // the unresolved PowerShell could submit after this Abort has returned.
    await abort();
    if (!settled || !/^[1-9][0-9]{0,18}$/.test(executorStartedTicks))
      throw new Error("native_abort_unconfirmed");
    if (this.lease) {
      this.lease.state = "settled_cancelled";
      this.lease.executorPid = process.pid;
      this.lease.executorStartedTicks = executorStartedTicks;
      await this.write();
    }
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("native_watchdog_not_stopped")),
          2000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    if (this.child === child) this.child = undefined;
  }
  private async write() {
    // Reader treats partial/missing JSON as an unsafe lease and aborts. No permissive parse.
    const temporary = `${this.activeFile}.tmp`;
    await writeFile(temporary, JSON.stringify(this.lease), { mode: 0o600 });
    await rename(temporary, this.activeFile);
  }
}
