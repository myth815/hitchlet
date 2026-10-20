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
