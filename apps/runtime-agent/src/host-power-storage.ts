import { open, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  PowerJournal,
  NativePowerDiagnostic,
  NativeObserverDiagnostic,
} from "./host-power.js";
/** Immutable System/Kernel-General event 12 evidence, not a clock-derived uptime estimate. */
export const NativeBootRecordSchema = z
  .object({
    bootRecordId: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .pipe(z.string().refine((v) => BigInt(v) <= 9223372036854775807n)),
    bootTime: z
      .string()
      .datetime({ precision: 7 })
      .refine((v) => !v.startsWith("0000-")),
  })
  .strict();
/** A new OS boot uses a new lock; wall-clock correction and process restart cannot change this ID. */
export function nativeBootId(bootRecordId: string, bootTime: string) {
  const evidence = NativeBootRecordSchema.parse({ bootRecordId, bootTime });
  const h = createHash("sha256")
    .update("hitchlet-system-boot-event-v1\n")
    .update(JSON.stringify(evidence))
    .digest("hex")
    .slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
export async function acquirePowerLock(journalFile: string, bootId: string) {
  await mkdir(dirname(journalFile), { recursive: true, mode: 0o700 });
  const path = `${journalFile}.${bootId}.lock`,
    handle = await open(path, "wx", 0o600);
  await handle.writeFile(JSON.stringify({ bootId, pid: process.pid }));
  await handle.sync();
  return async () => {
    await handle.close();
    await unlink(path);
  };
}
export async function savePowerJournal(path: string, j: PowerJournal) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`,
    f = await open(temp, "w", 0o600);
  try {
    await f.writeFile(JSON.stringify(j));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(temp, path);
}
/** Call only after the installation's journal directory ACL has been verified. One bounded record. */
export async function saveNativePowerFailure(
  journalFile: string,
  diagnostic: NativePowerDiagnostic,
) {
  const path = `${journalFile}.failure.json`,
    temp = `${path}.${randomUUID()}.tmp`;
  try {
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(
        JSON.stringify({
          at: new Date().toISOString(),
          phase: diagnostic.phase,
          code: diagnostic.code,
        }),
      );
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

const workloadReasonCodes = new Set([
  "workload_inventory_invalid",
  "workload_inventory_incomplete",
  "owned_watch_identity_unproven",
  "wsl_receipt_invalid",
  "running_wsl_workload",
  "running_scheduled_task",
  "unapproved_native_process",
  "unapproved_running_service",
  "executor_artifact_changed",
  "wsl_workload_evidence_missing",
  "wsl_distribution_coverage_incomplete",
  "wsl_distribution_unbound",
  "wsl_background_policy_changed",
  "wsl_workload_evidence_stale",
  "wsl_distribution_identity_changed",
  "wsl_native_inventory_incomplete",
  "wsl_engine_coverage_incomplete",
  "wsl_container_inventory_incomplete",
  "wsl_management_identity_unproven",
  "wsl_container_work",
  "wsl_unmanaged_native_work",
]);
const receiptFailureCodes = new Set([
  "wsl_receipt_stale_or_unbound",
  "wsl_receipt_producer_changed",
  "wsl_receipt_task_changed",
  "wsl_owner_coverage_incomplete",
]);
/** Never retain a raw exception from a file/schema/identity check. */
export function nativeReceiptFailureCode(error: unknown) {
  return error instanceof Error && receiptFailureCodes.has(error.message)
    ? error.message
    : "wsl_receipt_schema_or_read_failed";
}
export type NativeWorkloadObservation = {
  observedAt: string;
  executorPid: number;
  guardHash: string;
  executorHash: string;
  inventoryStartedAtMs: number;
  inventoryEndedAtMs: number;
  hostProbeEndedAtMs: number;
  workloadCheckedAtMs: number;
  inventoryComplete: boolean;
  observerAssessment?: {
    configured: boolean;
    artifactMatched: boolean;
    reconcilerOnlyObservers: boolean;
    processPids: readonly number[];
  };
  baseProbeStatus: "complete" | "partial" | "failed";
  baseErrorCodes: readonly string[];
  diagnostics: readonly {
    kind: string;
    pid: number;
    parentPid: number;
    stage?: string | undefined;
    code?: string | undefined;
    observer?: NativeObserverDiagnostic | undefined;
  }[];
  receipt: {
    stage: "not_running" | "not_configured" | "valid" | "invalid";
    code: string | null;
    observedAt: string | null;
    ageMs: number | null;
    producerPid: number | null;
  };
  reasons: readonly string[];
  workloadComplete: boolean;
  sessionsComplete: boolean;
  sessionCount: number;
  activeInteraction: boolean | "unknown";
  probeStatus: "complete" | "partial" | "failed";
};
/** Fixed fields only: no native process argv, names, paths, environment or raw errors. */
function workloadObservationRecord(o: NativeWorkloadObservation) {
  const observerProcess = (p: NativeObserverDiagnostic["chain"][number]) => ({
    pid: p.pid,
    parentPid: p.parentPid,
    creationTicks: p.creationTicks,
    role: p.role,
    status: p.status,
    ownerSid: p.ownerSid,
    imageSha256: p.imageSha256,
    argvSha256: p.argvSha256,
    argc: p.argc,
    ...(p.wslHostArguments
      ? {
          wslHostArguments: {
            shapeMatches: p.wslHostArguments.shapeMatches,
            distributionMatches: p.wslHostArguments.distributionMatches,
            vmGuidSha256: p.wslHostArguments.vmGuidSha256,
          },
        }
      : {}),
  });
  return {
    observedAt: o.observedAt,
    executorPid: o.executorPid,
    guardHash: o.guardHash,
    executorHash: o.executorHash,
    inventoryStartedAtMs: o.inventoryStartedAtMs,
    inventoryEndedAtMs: o.inventoryEndedAtMs,
    hostProbeEndedAtMs: o.hostProbeEndedAtMs,
    workloadCheckedAtMs: o.workloadCheckedAtMs,
    inventoryComplete: o.inventoryComplete,
    observerAssessment: o.observerAssessment
      ? {
          configured: o.observerAssessment.configured,
          artifactMatched: o.observerAssessment.artifactMatched,
          reconcilerOnlyObservers: o.observerAssessment.reconcilerOnlyObservers,
          processPids: o.observerAssessment.processPids.slice(0, 32),
        }
      : null,
    baseProbeStatus: o.baseProbeStatus,
    baseErrorCodes: [
      ...new Set(
        o.baseErrorCodes
          .slice(0, 16)
          .map((code) =>
            [
              "windows_input_state_unknown",
              "windows_lock_state_unknown",
              "windows_memory_availability_unknown",
              "windows_session_enumeration_incomplete",
              "windows_session_state_unknown",
              "windows_wts_shape_unknown",
              "unmanaged_activity_unproven",
            ].includes(code)
              ? code
              : "unknown_host_probe_code",
          ),
      ),
    ],
    diagnostics: o.diagnostics.slice(0, 32).map((d) => ({
      kind: [
        "process_identity_changed",
        "live_read_failed",
        "new_instance",
        "enumeration_failed",
      ].includes(d.kind)
        ? d.kind
        : "unknown",
      pid: d.pid,
      parentPid: d.parentPid,
      stage: ["image", "owner", "creation"].includes(d.stage ?? "")
        ? d.stage
        : null,
      code: [
        "native_process_image_unverifiable",
        "owner_sid_unavailable",
      ].includes(d.code ?? "")
        ? d.code
        : null,
      observer: d.observer
        ? {
            producerPid: d.observer.producerPid,
            producerCreationTicks: d.observer.producerCreationTicks,
            chain: d.observer.chain.slice(0, 4).map(observerProcess),
            ...(d.observer.keeperReference
              ? {
                  keeperReference: {
                    pid: d.observer.keeperReference.pid,
                    creationTicks: d.observer.keeperReference.creationTicks,
                    vmGuidSha256: d.observer.keeperReference.vmGuidSha256,
                    chain: d.observer.keeperReference.chain
                      .slice(0, 3)
                      .map(observerProcess),
                  },
                }
              : {}),
          }
        : null,
    })),
    diagnosticCount: o.diagnostics.length,
    receipt: {
      stage: o.receipt.stage,
      code:
        o.receipt.code === null
          ? null
          : nativeReceiptFailureCode(new Error(o.receipt.code)),
      observedAt: o.receipt.observedAt,
      ageMs: o.receipt.ageMs,
      producerPid: o.receipt.producerPid,
    },
    reasons: [
      ...new Set(
        o.reasons
          .slice(0, 32)
          .map((r) =>
            workloadReasonCodes.has(r) ? r : "unknown_workload_reason",
          ),
      ),
    ],
    workloadComplete: o.workloadComplete,
    sessionsComplete: o.sessionsComplete,
    sessionCount: o.sessionCount,
    activeInteraction: o.activeInteraction,
    probeStatus: o.probeStatus,
  };
}
/** One bounded latest record plus the last incomplete sample, in the existing trusted journal directory. */
export async function saveNativeWorkloadObservation(
  journalFile: string,
  latest: NativeWorkloadObservation,
  lastIncomplete: NativeWorkloadObservation | null,
) {
  const path = `${journalFile}.workload-observation.json`,
    temp = `${path}.${randomUUID()}.tmp`;
  try {
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(
        JSON.stringify({
          latest: workloadObservationRecord(latest),
          lastIncomplete: lastIncomplete
            ? workloadObservationRecord(lastIncomplete)
            : null,
        }),
      );
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export type NativeShutdownCheckpoint = {
  phase: "watch_arm" | "preflight" | "native_shutdown";
  elapsedMs: number;
  remainingUptimeMs: number;
  controllerRemainingMs: number;
};
export type NativeShutdownAttemptFailure = NativeShutdownCheckpoint & {
  at: string;
  cycleId: string;
  code: NativePowerDiagnostic["code"];
  checkpoints: readonly NativeShutdownCheckpoint[];
};
/** Latest failed attempt only. Called after the failing OS path settles, never before its API call. */
export async function saveNativeShutdownAttemptFailure(
  journalFile: string,
  attempt: NativeShutdownAttemptFailure,
) {
  const path = `${journalFile}.shutdown-attempt.json`,
    temp = `${path}.${randomUUID()}.tmp`;
  const checkpoint = (c: NativeShutdownCheckpoint) => ({
    phase: c.phase,
    elapsedMs: c.elapsedMs,
    remainingUptimeMs: c.remainingUptimeMs,
    controllerRemainingMs: c.controllerRemainingMs,
  });
  try {
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(
        JSON.stringify({
          at: attempt.at,
          cycleId: attempt.cycleId,
          code: attempt.code,
          ...checkpoint(attempt),
          checkpoints: attempt.checkpoints.slice(0, 3).map(checkpoint),
        }),
      );
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
