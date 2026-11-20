function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PORTAINER_FILTERED_SCOPES = [
  "resourceLimits",
  "firewallInput",
  "firewallForward",
  "ipv6",
  "sshBootstrap",
  "cleanupRecovery",
] as const;

export function passedCapabilityScopes(
  scopes: unknown,
  names: readonly string[],
): boolean {
  return (
    isRecord(scopes) &&
    names.every(
      (name) => isRecord(scopes[name]) && scopes[name].status === "passed",
    )
  );
}

/** Base Docker health requires resource evidence; selected filtered/SSH work uses its own verified capability fields. */
export function validAttestedCapability(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  // A durable Docker qualification is invalidated by changed facts, not elapsed time.
  if (
    !["constant_online_manual_inventory", "observed_host"].includes(
      String(value.admissionMode),
    ) ||
    value.offline !== false ||
    value.powerEnabled !== false ||
    typeof value.connectionRevisionId !== "string" ||
    value.cpuHardLimit !== "verified" ||
    value.memoryHardLimit !== "verified" ||
    typeof value.capabilityFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.capabilityFingerprint) ||
    typeof value.providerVersion !== "string" ||
    !Array.isArray(value.architectures) ||
    !Array.isArray(value.guestOs) ||
    !value.guestOs.includes("linux")
  )
    return false;
  const report = value.manualReport;
  if (!isRecord(report) || typeof report.sha256 !== "string") return false;
  return (
    passedCapabilityScopes(report.scopes, ["resourceLimits"]) &&
    (value.networkPolicyEnforcement !== "verified" ||
      passedCapabilityScopes(report.scopes, PORTAINER_FILTERED_SCOPES)) &&
    (!Array.isArray(value.supportedAccess) ||
      !value.supportedAccess.includes("ssh") ||
      passedCapabilityScopes(report.scopes, ["sshBootstrap"]))
  );
}

/** Same evidence binding used by observation and the atomic admission snapshot. */
export function portainerCapabilityMatches(
  value: unknown,
  binding: {
    connectionRevisionId: unknown;
    engineId: unknown;
    architecture: unknown;
    providerEvidence: unknown;
    capacity: unknown;
  },
): boolean {
  if (
    !validAttestedCapability(value) ||
    !isRecord(binding.providerEvidence) ||
    !isRecord(binding.capacity) ||
    !isRecord(value.capacity)
  )
    return false;
  const expectedCapacity = binding.capacity;
  const attestedCapacity = value.capacity;
  return (
    typeof binding.engineId === "string" &&
    typeof binding.connectionRevisionId === "string" &&
    value.engineId === binding.engineId &&
    value.connectionRevisionId === binding.connectionRevisionId &&
    value.architecture === binding.architecture &&
    Array.isArray(value.architectures) &&
    value.architectures.includes(binding.architecture) &&
    value.providerVersion ===
      `Portainer/${binding.providerEvidence.portainerVersion}; Docker/${binding.providerEvidence.dockerVersion}` &&
    ["cpuMillis", "memoryMiB", "scratchMiB"].every(
      (key) =>
        typeof expectedCapacity[key] === "number" &&
        attestedCapacity[key] === expectedCapacity[key],
    )
  );
}

/** NAT needs resource/SSH/cleanup evidence; strong isolation additionally needs network evidence. */
export function validTartAttestedCapability(
  value: unknown,
  now: number,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const expiry =
    typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  const report = value.manualReport;
  const scopes = isRecord(report) ? report.scopes : undefined;
  const names =
    value.networkMode === "trusted_nat"
      ? ["resourceLimits", "sshBootstrap", "cleanupRecovery"]
      : [
          "resourceLimits",
          "firewallInput",
          "firewallForward",
          "ipv6",
          "sshBootstrap",
          "cleanupRecovery",
        ];
  return (
    Number.isFinite(expiry) &&
    expiry > now &&
    value.admissionMode === "constant_online_manual_inventory" &&
    value.offline === false &&
    value.powerEnabled === false &&
    value.cpuHardLimit === "verified" &&
    value.memoryHardLimit === "verified" &&
    (value.networkMode === "trusted_nat"
      ? value.networkPolicyEnforcement === "unsupported"
      : value.networkPolicyEnforcement === "verified") &&
    typeof value.capabilityFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.capabilityFingerprint) &&
    typeof value.connectionRevisionId === "string" &&
    typeof value.nativeNamespaceId === "string" &&
    typeof value.tartVersion === "string" &&
    value.providerVersion === `Tart/${value.tartVersion}` &&
    typeof value.templateRef === "string" &&
    typeof value.templateDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.templateDigest) &&
    value.architecture === "arm64" &&
    Array.isArray(value.architectures) &&
    value.architectures.length === 1 &&
    value.architectures[0] === "arm64" &&
    Array.isArray(value.guestOs) &&
    value.guestOs.length === 1 &&
    (value.guestOs[0] === "linux" || value.guestOs[0] === "macos") &&
    isRecord(value.capacity) &&
    Number.isSafeInteger(value.capacity.cpuMillis) &&
    Number.isSafeInteger(value.capacity.memoryMiB) &&
    isRecord(report) &&
    typeof report.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(report.sha256) &&
    isRecord(scopes) &&
    (value.networkMode === "trusted_nat" ||
      Object.keys(scopes).length === names.length) &&
    names.every(
      (name) => isRecord(scopes[name]) && scopes[name].status === "passed",
    )
  );
}

export function validHyperVAttestedCapability(
  value: unknown,
  now: number,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const expiry =
    typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  const report = value.manualReport;
  const scopes = isRecord(report) ? report.scopes : undefined;
  const names = ["resourceLimits", "sshBootstrap", "cleanupRecovery"];
  return (
    Number.isFinite(expiry) &&
    expiry > now &&
    value.admissionMode === "constant_online_manual_inventory" &&
    value.offline === false &&
    value.powerEnabled === false &&
    value.cpuHardLimit === "verified" &&
    value.memoryHardLimit === "verified" &&
    value.networkMode === "trusted_nat" &&
    value.networkPolicyEnforcement === "unsupported" &&
    typeof value.capabilityFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.capabilityFingerprint) &&
    typeof value.connectionRevisionId === "string" &&
    typeof value.nativeNamespaceId === "string" &&
    typeof value.hyperVVersion === "string" &&
    value.providerVersion === `Hyper-V/${value.hyperVVersion}` &&
    typeof value.templateRef === "string" &&
    typeof value.templateDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.templateDigest) &&
    value.architecture === "amd64" &&
    Array.isArray(value.architectures) &&
    value.architectures.length === 1 &&
    value.architectures[0] === "amd64" &&
    Array.isArray(value.guestOs) &&
    value.guestOs.length === 1 &&
    (value.guestOs[0] === "linux" || value.guestOs[0] === "windows") &&
    isRecord(value.capacity) &&
    Number.isSafeInteger(value.capacity.cpuMillis) &&
    Number.isSafeInteger(value.capacity.memoryMiB) &&
    isRecord(report) &&
    typeof report.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(report.sha256) &&
    isRecord(scopes) &&
    Object.keys(scopes).length === names.length &&
    names.every(
      (name) => isRecord(scopes[name]) && scopes[name].status === "passed",
    )
  );
}
