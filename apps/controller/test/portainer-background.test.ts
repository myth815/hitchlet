import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerBackgroundLoops } from "../src/application/portainer-background.js";

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
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => {
        refreshCalls++;
      },
      reconcile: async () => {
        reconcileCalls++;
        reconcileStarted.resolve();
        await reconcileGate.promise;
      },
      reconcileLeaseIntents: async () => undefined,
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
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

  it("attributes cache-lane failures without blocking main reconciliation", async () => {
    vi.useFakeTimers();
    const cacheError = new Error("controlled provider failure");
    const failure = deferred();
    let mainCalls = 0;
    let failureKind = "";
    let reportedError: unknown;
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => {
        mainCalls++;
      },
      reconcileLeaseIntents: async () => undefined,
      reconcileCache: async () => {
        throw cacheError;
      },
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
      onFailure: (kind, error) => {
        failureKind = kind;
        reportedError = error;
        failure.resolve();
      },
    });

    loops.start();
    await failure.promise;
    await vi.advanceTimersByTimeAsync(0);

    expect(failureKind).toBe("cache");
    expect(reportedError).toBe(cacheError);
    expect(mainCalls).toBe(1);
    await loops.close();
  });

  it("keeps recovery unavailable after a lease-lane failure until that lane succeeds", async () => {
    vi.useFakeTimers();
    let mainHealthy = false;
    let leaseHealthy = false;
    let recovery = "recovering";
    let leaseAttempts = 0;
    const updateRecovery = () => {
      recovery = mainHealthy && leaseHealthy ? "ready" : "unavailable";
    };
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => undefined,
      reconcileLeaseIntents: async () => {
        leaseAttempts++;
        if (leaseAttempts === 1) throw new Error("SQLite busy");
      },
      onReconcileSuccess: () => {
        mainHealthy = true;
        updateRecovery();
      },
      onLeaseSuccess: () => {
        leaseHealthy = true;
        updateRecovery();
      },
      onFailure: (kind) => {
        if (kind === "reconcile") mainHealthy = false;
        if (kind === "lease") leaseHealthy = false;
        updateRecovery();
      },
      leaseIntervalMs: 1_000,
    });

    loops.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recovery).toBe("ready");
    expect(leaseAttempts).toBe(2);

    await loops.close();
  });

  it("waits for an in-flight lease decision and starts no lease writes after close", async () => {
    vi.useFakeTimers();
    const leaseGate = deferred();
    const leaseStarted = deferred();
    let leaseWrites = 0;
    let storageClosed = false;
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => undefined,
      reconcileLeaseIntents: async () => {
        leaseStarted.resolve();
        await leaseGate.promise;
        if (storageClosed) throw new Error("lease write after storage close");
        leaseWrites++;
      },
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
      onFailure: () => undefined,
      leaseIntervalMs: 10,
    });

    loops.start();
    await leaseStarted.promise;
    const closing = loops.close();
    let closeFinished = false;
    void closing.then(() => (closeFinished = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closeFinished).toBe(false);

    leaseGate.resolve();
    await closing;
    storageClosed = true;
    await vi.advanceTimersByTimeAsync(100);

    expect(leaseWrites).toBe(1);
    expect(closeFinished).toBe(true);
  });

  it("waits for an in-flight observation before storage shutdown and starts no later writes", async () => {
    vi.useFakeTimers();
    const observationGate = deferred();
    const observationStarted = deferred();
    let writes = 0;
    let storageClosed = false;
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => {
        observationStarted.resolve();
        await observationGate.promise;
        if (storageClosed) throw new Error("write after storage close");
        writes++;
      },
      reconcile: async () => undefined,
      reconcileLeaseIntents: async () => undefined,
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
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
