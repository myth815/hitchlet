import {
  tartRuntimeActionRequestSchema,
  tartRuntimeActionResponseSchema,
  tartRuntimeFactsRequestSchema,
  tartRuntimeFactsResponseSchema,
  type TartRuntimeFacts,
} from "@hitchlet/contracts/internal";
import type { FileJournal } from "./journal.js";
import type { TartLocalDriver } from "./drivers/tart.js";
import {
  createVmRuntimeServer,
  type VmRuntimeServerConfig,
} from "./vm-server.js";
export type TartRuntimeServerConfig = VmRuntimeServerConfig;
type TartActions = Pick<
  TartLocalDriver,
  "inspect" | "reconcile" | "bootstrapApply" | "destroy" | "revokeNetwork"
>;
export function createTartRuntimeServer(
  config: TartRuntimeServerConfig,
  driver: TartActions,
  journal: FileJournal,
  facts: () => Promise<TartRuntimeFacts>,
) {
  return createVmRuntimeServer(config, journal, {
    backend: "tart",
    actionRequest: tartRuntimeActionRequestSchema,
    actionResponse: tartRuntimeActionResponseSchema,
    factsRequest: tartRuntimeFactsRequestSchema,
    factsResponse: tartRuntimeFactsResponseSchema,
    facts,
    identity: (action) =>
      action.kind === "reconcile" ? action.request.identity : action.identity,
    execute: async (action) => {
      switch (action.kind) {
        case "inspect":
          return driver.inspect(action.identity);
        case "reconcile":
          return driver.reconcile(action.request);
        case "bootstrap.apply":
          return driver.bootstrapApply(action.identity, action.request);
        case "network.revoke":
          return driver.revokeNetwork(action.identity, action.network);
        case "destroy":
          return driver.destroy(action.identity);
      }
    },
  });
}
