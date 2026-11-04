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
  HyperVExecutionProvider,
  type HyperVExecutionProviderOptions,
} from "./hyperv-provider.js";
import {
  createHyperVReadinessPorts,
  resolveHyperVCleanupRuntime,
  resolveHyperVExecutionRuntime,
} from "./hyperv-runtime-resolver.js";

export type HyperVExecutionCompositionOptions = Readonly<{
  storage: Storage;
  secrets: LocalSecretStore;
  installationId: string;
  controllerEpoch: number;
  enabledExecutionMode?: ExecutionSelection;
  otherExecutionProviders?: Partial<Record<ExecutionMode, ExecutionPort>>;
  now?: () => number;
  /** Narrow fake-runtime seam for synthetic ledger tests. */
  resolveRuntime?: HyperVExecutionProviderOptions["resolveRuntime"];
  /** Narrow fake cleanup-runtime seam for synthetic ownership tests. */
  resolveCleanupRuntime?: HyperVExecutionProviderOptions["resolveCleanupRuntime"];
  /** Narrow SSH probe seam for synthetic ledger tests. */
  ssh?: HyperVExecutionProviderOptions["ssh"];
}>;

/** Compose the real HyperV provider with the controller's shared durable ticket/operation/lease services. */
export function createHyperVExecutionComposition(
  options: HyperVExecutionCompositionOptions,
) {
  const now = options.now ?? Date.now;
  const readiness = createHyperVReadinessPorts();
  const execution = new HyperVExecutionProvider({
    resolveRuntime:
      options.resolveRuntime ??
      ((plan) =>
        resolveHyperVExecutionRuntime(
          options.storage,
          options.secrets,
          plan,
          options.controllerEpoch,
          now(),
        )),
    resolveCleanupRuntime:
      options.resolveCleanupRuntime ??
      ((plan, authorization) =>
        resolveHyperVCleanupRuntime(
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
      { ...options.otherExecutionProviders, hyperv: execution },
      options.enabledExecutionMode ?? "hyperv",
    ),
    installationId: options.installationId,
    controllerEpoch: options.controllerEpoch,
    enabledExecutionMode: options.enabledExecutionMode ?? "hyperv",
    now,
  });
  const tickets = new TicketService({
    storage: options.storage,
    installationId: options.installationId,
    controllerEpoch: options.controllerEpoch,
    enabledExecutionMode: options.enabledExecutionMode ?? "hyperv",
    now,
  });
  const leases = new LeaseService(options.storage, now);
  return { execution, worker, tickets, leases } as const;
}
