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
  return (
    bootstrap.mechanism === "hitchlet-container-entrypoint-v1" &&
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
