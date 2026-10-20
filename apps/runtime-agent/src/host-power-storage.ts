import { open, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PowerJournal, NativePowerDiagnostic } from "./host-power.js";
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
