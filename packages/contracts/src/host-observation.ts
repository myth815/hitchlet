import { z } from "zod";

const id = z.string().uuid();
const session = z
  .object({
    sessionId: z.string().min(1).max(128),
    principalRef: z.string().min(1).max(128),
    type: z.enum(["console", "rdp", "ssh", "other_interactive"]),
    connection: z.enum(["connected", "disconnected", "unknown"]),
    locked: z.union([z.boolean(), z.literal("unknown")]),
  })
  .strict();
const measuredResources = z
  .object({
    /** Measured busy time over the sampling interval; percent, 0–100. */
    cpuPercent: z.number().finite().min(0).max(100),
    /** Native OS memory pressure inputs in bytes; null resources means unavailable. */
    memoryUsedBytes: z.number().int().nonnegative().safe(),
    memoryTotalBytes: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.memoryUsedBytes > value.memoryTotalBytes)
      ctx.addIssue({ code: "custom", message: "used memory exceeds total" });
  });

/**
 * Physical-host evidence. Missing/failed probes are represented explicitly;
 * callers must never fill missing values with an empty session list or zero load.
 * observedAt is agent wall-clock UTC; receivedAt is assigned by the controller.
 */
export const hostSnapshotSchema = z
  .object({
    machineId: id,
    agentId: id,
    bootId: id,
    sequence: z.number().int().nonnegative().safe(),
    observedAt: z.string().datetime({ offset: true }),
    probeStatus: z.enum(["complete", "partial", "failed"]),
    sessionsComplete: z.boolean(),
    sessions: z.array(session).max(4096),
    activeInteraction: z.union([z.boolean(), z.literal("unknown")]),
    resources: measuredResources.nullable(),
    unmanagedActivityHold: z.boolean().nullable(),
    errorCodes: z.array(z.string().min(1).max(128)).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.probeStatus === "complete") {
      if (!value.sessionsComplete)
        ctx.addIssue({
          code: "custom",
          message: "complete probe requires complete session enumeration",
          path: ["sessionsComplete"],
        });
      if (
        value.activeInteraction === "unknown" ||
        value.resources === null ||
        value.unmanagedActivityHold === null
      )
        ctx.addIssue({
          code: "custom",
          message: "complete probe requires all measurements",
          path: ["probeStatus"],
        });
      if (value.errorCodes.length !== 0)
        ctx.addIssue({
          code: "custom",
          message: "complete probe cannot report errors",
          path: ["errorCodes"],
        });
    }
    if (value.probeStatus === "failed" && value.errorCodes.length === 0)
      ctx.addIssue({
        code: "custom",
        message: "failed probe requires a diagnostic code",
        path: ["errorCodes"],
      });
    if (
      !value.sessionsComplete &&
      value.sessions.length === 0 &&
      value.probeStatus === "complete"
    )
      ctx.addIssue({
        code: "custom",
        message: "incomplete enumeration cannot be complete",
      });
  });

export type HostSnapshot = z.infer<typeof hostSnapshotSchema>;
export type HumanPresence = "present" | "absent" | "unknown";

/** Session evidence is independent of resource/workload completeness. Failed probes cannot attest absence.
 * A listed interactive login protects the machine even when disconnected or locked. */
export function classifyHumanPresence(snapshot: HostSnapshot): HumanPresence {
  if (snapshot.sessions.length > 0 || snapshot.activeInteraction === true)
    return "present";
  if (
    snapshot.probeStatus === "failed" ||
    !snapshot.sessionsComplete ||
    snapshot.activeInteraction === "unknown"
  )
    return "unknown";
  return "absent";
}

/** Stale observations lose all absence authority; future timestamps are untrusted. */
export function classifyFreshHumanPresence(
  snapshot: HostSnapshot,
  receivedAtMs: number,
  nowMs: number,
  maximumAgeMs: number,
): HumanPresence {
  const observedAtMs = Date.parse(snapshot.observedAt);
  if (
    !Number.isFinite(observedAtMs) ||
    !Number.isSafeInteger(receivedAtMs) ||
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(maximumAgeMs) ||
    maximumAgeMs < 0 ||
    observedAtMs > receivedAtMs ||
    receivedAtMs > nowMs ||
    nowMs - receivedAtMs > maximumAgeMs ||
    nowMs - observedAtMs > maximumAgeMs
  )
    return "unknown";
  return classifyHumanPresence(snapshot);
}
