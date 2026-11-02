import {
  AllocationCreateCalls,
  OperationWorker,
} from "../application/operations.js";
import { TicketService } from "../application/tickets.js";
import { LeaseService } from "../application/leases.js";
import type { Storage } from "../storage/index.js";
import { SQLiteAccessMaterialStore } from "../storage/access-material-store.js";
import type { LocalSecretStore } from "../storage/secret-store.js";
import {
  TartExecutionProvider,
  type TartExecutionProviderOptions,
} from "./tart-provider.js";
import {
  createTartReadinessPorts,
  resolveTartExecutionRuntime,
} from "./tart-runtime-resolver.js";

export type TartExecutionCompositionOptions = Readonly<{
  storage: Storage;
  secrets: LocalSecretStore;
  installationId: string;
  controllerEpoch: number;
  now?: () => number;
  /** Narrow fake-runtime seam for synthetic ledger tests. */
  resolveRuntime?: TartExecutionProviderOptions["resolveRuntime"];
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
    execution,
    installationId: options.installationId,
    controllerEpoch: options.controllerEpoch,
    now,
  });
  const tickets = new TicketService({
    storage: options.storage,
    installationId: options.installationId,
    controllerEpoch: options.controllerEpoch,
    now,
  });
  const leases = new LeaseService(options.storage, now);
  return { execution, worker, tickets, leases } as const;
}
