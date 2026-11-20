/** Fixed vocabulary only. Never persist request paths, URLs, headers or remote bodies. */
import type { PortainerFailure } from "@hitchlet/contracts/internal";
export type { PortainerFailure } from "@hitchlet/contracts/internal";

export class PortainerRequestError extends Error {
  constructor(readonly diagnostic: PortainerFailure) {
    super(`Portainer ${diagnostic.stage}: ${diagnostic.category}`);
    this.name = "PortainerRequestError";
  }
}

export function requestStage(
  path: string,
  method = "GET",
): PortainerFailure["stage"] {
  if (path.startsWith("distribution/")) return "manifest";
  if (path.startsWith("images/")) return "image_inspect";
  if (path.startsWith("containers/create")) return "container_create";
  if (/^containers\/[^/]+\/start$/.test(path)) return "container_start";
  if (method === "GET" && /^containers\/[^/]+\/json$/.test(path))
    return "container_inspect";
  if (method === "GET" && /^networks\/[^/?]+$/.test(path))
    return "network_inspect";
  return "docker_request";
}

/** Classify a remote or transport error without returning any part of its text. */
export function failureCategory(
  value: unknown,
  fallback: "http_error" | "transport_error",
): PortainerFailure["category"] {
  const message =
    typeof value === "string"
      ? value
      : value instanceof Error
        ? value.message
        : "";
  const cause =
    value instanceof Error &&
    value.cause &&
    typeof value.cause === "object" &&
    "code" in value.cause
      ? value.cause.code
      : undefined;
  if (
    cause === "ECONNREFUSED" ||
    /connection refused|ECONNREFUSED/i.test(message)
  )
    return "connection_refused";
  if (
    cause === "ENOTFOUND" ||
    cause === "EAI_AGAIN" ||
    /no such host|ENOTFOUND|EAI_AGAIN/i.test(message)
  )
    return "name_resolution_failed";
  if (
    cause === "ETIMEDOUT" ||
    (value instanceof Error &&
      ["TimeoutError", "AbortError"].includes(value.name)) ||
    /i\/o timeout|context deadline exceeded|ETIMEDOUT/i.test(message)
  )
    return "timeout";
  return fallback;
}

/** The caller already located an owned resource. Preserve only bounded inspect facts. */
export function assertContainerRunning(
  detail: Record<string, unknown>,
  expectedId: string,
  stage: "container_start" | "readiness",
): void {
  if (detail.Id !== expectedId)
    throw new PortainerRequestError({
      provider: "portainer",
      stage,
      category: "configuration_mismatch",
      reasonCode: "container_identity_mismatch",
    });
  const state =
    detail.State && typeof detail.State === "object"
      ? (detail.State as Record<string, unknown>)
      : {};
  if (state.Running === true) return;
  const status = state.Status;
  const exited = status === "exited" || status === "dead";
  const knownState =
    status === "created" ||
    status === "running" ||
    status === "paused" ||
    status === "restarting" ||
    status === "removing" ||
    status === "exited" ||
    status === "dead";
  throw new PortainerRequestError({
    provider: "portainer",
    stage,
    category: exited ? "process_exited" : "evidence_missing",
    reasonCode: exited
      ? "container_process_exited"
      : "container_running_unverified",
    ...(knownState ? { containerState: status } : {}),
    ...(exited &&
    typeof state.ExitCode === "number" &&
    Number.isSafeInteger(state.ExitCode)
      ? { exitCode: state.ExitCode }
      : {}),
    ...(exited && typeof state.OOMKilled === "boolean"
      ? { oomKilled: state.OOMKilled }
      : {}),
  });
}
