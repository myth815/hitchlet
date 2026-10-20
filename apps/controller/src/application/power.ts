import { randomUUID } from "node:crypto";
import {
  PowerConfigurationUpdateSchema,
  PowerPreviewStartSchema,
  PowerPreviewAdvanceSchema,
  PowerPreviewStateSchema,
} from "@hitchlet/contracts/admin";
import {
  advancePowerPreview,
  powerConditionKey,
  shutdownReasons,
} from "../domain/power.js";
import { SQLitePowerStore, type PowerActor } from "../storage/power-store.js";
import type { Storage } from "../storage/index.js";
import { ApplicationError } from "./errors.js";

/** Administrative simulation only. This service has no OS, Agent command or smart-plug port. */
export class PowerService {
  private readonly store: SQLitePowerStore;
  constructor(
    db: Storage,
    private readonly now = Date.now,
  ) {
    this.store = new SQLitePowerStore(db);
  }
  async configuration(machineId: string) {
    const now = this.now();
    return this.store.view(await this.store.load(machineId, now), now);
  }
  async previewPolicy(machineId: string, input: unknown) {
    const body = PowerConfigurationUpdateSchema.parse(input),
      now = this.now();
    const s = await this.store.load(machineId, now);
    if (body.expectedVersion !== s.context.policyVersion)
      throw new ApplicationError("conflict");
    return {
      configuration: this.store.view(
        { ...s, context: { ...s.context, policy: body.policy } },
        now,
      ),
      canSave: true as const,
    };
  }
  async configure(machineId: string, input: unknown, actor: PowerActor) {
    const body = PowerConfigurationUpdateSchema.parse(input),
      now = this.now();
    const s = await this.store.load(machineId, now);
    if (body.expectedVersion !== s.context.policyVersion)
      throw new ApplicationError("conflict");
    await this.store.configure(s, body.policy, actor, now);
    return this.configuration(machineId);
  }
  async capabilities(machineId: string, input: unknown, actor: PowerActor) {
    const now = this.now(),
      s = await this.store.load(machineId, now);
    await this.store.capabilities(s, input, actor, now);
    return this.configuration(machineId);
  }
  async bind(machineId: string, input: unknown, actor: PowerActor) {
    const now = this.now(),
      s = await this.store.load(machineId, now);
    await this.store.bind(s, input, actor, now);
    return this.configuration(machineId);
  }
  async list(machineId: string) {
    await this.store.load(machineId, this.now());
    return this.store.list(machineId);
  }
  get(machineId: string, id: string) {
    return this.store.get(machineId, id);
  }
  async start(machineId: string, input: unknown, actor: PowerActor) {
    const body = PowerPreviewStartSchema.parse(input),
      now = this.now();
    const s = await this.store.load(machineId, now),
      c = s.context;
    if (body.expectedPolicyVersion !== c.policyVersion)
      throw new ApplicationError("conflict");
    if (
      s.data.operations.some(
        (o) =>
          o.kind.startsWith("power.") &&
          ["planned", "running", "unknown"].includes(o.state),
      )
    )
      throw new ApplicationError("conflict");
    if (body.mode === "idle_shutdown" && c.policy.idleAction === "sleep")
      throw new ApplicationError("execution_mode_unsupported");
    const reasons = shutdownReasons(c, now);
    if (body.mode === "fault_recovery") {
      const fault = c.policy.faultRecovery;
      if (
        fault.mode !== "smart_plug_cycle" ||
        !c.binding ||
        c.binding.id !== fault.plugBindingId
      )
        throw new ApplicationError("invalid_request");
      if (fault.authorization === "automatic_verified")
        throw new ApplicationError("execution_mode_unsupported");
      // Unknown protected workloads are retained and explicitly acknowledged, never cleared for recovery.
      if (reasons.length && !body.riskAcknowledgement)
        throw new ApplicationError("invalid_request");
    }
    const p = PowerPreviewStateSchema.parse({
      id: randomUUID(),
      machineId,
      version: 1,
      dryRun: true,
      executable: false,
      mode: body.mode,
      phase: body.mode === "fault_recovery" ? "inspect" : "idle",
      policyVersion: c.policyVersion,
      machineVersion: c.machineVersion,
      machineEpoch: c.machineEpoch,
      virtualEpoch: c.machineEpoch,
      controllerEpoch: c.controllerEpoch,
      bootId: c.admission.observation?.snapshot.bootId ?? null,
      idleSinceMs: null,
      lastEvaluationAtMs: now,
      conditionKey: powerConditionKey(c),
      acceptedAtMs: null,
      acceptedReceiptId: null,
      observedPower: "unknown",
      offEvidenceId: null,
      wakeAttempts: 0,
      nextWakeAtMs: null,
      deadlineMs: null,
      minimumOffSeconds:
        c.policy.faultRecovery.mode === "smart_plug_cycle"
          ? c.policy.faultRecovery.minimumOffSeconds
          : 600,
      restoreRequired: false,
      supplyRestoredAtMs: null,
      restoreNotBeforeMs: null,
      incidentId: body.incidentId?.toLowerCase() ?? null,
      binding: body.mode === "fault_recovery" ? c.binding : null,
      riskAcknowledgement: body.riskAcknowledgement ?? null,
      affectedClaimIds: c.admission.claims.map((v) => v.id),
      reasons,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await this.store.create(s, p, actor);
    return p;
  }
  async advance(
    machineId: string,
    id: string,
    input: unknown,
    actor: PowerActor,
  ) {
    const body = PowerPreviewAdvanceSchema.parse(input),
      now = this.now();
    const s = await this.store.load(machineId, now),
      previous = await this.store.get(machineId, id);
    if (body.expectedVersion !== previous.version)
      throw new ApplicationError("conflict");
    let p;
    try {
      p = PowerPreviewStateSchema.parse(
        advancePowerPreview(s.context, previous, body.event, now, randomUUID()),
      );
    } catch {
      throw new ApplicationError("invalid_request");
    }
    await this.store.save(s, previous, p, actor);
    return p;
  }
  /** A restart advances only an existing restore duty. It never starts another cut or real action. */
  async recover() {
    for (const machineId of await this.store.restoreMachines(this.now())) {
      const previews = await this.store.list(machineId);
      for (const p of previews)
        if (
          p.restoreRequired &&
          p.phase === "off_wait" &&
          p.restoreNotBeforeMs !== null &&
          p.restoreNotBeforeMs <= this.now()
        )
          await this.advance(
            machineId,
            p.id,
            { expectedVersion: p.version, event: { kind: "evaluate" } },
            {
              operatorId: "controller",
              requestId: randomUUID(),
              actorType: "controller",
            },
          );
    }
  }
}

/** Bounded background continuation owns virtual restoration even when no browser is open. */
export function startPowerRecovery(
  service: PowerService,
  onError: (error: unknown) => void,
  intervalMs = 5000,
) {
  let pending: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = service
      .recover()
      .catch(onError)
      .finally(() => {
        pending = null;
      });
  }, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}
