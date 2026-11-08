import { expect, it } from "vitest";
import { hostSnapshotSchema } from "@hitchlet/contracts/internal";
import {
  powerEvidence,
  nativePowerEvidenceIsSafe,
  workloadObservationComplete,
} from "../src/host-power.js";
const id = "147eae63-b612-40f5-82b3-3ee921df5e3d";
const metadata = {
  machineId: id,
  agentId: id,
  bootId: id,
  sequence: 1,
  observedAt: "2026-11-07T18:00:00Z",
};
function sample() {
  return {
    sessions: [],
    sessionsComplete: true,
    activeInteraction: false as boolean | "unknown",
    resources: {
      cpuPercent: 1,
      memoryUsedBytes: 10,
      memoryTotalBytes: 100,
      memoryAvailableBytes: 90,
      memoryAvailableTotalBytes: 100,
      memoryAvailablePercent: 90,
      memoryPressurePercent: 10,
      memoryPressureSource: "windows_global_memory_status_ex" as const,
    },
    unmanagedActivityHold: null,
    probeStatus: "partial" as const,
    errorCodes: ["unmanaged_activity_unproven"],
  };
}
it("reports a measured busy backend as complete but never safe to shut down", () => {
  const reasons = ["running_wsl_workload", "wsl_container_work"];
  const e = powerEvidence(
    sample(),
    false,
    workloadObservationComplete(reasons),
  );
  expect(e.probeStatus).toBe("complete");
  expect(e.unmanagedActivityHold).toBe(true);
  expect(hostSnapshotSchema.safeParse({ ...metadata, ...e }).success).toBe(
    true,
  );
  expect(nativePowerEvidenceIsSafe(e)).toBe(false);
});
it("keeps a stale, foreign or incomplete observation partial instead of calling it busy-complete", () => {
  for (const reason of [
    "wsl_receipt_invalid",
    "wsl_workload_evidence_stale",
    "workload_inventory_incomplete",
    "executor_artifact_changed",
  ]) {
    const e = powerEvidence(
      sample(),
      false,
      workloadObservationComplete(["wsl_container_work", reason]),
    );
    expect(e.probeStatus).toBe("partial");
    expect(e.unmanagedActivityHold).toBe(true);
    expect(nativePowerEvidenceIsSafe(e)).toBe(false);
  }
});
it("does not emit an invalid complete snapshot while Windows input/lock state is unknown", () => {
  const e = powerEvidence(
    {
      ...sample(),
      activeInteraction: "unknown",
      errorCodes: ["windows_lock_state_unknown"],
    },
    true,
  );
  expect(e.probeStatus).toBe("partial");
  expect(hostSnapshotSchema.safeParse({ ...metadata, ...e }).success).toBe(
    true,
  );
  expect(nativePowerEvidenceIsSafe(e)).toBe(false);
});
it("preserves the clear, fully measured idle case", () => {
  const e = powerEvidence(sample(), true, workloadObservationComplete([]));
  expect(e.probeStatus).toBe("complete");
  expect(nativePowerEvidenceIsSafe(e)).toBe(true);
});
