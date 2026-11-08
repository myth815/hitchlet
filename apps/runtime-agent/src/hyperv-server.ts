import { z } from "zod";
import {
  type HyperVInteractiveReceipt,
  hyperVRuntimeCredentialResponseSchema,
  type HyperVInspection,
  type HyperVConsoleResult,
  hyperVRuntimeActionRequestSchema,
  hyperVRuntimeActionResponseSchema,
  hyperVRuntimeConsoleResponseSchema,
  hyperVRuntimeFactsRequestSchema,
  hyperVRuntimeFactsResponseSchema,
  hyperVActionIdentity,
} from "@hitchlet/contracts/internal";
import type { HyperVLocalDriver } from "./drivers/hyperv.js";
import type { FileJournal } from "./journal.js";
import {
  createVmRuntimeServer,
  type VmRuntimeServerConfig,
} from "./vm-server.js";

/** Internal composition only; it does not register rentable Hyper-V capability. */
export function createHyperVRuntimeServer(
  config: VmRuntimeServerConfig,
  driver: Pick<
    HyperVLocalDriver,
    | "inspect"
    | "reconcile"
    | "stop"
    | "destroy"
    | "facts"
    | "bootstrapApply"
    | "consoleCredentials"
    | "console"
  >,
  journal: FileJournal,
  templates: () => Promise<
    import("@hitchlet/contracts/internal").HyperVTemplateProof[]
  > = async () => [],
) {
  return createVmRuntimeServer(config, journal, {
    backend: "hyperv",
    actionRequest: hyperVRuntimeActionRequestSchema,
    actionResponse: z.union([
      hyperVRuntimeActionResponseSchema,
      hyperVRuntimeConsoleResponseSchema,
      hyperVRuntimeCredentialResponseSchema,
    ]),
    factsRequest: hyperVRuntimeFactsRequestSchema,
    factsResponse: hyperVRuntimeFactsResponseSchema,
    identity: hyperVActionIdentity,
    facts: async () => ({
      ...(await driver.facts()),
      nativeRuntimeNamespaceId: config.nativeRuntimeNamespaceId,
      templates: await templates(),
    }),
    execute: async (
      action,
    ): Promise<
      HyperVInspection | HyperVConsoleResult | HyperVInteractiveReceipt
    > =>
      action.kind === "console.credentials"
        ? driver.consoleCredentials(action.request)
        : action.kind === "console"
          ? driver.console(action.request)
          : action.kind === "bootstrap.apply"
            ? driver.bootstrapApply(action.request)
            : action.kind === "reconcile"
              ? driver.reconcile(action.request)
              : driver[action.kind](action.identity),
  });
}
