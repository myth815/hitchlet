import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeReceiptFailureCode,
  saveNativeWorkloadObservation,
  type NativeWorkloadObservation,
} from "../src/host-power-storage.js";
import {
  NativeObserverDiagnosticSchema,
  WorkloadInventorySchema,
} from "../src/host-power.js";

function observation(): NativeWorkloadObservation {
  return {
    observedAt: "2026-11-08T09:00:00.000Z",
    executorPid: 42,
    guardHash: "a".repeat(64),
    executorHash: "b".repeat(64),
    inventoryStartedAtMs: 1000,
    inventoryEndedAtMs: 3400,
    hostProbeEndedAtMs: 4000,
    workloadCheckedAtMs: 4010,
    inventoryComplete: true,
    baseProbeStatus: "partial",
    baseErrorCodes: ["unmanaged_activity_unproven"],
    diagnostics: [],
    receipt: {
      stage: "valid",
      code: null,
      observedAt: "2026-11-08T08:59:58.000Z",
      ageMs: 2000,
      producerPid: 99,
    },
    reasons: ["wsl_unmanaged_native_work"],
    workloadComplete: true,
    sessionsComplete: true,
    sessionCount: 0,
    activeInteraction: false,
    probeStatus: "complete",
  };
}
it("retains the actual incomplete sample when the next busy observation is complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "power-observation-"));
  try {
    const journal = join(dir, "journal"),
      incomplete = observation(),
      complete = observation();
    incomplete.reasons = [
      "wsl_receipt_invalid",
      "wsl_workload_evidence_missing",
    ];
    incomplete.receipt = {
      ...incomplete.receipt,
      stage: "invalid",
      code: "wsl_receipt_stale_or_unbound",
      ageMs: 5100,
    };
    incomplete.workloadComplete = false;
    incomplete.probeStatus = "partial";
    await saveNativeWorkloadObservation(journal, incomplete, incomplete);
    await saveNativeWorkloadObservation(journal, complete, incomplete);
    const saved = JSON.parse(
      await readFile(journal + ".workload-observation.json", "utf8"),
    );
    expect(saved.latest.probeStatus).toBe("complete");
    expect(saved.latest.reasons).toEqual(["wsl_unmanaged_native_work"]);
    expect(saved.lastIncomplete.receipt).toMatchObject({
      stage: "invalid",
      code: "wsl_receipt_stale_or_unbound",
      ageMs: 5100,
    });
    expect(saved.lastIncomplete.inventoryStartedAtMs).toBe(1000);
    expect(await readdir(dir)).toEqual(["journal.workload-observation.json"]);
    expect(
      (await stat(journal + ".workload-observation.json")).mode & 0o077,
    ).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("projects only bounded code and identity fields, never raw native data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "power-observation-"));
  try {
    const sample = Object.assign(observation(), {
      argv: "secret-value",
      environment: "secret-value",
    });
    sample.reasons = Array(100).fill("secret-value");
    sample.diagnostics = Array(100).fill({
      kind: "live_read_failed",
      pid: 1,
      parentPid: 2,
      stage: "secret-value",
      code: "secret-value",
      name: "secret-value",
      argv: "secret-value",
    });
    sample.receipt.code = "secret-value";
    const journal = join(dir, "journal");
    await saveNativeWorkloadObservation(journal, sample, sample);
    const raw = await readFile(journal + ".workload-observation.json", "utf8"),
      saved = JSON.parse(raw);
    expect(raw).not.toContain("secret-value");
    expect(saved.latest.reasons).toEqual(["unknown_workload_reason"]);
    expect(saved.latest.diagnostics).toHaveLength(32);
    expect(saved.latest.diagnosticCount).toBe(100);
    expect(raw.length).toBeLessThan(10000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("preserves only known receipt validation codes without leaking exception messages", () => {
  for (const code of [
    "wsl_receipt_stale_or_unbound",
    "wsl_receipt_producer_changed",
    "wsl_receipt_task_changed",
    "wsl_owner_coverage_incomplete",
  ])
    expect(nativeReceiptFailureCode(new Error(code))).toBe(code);
  expect(nativeReceiptFailureCode(new Error("private path and value"))).toBe(
    "wsl_receipt_schema_or_read_failed",
  );
  expect(
    nativeReceiptFailureCode({ message: "wsl_receipt_task_changed" }),
  ).toBe("wsl_receipt_schema_or_read_failed");
});
it("keeps candidate observer identity evidence bounded without allowing raw arguments or unrelated roles", async () => {
  const observer = {
    producerPid: 10,
    producerCreationTicks: "1000",
    chain: [
      {
        pid: 11,
        parentPid: 10,
        creationTicks: "1100",
        role: "powershell",
        status: "stable",
        ownerSid: "S-1-5-21-1000",
        imageSha256: "a".repeat(64),
        argvSha256: "b".repeat(64),
        argc: 5,
      },
    ],
  };
  expect(NativeObserverDiagnosticSchema.safeParse(observer).success).toBe(true);
  for (const change of [
    {
      ...observer,
      chain: [
        ...observer.chain,
        ...observer.chain,
        ...observer.chain,
        ...observer.chain,
        ...observer.chain,
      ],
    },
    { ...observer, chain: [{ ...observer.chain[0], argv: ["secret-value"] }] },
    {
      ...observer,
      chain: [{ ...observer.chain[0], role: "ordinary_user_node" }],
    },
    {
      ...observer,
      chain: [{ ...observer.chain[0], imageSha256: "private-path" }],
    },
  ])
    expect(NativeObserverDiagnosticSchema.safeParse(change).success).toBe(
      false,
    );
  const parsed = NativeObserverDiagnosticSchema.parse(observer),
    sample = observation();
  sample.diagnostics = [
    { kind: "new_instance", pid: 11, parentPid: 10, observer: parsed },
  ];
  const dir = await mkdtemp(join(tmpdir(), "power-observer-metadata-"));
  try {
    await saveNativeWorkloadObservation(join(dir, "journal"), sample, null);
    const saved = JSON.parse(
      await readFile(join(dir, "journal.workload-observation.json"), "utf8"),
    );
    expect(saved.latest.diagnostics[0].observer).toEqual(parsed);
    expect(saved.latest.inventoryComplete).toBe(true);
    expect(saved.latest.reasons).toEqual(["wsl_unmanaged_native_work"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("drops malformed optional observer telemetry without changing a genuine incomplete inventory", () => {
  const parsed = WorkloadInventorySchema.parse({
    bootRecordId: "1",
    bootTime: "2026-11-08T09:00:00.0000000Z",
    complete: false,
    wslRunning: false,
    runningTasks: [],
    processes: [],
    services: [],
    diagnostics: [
      {
        kind: "new_instance",
        pid: 11,
        name: "powershell.exe",
        parentPid: 10,
        observer: { argv: "private-value" },
      },
    ],
  });
  expect(parsed.complete).toBe(false);
  expect(parsed.diagnostics?.[0]?.kind).toBe("new_instance");
  expect(parsed.diagnostics?.[0]?.observer).toBeUndefined();
});
