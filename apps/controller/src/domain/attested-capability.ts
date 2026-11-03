function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the stored evidence envelope used by Node health and formal admission. */
export function validAttestedCapability(
  value: unknown,
  now: number,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const expiry =
    typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  if (
    !Number.isFinite(expiry) ||
    expiry <= now ||
    !["constant_online_manual_inventory", "observed_host"].includes(
      String(value.admissionMode),
    ) ||
    value.offline !== false ||
    value.powerEnabled !== false ||
    typeof value.connectionRevisionId !== "string" ||
    value.cpuHardLimit !== "verified" ||
    value.memoryHardLimit !== "verified" ||
    value.networkPolicyEnforcement !== "verified" ||
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
  const scopes = report.scopes;
  const names = [
    "resourceLimits",
    "firewallInput",
    "firewallForward",
    "ipv6",
    "sshBootstrap",
    "cleanupRecovery",
  ];
  return (
    isRecord(scopes) &&
    Object.keys(scopes).length === names.length &&
    names.every(
      (name) => isRecord(scopes[name]) && scopes[name].status === "passed",
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
