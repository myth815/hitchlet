import type { AcceptedAcquireRequestSchema } from "@hitchlet/contracts";

/** Internal registrations, not consumer-facing placement requirements or a plugin loader. */
export const executionDefinitions = {
  simulator: { provider: "portainer", kind: "container" },
  portainer: { provider: "portainer", kind: "container" },
  tart: { provider: "tart", kind: "vm" },
} as const;
export type ExecutionMode = keyof typeof executionDefinitions;
export type ExecutionSelection =
  | ExecutionMode
  | "disabled"
  | readonly ExecutionMode[];

export function configuredExecutionModes(
  mode: ExecutionMode | "disabled" | "registered",
): ExecutionSelection {
  return mode === "registered" ? ["portainer", "tart"] : mode;
}
export function isExecutionMode(mode: unknown): mode is ExecutionMode {
  return typeof mode === "string" && Object.hasOwn(executionDefinitions, mode);
}
export function executionEnabled(
  selection: ExecutionSelection | undefined,
  mode: unknown,
): boolean {
  // Undefined preserves existing direct test/service composition behaviour.
  if (selection === undefined) return true;
  if (!isExecutionMode(mode)) return false;
  return (
    selection === mode || (Array.isArray(selection) && selection.includes(mode))
  );
}

/** Backend-specific limitations belong to the registered implementation, not generic VM admission. */
export function environmentContractReason(
  provider: unknown,
  contract: ReturnType<typeof AcceptedAcquireRequestSchema.parse>,
  guestOs?: unknown,
): string | null {
  const definition = Object.values(executionDefinitions).find(
    (item) => item.provider === provider,
  );
  if (!definition || definition.kind !== contract.kind)
    return "environment_kind_unsupported";
  if (
    typeof guestOs === "string" &&
    ((provider === "tart" && !["macos", "linux"].includes(guestOs)) ||
      (provider === "portainer" && guestOs !== "linux"))
  )
    return "guest_os_unsupported";
  if (
    provider === "tart" &&
    (contract.resources.request.cpuMillis % 1000 !== 0 ||
      contract.resources.isolation !== "virtual_machine" ||
      contract.resources.scratchEnforcement !== "best_effort" ||
      contract.access.protocol !== "ssh" ||
      contract.storage.length > 0)
  )
    return "tart_contract_unsupported";
  return null;
}
