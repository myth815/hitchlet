import { readFile, readlink, readdir } from "node:fs/promises";
import {
  runtimeWorkloadRequestSchema,
  runtimeWorkloadResultSchema,
  runtimeNativeWorkloadSchema,
  runtimeBackgroundServiceSchema,
  runtimeNativeContextSchema,
  type RuntimeNativeContext,
  type RuntimeWorkloadRequest,
  type RuntimeNativeWorkload,
  type RuntimeContainerWorkload,
  type RuntimeBackgroundService,
} from "@hitchlet/contracts/internal";
import { FileJournal } from "./journal.js";
import { runFixedCommand, withCommandDeadline } from "./command-exec.js";

/** No argv, environment, home files or file contents enter workload evidence. */
export async function collectLinuxWorkloads(
  services: readonly RuntimeBackgroundService[] = [],
  deadline = Date.now() + 5000,
  expectedContext?: RuntimeNativeContext,
): Promise<RuntimeNativeWorkload> {
  const result: RuntimeNativeWorkload = {
    complete: true,
    distributionMachineId: null,
    bootId: null,
    namespaces: null,
    processes: [],
    backgroundPids: [],
    errorCodes: [],
  };
  try {
    const [machine, boot, pid, user, mount, network, init] = await Promise.all([
      readFile("/etc/machine-id", "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readlink("/proc/self/ns/pid"),
      readlink("/proc/self/ns/user"),
      readlink("/proc/self/ns/mnt"),
      readlink("/proc/self/ns/net"),
      readlink("/proc/1/exe"),
    ]);
    result.distributionMachineId = machine.trim();
    result.bootId = boot.trim();
    result.namespaces = { pid, user, mount, network };
    const context = runtimeNativeContextSchema.safeParse(expectedContext);
    if (!context.success)
      result.errorCodes.push("distribution_context_unbound");
    else if (
      context.data.distributionMachineId !== machine.trim() ||
      context.data.bootId !== boot.trim() ||
      context.data.pidNamespace !== pid
    )
      result.errorCodes.push("distribution_context_changed");
    // A container-local proc view cannot attest the distribution's native work.
    const status = await readFile("/proc/1/status", "utf8");
    if (
      !/^NSpid:\s+1\s*$/m.test(status) ||
      !["/init", "/usr/lib/systemd/systemd", "/lib/systemd/systemd"].includes(
        init,
      )
    )
      result.errorCodes.push("distribution_pid_view_unproven");
    const entries = (await readdir("/proc")).filter((p) =>
      /^[1-9]\d*$/.test(p),
    );
    if (entries.length > 8192) throw Error("native_inventory_limit");
    for (const entry of entries) {
      if (Date.now() >= deadline) throw Error("native_inventory_timeout");
      const path = `/proc/${entry}`;
      try {
        const before = await readFile(`${path}/stat`, "utf8");
        const fields = before
          .slice(before.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/);
        const status = await readFile(`${path}/status`, "utf8");
        const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
        const executable = await readlink(`${path}/exe`).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw e;
          },
        );
        const groups = await readFile(`${path}/cgroup`, "utf8");
        const unit =
          groups
            .split(/[\/\n]/)
            .findLast((part) => part.endsWith(".service")) ?? null;
        const afterExecutable = await readlink(`${path}/exe`).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw e;
          },
        );
        const after = await readFile(`${path}/stat`, "utf8");
        const afterFields = after
          .slice(after.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/);
        if (fields[19] !== afterFields[19] || executable !== afterExecutable)
          throw Error("native_process_identity_changed");
        result.processes.push({
          pid: Number(entry),
          parentPid: Number(fields[1]),
          uid,
          startTicks: fields[19]!,
          executable,
          unit,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // actually exited
        result.errorCodes.push("native_process_unverifiable");
      }
    }
    for (const raw of services) {
      const service = runtimeBackgroundServiceSchema.parse(raw);
      const { stdout } = await runFixedCommand(
        "systemctl",
        [
          ...(service.userService
            ? [
                "--user",
                // The native observer may be root while the daemon belongs to an
                // existing user's systemd manager. Never query root's bus instead.
                ...(process.getuid?.() !== service.uid
                  ? [`--machine=${service.uid}@.host`]
                  : []),
              ]
            : []),
          "show",
          service.unit,
          "--property=MainPID,ActiveState",
        ],
        { maxBuffer: 4096 },
      );
      const main = Number(stdout.match(/^MainPID=(\d+)$/m)?.[1]);
      const mainProcess = result.processes.find((p) => p.pid === main);
      if (
        /^ActiveState=active$/m.test(stdout) &&
        mainProcess?.unit === service.unit &&
        mainProcess.uid === service.uid &&
        mainProcess.executable === service.executable
      ) {
        // A service may restart/exec between process enumeration and systemctl.
        const live = await readFile(`/proc/${main}/stat`, "utf8");
        const startTicks = live
          .slice(live.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/)[19];
        if (
          startTicks !== mainProcess.startTicks ||
          (await readlink(`/proc/${main}/exe`)) !== mainProcess.executable
        )
          result.errorCodes.push("native_service_identity_changed");
        else result.backgroundPids.push(main);
      }
      // Only the actual MainPID is background. Sessions/jobs spawned by that service are not.
    }
    const initProcess = result.processes.find((p) => p.pid === 1);
    if (
      initProcess?.uid === 0 &&
      initProcess.executable === init &&
      !result.errorCodes.includes("distribution_pid_view_unproven")
    )
      result.backgroundPids.push(1);
    // New work that began after the first /proc walk must be observed next time,
    // never silently omitted from an otherwise "complete" sample.
    const finalPids = (await readdir("/proc")).filter((p) =>
      /^[1-9]\d*$/.test(p),
    );
    if (finalPids.some((p) => !entries.includes(p)))
      result.errorCodes.push("native_process_set_changed");
    if (Date.now() >= deadline)
      result.errorCodes.push("native_inventory_timeout");
  } catch {
    result.errorCodes.push("native_inventory_unavailable");
  }
  result.errorCodes = [...new Set(result.errorCodes)].slice(0, 32);
  result.complete = result.errorCodes.length === 0;
  const parsed = runtimeNativeWorkloadSchema.safeParse(result);
  return parsed.success
    ? parsed.data
    : {
        complete: false,
        distributionMachineId: null,
        bootId: null,
        namespaces: null,
        processes: [],
        backgroundPids: [],
        errorCodes: ["native_inventory_invalid"],
      };
}

/** The same journal queue fences network lifecycle commands and this read-only observation. */
export class RuntimeWorkloadFacts {
  constructor(
    private readonly identity: Omit<RuntimeWorkloadRequest, "requestId">,
    private readonly engine: {
      workloadInventory(): Promise<{
        complete: boolean;
        containers: RuntimeContainerWorkload[];
      }>;
    },
    private readonly journal: FileJournal,
    private readonly native = collectLinuxWorkloads,
    private readonly services: readonly RuntimeBackgroundService[] = [],
    private readonly now = Date.now,
    private readonly selfPid = process.pid,
  ) {}

  inspect(input: RuntimeWorkloadRequest) {
    const request = runtimeWorkloadRequestSchema.parse(input);
    if (
      Object.entries(this.identity).some(
        ([key, value]) =>
          request[key as keyof RuntimeWorkloadRequest] !== value,
      )
    )
      throw Error("Workload Runtime identity mismatch");
    return this.journal.serialize(() =>
      withCommandDeadline(this.now() + 5000, async () => {
        const started = this.now();
        const containers = await this.engine.workloadInventory();
        const native = runtimeNativeWorkloadSchema.parse(
          await this.native(this.services, started + 5000),
        );
        const pendingCommandCount = Object.values(
          this.journal.commandMap,
        ).filter((c) => !c.result || c.result.status === "unknown").length;
        const retainedAllocationCount = Object.values(
          this.journal.allocationMap,
        ).filter((a) => a.state !== "removed").length;
        const background = new Set(native.backgroundPids);
        const unapprovedProcessCount = native.processes.filter(
          (p) => p.pid !== this.selfPid && !background.has(p.pid),
        ).length;
        const reasons = [...native.errorCodes];
        if (!containers.complete) reasons.push("container_inventory_changed");
        if (pendingCommandCount) reasons.push("pending_runtime_commands");
        if (retainedAllocationCount)
          reasons.push("retained_runtime_allocations");
        if (unapprovedProcessCount) reasons.push("unapproved_native_processes");
        if (
          containers.containers.some(
            (c) =>
              c.installationId === this.identity.installationId &&
              c.runtimeIdentityId === this.identity.runtimeIdentityId,
          )
        )
          reasons.push("owned_container_resources_present");
        if (
          containers.containers.some(
            (c) =>
              (c.running || c.paused) &&
              (c.installationId !== this.identity.installationId ||
                c.runtimeIdentityId !== this.identity.runtimeIdentityId),
          )
        )
          reasons.push("unmanaged_active_containers");
        const complete =
          containers.complete && native.complete && this.now() - started < 5000;
        if (this.now() - started >= 5000)
          reasons.push("workload_sample_timeout");
        return runtimeWorkloadResultSchema.parse({
          ...request,
          observedAt: new Date(started).toISOString(),
          controllerEpoch: this.journal.epoch,
          complete,
          workloadState:
            !complete || pendingCommandCount
              ? "unknown"
              : reasons.length
                ? "busy"
                : "idle",
          containers: containers.containers,
          native,
          pendingCommandCount,
          retainedAllocationCount,
          backgroundProcessCount: background.size,
          unapprovedProcessCount,
          reasons: [...new Set(reasons)],
        });
      }),
    );
  }
}
