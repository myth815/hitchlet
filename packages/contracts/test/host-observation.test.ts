import { describe, expect, it } from "vitest";
import {
  classifyFreshHumanPresence,
  classifyHumanPresence,
  hostSnapshotSchema,
} from "../src/host-observation.js";

const base = {
  machineId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  bootId: "00000000-0000-4000-8000-000000000003",
  sequence: 1,
  observedAt: "2026-10-20T00:00:00.000Z",
  probeStatus: "complete" as const,
  sessionsComplete: true,
  sessions: [],
  activeInteraction: false as const,
  resources: { cpuPercent: 2, memoryUsedBytes: 1, memoryTotalBytes: 2 },
  unmanagedActivityHold: false,
  errorCodes: [],
};

describe("physical host observations", () => {
  it("only calls a complete, measured, fresh empty enumeration absent", () => {
    const snapshot = hostSnapshotSchema.parse(base);
    expect(classifyHumanPresence(snapshot)).toBe("absent");
    expect(
      classifyFreshHumanPresence(
        snapshot,
        Date.parse(base.observedAt),
        Date.parse(base.observedAt) + 1_000,
        60_000,
      ),
    ).toBe("absent");
    expect(
      classifyFreshHumanPresence(
        snapshot,
        Date.parse(base.observedAt),
        Date.parse(base.observedAt) + 61_000,
        60_000,
      ),
    ).toBe("unknown");
  });

  it("keeps failed, partial, unknown, and missing evidence unknown", () => {
    const partial = hostSnapshotSchema.parse({
      ...base,
      probeStatus: "partial",
      sessionsComplete: false,
      resources: null,
      unmanagedActivityHold: null,
      errorCodes: ["session_probe_failed"],
    });
    expect(classifyHumanPresence(partial)).toBe("unknown");
    const failed = hostSnapshotSchema.parse({
      ...base,
      probeStatus: "failed",
      sessionsComplete: false,
      activeInteraction: "unknown",
      resources: null,
      unmanagedActivityHold: null,
      errorCodes: ["permission_denied"],
    });
    expect(classifyHumanPresence(failed)).toBe("unknown");
    expect(
      hostSnapshotSchema.safeParse({
        ...base,
        probeStatus: "complete",
        resources: null,
      }).success,
    ).toBe(false);
  });

  it("treats logged-in interactive sessions as occupied across lock/disconnect states", () => {
    for (const [connection, locked] of [
      ["connected", true],
      ["disconnected", false],
      ["unknown", "unknown"],
    ] as const) {
      const value = hostSnapshotSchema.parse({
        ...base,
        sessions: [
          {
            sessionId: "s1",
            principalRef: "redacted-subject",
            type: "console",
            connection,
            locked,
          },
        ],
      });
      expect(classifyHumanPresence(value)).toBe("present");
    }
  });

  it("counts independent service-account interactive logins without username heuristics", () => {
    const value = hostSnapshotSchema.parse({
      ...base,
      sessions: [
        {
          sessionId: "s2",
          principalRef: "service-account-redacted",
          type: "rdp",
          connection: "disconnected",
          locked: true,
        },
      ],
    });
    expect(classifyHumanPresence(value)).toBe("present");
  });

  it("rejects impossible scalar, identity, and cross-field inputs", () => {
    expect(
      classifyFreshHumanPresence(
        { ...hostSnapshotSchema.parse(base), observedAt: "invalid-timestamp" },
        Date.parse(base.observedAt),
        Date.parse(base.observedAt),
        30_000,
      ),
    ).toBe("unknown");
    expect(
      hostSnapshotSchema.safeParse({ ...base, sequence: -1 }).success,
    ).toBe(false);
    expect(
      hostSnapshotSchema.safeParse({ ...base, machineId: "not-an-id" }).success,
    ).toBe(false);
    expect(
      hostSnapshotSchema.safeParse({
        ...base,
        resources: { cpuPercent: 2, memoryUsedBytes: 3, memoryTotalBytes: 2 },
      }).success,
    ).toBe(false);
    expect(
      hostSnapshotSchema.safeParse({
        ...base,
        probeStatus: "failed",
        sessionsComplete: false,
        resources: null,
        unmanagedActivityHold: null,
        errorCodes: [],
      }).success,
    ).toBe(false);
  });
});
