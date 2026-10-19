import type { PortainerProbe } from "./port.js";

/** Read-only Portainer X-API-Key and Docker Engine identity probe. No endpoint accepts mutations. */
export const probePortainer: PortainerProbe = async ({
  endpointUrl,
  environmentId,
  apiKey,
}) => {
  const base = new URL(endpointUrl);
  const request = async (path: string): Promise<unknown> => {
    const url = new URL(path, `${base.toString().replace(/\/$/, "")}/`);
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Portainer authentication or environment authorization failed"
          : `Portainer read probe failed (${response.status})`,
      );
    return response.json() as Promise<unknown>;
  };
  const root = `/api/endpoints/${encodeURIComponent(environmentId)}/docker/`;
  const [info, version, systemVersion, containers] = await Promise.all([
    request(`${root}info`),
    request(`${root}version`),
    request("/api/system/version"),
    request(`${root}containers/json?all=true`),
  ]);
  const i = record(info),
    v = record(version),
    p = record(systemVersion);
  const engineId = nonempty(i.ID),
    dockerVersion = nonempty(v.Version),
    apiVersion = nonempty(v.ApiVersion),
    minimumApiVersion = nonempty(v.MinAPIVersion),
    os = nonempty(i.OSType);
  const infoArchitecture = normalizeArchitecture(nonempty(i.Architecture));
  const versionArchitecture = normalizeArchitecture(nonempty(v.Arch));
  const architecture =
    infoArchitecture &&
    versionArchitecture &&
    infoArchitecture === versionArchitecture
      ? versionArchitecture
      : null;
  const portainerVersion = nonempty(p.ServerVersion);
  if (
    !engineId ||
    !dockerVersion ||
    !apiVersion ||
    !minimumApiVersion ||
    !os ||
    !architecture ||
    !portainerVersion ||
    typeof i.NCPU !== "number" ||
    !Number.isSafeInteger(i.NCPU) ||
    typeof i.MemTotal !== "number" ||
    !Number.isSafeInteger(i.MemTotal) ||
    !Array.isArray(containers)
  )
    throw new Error(
      "Portainer returned incomplete Engine identity/version/capacity/inventory evidence",
    );
  const inventory = containers.map(record);
  if (
    inventory.some(
      (item) =>
        typeof item.Id !== "string" ||
        (item.Labels !== null && typeof item.Labels !== "object"),
    )
  )
    throw new Error("Portainer returned an incomplete container inventory");
  // No resource is recognized as owned from a label namespace alone. Until an
  // ownership manifest is independently reconciled, every observed object is
  // conservatively unverified and must be treated as unmanaged work.
  return {
    engineId,
    dockerVersion,
    apiVersion,
    minimumApiVersion,
    os,
    architecture,
    portainerVersion,
    cpuCount: i.NCPU,
    memoryBytes: i.MemTotal,
    containerCount: inventory.length,
    unmanagedContainerCount: inventory.length,
  };
};
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function normalizeArchitecture(value: string | null): string | null {
  if (value === "amd64" || value === "x86_64" || value === "x86-64")
    return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return null;
}
