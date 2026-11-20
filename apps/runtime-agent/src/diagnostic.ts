import type { RuntimeFailure } from "@hitchlet/contracts/internal";
import { isFixedCommandTimeout } from "./command-exec.js";

/** Exact known assertions only; unknown exception text is never reflected. */
export function runtimeFailure(
  error: unknown,
  stage: RuntimeFailure["stage"],
  requestId: string,
  operationId?: string,
): RuntimeFailure {
  const message = error instanceof Error ? error.message : "";
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  let category: RuntimeFailure["category"] = "operation_failed";
  if (isFixedCommandTimeout(error)) category = "command_timeout";
  else if (code === "EACCES" || code === "EPERM")
    category = "permission_denied";
  else if (
    [
      "Storage identity mismatch",
      "Workload Runtime identity mismatch",
      "Engine changed",
      "Native Engine identity mismatch",
      "Command identity does not match its network plan",
      "Plan targets another Engine",
    ].includes(message)
  )
    category = "identity_mismatch";
  else if (
    [
      "Stale controller epoch",
      "Stale allocation generation or control version",
      "Command deadline expired",
    ].includes(message)
  )
    category = "stale_command";
  else if (
    [
      "Command content hash mismatch",
      "Command id was replayed with different content",
      "Expected ruleset hash mismatch",
    ].includes(message)
  )
    category = "replay_conflict";
  else if (
    [
      "Storage path escaped approved root",
      "Agent path does not map to the daemon host directory",
      "Tenant-writable storage ancestor is not approved",
    ].includes(message)
  )
    category = "storage_boundary";
  else if (
    (stage === "storage_facts" && code === "ENOENT") ||
    [
      "Approved storage mount is absent or replaced",
      "Approved ext4 submount is absent or replaced",
      "Workspace backing image is absent or replaced",
      "Workspace mount facts directory is not root-owned 0700",
      "Workspace mount fact is not a root-owned 0600 file",
    ].includes(message)
  )
    category = "mount_changed";
  else if (
    [
      "Docker iptables firewall backend is required",
      "Cannot verify Docker firewall capabilities",
      "Linux br_netfilter module is not loaded",
      "Allocation bridge iptables hooks are not enabled",
    ].includes(message)
  )
    category = "required_capability_unavailable";
  const advice: RuntimeFailure["message"] =
    category === "identity_mismatch"
      ? "Check Runtime installation and Engine binding; retry the original request."
      : ["storage_boundary", "mount_changed", "permission_denied"].includes(
            category,
          )
        ? "Refresh authorized mount facts and read-only path mappings; retry the original request."
        : category === "required_capability_unavailable"
          ? "Check the required capability for this selected profile; keep the existing lease tracked."
          : "Inspect the original operation and reconcile its journal; do not create a replacement allocation.";
  return {
    provider: "runtime",
    stage,
    category,
    message: advice,
    requestId,
    ...(operationId ? { operationId } : {}),
  };
}
