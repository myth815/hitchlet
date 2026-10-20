import { createHash } from "node:crypto";
import type {
  PowerPolicy,
  PowerCapabilities,
  SmartPlugBinding,
  PowerPreviewState,
  PowerPreviewEvent,
} from "@hitchlet/contracts/admin";
import {
  evaluateMachineAdmission,
  type MachineAdmissionContext,
} from "./human-use.js";

/** A complete immutable decision input. Persistence supplies the same input again under CAS. */
export type PowerContext = {
  machineId: string;
  machineVersion: number;
  machineEpoch: number;
  controllerEpoch: number;
  policyVersion: number;
  policy: PowerPolicy;
  binding: SmartPlugBinding | null;
  capabilities: PowerCapabilities;
  admission: MachineAdmissionContext;
  operations: { id: string; kind: string; state: string }[];
  allocations: {
    id: string;
    purpose: string;
    desiredState: string;
    observedState: string;
    cleanupStatus: string;
  }[];
};

/** Eligibility is independent of installed executors: a dry-run can explain unverified hardware. */
export function shutdownReasons(c: PowerContext, now: number): string[] {
  const a = evaluateMachineAdmission(c.admission, now),
    reasons: string[] = [...a.reasons];
  if (c.admission.source !== "local" || c.admission.power !== "on")
    reasons.push("Machine must be local and observed on");
  if (c.admission.admission !== "enabled")
    reasons.push("Machine admission is not enabled");
  if (c.admission.nodes.some((n) => n.manualInventory))
    reasons.push("Manual inventory never authorizes power");
  if (
    a.hostObservation.state !== "fresh" ||
    a.hostObservation.probeStatus !== "complete" ||
    a.hostObservation.sessionsComplete !== true
  )
    reasons.push("Host evidence must be authenticated, complete and fresh");
  if (a.hostObservation.humanPresence !== "absent")
    reasons.push(`Human presence is ${a.hostObservation.humanPresence}`);
  if (a.hostObservation.unmanagedActivityHold !== false)
    reasons.push("Unmanaged activity is unknown or held");
  if (!c.admission.policy || c.admission.policyInvalid)
    reasons.push("Human-use policy is missing or invalid");
  if (
    a.hostObservation.cpuPercent === null ||
    a.hostObservation.memoryPercent === null ||
    a.hostObservation.cpuPercent >=
      (c.admission.policy?.cpuPressureLimitPercent ?? 0) ||
    a.hostObservation.memoryPercent >=
      (c.admission.policy?.memoryPressureLimitPercent ?? 0)
  )
    reasons.push("Resource pressure is unknown or above policy");
  reasons.push(...c.admission.holds.map((h) => `Hold: ${h.id}: ${h.reason}`));
  for (const claim of c.admission.claims) {
    const owner = c.allocations.find((a) => a.id === claim.allocationId);
    // Stopped infrastructure may retain only known persistent disk. Everything else protects power.
    if (
      !(
        owner?.purpose === "infrastructure" &&
        owner.desiredState === "absent" &&
        owner.observedState === "stopped" &&
        claim.state === "committed" &&
        claim.resources.cpuMillis === 0 &&
        claim.resources.memoryMiB === 0
      )
    )
      reasons.push(`Unreleased Claim: ${claim.id}`);
  }
  for (const a of c.allocations)
    if (
      a.cleanupStatus !== "complete" &&
      !(
        a.purpose === "infrastructure" &&
        a.desiredState === "absent" &&
        a.observedState === "stopped"
      )
    )
      reasons.push(`Active/preparing/cleanup allocation: ${a.id}`);
  for (const op of c.operations)
    if (
      !op.kind.startsWith("power.dry-run") &&
      ["planned", "running", "unknown"].includes(op.state)
    )
      reasons.push(`Unresolved operation: ${op.id}`);
  if (
    c.admission.nodes.some(
      (n) =>
        n.observedHealth !== "healthy" ||
        n.observedAtMs === null ||
        n.observedAtMs > now ||
        now - n.observedAtMs >= 120000,
    )
  )
    reasons.push("Node or infrastructure readiness is unknown");
  return [...new Set(reasons)];
}

export function executionReasons(c: PowerContext): string[] {
  const reasons = [
    "D22b real power executor and per-machine acceptance are unavailable; preview is never a permit",
  ];
  if (c.policy.idleAction === "sleep")
    reasons.push(
      "Sleep preview is unsupported in D22a; sleep wake is distinct from cold boot",
    );
  if (!c.policy.enabled || c.policy.idleAction === "none")
    reasons.push("Automatic idle power policy is disabled");
  const capability =
    c.policy.idleAction === "sleep"
      ? c.capabilities.sleep
      : c.capabilities.normalShutdown;
  if (capability !== "verified")
    reasons.push("Normal power action has no verified hardware evidence");
  if (c.capabilities.coldBoot !== "verified" || !c.capabilities.wakeRouteRef)
    reasons.push("Cold boot / wake route is unverified");
  if (!c.capabilities.verificationReportIds.length)
    reasons.push("No accepted per-machine power report");
  if (c.binding)
    reasons.push(
      "Smart plug dedicated supply and AC recovery remain unverified (D22b)",
    );
  return reasons;
}

/** Excludes sampling sequence/time, includes the safety conditions whose change resets continuous idle. */
export function powerConditionKey(c: PowerContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: c.machineVersion,
        epoch: c.machineEpoch,
        controllerEpoch: c.controllerEpoch,
        policyVersion: c.policyVersion,
        policy: c.policy,
        admission: c.admission.admission,
        power: c.admission.power,
        pools: c.admission.pools,
        nodes: c.admission.nodes.map((n) => ({ ...n, observedAtMs: null })),
        holds: c.admission.holds,
        claims: c.admission.claims,
        allocations: c.allocations,
        operations: c.operations.filter(
          (o) => !o.kind.startsWith("power.dry-run"),
        ),
        host: c.admission.observation
          ? {
              boot: c.admission.observation.snapshot.bootId,
              agent: c.admission.observation.snapshot.agentId,
              authenticated: c.admission.observation.authenticated,
              interaction: c.admission.observation.snapshot.activeInteraction,
              sessions: c.admission.observation.snapshot.sessions.map((s) => ({
                type: s.type,
                locked: s.locked,
                connection: s.connection,
              })),
              probe: c.admission.observation.snapshot.probeStatus,
              complete: c.admission.observation.snapshot.sessionsComplete,
              unmanaged: c.admission.observation.snapshot.unmanagedActivityHold,
            }
          : null,
      }),
    )
    .digest("hex");
}

const closed = (p: PowerPreviewState) =>
  ["cancelled", "complete"].includes(p.phase) ||
  (p.phase === "manual" && !p.restoreRequired);
/** Simulation inputs have no route to Agent receipts, Machine power or real OS/device calls. */
export function advancePowerPreview(
  c: PowerContext,
  previous: PowerPreviewState,
  event: PowerPreviewEvent,
  now: number,
  receiptId: string,
): PowerPreviewState {
  const p: PowerPreviewState = {
    ...previous,
    version: previous.version + 1,
    updatedAtMs: now,
    reasons: [],
  };
  if (closed(previous)) throw new Error("Preview is terminal");
  const shutdown = shutdownReasons(c, now),
    key = powerConditionKey(c);
  const fenced =
    c.machineEpoch === p.machineEpoch &&
    c.controllerEpoch === p.controllerEpoch &&
    c.policyVersion === p.policyVersion &&
    c.machineVersion === p.machineVersion;
  const host = c.admission.observation;
  const newHeartbeat =
    !!host?.authenticated &&
    Date.parse(host.snapshot.observedAt) > (p.acceptedAtMs ?? now);
  if (p.restoreRequired) {
    // Restoration owns its frozen binding and original deadline across restarts, cancellation and policy changes.
    if (event.kind === "cancel")
      return {
        ...p,
        reasons: [
          "Restore supply obligation retained independently of the originating request",
        ],
      };
    return advanceRecovery(p, event, now);
  }
  if (event.kind === "cancel")
    return {
      ...p,
      phase: "cancelled",
      idleSinceMs: null,
      virtualEpoch: p.virtualEpoch + 1,
      acceptedReceiptId: null,
      acceptedAtMs: null,
      offEvidenceId: null,
      observedPower: "unknown",
    };
  // Read-only readiness after supply restoration uses current authenticated evidence, not an expired off permit.
  if (p.mode === "fault_recovery" && p.phase === "verifying") {
    if (event.kind !== "evaluate")
      throw new Error("Only readiness review is valid after restoring supply");
    const recovered =
      shutdown.length === 0 &&
      !!host?.authenticated &&
      host.snapshot.bootId !== p.bootId &&
      p.supplyRestoredAtMs !== null &&
      Date.parse(host.snapshot.observedAt) > p.supplyRestoredAtMs;
    return {
      ...p,
      phase: recovered ? "complete" : "verifying",
      observedPower: recovered ? "on" : "unknown",
      reasons: recovered
        ? []
        : [
            "Await a new authenticated boot, complete human/resource evidence and healthy dependencies after supply restoration",
          ],
    };
  }
  if (
    p.mode === "idle_shutdown" &&
    ["shutdown_requested", "off_expected", "off_confirmed", "waking"].includes(
      p.phase,
    ) &&
    p.deadlineMs !== null &&
    now >= p.deadlineMs
  )
    return {
      ...p,
      phase: "manual",
      observedPower: "unknown",
      acceptedAtMs: null,
      acceptedReceiptId: null,
      offEvidenceId: null,
      reasons: [
        "Power cycle deadline expired; inspect without restarting an old wake window",
      ],
    };
  if (!fenced)
    return {
      ...p,
      phase: "cancelled",
      idleSinceMs: null,
      acceptedAtMs: null,
      acceptedReceiptId: null,
      offEvidenceId: null,
      observedPower: "unknown",
      reasons: [
        "Machine/policy/controller fence changed; old simulation invalidated",
      ],
    };
  if (
    ["shutdown_requested", "off_expected", "off_confirmed", "waking"].includes(
      p.phase,
    ) &&
    newHeartbeat
  ) {
    const healthy = shutdown.length === 0 && host?.snapshot.bootId !== p.bootId;
    return {
      ...p,
      phase: p.phase === "waking" && healthy ? "complete" : "manual",
      observedPower: "on",
      acceptedReceiptId: null,
      acceptedAtMs: null,
      offEvidenceId: null,
      reasons: healthy
        ? []
        : [
            "Fresh online evidence invalidated the old shutdown inference; inspect before any power action",
          ],
    };
  }
  if (key !== p.conditionKey && !["idle", "draining"].includes(p.phase))
    return {
      ...p,
      phase: "cancelled",
      acceptedAtMs: null,
      acceptedReceiptId: null,
      offEvidenceId: null,
      observedPower: "unknown",
      reasons: ["Safety conditions changed; old power simulation invalidated"],
    };
  if (p.mode === "fault_recovery") return advanceRecovery(p, event, now);
  if (event.kind === "evaluate") {
    if (p.phase === "idle" || p.phase === "draining") {
      if (!c.policy.enabled || c.policy.idleAction !== "shutdown")
        shutdown.push("Idle power policy is disabled");
      const continuous =
        previous.conditionKey === key &&
        now - p.lastEvaluationAtMs <=
          Math.min(c.admission.policy?.maximumObservationAgeSeconds ?? 30, 30) *
            1000 &&
        now >= p.lastEvaluationAtMs;
      const since = shutdown.length
        ? null
        : continuous
          ? (p.idleSinceMs ?? now)
          : now;
      const drain =
        since !== null && now - since >= c.policy.idleSeconds * 1000;
      return {
        ...p,
        conditionKey: key,
        idleSinceMs: since,
        lastEvaluationAtMs: now,
        phase: drain ? "draining" : "idle",
        virtualEpoch:
          p.virtualEpoch + (drain && p.phase !== "draining" ? 1 : 0),
        reasons: shutdown,
      };
    }
    if (
      p.phase === "shutdown_requested" &&
      p.acceptedAtMs !== null &&
      p.acceptedReceiptId &&
      now - p.acceptedAtMs >= c.policy.expectedOffGuardSeconds * 1000 &&
      host &&
      now - host.receivedAtMs > 30000
    )
      return { ...p, phase: "off_expected", observedPower: "unknown" };
    if (p.phase === "waking" && p.deadlineMs !== null && now >= p.deadlineMs)
      return {
        ...p,
        phase: "manual",
        observedPower: "unknown",
        reasons: ["Wake deadline exhausted; inspect, never power cycle"],
      };
    return p;
  }
  if (event.kind === "accept_shutdown") {
    if (
      p.phase !== "draining" ||
      key !== p.conditionKey ||
      shutdown.length ||
      now - p.lastEvaluationAtMs > 5000
    )
      return {
        ...p,
        phase: "idle",
        idleSinceMs: null,
        reasons: [
          ...shutdown,
          "Final recheck failed or simulated local review expired",
        ],
      };
    return {
      ...p,
      phase: "shutdown_requested",
      acceptedAtMs: now,
      acceptedReceiptId: receiptId,
      observedPower: "unknown",
      deadlineMs: now + 300000,
    };
  }
  if (event.kind === "confirm_off") {
    if (
      !["shutdown_requested", "off_expected"].includes(p.phase) ||
      !p.acceptedReceiptId
    )
      throw new Error("No owned shutdown to confirm");
    return {
      ...p,
      phase: "off_confirmed",
      offEvidenceId: event.evidenceId,
      observedPower: "off",
    };
  }
  if (event.kind === "wake") {
    const safeExpected =
      p.phase === "off_expected" &&
      c.capabilities.wolWhilePossiblyOn === "verified" &&
      !!p.acceptedReceiptId &&
      p.acceptedAtMs !== null &&
      now - p.acceptedAtMs >= c.policy.expectedOffGuardSeconds * 1000;
    if (
      !(safeExpected || p.phase === "off_confirmed" || p.phase === "waking") ||
      !c.policy.wakeOnDemand ||
      c.capabilities.coldBoot !== "verified" ||
      !c.capabilities.wakeRouteRef ||
      !c.capabilities.verificationReportIds.length
    )
      return {
        ...p,
        reasons: [
          "Wake blocked: unknown power or missing separately verified safe WOL/cold-boot route",
        ],
      };
    const deadline =
      p.deadlineMs !== null && p.phase === "waking"
        ? p.deadlineMs
        : Math.min(
            now + c.policy.wakeTimeoutSeconds * 1000,
            event.provisionDeadlineMs,
            p.deadlineMs ?? Number.MAX_SAFE_INTEGER,
          );
    if (now >= deadline || p.wakeAttempts >= c.policy.maximumWakeAttempts)
      return {
        ...p,
        phase: "manual",
        observedPower: "unknown",
        reasons: ["Wake attempt/deadline bound exhausted"],
      };
    if (p.nextWakeAtMs !== null && now < p.nextWakeAtMs)
      return { ...p, reasons: ["Wake retry interval has not elapsed"] };
    return {
      ...p,
      phase: "waking",
      deadlineMs: deadline,
      wakeAttempts: p.wakeAttempts + 1,
      nextWakeAtMs: now + 30000,
    };
  }
  throw new Error("Event is invalid for normal power preview");
}
function advanceRecovery(
  p: PowerPreviewState,
  event: PowerPreviewEvent,
  now: number,
): PowerPreviewState {
  if (event.kind === "evaluate") {
    if (
      p.restoreRequired &&
      p.restoreNotBeforeMs !== null &&
      now >= p.restoreNotBeforeMs &&
      p.phase === "off_wait"
    )
      return { ...p, phase: "on_pending" };
    return p;
  }
  if (event.kind === "off_result_unknown") {
    if (p.phase !== "off_pending")
      throw new Error("No simulated off request pending");
    // The device may be off: retain an obligation and inspect before another decision.
    return {
      ...p,
      phase: "inspect_off",
      restoreRequired: true,
      observedPower: "unknown",
    };
  }
  if (event.kind !== "plug_readback" || !p.binding)
    throw new Error("Recovery requires frozen binding readback");
  const matches =
    event.deviceId === p.binding.device.deviceId &&
    event.macAddress.toLowerCase() ===
      p.binding.device.macAddress.toLowerCase();
  if (!matches)
    return {
      ...p,
      reasons: ["Device identity mismatch; no switch action authorized"],
    };
  if (event.state === "unknown")
    return {
      ...p,
      reasons: [
        "Unknown plug result; inspect exact identity before any switch action",
      ],
    };
  if (p.phase === "inspect") {
    if (event.state === "off")
      return {
        ...p,
        phase: "on_pending",
        restoreRequired: true,
        restoreNotBeforeMs: now,
        observedPower: "unknown",
        reasons: ["Already off: restore supply without another off cycle"],
      };
    return { ...p, phase: "off_pending", restoreRequired: true };
  }
  if (["off_pending", "inspect_off"].includes(p.phase)) {
    if (event.state === "on")
      return {
        ...p,
        phase: "manual",
        restoreRequired: false,
        reasons: ["Off was not confirmed; no repeated cut for this incident"],
      };
    const minimumOffSeconds = p.minimumOffSeconds;
    return {
      ...p,
      phase: "off_wait",
      restoreRequired: true,
      observedPower: "unknown",
      restoreNotBeforeMs: now + minimumOffSeconds * 1000,
      deadlineMs: now + minimumOffSeconds * 1000,
    };
  }
  if (p.phase === "off_wait")
    return {
      ...p,
      reasons: [
        "Confirmed off wait retains the original deadline; never send off again",
      ],
    };
  if (p.phase === "on_pending") {
    if (event.state === "off")
      return {
        ...p,
        reasons: ["Supply is still off; restore responsibility retained"],
      };
    return {
      ...p,
      phase: "verifying",
      restoreRequired: false,
      supplyRestoredAtMs: now,
      observedPower: "unknown",
      reasons: [
        "Supply on is not Host/boot/Docker readiness; authenticated verification required",
      ],
    };
  }
  return { ...p, reasons: ["No additional cut cycle is permitted"] };
}
