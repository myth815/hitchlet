import { expect, it, vi } from "vitest";
import { createTartRecoveryTick } from "../src/application/tart-recovery.js";
import { ControllerBackgroundLoops } from "../src/application/portainer-background.js";

it("starts lease and cleanup lanes while slow startup replay holds scheduling", async () => {
  let releaseReplay!: () => void;
  const replay = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });
  const worker = {
    reconcileBeforeScheduling: vi.fn(async () => {
      await replay;
      return 0;
    }),
    reconcileScheduledWork: vi.fn(async () => 0),
    reconcile: vi.fn(async () => 0),
    reconcileCleanupLane: vi.fn(async () => 0),
    reconcileExpiries: vi.fn(async () => 0),
  };
  const tickets = { reserveNext: vi.fn(async () => null) };
  const leases = { reconcilePending: vi.fn(async () => 0) };
  const tick = createTartRecoveryTick({ worker, tickets, leases });
  const loops = new ControllerBackgroundLoops({
    refreshObservations: async () => undefined,
    reconcile: tick,
    reconcileCleanup: () => worker.reconcileCleanupLane(),
    reconcileLeaseIntents: async () => {
      await leases.reconcilePending();
      await worker.reconcileExpiries();
    },
    onReconcileSuccess: () => undefined,
    onLeaseSuccess: () => undefined,
    onCleanupSuccess: () => undefined,
    onFailure: (_kind, error) => {
      throw error;
    },
  });

  loops.start();
  await vi.waitFor(() => {
    expect(worker.reconcileBeforeScheduling).toHaveBeenCalledOnce();
    expect(worker.reconcileCleanupLane).toHaveBeenCalledOnce();
    expect(leases.reconcilePending).toHaveBeenCalledOnce();
  });
  expect(tickets.reserveNext).not.toHaveBeenCalled();

  releaseReplay();
  await vi.waitFor(() => expect(tickets.reserveNext).toHaveBeenCalledOnce());
  await loops.close();
  expect(worker.reconcileScheduledWork).toHaveBeenCalledOnce();
});
