import { createHash } from "node:crypto";
import type { PowerContext } from "./power.js";
import { powerConditionKey, shutdownReasons } from "./power.js";
import type {
  PowerInstallationMachine,
  PowerExecution,
} from "@hitchlet/contracts/admin";
export const bindingHash = (value: PowerInstallationMachine) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        machineId: value.machineId,
        agentId: value.agentId,
        guardHash: value.guardHash,
        executorHash: value.executorHash,
        powerProtocolVersion: 1,
        idleSeconds: value.idleSeconds,
        route: value.route,
      }),
    )
    .digest("hex");
/** Drain is our own fence, not a new safety exemption. Real executions protect every Claim. */
export function ownsDrain(c: PowerContext, p?: PowerExecution) {
  return (
    !!p &&
    p.phase !== "idle" &&
    c.admission.admission === "draining" &&
    c.machineEpoch === p.machineEpoch &&
    c.machineVersion === p.machineVersion &&
    c.controllerEpoch === p.controllerEpoch
  );
}
export function executionContext(
  c: PowerContext,
  p?: PowerExecution,
): PowerContext {
  return {
    ...c,
    machineEpoch: 1,
    machineVersion: 1,
    policy: { ...c.policy, enabled: false },
    operations: c.operations.filter((o) => o.kind !== "power.execution"),
    admission: {
      ...c.admission,
      admission: ownsDrain(c, p) ? "enabled" : c.admission.admission,
      power: c.admission.observation?.authenticated ? "on" : c.admission.power,
    },
  };
}
export function realShutdownReasons(
  c: PowerContext,
  now: number,
  p?: PowerExecution,
) {
  return [
    ...new Set([
      ...shutdownReasons(executionContext(c, p), now),
      ...c.admission.claims.map((v) => `Unreleased Claim: ${v.id}`),
    ]),
  ];
}
export const executionConditionKey = (c: PowerContext, p?: PowerExecution) =>
  powerConditionKey(executionContext(c, p));

/** Power recovery returns control to HumanUsePolicy. Presence/high load are facts, not a reason to leave power unknown. */
export function powerReadyReasons(c: PowerContext, now: number) {
  const h = c.admission.observation,
    s = h?.snapshot,
    reasons: string[] = [];
  if (
    !h?.authenticated ||
    !s ||
    h.revoked ||
    now - h.receivedAtMs > 30000 ||
    now - Date.parse(s.observedAt) > 30000 ||
    Date.parse(s.observedAt) > now
  )
    reasons.push("New authenticated fresh Host evidence required");
  if (!s?.sessionsComplete || s.probeStatus === "failed" || !s.resources)
    reasons.push(
      "Complete session enumeration and measured resources required",
    );
  if (
    c.admission.nodes.some(
      (n) =>
        n.observedHealth !== "healthy" ||
        n.observedAtMs === null ||
        now - n.observedAtMs >= 120000 ||
        n.observedAtMs > now,
    )
  )
    reasons.push("Registered Node dependencies are not healthy/fresh");
  return reasons;
}
