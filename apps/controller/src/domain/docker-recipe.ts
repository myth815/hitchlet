/** The only Docker bootstrap/readiness contract this M1 Provider claims. */
export function supportsNodeSshRecipe(
  requirements: unknown,
  access: unknown,
): boolean {
  const req = record(requirements);
  const bootstrap = record(req.bootstrap);
  const recipe = record(access);
  const protocols = recipe.accessProtocols;
  const ports = recipe.ports;
  return (
    bootstrap.mechanism === "hitchlet-node-ssh-v1" &&
    bootstrap.contractVersion === "1" &&
    bootstrap.identityReset === true &&
    Array.isArray(protocols) &&
    protocols.length === 1 &&
    protocols[0] === "ssh" &&
    Array.isArray(ports) &&
    ports.length === 1 &&
    ports[0] === 22 &&
    recipe.account === "workspace" &&
    recipe.discovery === "portainer-published-port" &&
    recipe.readiness === "ssh-public-key-authenticated-fingerprint"
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
