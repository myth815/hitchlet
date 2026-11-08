import {
  wslReceiptPolicySchema,
  validateWslReceipt,
  type wslReceiptSchema,
} from "./host-wsl-receipt.js";
import { HostRequestError, isTransientHostFailure } from "./host-client.js";
import {
  assessOwnWslObservers,
  type ObserverArtifacts,
} from "./host-power-observer.js";
import { createHash, randomUUID } from "node:crypto";
import { uptime } from "node:os";
import { z } from "zod";
import { NativeBootRecordSchema } from "./host-power-storage.js";
import {
  wslBindingSchema,
  runningWslSchema,
  wslWorkloadReasons,
} from "./host-wsl.js";
import type {
  HostPowerDirective,
  HostPowerEvent,
  HostSnapshot,
} from "@hitchlet/contracts/internal";

export type NativePowerPhase =
  | "startup"
  | "config"
  | "permissions"
  | "boot"
  | "inventory"
  | "artifact"
  | "journal"
  | "bootstrap"
  | "observation"
  | "session"
  | "power"
  | "shutdown"
  | "abort"
  | "cleanup";
export type NativePowerAction =
  | "inventory"
  | "boot"
  | "permissions"
  | "shutdown"
  | "abort";
type NativeCommandCode =
  | "inventory_timeout"
  | "inventory_unavailable"
  | "inventory_permission_denied"
  | "inventory_cache_failed"
  | "native_executable_missing"
  | "native_execution_denied"
  | "native_output_limit"
  | "shutdown_permit_expired_or_parent_lost"
  | "shutdown_watchdog_lease_invalid"
  | "shutdown_privilege_unavailable"
  | "shutdown_os_rejected"
  | "shutdown_timeout"
  | "native_command_failed";
export type NativePowerDiagnostic = {
  phase: NativePowerPhase;
  code:
    | NativeCommandCode
    | "controller_unavailable"
    | "host_auth_rejected"
    | "host_http_rejected"
    | "schema_invalid"
    | "json_invalid"
    | "file_missing"
    | "file_access_denied"
    | "process_lock_held"
    | "abort_unconfirmed"
    | "host_session_fenced"
    | "host_transport_permanent"
    | "boot_evidence_changed"
    | "prepared_window_expired"
    | "watchdog_not_ready"
    | "watchdog_exited"
    | "watchdog_identity_invalid"
    | "watchdog_lease_failed"
    | "unexpected_failure";
};
/** A fixed native helper result; never retain its argv, stderr or raw Error in diagnostics. */
class NativePowerCommandError extends Error {
  constructor(
    readonly action: NativePowerAction,
    readonly code: NativeCommandCode,
  ) {
    super(code);
  }
}
export function nativePowerCommandFailure(
  action: NativePowerAction,
  error: unknown,
): Error {
  const e = error !== null && typeof error === "object" ? error : {};
  const code = "code" in e ? e.code : undefined;
  if (action === "inventory") {
    // Only these reserved helper exits denote sampling failure. Ordinary PS exit=1 stays fatal.
    if (code === 70)
      return new NativePowerCommandError(action, "inventory_unavailable");
    if (code === 71)
      return new NativePowerCommandError(action, "inventory_permission_denied");
    if (code === 72)
      return new NativePowerCommandError(action, "inventory_cache_failed");
    if (
      code === null &&
      "killed" in e &&
      e.killed === true &&
      "signal" in e &&
      e.signal === "SIGTERM"
    )
      return new NativePowerCommandError(action, "inventory_timeout");
  }
  if (action === "shutdown") {
    const known = {
      73: "shutdown_permit_expired_or_parent_lost",
      74: "shutdown_watchdog_lease_invalid",
      75: "shutdown_privilege_unavailable",
      76: "shutdown_os_rejected",
    } as const;
    if (
      typeof code === "number" &&
      (code === 73 || code === 74 || code === 75 || code === 76)
    )
      return new NativePowerCommandError(action, known[code]);
    if (
      code === null &&
      "killed" in e &&
      e.killed === true &&
      "signal" in e &&
      e.signal === "SIGTERM"
    )
      return new NativePowerCommandError(action, "shutdown_timeout");
  }
  return new NativePowerCommandError(
    action,
    code === "ENOENT"
      ? "native_executable_missing"
      : code === "EACCES" || code === "EPERM"
        ? "native_execution_denied"
        : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "native_output_limit"
          : "native_command_failed",
  );
}
export function isTransientNativeSamplingFailure(error: unknown): boolean {
  return (
    error instanceof NativePowerCommandError &&
    error.action === "inventory" &&
    ["inventory_timeout", "inventory_unavailable"].includes(error.code)
  );
}
/** Cancel local permits before retrying a failed observation; an unknown abort never becomes retryable. */
export async function cancelBeforeNativePowerRetry(
  error: unknown,
  abort: () => Promise<void>,
) {
  await abort();
  if (
    !isTransientHostFailure(error) &&
    !isTransientNativeSamplingFailure(error)
  )
    throw error;
}
export function nativePowerDiagnostic(
  phase: NativePowerPhase,
  error: unknown,
): NativePowerDiagnostic {
  if (error instanceof NativePowerCommandError)
    return { phase: error.action, code: error.code };
  if (isTransientHostFailure(error))
    return { phase, code: "controller_unavailable" };
  if (error instanceof HostRequestError)
    return {
      phase,
      code: [401, 403].includes(error.status)
        ? "host_auth_rejected"
        : "host_http_rejected",
    };
  if (error instanceof z.ZodError) return { phase, code: "schema_invalid" };
  if (error instanceof SyntaxError) return { phase, code: "json_invalid" };
  if (error instanceof Error) {
    if (error.message === "prepared_window_expired")
      return { phase: "shutdown", code: "prepared_window_expired" };
    if (error.message === "native_watchdog_not_ready")
      return { phase, code: "watchdog_not_ready" };
    if (
      error.message === "native_watchdog_exited" ||
      error.message === "native_watchdog_start_failed"
    )
      return { phase, code: "watchdog_exited" };
    if (error.message === "native_watchdog_output_invalid")
      return { phase, code: "watchdog_identity_invalid" };
    if (error.message === "native_watchdog_lease_failed")
      return { phase, code: "watchdog_lease_failed" };
    if (
      error.message === "native_shutdown_cancellation_unknown" ||
      error.message === "native_abort_unconfirmed"
    )
      return { phase: "abort", code: "abort_unconfirmed" };
    if (error.message === "host_session_fenced")
      return { phase, code: "host_session_fenced" };
    if (error.message === "host_request_failed")
      return { phase, code: "host_transport_permanent" };
    if (error.message === "native_boot_evidence_changed")
      return { phase: "boot", code: "boot_evidence_changed" };
    if ("code" in error) {
      if (error.code === "ENOENT") return { phase, code: "file_missing" };
      if (error.code === "EACCES" || error.code === "EPERM")
        return { phase, code: "file_access_denied" };
      if (error.code === "EEXIST") return { phase, code: "process_lock_held" };
    }
  }
  return { phase, code: "unexpected_failure" };
}

/** SCM names are compared as data, never interpolated into a command. Preserve exact spelling. */
const serviceNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\\u0000-\u001f\u007f-\u009f]+$/)
  .refine((name) => name.trim().length > 0, "Service name must not be blank");

const hostedLibrarySchema = z
  .object({
    path: z.string().regex(/^[a-zA-Z]:\\/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    signerThumbprint: z.string().regex(/^[A-Fa-f0-9]{40}$/),
    entryPoint: z.string().regex(/^[A-Za-z_][A-Za-z0-9_@]*$/),
  })
  .strict();

/** Exact task definition and action identity, never a publisher-wide exemption. */
const reviewedTaskSchema = z
  .object({
    path: z.string().startsWith("\\").max(1024),
    definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    principalId: z.string().min(1).max(256),
    actionKind: z.enum(["exec", "com"]),
    executable: z.string().regex(/^[a-zA-Z]:\\/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    signerThumbprint: z.string().regex(/^[A-Fa-f0-9]{40}$/),
  })
  .strict();

/** Local operator approves a finite service baseline; arbitrary workload executables are unsupported. */
export const WorkloadGuardSchema = z
  .object({
    version: z.literal(1),
    acknowledgement: z.literal(
      "Only reviewed Windows system services run; all other work is stopped",
    ),
    systemExecutables: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9_.-]+\.exe$/i),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    systemServices: z.array(serviceNameSchema).max(256),
    signedWindowsServiceHelpers: z.boolean().default(false),
    reviewedServices: z
      .array(
        z
          .object({
            serviceName: serviceNameSchema,
            path: z.string().regex(/^[a-zA-Z]:\\/),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            signerThumbprint: z.string().regex(/^[A-Fa-f0-9]{40}$/),
            hostedLibrary: hostedLibrarySchema.optional(),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    reviewedTasks: z.array(reviewedTaskSchema).max(64).default([]),
    wslDistributions: z.array(wslBindingSchema).max(16).default([]),
    wslObservation: wslReceiptPolicySchema.optional(),
    agentTask: z
      .object({
        path: z.string().startsWith("\\"),
        executable: z.string(),
        arguments: z.string(),
      })
      .strict()
      .optional(),
    /** The installed, ACL-protected Hitchlet Node binary also runs the supervisor and Runtime. */
    ownedRuntime: z
      .object({
        executable: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkloadGuard = z.infer<typeof WorkloadGuardSchema>;
export const guardHash = (g: WorkloadGuard) => {
  const { reviewedTasks, wslDistributions, wslObservation, ...legacy } = g;
  return createHash("sha256")
    .update(
      JSON.stringify(
        reviewedTasks.length || wslDistributions.length || wslObservation
          ? g
          : legacy,
      ),
    )
    .digest("hex");
};
const NativeObserverProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().nonnegative(),
    creationTicks: z.string().regex(/^[0-9]+$/),
    role: z.enum([
      "powershell",
      "wsl_system",
      "wsl_store",
      "wsl_host",
      "conhost",
    ]),
    status: z.enum(["stable", "exited", "changed", "unavailable"]),
    ownerSid: z
      .string()
      .regex(/^S-1-5-[0-9-]+$/)
      .nullable(),
    imageSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    argvSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    argc: z.number().int().nonnegative().max(64),
    wslHostArguments: z
      .object({
        shapeMatches: z.boolean(),
        distributionMatches: z.boolean(),
        vmGuidSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const NativeObserverDiagnosticSchema = z
  .object({
    producerPid: z.number().int().positive(),
    producerCreationTicks: z.string().regex(/^[0-9]+$/),
    chain: z.array(NativeObserverProcessSchema).min(1).max(4),
    keeperReference: z
      .object({
        pid: z.number().int().positive(),
        creationTicks: z.string().regex(/^[0-9]+$/),
        vmGuidSha256: z.string().regex(/^[a-f0-9]{64}$/),
        chain: z.array(NativeObserverProcessSchema).length(3),
      })
      .strict()
      .optional(),
  })
  .strict();
export type NativeObserverDiagnostic = z.infer<
  typeof NativeObserverDiagnosticSchema
>;
export const WorkloadInventorySchema = NativeBootRecordSchema.extend({
  complete: z.boolean(),
  reconciliation: z
    .object({
      completeBefore: z.boolean(),
      completeAfter: z.boolean(),
      diagnosticCount: z.number().int().nonnegative(),
    })
    .strict()
    .optional()
    .catch(undefined),
  observerCandidates: z
    .array(NativeObserverDiagnosticSchema)
    .max(32)
    .optional()
    .catch(undefined),
  diagnostics: z
    .array(
      z
        .object({
          kind: z.enum([
            "process_identity_changed",
            "live_read_failed",
            "new_instance",
            "enumeration_failed",
          ]),
          pid: z.number().int().nonnegative(),
          name: z.string().max(260),
          parentPid: z.number().int().nonnegative(),
          stage: z.string().max(64).optional(),
          code: z.string().max(256).optional(),
          // Optional telemetry cannot invalidate the original safety inventory.
          observer: NativeObserverDiagnosticSchema.optional().catch(undefined),
        })
        .strict(),
    )
    .max(256)
    .optional(),
  wslRunning: z.boolean(),
  runningDistributions: z.array(runningWslSchema).max(16).default([]),
  localWslEnumerationComplete: z.boolean().default(true),
  runningTasks: z.array(
    z
      .object({
        path: z.string(),
        executable: z.string(),
        arguments: z.string(),
        definitionSha256: z.string().default(""),
        principalId: z.string().default(""),
        actionKind: z
          .enum(["exec", "com", "unsupported"])
          .default("unsupported"),
        actionPath: z.string().default(""),
        actionSha256: z.string().default(""),
        actionSignerThumbprint: z.string().default(""),
        enginePid: z.number().int().nonnegative().default(0),
        loadedActionVerified: z.boolean().default(false),
      })
      .strict(),
  ),
  processes: z.array(
    z
      .object({
        pid: z.number().int(),
        parentPid: z.number().int(),
        ownerSid: z.string().default(""),
        name: z.string(),
        path: z.string(),
        sha256: z.string(),
        microsoftSigned: z.boolean(),
        signerThumbprint: z.string(),
        hostedLibrary: hostedLibrarySchema.nullable().optional(),
        creationTicks: z
          .string()
          .regex(/^[0-9]*$/)
          .default(""),
      })
      .strict(),
  ),
  services: z.array(
    z.object({ name: z.string(), pid: z.number().int() }).strict(),
  ),
}).strict();
export type NativeOwnedWatchProcess = {
  pid: number;
  parentPid: number;
  creationTicks: string;
  path: string;
};
export type WorkloadInventory = z.infer<typeof WorkloadInventorySchema>;
export function workloadReasons(
  g: WorkloadGuard,
  raw: unknown,
  selfPid: number,
  probePid: number,
  ownedWatch: readonly NativeOwnedWatchProcess[] = [],
  wslEvidence?: unknown,
  now = Date.now(),
  observerArtifacts?: ObserverArtifacts,
) {
  const parsed = WorkloadInventorySchema.safeParse(raw);
  if (!parsed.success) return ["workload_inventory_invalid"];
  const i = parsed.data,
    reasons: string[] = [];
  const [launcher, watch] = ownedWatch;
  const watchChain =
    ownedWatch.length === 2 &&
    launcher?.parentPid === selfPid &&
    watch?.parentPid === launcher.pid &&
    launcher.pid !== watch.pid;
  const matchesWatch = (
    p: (typeof i.processes)[number],
    h: NativeOwnedWatchProcess,
  ) =>
    h.pid === p.pid &&
    h.parentPid === p.parentPid &&
    h.path.toLowerCase() === p.path.toLowerCase() &&
    p.creationTicks.endsWith("0") &&
    p.creationTicks.length === h.creationTicks.length &&
    p.creationTicks.slice(0, -1) === h.creationTicks.slice(0, -1);
  if (
    ownedWatch.length > 0 &&
    (!watchChain ||
      !ownedWatch.every((h) => i.processes.some((p) => matchesWatch(p, h))))
  )
    reasons.push("owned_watch_identity_unproven");
  let receipt: z.infer<typeof wslReceiptSchema> | undefined;
  if (i.wslRunning && g.wslObservation) {
    try {
      receipt = validateWslReceipt(
        wslEvidence,
        g.wslObservation,
        i,
        g.ownedRuntime,
        now,
      );
      i.runningDistributions = receipt.runningDistributions;
      wslEvidence = receipt.workloads;
    } catch {
      reasons.push("wsl_receipt_invalid");
      wslEvidence = undefined;
    }
  }
  const observers = assessOwnWslObservers(g, i, receipt, observerArtifacts);
  if (!i.complete && !observers.reconcilerOnlyObservers)
    reasons.push("workload_inventory_incomplete");
  const wslReasons = i.wslRunning
    ? wslWorkloadReasons(
        g.wslDistributions,
        i.runningDistributions,
        wslEvidence,
        now,
      )
    : [];
  if (i.wslRunning && wslReasons.length)
    reasons.push("running_wsl_workload", ...wslReasons);
  const reviewedTask = (t: (typeof i.runningTasks)[number]) =>
    (receipt !== undefined &&
      t.path === g.wslObservation?.producerTask &&
      t.enginePid === receipt.producerPid) ||
    g.reviewedTasks.some(
      (r) =>
        r.path === t.path &&
        r.definitionSha256 === t.definitionSha256 &&
        r.principalId === t.principalId &&
        r.actionKind === t.actionKind &&
        r.executable.toLowerCase() === t.actionPath.toLowerCase() &&
        r.sha256 === t.actionSha256 &&
        r.signerThumbprint.toLowerCase() ===
          t.actionSignerThumbprint.toLowerCase() &&
        t.enginePid > 4 &&
        t.loadedActionVerified &&
        i.processes.some(
          (p) =>
            p.pid === t.enginePid &&
            (t.actionKind === "com"
              ? p.name.toLowerCase() === "taskhostw.exe" &&
                p.microsoftSigned &&
                /^[a-z]:\\windows\\/i.test(p.path)
              : p.path.toLowerCase() === r.executable.toLowerCase() &&
                p.sha256 === r.sha256 &&
                p.signerThumbprint.toLowerCase() ===
                  r.signerThumbprint.toLowerCase()),
        ),
    );
  if (
    i.runningTasks.some(
      (t) =>
        !reviewedTask(t) &&
        (!g.agentTask ||
          t.path !== g.agentTask.path ||
          t.executable.toLowerCase() !== g.agentTask.executable.toLowerCase() ||
          t.arguments !== g.agentTask.arguments),
    )
  )
    reasons.push("running_scheduled_task");
  const serviceOwns = (pid: number, servicePid: number) => {
    const visited = new Set<number>();
    for (let at = pid; at > 4 && !visited.has(at); ) {
      if (at === servicePid) return true;
      visited.add(at);
      at = i.processes.find((p) => p.pid === at)?.parentPid ?? 0;
    }
    return false;
  };
  for (const p of i.processes) {
    const owned = watchChain && ownedWatch.some((h) => matchesWatch(p, h));
    if (
      p.pid === selfPid ||
      p.pid === probePid ||
      owned ||
      observers.processPids.has(p.pid)
    )
      continue;
    // Only this task's actual engine process; children remain ordinary workloads.
    if (
      i.runningTasks.some((t) => t.enginePid === p.pid && reviewedTask(t)) &&
      !/^(?:wsl|bash|pwsh|powershell|cmd|node|python.*|java.*|dotnet|cscript|wscript|mshta|rundll32|wmic|ssh|docker.*)(?:\.exe)?$/i.test(
        p.name,
      )
    )
      continue;
    if (
      g.ownedRuntime &&
      g.agentTask &&
      p.path.toLowerCase() === g.ownedRuntime.executable.toLowerCase() &&
      p.sha256 === g.ownedRuntime.sha256 &&
      g.agentTask.executable.toLowerCase() === p.path.toLowerCase()
    )
      continue;
    if (receipt && i.wslRunning && !wslReasons.length) {
      const sameCreation = (a: string, b: string) =>
        a.length === b.length &&
        a.endsWith("0") &&
        a.slice(0, -1) === b.slice(0, -1);
      const isKeeper = (candidate: (typeof i.processes)[number]) =>
        candidate.pid === receipt.keeper.pid &&
        candidate.parentPid === receipt.producerPid &&
        sameCreation(candidate.creationTicks, receipt.keeper.startedTicks) &&
        candidate.ownerSid === receipt.ownerSid &&
        /^[a-z]:\\windows\\system32\\wsl\.exe$/i.test(candidate.path) &&
        candidate.microsoftSigned;
      const keeper = isKeeper(p);
      // Store WSL redirects the owned System32 launcher to this exact child.
      // Other wsl.exe callers and descendants remain ordinary workloads.
      const keeperRedirector =
        p.parentPid === receipt.keeper.pid &&
        p.ownerSid === receipt.ownerSid &&
        /^[a-z]:\\program files\\wsl\\wsl\.exe$/i.test(p.path) &&
        p.microsoftSigned &&
        g.systemExecutables.some(
          (e) => e.name.toLowerCase() === "wsl.exe" && e.sha256 === p.sha256,
        ) &&
        i.processes.some(isKeeper);
      const nativeWsl =
        p.ownerSid === receipt.ownerSid &&
        /^(wslhost|wslrelay)\.exe$/i.test(p.name) &&
        /^[a-z]:\\program files\\wsl\\/i.test(p.path) &&
        p.microsoftSigned &&
        g.systemExecutables.some(
          (e) =>
            e.name.toLowerCase() === p.name.toLowerCase() &&
            e.sha256 === p.sha256,
        );
      const wslMemory =
        p.name.toLowerCase() === "vmmemwsl" &&
        /^S-1-5-83-1-/.test(p.ownerSid) &&
        i.services.some(
          (s) => s.name === "vmcompute" && serviceOwns(p.pid, s.pid),
        );
      if (keeper || keeperRedirector || nativeWsl || wslMemory) continue;
    }
    // A finite reviewed service executable is allowed only in that running service's process tree.
    const reviewed = g.reviewedServices.some(
      (e) =>
        e.path.toLowerCase() === p.path.toLowerCase() &&
        e.sha256 === p.sha256 &&
        e.signerThumbprint.toLowerCase() === p.signerThumbprint.toLowerCase() &&
        (e.hostedLibrary
          ? !!p.hostedLibrary &&
            e.hostedLibrary.path.toLowerCase() ===
              p.hostedLibrary.path.toLowerCase() &&
            e.hostedLibrary.sha256 === p.hostedLibrary.sha256 &&
            e.hostedLibrary.signerThumbprint.toLowerCase() ===
              p.hostedLibrary.signerThumbprint.toLowerCase() &&
            e.hostedLibrary.entryPoint === p.hostedLibrary.entryPoint
          : !p.hostedLibrary) &&
        i.services.some(
          (s) => s.name === e.serviceName && serviceOwns(p.pid, s.pid),
        ),
    );
    const interpreter =
      /^(?:wsl|wslhost|bash|pwsh|powershell|cmd|node|python.*|java.*|dotnet|cscript|wscript|mshta|rundll32|wmic|ssh|docker.*|vmmem.*)(?:\.exe)?$/i.test(
        p.name,
      );
    const os =
      /^[a-z]:\\windows\\/i.test(p.path) &&
      p.microsoftSigned &&
      (g.systemExecutables.some(
        (e) =>
          e.name.toLowerCase() === p.name.toLowerCase() &&
          e.sha256 === p.sha256,
      ) ||
        (g.signedWindowsServiceHelpers &&
          i.services.some((s) => serviceOwns(p.pid, s.pid))));
    // OpenSSH's listening service may be reviewed; per-connection children remain interactive blockers.
    const sshListener =
      p.name.toLowerCase() === "sshd.exe" &&
      i.services.some((s) => s.pid === p.pid && s.name === "sshd");
    if (
      (interpreter &&
        !(
          p.name.toLowerCase() === "rundll32.exe" &&
          p.microsoftSigned &&
          p.hostedLibrary &&
          reviewed
        )) ||
      (!os && !reviewed) ||
      (p.name.toLowerCase() === "sshd.exe" && !sshListener)
    )
      reasons.push("unapproved_native_process");
  }
  for (const s of i.services)
    if (
      s.pid !== selfPid &&
      !g.systemServices.includes(s.name) &&
      !(
        g.signedWindowsServiceHelpers &&
        i.processes.some(
          (p) =>
            p.pid === s.pid &&
            /^[a-z]:\\windows\\/i.test(p.path) &&
            p.microsoftSigned &&
            p.sha256,
        )
      ) &&
      !g.reviewedServices.some((e) => e.serviceName === s.name)
    )
      reasons.push("unapproved_running_service");
  return [...new Set(reasons)];
}
export type PowerJournal = {
  bootEvidence: "system-event-v1";
  bootId: string;
  cycleId: string;
  token: string | null;
  expiresAtUptimeMs: number;
  state: "prepared" | "executing" | "accepted" | "cancelled" | "unknown";
  /** Same-OS-boot confirmed Abort fact, retained until its existing cancelled event is acknowledged.
   * Optional only for old journals: absence means false. Every new record writes it explicitly. */
  cancelReportPending?: boolean;
  machineEpoch: number;
};
/** Node Windows uv_uptime uses GetTickCount64, shared with the fixed native helper. */
export const nativeUptimeMs = () => Math.floor(uptime() * 1000);
/** One real local sample. System uptime is captured before collection starts. */
export type NativeSafetySample = {
  safe: boolean;
  startedAtMonotonicMs: number;
};
export function isFreshNativeSafetySample(
  sample: NativeSafetySample | null,
  now: number,
): boolean {
  if (
    !sample?.safe ||
    !Number.isFinite(now) ||
    !Number.isFinite(sample.startedAtMonotonicMs)
  )
    return false;
  const age = now - sample.startedAtMonotonicMs;
  return age >= 0 && age < 5000;
}
export function nativePowerEvidenceIsSafe(
  e: Pick<
    HostSnapshot,
    | "probeStatus"
    | "sessionsComplete"
    | "sessions"
    | "activeInteraction"
    | "unmanagedActivityHold"
    | "resources"
  >,
): boolean {
  return (
    e.probeStatus === "complete" &&
    e.sessionsComplete &&
    e.sessions.length === 0 &&
    e.activeInteraction === false &&
    e.unmanagedActivityHold === false &&
    !!e.resources &&
    e.resources.cpuPercent < 50 &&
    e.resources.memoryPressurePercent !== undefined &&
    e.resources.memoryPressurePercent < 80
  );
}
/** Durable write precedes side effects. A recovered executing journal only cancels; never replays. */
export class NativePowerExecutor {
  private journal: PowerJournal | null = null;
  constructor(
    private readonly ports: {
      load: () => Promise<PowerJournal | null>;
      save: (j: PowerJournal) => Promise<void>;
      check: () => Promise<boolean>;
      shutdown: (permit: {
        notAfterUptimeMs: number;
        controllerNotAfterMs: number;
        cycleId: string;
      }) => Promise<void>;
      abort: () => Promise<void>;
      now?: () => number;
      uptimeMs?: () => number;
      bootId: string;
    },
  ) {}
  async initialize() {
    const loaded = await this.ports.load();
    if (loaded && loaded.bootEvidence !== "system-event-v1")
      throw new Error("native_boot_evidence_legacy");
    this.journal = loaded;
    if (
      this.journal &&
      (this.journal.bootId !== this.ports.bootId ||
        this.journal.state === "prepared")
    )
      await this.save({
        ...this.journal,
        state: "cancelled",
        token: null,
        cancelReportPending: false,
      });
    else if (
      this.journal &&
      ["executing", "accepted", "unknown"].includes(this.journal.state)
    )
      await this.abort();
  }
  private now() {
    return (this.ports.now ?? Date.now)();
  }
  private uptimeMs() {
    return (this.ports.uptimeMs ?? nativeUptimeMs)();
  }
  private directiveDeadline(expiresAtMs: number | null): number | null {
    if (!expiresAtMs) return null;
    const remaining = expiresAtMs - this.now();
    return Number.isFinite(remaining) && remaining > 0
      ? this.uptimeMs() + Math.min(5000, remaining)
      : null;
  }
  private async save(j: PowerJournal) {
    await this.ports.save(j);
    this.journal = j;
  }
  /** A bounded fact in the existing journal, never replayed across a real OS boot. */
  pendingCancellation(): Pick<HostPowerEvent, "event" | "cycleId"> | null {
    const j = this.journal;
    return j?.state === "cancelled" &&
      j.cancelReportPending === true &&
      j.bootId === this.ports.bootId
      ? { event: "cancelled", cycleId: j.cycleId }
      : null;
  }
  async acknowledgeCancellation(cycleId: string, response: HostPowerDirective) {
    const j = this.journal;
    if (
      response.action === "none" &&
      j?.state === "cancelled" &&
      j.cancelReportPending === true &&
      j.cycleId === cycleId &&
      j.bootId === this.ports.bootId
    )
      await this.save({ ...j, cancelReportPending: false });
  }
  async abort() {
    // Repeated cleanup must neither reissue Abort nor recreate a fact that already received its ACK.
    if (!this.journal || this.journal.state === "cancelled") return;
    try {
      const needsAbort = ["executing", "accepted", "unknown"].includes(
        this.journal.state,
      );
      if (needsAbort) await this.ports.abort();
      await this.save({
        ...this.journal,
        state: "cancelled",
        token: null,
        cancelReportPending:
          needsAbort && this.journal.bootId === this.ports.bootId,
      });
    } catch {
      await this.save({
        ...this.journal,
        state: "unknown",
        token: null,
        cancelReportPending: false,
      });
      throw new Error("native_shutdown_cancellation_unknown");
    }
  }
  async watchdog(sample: NativeSafetySample | null) {
    if (
      this.journal?.state === "accepted" &&
      (!isFreshNativeSafetySample(sample, this.uptimeMs()) ||
        this.uptimeMs() >= this.journal.expiresAtUptimeMs)
    )
      await this.abort();
  }
  async directive(
    d: HostPowerDirective,
  ): Promise<Pick<HostPowerEvent, "event" | "cycleId" | "token"> | null> {
    if (d.action === "none") return null;
    if (!d.cycleId || d.machineEpoch === null)
      throw new Error("invalid_power_directive");
    if (d.action === "cancel") {
      if (this.journal?.cycleId === d.cycleId) await this.abort();
      return { event: "cancelled", cycleId: d.cycleId };
    }
    if (d.action === "prepare") {
      const offerNotAfterUptimeMs = this.directiveDeadline(d.expiresAtMs);
      if (
        this.pendingCancellation() !== null ||
        (this.journal?.cycleId === d.cycleId &&
          this.journal.state !== "prepared")
      )
        return { event: "rejected", cycleId: d.cycleId };
      if (
        !d.expiresAtMs ||
        offerNotAfterUptimeMs === null ||
        this.uptimeMs() >= offerNotAfterUptimeMs ||
        this.now() >= d.expiresAtMs ||
        !(await this.ports.check()) ||
        this.now() >= d.expiresAtMs ||
        this.uptimeMs() >= offerNotAfterUptimeMs
      )
        return { event: "rejected", cycleId: d.cycleId };
      const token = randomUUID();
      await this.save({
        bootEvidence: "system-event-v1",
        bootId: this.ports.bootId,
        cycleId: d.cycleId,
        token,
        // The offer must survive the first check; the newly issued token then owns its own five seconds.
        expiresAtUptimeMs: this.uptimeMs() + 5000,
        state: "prepared",
        cancelReportPending: false,
        machineEpoch: d.machineEpoch,
      });
      return { event: "prepared", cycleId: d.cycleId, token };
    }
    const j = this.journal;
    const controllerNotAfterUptimeMs = this.directiveDeadline(d.expiresAtMs);
    const notAfterUptimeMs =
      j && controllerNotAfterUptimeMs !== null
        ? Math.min(j.expiresAtUptimeMs, controllerNotAfterUptimeMs)
        : null;
    if (
      !j ||
      j.state !== "prepared" ||
      j.cycleId !== d.cycleId ||
      j.token !== d.token ||
      j.machineEpoch !== d.machineEpoch ||
      notAfterUptimeMs === null ||
      this.uptimeMs() >= notAfterUptimeMs ||
      !d.expiresAtMs ||
      this.now() >= d.expiresAtMs ||
      !(await this.ports.check()) ||
      this.uptimeMs() >= notAfterUptimeMs ||
      this.now() >= d.expiresAtMs
    )
      return { event: "rejected", cycleId: d.cycleId };
    await this.save({ ...j, state: "executing" });
    try {
      await this.ports.shutdown({
        notAfterUptimeMs,
        controllerNotAfterMs: d.expiresAtMs,
        cycleId: j.cycleId,
      });
      await this.save({
        ...j,
        state: "accepted",
        expiresAtUptimeMs: this.uptimeMs() + 90000,
      });
      return { event: "accepted", cycleId: d.cycleId, token: j.token! };
    } catch {
      await this.save({
        ...j,
        state: "unknown",
        token: null,
        cancelReportPending: false,
      });
      return { event: "rejected", cycleId: d.cycleId };
    }
  }
}
/** Known busy work is a complete observation, while missing/changed facts remain unknown. */
export function workloadObservationComplete(reasons: readonly string[]) {
  return reasons.every((reason) =>
    [
      "running_wsl_workload",
      "wsl_unmanaged_native_work",
      "wsl_container_work",
      "running_scheduled_task",
      "unapproved_native_process",
      "unapproved_running_service",
    ].includes(reason),
  );
}
/** Upgrading partial/null requires complete native measurements, independently of idle/busy. */
export function powerEvidence(
  e: Pick<
    HostSnapshot,
    | "sessions"
    | "sessionsComplete"
    | "activeInteraction"
    | "resources"
    | "unmanagedActivityHold"
    | "probeStatus"
    | "errorCodes"
  >,
  clear: boolean,
  workloadComplete = clear,
) {
  const sessionsComplete =
    e.sessionsComplete ||
    (e.sessions.length > 0 &&
      !e.errorCodes.some(
        (c) =>
          ![
            "windows_lock_state_unknown",
            "unmanaged_activity_unproven",
          ].includes(c),
      ));
  const complete =
    workloadComplete &&
    sessionsComplete &&
    e.activeInteraction !== "unknown" &&
    e.resources !== null &&
    !e.errorCodes.some(
      (c) =>
        !["windows_lock_state_unknown", "unmanaged_activity_unproven"].includes(
          c,
        ),
    );
  return {
    ...e,
    sessionsComplete,
    unmanagedActivityHold: clear ? false : true,
    probeStatus: complete
      ? ("complete" as const)
      : e.probeStatus === "complete"
        ? ("partial" as const)
        : e.probeStatus,
    errorCodes: complete
      ? []
      : [
          ...e.errorCodes.filter((c) => c !== "unmanaged_activity_unproven"),
          ...(!clear ? ["native_workload_guard_blocked"] : []),
        ],
  };
}

/** One native Host process owns this lock through journal recovery, network bootstrap and shutdown cleanup. */
export async function runNativePowerLifecycle(options: {
  executor: Pick<NativePowerExecutor, "initialize" | "abort">;
  observation: { initialize: () => Promise<void> };
  releaseLock: () => Promise<void>;
  stopped: () => boolean;
  wait: (milliseconds: number) => Promise<void>;
  onTransient: () => void;
  run: () => Promise<void>;
}) {
  let journalInitialized = false;
  try {
    await options.executor.initialize();
    journalInitialized = true;
    while (!options.stopped()) {
      try {
        await options.observation.initialize();
        break;
      } catch (error) {
        if (!isTransientHostFailure(error)) throw error;
        options.onTransient();
        if (!options.stopped()) await options.wait(5000);
      }
    }
    if (!options.stopped()) await options.run();
  } finally {
    // Unknown/corrupt journal recovery cannot certify there is no pending OS request.
    // A failed abort deliberately prevents release, retaining the lock and recovery responsibility.
    await options.executor.abort();
    if (journalInitialized) await options.releaseLock();
  }
}
