import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { TicketService } from "../src/application/tickets.js";
import { TicketQueries } from "../src/application/queries.js";
import { LeaseService } from "../src/application/leases.js";
import {
  AllocationCreateCalls,
  OperationWorker,
} from "../src/application/operations.js";
import { ImageCacheWorker } from "../src/application/image-cache.js";
import type { ImageCacheExecutionPort } from "../src/providers/image-cache-port.js";
import { SQLiteImageValidationStore } from "../src/storage/image-validation-store.js";
import { SQLiteImageCacheStore } from "../src/storage/image-cache-store.js";
import { PersistentSimulator } from "../src/providers/simulator.js";
import {
  ControllerBackgroundLoops,
  reconcileLeaseAndExpiryIntents,
} from "../src/application/portainer-background.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanup.length) await cleanup.pop()!();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(withRenewal = true) {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-f1-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const value = (pattern: RegExp) => {
    const result = stdout.match(pattern)?.[1];
    if (!result) throw new Error("Incomplete Simulator fixture");
    return result;
  };
  const consumerId = value(/Consumer ID: (\S+)/);
  const versionId = value(/Image version: (\S+)/);
  const networkProfileId = value(/Network profile: (\S+)/);
  const storage = await openStorage(dir);
  cleanup.push(() => storage.close());
  const installation = await storage.get<{ installation_id: string }>(
    "SELECT installation_id FROM installations WHERE singleton=1",
  );
  if (!installation) throw new Error("Fixture has no installation");
  let current = Date.now();
  const now = () => current;
  const tickets = new TicketService({
    storage,
    installationId: installation.installation_id,
    now,
  });
  const createCalls = new AllocationCreateCalls();
  const worker = new OperationWorker({
    storage,
    installationId: installation.installation_id,
    execution: new PersistentSimulator(join(dir, "external")),
    now,
    createCalls,
  });
  const leases = new LeaseService(storage, now);
  const accepted = await tickets.acquire(consumerId, "f1-acquire", {
    image: { versionId },
    resources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 1 },
    networkProfileId,
    lease: { requestedSeconds: 900, maximumLifetimeSeconds: 3600 },
  });
  await tickets.refreshSimulatorFixtureObservation();
  await tickets.reserveNext();
  await worker.reconcileBeforeScheduling();
  const ready = await new TicketQueries(storage, now).get(
    consumerId,
    accepted.ticketId,
  );
  if (ready?.phase !== "ready" || !ready.lease)
    throw new Error(`Fixture did not become ready: ${JSON.stringify(ready)}`);
  const renewal = withRenewal
    ? await leases.renew(consumerId, accepted.ticketId, "f1-renew", {
        generation: ready.lease.generation,
        expectedLeaseVersion: ready.lease.version,
        requestedTtlSec: 900,
      })
    : undefined;
  if (renewal && renewal.outcome !== "pending")
    throw new Error("Expected renewal to be pending");
  return {
    storage,
    leases,
    worker,
    installationId: installation.installation_id,
    createCalls,
    tickets,
    externalDir: join(dir, "external"),
    now,
    ticketId: accepted.ticketId,
    consumerId,
    renewalId: renewal?.outcome === "pending" ? renewal.renewal.id : undefined,
    setTime(value: number) {
      current = value;
    },
  };
}

describe("lease decision scheduling alongside slow work", () => {
  it("confirms a real pending renewal while the main Portainer reconciliation is blocked", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const mainGate = deferred();
    const mainStarted = deferred();
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => {
        mainStarted.resolve();
        await mainGate.promise;
      },
      reconcileLeaseIntents: () =>
        reconcileLeaseAndExpiryIntents(f.leases, f.worker),
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
      onFailure: () => undefined,
      reconcileIntervalMs: 2_000,
    });

    loops.start();
    await mainStarted.promise;
    await vi.advanceTimersByTimeAsync(8_000);

    const renewal = await f.leases.get(f.consumerId, f.ticketId, f.renewalId!);
    expect(renewal?.state).toBe("confirmed");
    expect(
      await f.storage.get<{ phase: string }>(
        "SELECT phase FROM tickets WHERE id=?",
        [f.ticketId],
      ),
    ).toEqual({ phase: "ready" });

    const closing = loops.close();
    mainGate.resolve();
    await closing;
  });

  it("writes the real lease-expiry cleanup intent while worker I/O is blocked", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    await f.leases.reconcilePending();
    const lease = await f.storage.get<{ expires_at_ms: bigint }>(
      "SELECT expires_at_ms FROM leases WHERE ticket_id=?",
      [f.ticketId],
    );
    if (!lease) throw new Error("Ready ticket has no confirmed lease");
    f.setTime(Number(lease.expires_at_ms));
    const mainGate = deferred();
    const mainStarted = deferred();
    const intentsFinished = deferred();
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => {
        mainStarted.resolve();
        await mainGate.promise;
      },
      reconcileLeaseIntents: async () => {
        await reconcileLeaseAndExpiryIntents(f.leases, f.worker);
        intentsFinished.resolve();
      },
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
      onFailure: (kind, error) => {
        throw new Error(`${kind} failed`, { cause: error });
      },
      reconcileIntervalMs: 2_000,
    });

    loops.start();
    await mainStarted.promise;
    await intentsFinished.promise;

    expect(
      await f.storage.get<{
        phase: string;
        terminal_reason: string;
        cleanup_status: string;
      }>(
        "SELECT phase,terminal_reason,cleanup_status FROM tickets WHERE id=?",
        [f.ticketId],
      ),
    ).toEqual({
      phase: "releasing",
      terminal_reason: "lease_expired",
      cleanup_status: "pending",
    });
    expect(
      await f.storage.get<{ n: bigint }>(
        "SELECT count(*) n FROM operations WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.cleanup' AND state='planned'",
        [f.ticketId],
      ),
    ).toEqual({ n: 1n });

    const closing = loops.close();
    mainGate.resolve();
    await closing;
  });

  it("finishes real ticket cleanup while a SQLite cache pull is hung in its own lane", async () => {
    const f = await fixture();
    await f.leases.reconcilePending();
    const lease = await f.storage.get<{ expires_at_ms: bigint }>(
      "SELECT expires_at_ms FROM leases WHERE ticket_id=?",
      [f.ticketId],
    );
    if (!lease) throw new Error("Ready ticket has no lease");
    f.setTime(Number(lease.expires_at_ms));
    await f.tickets.refreshSimulatorFixtureObservation();

    const target = await f.storage.get<{
      node_id: string;
      image_artifact_id: string;
    }>("SELECT node_id,image_artifact_id FROM allocations WHERE ticket_id=?", [
      f.ticketId,
    ]);
    if (!target) throw new Error("Ticket has no allocation for cache fixture");
    const cachePlan = await new SQLiteImageValidationStore(
      f.storage,
      f.now,
    ).prewarmImageCache({
      nodeId: target.node_id,
      artifactId: target.image_artifact_id,
    });
    if (cachePlan.state !== "queued")
      throw new Error(`Expected queued cache pull, got ${cachePlan.state}`);
    const artifact = await f.storage.get<{
      content_digest: string;
      architecture: string;
    }>("SELECT content_digest,architecture FROM image_artifacts WHERE id=?", [
      target.image_artifact_id,
    ]);
    if (!artifact) throw new Error("Cache fixture artifact is missing");

    const cacheGate = deferred();
    const cacheStarted = deferred();
    const pullState = { present: false, calls: 0 };
    const provider: ImageCacheExecutionPort = {
      inspectLocal: async () =>
        pullState.present
          ? {
              presence: "present",
              localRef: artifact.content_digest,
              imageId: "sha256:simulated-cache-image",
              sizeMiB: 8,
              architecture: artifact.architecture as "amd64" | "arm64",
              os: "linux",
            }
          : { presence: "absent" },
      verifyRegistryManifest: async () => undefined,
      pullPinned: async () => {
        pullState.calls++;
        cacheStarted.resolve();
        await cacheGate.promise;
        pullState.present = true;
      },
      imageInUse: async () => false,
      removePinned: async () => undefined,
    };
    const cacheWorker = new ImageCacheWorker(
      new SQLiteImageCacheStore(f.storage, f.now),
      provider,
      async () => ({
        verified: true,
        evidenceId: "test-host-storage-snapshot",
        observedAtMs: f.now(),
        availableMiB: 1_000,
        requiredMiB: 500,
        lowWaterMiB: 100,
      }),
      f.now,
    );
    const mainStarted = deferred();
    const cleanupFinished = deferred();
    let mainCalls = 0;
    let cacheCalls = 0;
    let backgroundFailure: { kind: string; error: unknown } | undefined;
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => {
        mainCalls++;
        mainStarted.resolve();
        await f.worker.reconcileScheduledWork();
        await f.tickets.reserveNext();
        await f.worker.reconcile();
        const ticket = await f.storage.get<{ phase: string }>(
          "SELECT phase FROM tickets WHERE id=?",
          [f.ticketId],
        );
        if (ticket?.phase === "released") cleanupFinished.resolve();
      },
      reconcileLeaseIntents: () =>
        reconcileLeaseAndExpiryIntents(f.leases, f.worker),
      reconcileCache: async () => {
        cacheCalls++;
        await cacheWorker.reconcile();
      },
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
      onFailure: (kind, error) => {
        backgroundFailure = { kind, error };
      },
      reconcileIntervalMs: 5,
      cacheIntervalMs: 3,
    });

    try {
      loops.start();
      await mainStarted.promise;
      await Promise.race([
        cacheStarted.promise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      expect(pullState.calls).toBe(1);
      await cleanupFinished.promise;
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(cacheCalls).toBe(1);
      expect(mainCalls).toBeGreaterThan(1);
      expect(backgroundFailure).toBeUndefined();
      expect(
        await f.storage.get<{
          phase: string;
          terminal_reason: string;
          cleanup_status: string;
        }>(
          "SELECT phase,terminal_reason,cleanup_status FROM tickets WHERE id=?",
          [f.ticketId],
        ),
      ).toEqual({
        phase: "released",
        terminal_reason: "lease_expired",
        cleanup_status: "complete",
      });
      expect(
        await f.storage.get<{ n: bigint }>(
          "SELECT count(*) n FROM capacity_claims WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND state<>'released'",
          [f.ticketId],
        ),
      ).toEqual({ n: 0n });
      const resourceRoot = join(f.externalDir, "resources");
      const resourceDirs = await readdir(resourceRoot);
      expect(resourceDirs.length).toBeGreaterThan(0);
      for (const name of resourceDirs)
        expect(await readdir(join(resourceRoot, name))).toEqual([
          "revoked.json",
        ]);

      const closing = loops.close();
      let closeFinished = false;
      void closing.then(() => (closeFinished = true));
      await Promise.resolve();
      expect(closeFinished).toBe(false);
      cacheGate.resolve();
      await closing;
      const mainCallsAtClose = mainCalls;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mainCalls).toBe(mainCallsAtClose);
      expect(cacheCalls).toBe(1);
      expect(pullState.calls).toBe(1);
      expect(
        await new SQLiteImageCacheStore(f.storage, f.now).operationReceipt(
          target.node_id,
          cachePlan.operationId!,
        ),
      ).toMatchObject({ state: "succeeded", kind: "image-cache.pull" });
    } finally {
      cacheGate.resolve();
      await loops.close();
    }
  });

  it("keeps recovery unavailable until the independent cleanup lane succeeds", async () => {
    let mainHealthy = false;
    let cleanupHealthy = false;
    let failCleanup = false;
    let cleanupFailures = 0;
    const mainAfterCleanupFailure = deferred();
    const cleanupFailed = deferred();
    const cleanupRecovered = deferred();
    const initialRecovery = deferred();
    const recoveryState = () =>
      mainHealthy && cleanupHealthy ? "ready" : "unavailable";
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => undefined,
      reconcileCleanup: async () => {
        if (failCleanup) throw new Error("cleanup lane unavailable");
      },
      reconcileLeaseIntents: async () => undefined,
      onReconcileSuccess: () => {
        mainHealthy = true;
        if (cleanupFailures > 0) mainAfterCleanupFailure.resolve();
        if (recoveryState() === "ready") initialRecovery.resolve();
      },
      onLeaseSuccess: () => undefined,
      onCleanupSuccess: () => {
        cleanupHealthy = true;
        if (cleanupFailures > 0) cleanupRecovered.resolve();
        if (recoveryState() === "ready") initialRecovery.resolve();
      },
      onFailure: (kind, error) => {
        if (kind !== "cleanup")
          throw new Error(`${kind} failed`, { cause: error });
        cleanupFailures++;
        cleanupHealthy = false;
        cleanupFailed.resolve();
      },
      reconcileIntervalMs: 5,
      cleanupIntervalMs: 20,
    });
    loops.start();
    await initialRecovery.promise;
    expect(recoveryState()).toBe("ready");

    failCleanup = true;
    await cleanupFailed.promise;
    await mainAfterCleanupFailure.promise;
    expect(recoveryState()).toBe("unavailable");

    failCleanup = false;
    await cleanupRecovered.promise;
    expect(recoveryState()).toBe("ready");
    await loops.close();
  });

  it("runs one cleanup beside a held create and keeps the same-allocation fence", async () => {
    const f = await fixture(false);
    const lease = await f.storage.get<{ expires_at_ms: bigint }>(
      "SELECT expires_at_ms FROM leases WHERE ticket_id=?",
      [f.ticketId],
    );
    if (!lease) throw new Error("Ready ticket has no confirmed lease");
    f.setTime(Number(lease.expires_at_ms));
    await f.worker.expireDue();
    const allocation = await f.storage.get<{ id: string }>(
      "SELECT id FROM allocations WHERE ticket_id=?",
      [f.ticketId],
    );
    if (!allocation) throw new Error("Expired ticket has no allocation");
    const cleanup = await f.storage.get<{ id: string }>(
      "SELECT id FROM operations WHERE allocation_id=? AND kind='allocation.cleanup'",
      [allocation.id],
    );
    if (!cleanup) throw new Error("Expired ticket has no cleanup intent");
    const ownerA = "held-create-a";
    f.createCalls.enter(`${f.installationId}:${ownerA}`);
    f.createCalls.enter(`${f.installationId}:${allocation.id}`);
    expect(await f.worker.reconcileCleanupLane()).toBe(1);
    expect(
      await f.storage.get<{ state: string; diagnostic: string }>(
        "SELECT state,json_extract(result_json,'$.diagnostic') AS diagnostic FROM operations WHERE id=?",
        [cleanup.id],
      ),
    ).toEqual({ state: "unknown", diagnostic: "create_call_in_flight" });
    f.createCalls.leave(`${f.installationId}:${allocation.id}`);
    f.setTime(Number(lease.expires_at_ms) + 3_000);

    const mainGate = deferred();
    const mainStarted = deferred();
    const cleanupFinished = deferred();
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => {
        mainStarted.resolve();
        await mainGate.promise;
      },
      reconcileCleanup: async () => {
        await f.worker.reconcileCleanupLane();
        const ticket = await f.storage.get<{ phase: string }>(
          "SELECT phase FROM tickets WHERE id=?",
          [f.ticketId],
        );
        if (ticket?.phase === "released") cleanupFinished.resolve();
      },
      reconcileLeaseIntents: async () => undefined,
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
      onFailure: (kind, error) => {
        throw new Error(`${kind} failed`, { cause: error });
      },
      reconcileIntervalMs: 2_000,
    });
    loops.start();
    await mainStarted.promise;
    await cleanupFinished.promise;
    expect(f.createCalls.has(`${f.installationId}:${ownerA}`)).toBe(true);
    expect(
      await f.storage.get<{ phase: string; cleanup_status: string }>(
        "SELECT phase,cleanup_status FROM tickets WHERE id=?",
        [f.ticketId],
      ),
    ).toEqual({ phase: "released", cleanup_status: "complete" });
    const closing = loops.close();
    mainGate.resolve();
    await closing;
    f.createCalls.leave(`${f.installationId}:${ownerA}`);
  });

  it("persists an expired renewal termination intent while main reconciliation remains blocked", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const mainGate = deferred();
    const mainStarted = deferred();
    const pending = await f.leases.get(f.consumerId, f.ticketId, f.renewalId!);
    if (!pending) throw new Error("Renewal disappeared");
    f.setTime(Date.parse(pending.decisionDeadline));
    const leaseFinished = deferred();
    const loops = new ControllerBackgroundLoops({
      refreshObservations: async () => undefined,
      reconcile: async () => {
        mainStarted.resolve();
        await mainGate.promise;
      },
      reconcileLeaseIntents: async () => {
        await f.leases.reconcilePending();
        leaseFinished.resolve();
      },
      onReconcileSuccess: () => undefined,
      onLeaseSuccess: () => undefined,
      onFailure: (kind, error) => {
        throw new Error(`${kind} failed`, { cause: error });
      },
      reconcileIntervalMs: 2_000,
    });
    loops.start();
    await mainStarted.promise;
    await leaseFinished.promise;

    const lease = await f.storage.get<{ expires_at_ms: bigint }>(
      "SELECT expires_at_ms FROM leases WHERE ticket_id=?",
      [f.ticketId],
    );
    expect(
      lease!.expires_at_ms > BigInt(Date.parse(pending.decisionDeadline)),
    ).toBe(true);
    expect(
      await f.storage.get<{ state: string }>(
        "SELECT state FROM lease_renewals WHERE id=?",
        [f.renewalId!],
      ),
    ).toEqual({ state: "rejected" });
    expect(
      await f.storage.get<{ phase: string; cleanup_status: string }>(
        "SELECT phase,cleanup_status FROM tickets WHERE id=?",
        [f.ticketId],
      ),
    ).toEqual({ phase: "releasing", cleanup_status: "pending" });
    expect(
      await f.storage.get<{ n: bigint }>(
        "SELECT count(*) n FROM operations WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.cleanup' AND state='planned'",
        [f.ticketId],
      ),
    ).toEqual({ n: 1n });

    const closing = loops.close();
    mainGate.resolve();
    await closing;
  });
});
