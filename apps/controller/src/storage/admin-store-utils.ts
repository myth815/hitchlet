import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type Row = Record<string, string | number | bigint | null>;

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function parseJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError("Stored JSON must be an object");
  return parsed as Record<string, unknown>;
}
export function str(value: unknown) {
  return typeof value === "string" ? value : "";
}
export function integer(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError("Admin DTO exceeds the safe integer range");
  return n;
}
export function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}
export function projectEvidence(value: string) {
  const e = parseJson(value);
  return {
    engineId: str(e.engineId),
    dockerVersion: str(e.dockerVersion),
    apiVersion: str(e.apiVersion),
    minimumApiVersion: str(e.minimumApiVersion),
    os: str(e.os),
    architecture: str(e.architecture),
    portainerVersion: str(e.portainerVersion),
    cpuCount: integer(e.cpuCount),
    memoryBytes: integer(e.memoryBytes),
    containerCount: integer(e.containerCount),
    unmanagedContainerCount: integer(e.unmanagedContainerCount),
  };
}
export function projectCapabilities(value: string) {
  const c = parseJson(value);
  return {
    verified:
      c.cpuHardLimit === "verified" &&
      c.memoryHardLimit === "verified" &&
      c.networkPolicyEnforcement === "verified",
    expiresAt: typeof c.expiresAt === "string" ? c.expiresAt : null,
    architectures: Array.isArray(c.architectures)
      ? c.architectures.filter((x) => x === "amd64" || x === "arm64")
      : [],
    guestOs: Array.isArray(c.guestOs)
      ? c.guestOs.filter(
          (x) => x === "linux" || x === "windows" || x === "macos",
        )
      : [],
    resourceKinds: Array.isArray(c.resourceKinds)
      ? c.resourceKinds.filter((x) => x === "container" || x === "vm")
      : [],
    supportedAccess: Array.isArray(c.supportedAccess)
      ? c.supportedAccess.filter((x) => x === "ssh" || x === "rdp")
      : [],
  };
}
export function validateArtifact(ref: string, digest: string) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(digest) ||
    !/^.+@sha256:[a-f0-9]{64}$/.test(ref) ||
    !ref.endsWith(`@${digest}`)
  )
    throw new RangeError(
      "Artifact reference and digest must pin the same OCI manifest by SHA-256 digest",
    );
}
export function normalizeDraftRequirements(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RangeError("Draft requirements must be an object");
  const input = value as Record<string, unknown>;
  const bootstrap = input.bootstrap !== undefined ? input.bootstrap : input;
  const capabilities = input.requiredCapabilities ?? [];
  if (
    !Array.isArray(capabilities) ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" || capability.trim().length === 0,
    )
  )
    throw new RangeError("Required capabilities must be named strings");
  return { bootstrap, requiredCapabilities: capabilities as string[] };
}
export function validateBootstrapAndAccess(
  bootstrap: unknown,
  access: unknown,
) {
  if (
    !bootstrap ||
    typeof bootstrap !== "object" ||
    Array.isArray(bootstrap) ||
    !access ||
    typeof access !== "object" ||
    Array.isArray(access)
  )
    throw new RangeError("Bootstrap and access contracts are required");
  const b = bootstrap as Record<string, unknown>,
    a = access as Record<string, unknown>;
  if (
    typeof b.mechanism !== "string" ||
    !b.mechanism.trim() ||
    typeof b.contractVersion !== "string" ||
    !b.contractVersion.trim() ||
    b.identityReset !== true
  )
    throw new RangeError(
      "Bootstrap requires a versioned mechanism and identity reset contract",
    );
  if (
    !Array.isArray(a.accessProtocols) ||
    a.accessProtocols.length === 0 ||
    a.accessProtocols.some((x) => x !== "ssh" && x !== "rdp") ||
    !Array.isArray(a.ports) ||
    a.ports.length === 0 ||
    a.ports.some((x) => !Number.isInteger(x) || x < 1 || x > 65535) ||
    typeof a.account !== "string" ||
    !a.account.trim() ||
    !Array.isArray(a.allowedSourceCidrs) ||
    typeof a.discovery !== "string" ||
    !a.discovery.trim() ||
    typeof a.readiness !== "string" ||
    !a.readiness.trim()
  )
    throw new RangeError(
      "Access contract requires protocols, ports, account, allowed sources, discovery, and readiness",
    );
}
export function validateNetworkProfile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RangeError("Network profile must be a structured policy");
  const p = value as Record<string, unknown>;
  if (
    !Array.isArray(p.allowedEgress) ||
    !Array.isArray(p.allowedIngressSourceCidrs) ||
    !new Set(["disabled", "verified_equivalent"]).has(String(p.ipv6))
  )
    throw new RangeError(
      "Network profile must declare allowed egress, ingress sources, and IPv6 policy",
    );
  const cidr = (candidate: unknown) => {
    if (typeof candidate !== "string") return false;
    const [address, prefix, extra] = candidate.split("/");
    const bits = isIP(address ?? "");
    return (
      bits > 0 &&
      prefix !== undefined &&
      extra === undefined &&
      /^\d+$/.test(prefix) &&
      Number(prefix) <= (bits === 4 ? 32 : 128)
    );
  };
  for (const entry of p.allowedEgress) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new RangeError("Invalid network egress rule");
    const rule = entry as Record<string, unknown>;
    if (
      !cidr(rule.cidr) ||
      !new Set(["tcp", "udp"]).has(String(rule.protocol)) ||
      !Array.isArray(rule.ports) ||
      rule.ports.length === 0 ||
      rule.ports.some(
        (port) =>
          !Number.isSafeInteger(port) ||
          Number(port) < 1 ||
          Number(port) > 65535,
      )
    )
      throw new RangeError("Invalid network egress rule");
  }
  if (p.allowedIngressSourceCidrs.some((source) => !cidr(source)))
    throw new RangeError("Ingress sources must use fixed CIDRs");
}
export function safeRelativePath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.endsWith("/") &&
    value
      .split("/")
      .every((part) => part !== "." && part !== ".." && part.length > 0)
  );
}
export function safeMountPath(value: string) {
  return (
    /^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) &&
    !value.endsWith("/") &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}
