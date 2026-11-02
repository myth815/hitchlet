import type { OperationWorker } from "./operations.js";
import type { LeaseService } from "./leases.js";

type BackgroundKind = "observation" | "reconcile" | "lease" | "cache";

type ControllerBackgroundOptions = Readonly<{
  refreshObservations(): Promise<unknown>;
  reconcile(): Promise<void>;
  reconcileLeaseIntents(): Promise<unknown>;
  /** Portainer-only independent lane. Simulator controllers omit it. */
  reconcileCache?(): Promise<unknown>;
  onLeaseSuccess(): void;
  onReconcileSuccess(): void;
  onFailure(kind: BackgroundKind, error: unknown): void;
  observationIntervalMs?: number;
  reconcileIntervalMs?: number;
  leaseIntervalMs?: number;
  cacheIntervalMs?: number;
}>;

/** The durable renewal and deadline intents that must bypass external operation I/O. */
export async function reconcileLeaseAndExpiryIntents(
  leases: Pick<LeaseService, "reconcilePending">,
  worker: Pick<OperationWorker, "reconcileExpiries">,
): Promise<void> {
  await leases.reconcilePending();
  await worker.reconcileExpiries();
}

/** Runs bounded controller work independently so external I/O cannot stall lease decisions. */
export class ControllerBackgroundLoops {
  private observationTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private cacheTimer: NodeJS.Timeout | undefined;
  private observationRunning = false;
  private reconcileRunning = false;
  private leaseRunning = false;
  private cacheRunning = false;
  private stopped = false;
  private closePromise: Promise<void> | undefined;
  private readonly tasks = new Set<Promise<void>>();

  constructor(private readonly options: ControllerBackgroundOptions) {}

  start(): void {
    if (this.stopped || this.observationTimer || this.reconcileTimer) return;
    const observationInterval = this.options.observationIntervalMs ?? 10_000;
    const reconcileInterval = this.options.reconcileIntervalMs ?? 2_000;
    const leaseInterval = this.options.leaseIntervalMs ?? 1_000;
    this.launch("observation");
    this.launch("reconcile");
    this.launch("lease");
    if (this.options.reconcileCache) this.launch("cache");
    this.observationTimer = setInterval(
      () => this.launch("observation"),
      observationInterval,
    );
    this.reconcileTimer = setInterval(
      () => this.launch("reconcile"),
      reconcileInterval,
    );
    this.leaseTimer = setInterval(() => this.launch("lease"), leaseInterval);
    if (this.options.reconcileCache) {
      const cacheInterval = this.options.cacheIntervalMs ?? 2_000;
      this.cacheTimer = setInterval(() => this.launch("cache"), cacheInterval);
      this.cacheTimer.unref();
    }
    this.observationTimer.unref();
    this.reconcileTimer.unref();
    this.leaseTimer.unref();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    if (this.observationTimer) clearInterval(this.observationTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.cacheTimer) clearInterval(this.cacheTimer);
    this.closePromise = Promise.allSettled([...this.tasks]).then(
      () => undefined,
    );
    return this.closePromise;
  }

  private launch(kind: BackgroundKind): void {
    if (this.stopped) return;
    if (
      kind === "observation"
        ? this.observationRunning
        : kind === "reconcile"
          ? this.reconcileRunning
          : kind === "lease"
            ? this.leaseRunning
            : this.cacheRunning
    )
      return;
    if (kind === "observation") this.observationRunning = true;
    else if (kind === "reconcile") this.reconcileRunning = true;
    else if (kind === "lease") this.leaseRunning = true;
    else this.cacheRunning = true;
    const task = Promise.resolve()
      .then(() => {
        if (kind === "observation") return this.options.refreshObservations();
        if (kind === "reconcile") return this.options.reconcile();
        if (kind === "lease") return this.options.reconcileLeaseIntents();
        return this.options.reconcileCache?.();
      })
      .then(() => {
        if (this.stopped) return;
        if (kind === "reconcile") this.options.onReconcileSuccess();
        else if (kind === "lease") this.options.onLeaseSuccess();
      })
      .catch((error: unknown) => this.options.onFailure(kind, error))
      .finally(() => {
        if (kind === "observation") this.observationRunning = false;
        else if (kind === "reconcile") this.reconcileRunning = false;
        else if (kind === "lease") this.leaseRunning = false;
        else this.cacheRunning = false;
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }
}
