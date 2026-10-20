/** Internal controller-facing shared types; intentionally excluded from the public root. */
export {
  hostSnapshotSchema,
  classifyHumanPresence,
} from "./host-observation.js";
export type { HostSnapshot } from "./host-observation.js";
export type { EffectiveResources } from "./common.js";
export type { ImageValidationRequest } from "./consumer.js";
export {
  canonicalRuntimeNetworkValue,
  runtimeNetworkCommandSchema,
  runtimeNetworkPlanSchema,
  runtimeNetworkResultSchema,
  runtimeNetworkRulesMaterial,
} from "./runtime-network.js";
export type {
  RuntimeNetworkCommand,
  RuntimeNetworkPlan,
  RuntimeNetworkResult,
  RuntimeNetworkRuleSet,
} from "./runtime-network.js";
export * from "./host-agent.js";
export { classifyFreshHumanPresence } from "./host-observation.js";
export * from "./runtime-storage.js";
export * from "./recovery.js";
