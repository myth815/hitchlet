import {
  CONTAINER_GROUP_BOOTSTRAP,
  containerGroupFromRequirements,
} from "./container-group.js";
/** Fixed resource-delivery recipe with no interactive access endpoint. */
export function supportsContainerEntrypoint(
  requirements: unknown,
  access: unknown,
): boolean {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const bootstrap = record(record(requirements).bootstrap),
    recipe = record(access);
  let mechanismMatches =
    bootstrap.mechanism === "hitchlet-container-entrypoint-v1";
  try {
    const group = containerGroupFromRequirements(requirements);
    mechanismMatches =
      group !== undefined
        ? bootstrap.mechanism === CONTAINER_GROUP_BOOTSTRAP
        : mechanismMatches;
  } catch {
    return false;
  }
  return (
    mechanismMatches &&
    bootstrap.contractVersion === "1" &&
    bootstrap.identityReset === true &&
    Array.isArray(recipe.accessProtocols) &&
    recipe.accessProtocols.length === 0 &&
    Array.isArray(recipe.ports) &&
    recipe.ports.length === 0 &&
    recipe.account === "workspace" &&
    Array.isArray(recipe.allowedSourceCidrs) &&
    recipe.allowedSourceCidrs.length === 0 &&
    recipe.discovery === "none" &&
    recipe.readiness === "container-running"
  );
}
