import { describe, it, expect } from "vitest";
import { HumanUsePolicySchema } from "@hitchlet/contracts/admin";
import {
  evaluateMachineAdmission,
  zeroResources,
  type MachineAdmissionContext,
} from "../src/domain/human-use.js";

const now = Date.parse("2026-10-20T00:00:00Z");
const amounts = (
  cpuMillis: number,
  memoryMiB = cpuMillis,
  scratchMiB = cpuMillis,
) => ({ cpuMillis, memoryMiB, scratchMiB });
function fixture(): MachineAdmissionContext {
  return {
    machineId: "m",
    source: "local",
    admission: "enabled",
    power: "on",
    policy: HumanUsePolicySchema.parse({
      blockShutdownForAnyInteractiveSession: true,
      blockShutdownOnUnknownPresence: true,
      maximumObservationAgeSeconds: 30,
      admissionDuringInteraction: "within_reserved_budget",
      humanReserved: amounts(100),
      systemReserve: amounts(200),
      attendedMaximum: amounts(600),
      unattendedMaximum: amounts(800),
      cpuPressureLimitPercent: 80,
      memoryPressureLimitPercent: 80,
    }),
    pools: [
      {
        id: "root",
        parentAllocationId: null,
        capacity: amounts(1000),
        reserve: amounts(200),
      },
    ],
    nodes: [
      {
        id: "n",
        name: "node",
        poolId: "root",
        admission: "enabled",
        observedHealth: "healthy",
        observedAtMs: now,
        manualInventory: false,
        capabilityExpiresAtMs: now + 600_000,
      },
    ],
    allocations: [],
    claims: [],
    holds: [],
    observation: {
      receivedAtMs: now,
      authenticated: true,
      revoked: false,
      snapshot: {
        machineId: "m",
        agentId: "agent",
        bootId: "boot",
        sequence: 1,
        observedAt: new Date(now).toISOString(),
        probeStatus: "complete",
        sessionsComplete: true,
        sessions: [],
        activeInteraction: false,
        resources: {
          cpuPercent: 20,
          memoryUsedBytes: 200,
          memoryTotalBytes: 1000,
        },
        unmanagedActivityHold: false,
        errorCodes: [],
      },
    },
  };
}
describe("one Machine human-use and physical-budget admission rule", () => {
  it("dedicated use is not an observation or pressure bypass; unknown workload is never false", () => {
    const c = fixture();
    c.observation!.snapshot.unmanagedActivityHold = null;
    c.observation!.snapshot.probeStatus = "partial";
    c.policy!.admissionDuringInteraction = "block_new";
    expect(evaluateMachineAdmission(c, now, "n", amounts(1)).reasons).toContain(
      "Unmanaged activity is unknown or held",
    );
    c.observation!.snapshot.unmanagedActivityHold = false;
    c.observation!.snapshot.probeStatus = "complete";
    c.observation!.snapshot.resources!.cpuPercent = 80;
    expect(evaluateMachineAdmission(c, now, "n").allowed).toBe(false);
  });
  it.each(["locked", "disconnected", "fast-user-switch"])(
    "protects %s sessions while honoring the explicit attended allocation budget",
    (kind) => {
      const c = fixture();
      c.observation!.snapshot.sessions = [
        {
          sessionId: "session",
          principalRef: "redacted",
          type: "rdp",
          connection: kind === "disconnected" ? "disconnected" : "connected",
          locked: kind === "locked" ? true : "unknown",
        },
      ];
      expect(evaluateMachineAdmission(c, now, "n", amounts(600)).allowed).toBe(
        true,
      );
      expect(evaluateMachineAdmission(c, now, "n", amounts(601)).allowed).toBe(
        false,
      );
      expect(evaluateMachineAdmission(c, now, "n").shutdownReasons).toContain(
        "Human presence is present",
      );
      c.policy!.admissionDuringInteraction = "block_new";
      expect(evaluateMachineAdmission(c, now, "n").allowed).toBe(false);
    },
  );
  it.each(["stale", "future", "incomplete", "failed", "revoked"])(
    "fails closed on %s evidence and caps policy TTL at Host protocol age",
    (kind) => {
      const c = fixture();
      c.policy!.maximumObservationAgeSeconds = 3600;
      if (kind === "stale")
        c.observation!.snapshot.observedAt = new Date(
          now - 30_001,
        ).toISOString();
      if (kind === "future")
        c.observation!.snapshot.observedAt = new Date(now + 1).toISOString();
      if (kind === "incomplete") {
        c.observation!.snapshot.probeStatus = "partial";
        c.observation!.snapshot.sessionsComplete = false;
      }
      if (kind === "failed") {
        c.observation!.snapshot.probeStatus = "failed";
        c.observation!.snapshot.errorCodes = ["FAILED"];
      }
      if (kind === "revoked") {
        c.observation!.authenticated = false;
        c.observation!.revoked = true;
      }
      expect(evaluateMachineAdmission(c, now, "n").allowed).toBe(false);
      expect(
        evaluateMachineAdmission(c, now, "n").shutdownReasons.length,
      ).toBeGreaterThan(1);
    },
  );
  it("charges all Machine sibling claims, including reserved, quarantined, and validation; ignores only released", () => {
    const c = fixture();
    c.nodes.push({ ...c.nodes[0]!, id: "n2" });
    for (const [index, state] of [
      "reserved",
      "committed",
      "quarantined",
      "released",
    ].entries()) {
      c.allocations.push({
        id: `a${index}`,
        nodeId: "n2",
        purpose: index === 1 ? "validation" : "tenant",
        desiredState: "absent",
        observedState: "unknown",
        cleanupStatus: "blocked",
      });
      c.claims.push({
        id: `c${index}`,
        allocationId: `a${index}`,
        poolId: "root",
        state,
        resources: amounts(200),
      });
    }
    expect(evaluateMachineAdmission(c, now, "n", amounts(201)).allowed).toBe(
      false,
    );
    const result = evaluateMachineAdmission(c, now, "n", amounts(200));
    expect(result.allowed).toBe(true);
    expect(result.physicalUsage).toEqual(amounts(600));
    c.observation!.snapshot.activeInteraction = true;
    expect(evaluateMachineAdmission(c, now, "n", amounts(1)).allowed).toBe(
      false,
    );
    expect(c.claims.filter((c) => c.state !== "released")).toHaveLength(3);
  });
  it("subtracts platform/human reserve once and keeps root and child envelopes separate", () => {
    const c = fixture();
    expect(evaluateMachineAdmission(c, now, "n", amounts(800)).allowed).toBe(
      true,
    );
    c.allocations.push({
      id: "base",
      nodeId: "n",
      purpose: "infrastructure",
      desiredState: "present",
      observedState: "running",
      cleanupStatus: "pending",
    });
    c.claims.push({
      id: "backing",
      allocationId: "base",
      poolId: "root",
      state: "committed",
      resources: amounts(800),
    });
    c.pools.push({
      id: "child",
      parentAllocationId: "base",
      capacity: amounts(800),
      reserve: zeroResources(),
    });
    c.nodes.push({ ...c.nodes[0]!, id: "cn", poolId: "child" });
    c.allocations.push({
      id: "tenant",
      nodeId: "cn",
      purpose: "tenant",
      desiredState: "absent",
      observedState: "unknown",
      cleanupStatus: "blocked",
    });
    c.claims.push({
      id: "nested",
      allocationId: "tenant",
      poolId: "child",
      state: "quarantined",
      resources: amounts(700),
    });
    const result = evaluateMachineAdmission(c, now, "cn", amounts(100));
    expect(result.allowed).toBe(true);
    expect(result.physicalUsage).toEqual(amounts(800));
    expect(result.workloadUsage).toEqual(amounts(700));
    expect(evaluateMachineAdmission(c, now, "cn", amounts(101)).allowed).toBe(
      false,
    );
    c.pools.push({
      id: "overlapping",
      parentAllocationId: "base",
      capacity: amounts(1),
      reserve: zeroResources(),
    });
    expect(evaluateMachineAdmission(c, now, "cn").allowed).toBe(false);
  });
  it.each([null, false])(
    "admits positive partial sessions with unmanaged=%s under the attended envelope without claiming complete workload evidence",
    (unmanaged) => {
      const c = fixture();
      c.observation!.snapshot.probeStatus = "partial";
      c.observation!.snapshot.sessionsComplete = false;
      c.observation!.snapshot.unmanagedActivityHold = unmanaged;
      c.observation!.snapshot.sessions = [
        {
          sessionId: "known",
          principalRef: "redacted",
          type: "console",
          connection: "connected",
          locked: "unknown",
        },
      ];
      const result = evaluateMachineAdmission(c, now, "n", amounts(600));
      expect(result.allowed).toBe(true);
      expect(result.admissionAssurance).toBe("bounded_partial_host");
      expect(result.hostObservation.unmanagedActivityHold).toBe(unmanaged);
      expect(result.hostObservation.humanPresence).toBe("present");
      expect(evaluateMachineAdmission(c, now, "n", amounts(601)).allowed).toBe(
        false,
      );
      c.observation!.snapshot.unmanagedActivityHold = true;
      expect(evaluateMachineAdmission(c, now, "n").allowed).toBe(false);
    },
  );
  it.each(["missing", "stale", "revoked", "failed", "unknown"])(
    "does not label %s Host evidence complete",
    (state) => {
      const c = fixture();
      if (state === "missing") c.observation = null;
      if (state === "stale")
        c.observation!.snapshot.observedAt = new Date(
          now - 30_001,
        ).toISOString();
      if (state === "revoked") {
        c.observation!.authenticated = false;
        c.observation!.revoked = true;
      }
      if (state === "failed") {
        c.observation!.snapshot.probeStatus = "failed";
        c.observation!.snapshot.errorCodes = ["FAILED"];
      }
      if (state === "unknown") {
        c.observation!.snapshot.probeStatus = "partial";
        c.observation!.snapshot.sessionsComplete = false;
      }
      const result = evaluateMachineAdmission(c, now, "n");
      expect(result.allowed).toBe(false);
      expect(result.admissionAssurance).toBe("unavailable_host");
    },
  );
  it("keeps fresh complete Host evidence on the complete path even under within_reserved_budget", () => {
    const result = evaluateMachineAdmission(fixture(), now, "n");
    expect(result.allowed).toBe(true);
    expect(result.admissionAssurance).toBe("complete_host");
  });
  it("keeps the explicit M1 static trial separate from shared-host evidence", () => {
    const c = fixture();
    c.nodes[0]!.manualInventory = true;
    c.observation = null;
    c.policy = null;
    const result = evaluateMachineAdmission(c, now, "n", amounts(800));
    expect(result.allowed).toBe(true);
    expect(result.hostObservation.humanPresence).toBe("unknown");
    expect(result.hostObservation.unmanagedActivityHold).toBe(null);
    c.policyInvalid = true;
    expect(evaluateMachineAdmission(c, now, "n").allowed).toBe(false);
  });
  it("does not advertise admission when capability verification has expired even if the Node was probed healthy", () => {
    const c = fixture();
    c.nodes[0]!.capabilityExpiresAtMs = now;
    expect(evaluateMachineAdmission(c, now, "n").reasons).toContain(
      "Node capabilities are expired or unverified",
    );
  });
  it("accepts zero reserves/ceilings as safe integers and rejects unsafe or contradictory intentions", () => {
    const p = fixture().policy!;
    expect(
      HumanUsePolicySchema.parse({
        ...p,
        humanReserved: amounts(0),
        systemReserve: amounts(0),
        attendedMaximum: amounts(0),
        unattendedMaximum: amounts(0),
      }).humanReserved.cpuMillis,
    ).toBe(0);
    expect(() =>
      HumanUsePolicySchema.parse({ ...p, attendedMaximum: amounts(900) }),
    ).toThrow();
    expect(() =>
      HumanUsePolicySchema.parse({
        ...p,
        systemReserve: amounts(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow();
  });
});
