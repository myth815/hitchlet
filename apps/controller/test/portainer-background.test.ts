import { afterEach, describe, expect, it, vi } from "vitest";
import { PortainerBackgroundLoops } from "../src/application/portainer-background.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("Portainer background loops", () => {
  it("keeps refreshing observations while startup reconciliation is slow", async () => {
    vi.useFakeTimers();
    const reconcileGate = deferred();
    const reconcileStarted = deferred();
    let reconcileCalls = 0;
    let refreshCalls = 0;
    const loops = new PortainerBackgroundLoops({
      refreshObservations: async () => {
        refreshCalls++;
      },
      reconcile: async () => {
        reconcileCalls++;
        reconcileStarted.resolve();
        await reconcileGate.promise;
      },
      onReconcileSuccess: () => undefined,
      onFailure: () => undefined,
      observationIntervalMs: 10,
      reconcileIntervalMs: 2,
    });

    loops.start();
    await reconcileStarted.promise;
    await vi.advanceTimersByTimeAsync(50);

    expect(refreshCalls).toBeGreaterThanOrEqual(3);
    expect(reconcileCalls).toBe(1);

    const closing = loops.close();
    reconcileGate.resolve();
    await closing;
  });

  it("waits for an in-flight observation before storage shutdown and starts no later writes", async () => {
    vi.useFakeTimers();
    const observationGate = deferred();
    const observationStarted = deferred();
    let writes = 0;
    let storageClosed = false;
    const loops = new PortainerBackgroundLoops({
      refreshObservations: async () => {
        observationStarted.resolve();
        await observationGate.promise;
        if (storageClosed) throw new Error("write after storage close");
        writes++;
      },
      reconcile: async () => undefined,
      onReconcileSuccess: () => undefined,
      onFailure: () => undefined,
      observationIntervalMs: 10,
      reconcileIntervalMs: 2,
    });

    loops.start();
    await observationStarted.promise;
    const closing = loops.close();
    let closeFinished = false;
    void closing.then(() => (closeFinished = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closeFinished).toBe(false);

    observationGate.resolve();
    await closing;
    storageClosed = true;
    await vi.advanceTimersByTimeAsync(100);

    expect(writes).toBe(1);
    expect(closeFinished).toBe(true);
  });
});
