import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileJournal } from "../src/journal.js";
it("expires completed receipts but preserves unknown effects and active/revoked fences", async () => {
  const dir = await mkdtemp("/private/tmp/hitchlet-journal-retention-");
  try {
    const journal = new FileJournal(join(dir, "journal.json"));
    await journal.initialize();
    const result = {
      commandId: "done",
      operationId: "operation",
      allocationId: "allocation",
      generation: 1,
      nativeEngineId: "engine",
      status: "removed" as const,
      rulesetHash: null,
      verifiedAt: new Date(1).toISOString(),
    };
    journal.setCommand("done", {
      hash: "hash",
      notAfterMs: 1,
      allocationId: "removed",
      result,
    });
    journal.setCommand("unknown", {
      hash: "hash",
      notAfterMs: 1,
      allocationId: "unknown",
      result: { ...result, status: "unknown" },
    });
    for (const state of ["active", "revoked", "removed"] as const)
      journal.setAllocation(state, {
        generation: 1,
        controlVersion: 1,
        state,
        rulesetHash: null,
      });
    journal.setAllocation("unknown", {
      generation: 1,
      controlVersion: 1,
      state: "removed",
      rulesetHash: null,
    });
    journal.prune(Date.now() + 9 * 86400000);
    expect(journal.commandMap.done).toBeUndefined();
    expect(journal.commandMap.unknown).toBeDefined();
    expect(Object.keys(journal.allocationMap).sort()).toEqual([
      "active",
      "revoked",
      "unknown",
    ]);
    await journal.save();
    const reopened = new FileJournal(join(dir, "journal.json"));
    await reopened.initialize();
    expect(reopened.commandMap.unknown).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
