import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PowerPolicySchema,
  PowerPreviewStateSchema,
  SmartPlugBindingSchema,
} from "@hitchlet/contracts/admin";
import {
  shutdownReasons,
  powerConditionKey,
  advancePowerPreview,
  type PowerContext,
} from "../src/domain/power.js";
import { HumanUsePolicySchema } from "@hitchlet/contracts/admin";
const now = 1792454400000;
const amounts = (n: number) => ({ cpuMillis: n, memoryMiB: n, scratchMiB: n });
function context(): PowerContext {
  const machineId = randomUUID();
  return {
    machineId,
    machineVersion: 1,
    machineEpoch: 1,
    controllerEpoch: 1,
    policyVersion: 1,
    policy: PowerPolicySchema.parse({
      enabled: true,
      idleAction: "shutdown",
      idleSeconds: 10,
      wakeOnDemand: true,
    }),
    binding: null,
    capabilities: {
      sleep: "verified",
      normalShutdown: "verified",
      wakeFromSleep: "verified",
      coldBoot: "verified",
      wolWhilePossiblyOn: "verified",
      wakeRouteRef: randomUUID(),
      verificationReportIds: [randomUUID()],
    },
    operations: [],
    allocations: [],
    admission: {
      machineId,
      source: "local",
      admission: "enabled",
      power: "on",
      policy: HumanUsePolicySchema.parse({
        blockShutdownForAnyInteractiveSession: true,
        blockShutdownOnUnknownPresence: true,
        maximumObservationAgeSeconds: 30,
        admissionDuringInteraction: "block_new",
        humanReserved: amounts(0),
        systemReserve: amounts(100),
        attendedMaximum: amounts(500),
        unattendedMaximum: amounts(800),
        cpuPressureLimitPercent: 80,
        memoryPressureLimitPercent: 80,
      }),
      pools: [
        {
          id: "pool",
          parentAllocationId: null,
          capacity: amounts(1000),
          reserve: amounts(100),
        },
      ],
      claims: [],
      allocations: [],
      holds: [],
      nodes: [
        {
          id: "node",
          name: "node",
          poolId: "pool",
          admission: "enabled",
          observedHealth: "healthy",
          observedAtMs: now,
          manualInventory: false,
          capabilityExpiresAtMs: now + 900000,
        },
      ],
      observation: {
        authenticated: true,
        revoked: false,
        receivedAtMs: now,
        snapshot: {
          machineId,
          agentId: randomUUID(),
          bootId: randomUUID(),
          sequence: 1,
          observedAt: new Date(now).toISOString(),
          probeStatus: "complete",
          sessionsComplete: true,
          sessions: [],
          activeInteraction: false,
          unmanagedActivityHold: false,
          resources: {
            cpuPercent: 1,
            memoryUsedBytes: 1,
            memoryTotalBytes: 100,
          },
          errorCodes: [],
        },
      },
    },
  };
}
function state(c: PowerContext) {
  return PowerPreviewStateSchema.parse({
    id: randomUUID(),
    machineId: c.machineId,
    version: 1,
    dryRun: true,
    executable: false,
    mode: "idle_shutdown",
    phase: "idle",
    policyVersion: c.policyVersion,
    machineVersion: c.machineVersion,
    machineEpoch: c.machineEpoch,
    virtualEpoch: c.machineEpoch,
    controllerEpoch: c.controllerEpoch,
    bootId: c.admission.observation!.snapshot.bootId,
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
    minimumOffSeconds: 600,
    restoreRequired: false,
    supplyRestoredAtMs: null,
    restoreNotBeforeMs: null,
    incidentId: null,
    binding: c.binding,
    riskAcknowledgement: null,
    affectedClaimIds: [],
    reasons: [],
    createdAtMs: now,
    updatedAtMs: now,
  });
}
function ready(c = context()) {
  let p = advancePowerPreview(
    c,
    state(c),
    { kind: "evaluate" },
    now,
    randomUUID(),
  );
  p = advancePowerPreview(
    c,
    p,
    { kind: "evaluate" },
    now + 10000,
    randomUUID(),
  );
  expect(p.phase).toBe("draining");
  return { c, p };
}
describe("isolated power decisions", () => {
  it.each(["present", "unknown", "partial", "stale", "revoked", "manual"])(
    "%s evidence cannot drain",
    (kind) => {
      const c = context(),
        h = c.admission.observation!;
      if (kind === "present")
        h.snapshot.sessions.push({
          sessionId: "session",
          principalRef: "private",
          type: "rdp",
          connection: "disconnected",
          locked: true,
        });
      if (kind === "unknown") h.snapshot.activeInteraction = "unknown";
      if (kind === "partial") h.snapshot.probeStatus = "partial";
      if (kind === "stale") h.receivedAtMs -= 31000;
      if (kind === "revoked") h.authenticated = false;
      if (kind === "manual") c.admission.nodes[0]!.manualInventory = true;
      expect(shutdownReasons(c, now).length).toBeGreaterThan(0);
      expect(
        advancePowerPreview(
          c,
          state(c),
          { kind: "evaluate" },
          now,
          randomUUID(),
        ).idleSinceMs,
      ).toBeNull();
    },
  );
  it.each(["claim", "preparing", "cleanup", "unknown_operation", "hold"])(
    "%s protects power without hiding capacity",
    (kind) => {
      const c = context();
      if (kind === "claim")
        c.admission.claims.push({
          id: "claim",
          allocationId: "a",
          poolId: "pool",
          state: "quarantined",
          resources: amounts(1),
        });
      if (kind === "preparing" || kind === "cleanup")
        c.allocations.push({
          id: "a",
          purpose: "validation",
          desiredState: kind === "preparing" ? "present" : "absent",
          observedState: "unknown",
          cleanupStatus: "pending",
        });
      if (kind === "unknown_operation")
        c.operations.push({
          id: "op",
          kind: "network.change",
          state: "unknown",
        });
      if (kind === "hold")
        c.admission.holds.push({
          id: "hold",
          kind: "infrastructure",
          reason: "WOL relay dependency",
        });
      expect(shutdownReasons(c, now).length).toBeGreaterThan(0);
    },
  );
  it("requires continuous sampling and resets idle after condition changes", () => {
    const c = context();
    let p = advancePowerPreview(
      c,
      state(c),
      { kind: "evaluate" },
      now,
      randomUUID(),
    );
    c.admission.observation!.receivedAtMs = now + 31000;
    c.admission.observation!.snapshot.observedAt = new Date(
      now + 31000,
    ).toISOString();
    p = advancePowerPreview(
      c,
      p,
      { kind: "evaluate" },
      now + 31000,
      randomUUID(),
    );
    expect(p.phase).toBe("idle");
    expect(p.idleSinceMs).toBe(now + 31000);
    const { c: c2, p: p2 } = ready();
    c2.admission.holds.push({ id: "new", kind: "manual", reason: "new work" });
    const failed = advancePowerPreview(
      c2,
      p2,
      { kind: "accept_shutdown", simulatedLocalCheck: "complete_absent_clear" },
      now + 10001,
      randomUUID(),
    );
    expect(failed.phase).toBe("idle");
    expect(failed.acceptedReceiptId).toBeNull();
  });
  it("expires final local review after 5 seconds and fences old epochs", () => {
    const { c, p } = ready();
    expect(
      advancePowerPreview(
        c,
        p,
        {
          kind: "accept_shutdown",
          simulatedLocalCheck: "complete_absent_clear",
        },
        now + 15001,
        randomUUID(),
      ).phase,
    ).toBe("idle");
    c.machineEpoch++;
    expect(
      advancePowerPreview(
        c,
        p,
        {
          kind: "accept_shutdown",
          simulatedLocalCheck: "complete_absent_clear",
        },
        now + 10001,
        randomUUID(),
      ).phase,
    ).toBe("cancelled");
  });
  it("only owned accepted shutdown plus stopped heartbeat and >=120s yields expected, never observed off", () => {
    const { c, p } = ready();
    let q = advancePowerPreview(
      c,
      p,
      { kind: "accept_shutdown", simulatedLocalCheck: "complete_absent_clear" },
      now + 10001,
      randomUUID(),
    );
    expect(q.phase).toBe("shutdown_requested");
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      now + 130000,
      randomUUID(),
    );
    expect(q.phase).toBe("shutdown_requested");
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      now + 130001,
      randomUUID(),
    );
    expect(q.phase).toBe("off_expected");
    expect(q.observedPower).toBe("unknown");
    q = advancePowerPreview(
      c,
      q,
      { kind: "wake", provisionDeadlineMs: now + 500000 },
      now + 130001,
      randomUUID(),
    );
    expect(q.phase).toBe("waking");
    expect(q.wakeAttempts).toBe(1);
    q = advancePowerPreview(
      c,
      q,
      { kind: "wake", provisionDeadlineMs: now + 500000 },
      now + 130002,
      randomUUID(),
    );
    expect(q.wakeAttempts).toBe(1);
    q = advancePowerPreview(
      c,
      q,
      { kind: "wake", provisionDeadlineMs: now + 900000 },
      now + 160001,
      randomUUID(),
    );
    expect(q.wakeAttempts).toBe(2);
    expect(q.deadlineMs).toBe(now + 310001);
    q = advancePowerPreview(
      c,
      q,
      { kind: "wake", provisionDeadlineMs: now + 900000 },
      now + 190001,
      randomUUID(),
    );
    expect(q.wakeAttempts).toBe(3);
    q = advancePowerPreview(
      c,
      q,
      { kind: "wake", provisionDeadlineMs: now + 900000 },
      now + 220001,
      randomUUID(),
    );
    expect(q.phase).toBe("manual");
  });
  it.each(["shutdown_requested", "off_expected"] as const)(
    "expired %s never reopens a wake window",
    (phase) => {
      const { c, p } = ready();
      let q = advancePowerPreview(
        c,
        p,
        {
          kind: "accept_shutdown",
          simulatedLocalCheck: "complete_absent_clear",
        },
        now + 10001,
        randomUUID(),
      );
      if (phase === "off_expected")
        q = advancePowerPreview(
          c,
          q,
          { kind: "evaluate" },
          now + 130001,
          randomUUID(),
        );
      q = advancePowerPreview(
        c,
        q,
        { kind: "wake", provisionDeadlineMs: now + 9000000 },
        q.deadlineMs!,
        randomUUID(),
      );
      expect(q.phase).toBe("manual");
      expect(q.observedPower).toBe("unknown");
      expect(q.wakeAttempts).toBe(0);
      expect(q.acceptedReceiptId).toBeNull();
    },
  );
  it("does not wake ordinary unknown or unsafe expected off; fresh heartbeat invalidates inference", () => {
    const c = context();
    expect(
      advancePowerPreview(
        c,
        state(c),
        { kind: "wake", provisionDeadlineMs: now + 10000 },
        now,
        randomUUID(),
      ).wakeAttempts,
    ).toBe(0);
    const { p } = ready(c);
    let q = advancePowerPreview(
      c,
      p,
      { kind: "accept_shutdown", simulatedLocalCheck: "complete_absent_clear" },
      now + 10001,
      randomUUID(),
    );
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      now + 130001,
      randomUUID(),
    );
    c.capabilities.wolWhilePossiblyOn = "unverified";
    expect(
      advancePowerPreview(
        c,
        q,
        { kind: "wake", provisionDeadlineMs: now + 500000 },
        now + 130001,
        randomUUID(),
      ).wakeAttempts,
    ).toBe(0);
    c.admission.observation!.snapshot.observedAt = new Date(
      now + 130002,
    ).toISOString();
    c.admission.observation!.receivedAtMs = now + 130002;
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      now + 130002,
      randomUUID(),
    );
    expect(q.phase).toBe("manual");
    expect(q.acceptedReceiptId).toBeNull();
  });
  it("trusted simulated off confirmation is distinct from accepted; deadline cannot be extended", () => {
    const { c, p } = ready();
    let q = advancePowerPreview(
      c,
      p,
      { kind: "accept_shutdown", simulatedLocalCheck: "complete_absent_clear" },
      now + 10001,
      randomUUID(),
    );
    q = advancePowerPreview(
      c,
      q,
      { kind: "confirm_off", evidenceId: randomUUID() },
      now + 11000,
      randomUUID(),
    );
    expect(q.phase).toBe("off_confirmed");
    expect(q.observedPower).toBe("off");
    q = advancePowerPreview(
      c,
      q,
      { kind: "wake", provisionDeadlineMs: now + 11001 },
      now + 11000,
      randomUUID(),
    );
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      now + 11001,
      randomUUID(),
    );
    expect(q.phase).toBe("manual");
  });
  it("a new authenticated healthy boot completes bounded wake while a same-boot heartbeat only invalidates shutdown", () => {
    const { c, p } = ready();
    let q = advancePowerPreview(
      c,
      p,
      { kind: "accept_shutdown", simulatedLocalCheck: "complete_absent_clear" },
      now + 10001,
      randomUUID(),
    );
    q = advancePowerPreview(
      c,
      q,
      { kind: "confirm_off", evidenceId: randomUUID() },
      now + 11000,
      randomUUID(),
    );
    q = advancePowerPreview(
      c,
      q,
      { kind: "wake", provisionDeadlineMs: now + 100000 },
      now + 11000,
      randomUUID(),
    );
    c.admission.observation!.snapshot.bootId = randomUUID();
    c.admission.observation!.snapshot.observedAt = new Date(
      now + 12000,
    ).toISOString();
    c.admission.observation!.receivedAtMs = now + 12000;
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      now + 12000,
      randomUUID(),
    );
    expect(q.phase).toBe("complete");
    expect(q.acceptedReceiptId).toBeNull();
  });
  it("exact plug identity, lost off result, restart deadline, cancellation and changed epochs retain restore duty", () => {
    const c = context();
    c.binding = SmartPlugBindingSchema.parse({
      id: randomUUID(),
      machineId: c.machineId,
      adapter: "xiaomi_miio_lan",
      device: {
        model: "cuco.plug.v3",
        deviceId: "12345",
        macAddress: "aa:bb:cc:dd:ee:ff",
      },
      endpointRef: "endpoint:test",
      credentialVersionRef: `secret:${"1".repeat(32)}`,
      dedicatedSupply: "unverified",
      acPowerOn: "unverified",
      verificationReportIds: [],
      version: 1,
    });
    let p = {
      ...state(c),
      mode: "fault_recovery" as const,
      phase: "inspect" as const,
      binding: c.binding,
    };
    const read = (state: "on" | "off" | "unknown", deviceId = "12345") => ({
      kind: "plug_readback" as const,
      state,
      deviceId,
      macAddress: "AA:BB:CC:DD:EE:FF",
    });
    let q = advancePowerPreview(c, p, read("on", "6789"), now, randomUUID());
    expect(q.phase).toBe("inspect");
    q = advancePowerPreview(c, q, read("on"), now, randomUUID());
    expect(q.phase).toBe("off_pending");
    expect(q.restoreRequired).toBe(true);
    q = advancePowerPreview(
      c,
      q,
      { kind: "off_result_unknown" },
      now,
      randomUUID(),
    );
    expect(q.phase).toBe("inspect_off");
    q = advancePowerPreview(c, q, read("unknown"), now + 1000, randomUUID());
    expect(q.phase).toBe("inspect_off");
    q = advancePowerPreview(c, q, read("off"), now + 2000, randomUUID());
    const deadline = now + 602000;
    expect(q.restoreNotBeforeMs).toBe(deadline);
    c.controllerEpoch++;
    c.machineEpoch++;
    c.policyVersion++;
    c.binding = null;
    q = advancePowerPreview(c, q, { kind: "cancel" }, now + 3000, randomUUID());
    expect(q.restoreRequired).toBe(true);
    q = advancePowerPreview(
      c,
      JSON.parse(JSON.stringify(q)),
      read("off"),
      now + 5000,
      randomUUID(),
    );
    expect(q.restoreNotBeforeMs).toBe(deadline);
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      deadline - 1,
      randomUUID(),
    );
    expect(q.phase).toBe("off_wait");
    q = advancePowerPreview(c, q, { kind: "evaluate" }, deadline, randomUUID());
    expect(q.phase).toBe("on_pending");
    q = advancePowerPreview(c, q, read("on"), deadline + 1, randomUUID());
    expect(q.phase).toBe("verifying");
    expect(q.restoreRequired).toBe(false);
    expect(q.binding!.credentialVersionRef).toBe(
      p.binding!.credentialVersionRef,
    );
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      deadline + 2,
      randomUUID(),
    );
    expect(q.phase).toBe("verifying");
    c.admission.observation!.snapshot.bootId = randomUUID();
    c.admission.observation!.snapshot.observedAt = new Date(
      deadline + 3,
    ).toISOString();
    c.admission.observation!.receivedAtMs = deadline + 3;
    c.admission.nodes[0]!.observedAtMs = deadline + 3;
    q = advancePowerPreview(
      c,
      q,
      { kind: "evaluate" },
      deadline + 3,
      randomUUID(),
    );
    expect(q.phase).toBe("complete");
  });
});
