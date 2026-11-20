import { expect, it } from "vitest";
import { runtimeFailure } from "../src/diagnostic.js";
import { FixedCommandTimeoutError } from "../src/command-exec.js";
import { RuntimeConflictSchema } from "@hitchlet/contracts/internal";
const requestId = "00000000-0000-4000-8000-000000000001";
it.each([
  [new Error("Storage identity mismatch"), "identity_mismatch"],
  [new Error("Workload Runtime identity mismatch"), "identity_mismatch"],
  [new Error("Stale controller epoch"), "stale_command"],
  [
    new Error("Command id was replayed with different content"),
    "replay_conflict",
  ],
  [new Error("Storage path escaped approved root"), "storage_boundary"],
  [new Error("Approved ext4 submount is absent or replaced"), "mount_changed"],
  [
    Object.assign(new Error("PRIVATE_PATH"), { code: "EACCES" }),
    "permission_denied",
  ],
  [
    new Error("Docker iptables firewall backend is required"),
    "required_capability_unavailable",
  ],
  [new FixedCommandTimeoutError(), "command_timeout"],
  [
    new Error("PRIVATE_TOKEN http://PRIVATE_HOST/PRIVATE_PATH"),
    "operation_failed",
  ],
] as const)("keeps only the fixed Runtime category %s", (error, category) => {
  const result = runtimeFailure(error, "network_action", requestId, requestId);
  expect(RuntimeConflictSchema.parse({ error: result }).error).toMatchObject({
    category,
    requestId,
    operationId: requestId,
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("does not infer a replaced mount from an unrelated missing network command", () => {
  const error = Object.assign(new Error("PRIVATE_MISSING_BINARY"), {
    code: "ENOENT",
  });
  expect(runtimeFailure(error, "network_action", requestId).category).toBe(
    "operation_failed",
  );
  expect(runtimeFailure(error, "storage_facts", requestId).category).toBe(
    "mount_changed",
  );
});
