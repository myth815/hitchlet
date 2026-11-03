import type { LeaseService } from "./leases.js";
import type { OperationWorker } from "./operations.js";
import type { TicketService } from "./tickets.js";

/** Keeps startup replay on the main lane and delays new reservations until it settles. */
export function createTartRecoveryTick(input: {
  worker: Pick<
    OperationWorker,
    "reconcileBeforeScheduling" | "reconcileScheduledWork" | "reconcile"
  >;
  tickets: Pick<TicketService, "reserveNext">;
  leases: Pick<LeaseService, "reconcilePending">;
}) {
  let initialRecoveryComplete = false;
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      if (!initialRecoveryComplete) {
        await input.worker.reconcileBeforeScheduling();
        await input.leases.reconcilePending();
        initialRecoveryComplete = true;
      }
      await input.worker.reconcileScheduledWork();
      for (let index = 0; index < 32; index++)
        if (!(await input.tickets.reserveNext())) break;
      await input.worker.reconcile();
    } finally {
      running = false;
    }
  };
}
