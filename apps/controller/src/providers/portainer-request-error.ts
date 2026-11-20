/** Fixed vocabulary only. Never persist request paths, URLs, headers or remote bodies. */
import type { PortainerFailure } from "@hitchlet/contracts/internal";
export type { PortainerFailure } from "@hitchlet/contracts/internal";

export class PortainerRequestError extends Error {
  constructor(readonly diagnostic: PortainerFailure) {
    super(`Portainer ${diagnostic.stage}: ${diagnostic.category}`);
    this.name = "PortainerRequestError";
  }
}

export function requestStage(path: string): PortainerFailure["stage"] {
  if (path.startsWith("distribution/")) return "manifest";
  if (path.startsWith("images/")) return "image_inspect";
  if (path.startsWith("containers/create")) return "container_create";
  if (/^containers\/[^/]+\/start$/.test(path)) return "container_start";
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
