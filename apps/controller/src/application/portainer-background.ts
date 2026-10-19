type PortainerBackgroundOptions = Readonly<{
  refreshObservations(): Promise<unknown>;
  reconcile(): Promise<void>;
  onReconcileSuccess(): void;
  onFailure(kind: "observation" | "reconcile", error: unknown): void;
  observationIntervalMs?: number;
  reconcileIntervalMs?: number;
}>;

/** Runs bounded Portainer observation and reconciliation loops independently. */
export class PortainerBackgroundLoops {
  private observationTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private observationRunning = false;
  private reconcileRunning = false;
  private stopped = false;
  private closePromise: Promise<void> | undefined;
  private readonly tasks = new Set<Promise<void>>();

  constructor(private readonly options: PortainerBackgroundOptions) {}

  start(): void {
    if (this.stopped || this.observationTimer || this.reconcileTimer) return;
    const observationInterval = this.options.observationIntervalMs ?? 10_000;
    const reconcileInterval = this.options.reconcileIntervalMs ?? 2_000;
    this.launch("observation");
    this.launch("reconcile");
    this.observationTimer = setInterval(
      () => this.launch("observation"),
      observationInterval,
    );
    this.reconcileTimer = setInterval(
      () => this.launch("reconcile"),
      reconcileInterval,
    );
    this.observationTimer.unref();
    this.reconcileTimer.unref();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    if (this.observationTimer) clearInterval(this.observationTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.closePromise = Promise.allSettled([...this.tasks]).then(
      () => undefined,
    );
    return this.closePromise;
  }

  private launch(kind: "observation" | "reconcile"): void {
    if (this.stopped) return;
    if (
      kind === "observation" ? this.observationRunning : this.reconcileRunning
    )
      return;
    if (kind === "observation") this.observationRunning = true;
    else this.reconcileRunning = true;
    const task = Promise.resolve()
      .then(() =>
        kind === "observation"
          ? this.options.refreshObservations()
          : this.options.reconcile(),
      )
      .then(() => {
        if (kind === "reconcile" && !this.stopped)
          this.options.onReconcileSuccess();
      })
      .catch((error: unknown) => this.options.onFailure(kind, error))
      .finally(() => {
        if (kind === "observation") this.observationRunning = false;
        else this.reconcileRunning = false;
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }
}
