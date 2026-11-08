import { expect, it } from "vitest";
import { parseWindowsSessions } from "../src/host-probes.js";
import {
  classifyHumanPresence,
  hostSnapshotSchema,
} from "@hitchlet/contracts/internal";
import { nativePowerEvidenceIsSafe } from "../src/host-power.js";
const id = "147eae63-b612-40f5-82b3-3ee921df5e3d";
function input(
  flags: number | undefined,
  idle: number | null | undefined,
  state = 0,
) {
  return {
    physical: true,
    complete: true,
    memoryAvailableTotalBytes: 100,
    memoryAvailableBytes: 90,
    sessions: [
      {
        id: 1,
        user: "fixture-user",
        domain: "HOST",
        state,
        protocol: 0,
        ...(flags === undefined ? {} : { sessionFlags: flags }),
        ...(idle === undefined ? {} : { inputIdleMilliseconds: idle }),
      },
    ],
  };
}
function snapshot(e: ReturnType<typeof parseWindowsSessions>) {
  return hostSnapshotSchema.parse({
    machineId: id,
    agentId: id,
    bootId: id,
    sequence: 0,
    observedAt: "2026-11-07T19:00:00Z",
    probeStatus: e.complete ? "complete" : "partial",
    sessions: e.sessions,
    sessionsComplete: e.complete,
    activeInteraction: e.activeInteraction,
    resources: {
      cpuPercent: 1,
      memoryUsedBytes: 10,
      memoryTotalBytes: 100,
      memoryAvailableBytes: 90,
      memoryAvailableTotalBytes: 100,
      memoryAvailablePercent: 90,
      memoryPressurePercent: 10,
      memoryPressureSource: "windows_global_memory_status_ex",
    },
    unmanagedActivityHold: false,
    errorCodes: e.errors,
  });
}
it.each([
  [0, 100000, 0, true, false],
  [1, 100, 0, false, true],
  [1, 100000, 0, false, false],
  [1, 100000, 4, false, false],
] as const)(
  "reports real lock/input metadata without treating retained session %s/%s/%s absent",
  (flags, idle, state, locked, interaction) => {
    const e = parseWindowsSessions(input(flags, idle, state));
    expect(e).toMatchObject({
      complete: true,
      activeInteraction: interaction,
      errors: [],
      sessions: [{ locked }],
    });
    const s = snapshot(e);
    expect(classifyHumanPresence(s)).toBe("present");
    expect(nativePowerEvidenceIsSafe(s)).toBe(false);
    expect(JSON.stringify(s)).not.toContain("fixture-user");
  },
);
it("retains legacy/failed extended queries as unknown, never empty or safe", () => {
  const e = parseWindowsSessions(input(undefined, undefined));
  expect(e.sessions).toHaveLength(1);
  expect(e.sessions[0]!.locked).toBe("unknown");
  expect(e.complete).toBe(false);
  expect(e.activeInteraction).toBe("unknown");
  expect(e.errors).toContain("windows_lock_state_unknown");
  expect(e.errors).toContain("windows_input_state_unknown");
  expect(classifyHumanPresence(snapshot(e))).toBe("present");
});
it("does not reinterpret unknown lock flags or a connection race as complete", () => {
  for (const raw of [input(-1, 100), input(1, 100, 3)]) {
    const e = parseWindowsSessions(raw);
    expect(e.complete).toBe(false);
    expect(classifyHumanPresence(snapshot(e))).toBe("present");
  }
});
it("keeps missing input facts unknown when the unlocked session has no valid time", () => {
  const e = parseWindowsSessions(input(1, null));
  expect(e.complete).toBe(false);
  expect(e.activeInteraction).toBe("unknown");
  expect(e.errors).toContain("windows_input_state_unknown");
});
it("only a complete empty enumeration proves no logged-in sessions", () => {
  const absent = parseWindowsSessions({
    physical: true,
    complete: true,
    memoryAvailableTotalBytes: 100,
    memoryAvailableBytes: 90,
    sessions: [],
  });
  expect(classifyHumanPresence(snapshot(absent))).toBe("absent");
  expect(nativePowerEvidenceIsSafe(snapshot(absent))).toBe(true);
  const unknown = parseWindowsSessions({
    physical: true,
    complete: false,
    memoryAvailableTotalBytes: 100,
    memoryAvailableBytes: 90,
    sessions: [],
  });
  expect(classifyHumanPresence(snapshot(unknown))).toBe("unknown");
});
