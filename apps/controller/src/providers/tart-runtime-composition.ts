import {
  AllocationCreateCalls,
  OperationWorker,
} from "../application/operations.js";
import { TicketService } from "../application/tickets.js";
import { LeaseService } from "../application/leases.js";
import {
  ExecutionProviderDispatcher,
  type ExecutionMode,
  type ExecutionSelection,
} from "./execution-dispatcher.js";
import type { Storage } from "../storage/index.js";
import { SQLiteAccessMaterialStore } from "../storage/access-material-store.js";
import type { LocalSecretStore } from "../storage/secret-store.js";
import type { ExecutionPort } from "./port.js";
import {
  TartExecutionProvider,
  type TartExecutionProviderOptions,
} from "./tart-provider.js";
import {
  createTartReadinessPorts,
  resolveTartCleanupRuntime,
  resolveTartExecutionRuntime,
} from "./tart-runtime-resolver.js";

export type TartExecutionCompositionOptions = Readonly<{
  storage: Storage;
  secrets: LocalSecretStore;
  installationId: string;
  controllerEpoch: number;
  enabledExecutionMode?: ExecutionSelection;
  otherExecutionProviders?: Partial<Record<ExecutionMode, ExecutionPort>>;
  now?: () => number;
  /** Narrow fake-runtime seam for synthetic ledger tests. */
  resolveRuntime?: TartExecutionProviderOptions["resolveRuntime"];
  /** Narrow fake cleanup-runtime seam for synthetic ownership tests. */
  resolveCleanupRuntime?: TartExecutionProviderOptions["resolveCleanupRuntime"];
  /** Narrow SSH probe seam for synthetic ledger tests. */
  ssh?: TartExecutionProviderOptions["ssh"];
}>;

/** Compose the real Tart provider with the controller's shared durable ticket/operation/lease services. */
export function createTartExecutionComposition(
  options: TartExecutionCompositionOptions,
) {
  const now = options.now ?? Date.now;
  const readiness = createTartReadinessPorts();
  const execution = new TartExecutionProvider({
    resolveRuntime:
      options.resolveRuntime ??
      ((plan) =>
        resolveTartExecutionRuntime(
          options.storage,
          options.secrets,
          plan,
          options.controllerEpoch,
          now(),
        )),
    resolveCleanupRuntime:
      options.resolveCleanupRuntime ??
      ((plan, authorization) =>
        resolveTartCleanupRuntime(
          options.storage,
          options.secrets,
          plan,
          authorization,
          options.controllerEpoch,
          now(),
        )),
    accessMaterials: new SQLiteAccessMaterialStore(
      options.storage,
      options.secrets,
      now,
    ),
    ssh: options.ssh ?? readiness.ssh,
    now,
  });
  const worker = new OperationWorker({
    createCalls: new AllocationCreateCalls(),
    storage: options.storage,
    execution: new ExecutionProviderDispatcher(
      { ...options.otherExecutionProviders, tart: execution },
      options.enabledExecutionMode ?? "tart",
    ),
    installationId: options.installationId,
    controllerEpoch: options.controllerEpoch,
    enabledExecutionMode: options.enabledExecutionMode ?? "tart",
    now,
  });
  const tickets = new TicketService({
    storage: options.storage,
    installationId: options.installationId,
    controllerEpoch: options.controllerEpoch,
    enabledExecutionMode: options.enabledExecutionMode ?? "tart",
    now,
  });
  const leases = new LeaseService(options.storage, now);
  return { execution, worker, tickets, leases } as const;
}
