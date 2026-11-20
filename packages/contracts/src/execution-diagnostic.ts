import { z } from "zod";

/** Bounded diagnostic vocabulary, never request/response text or credentials. */
export const PortainerFailureSchema = z
  .object({
    provider: z.literal("portainer"),
    stage: z.enum([
      "manifest",
      "image_inspect",
      "container_create",
      "container_start",
      "docker_request",
      "node_probe",
    ]),
    category: z.enum([
      "connection_refused",
      "name_resolution_failed",
      "timeout",
      "http_error",
      "transport_error",
      "invalid_response",
      "configuration_mismatch",
      "evidence_missing",
      "credential_unavailable",
    ]),
    statusCode: z.number().int().min(100).max(599).optional(),
  })
  .strict();
export type PortainerFailure = z.infer<typeof PortainerFailureSchema>;
export const RuntimeFailureSchema = z
  .object({
    provider: z.literal("runtime"),
    stage: z.enum(["network_action", "storage_facts", "workload_facts"]),
    category: z.enum([
      "identity_mismatch",
      "stale_command",
      "replay_conflict",
      "storage_boundary",
      "mount_changed",
      "permission_denied",
      "required_capability_unavailable",
      "command_timeout",
      "operation_failed",
    ]),
    requestId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200).optional(),
    message: z.enum([
      "Check Runtime installation and Engine binding; retry the original request.",
      "Refresh authorized mount facts and read-only path mappings; retry the original request.",
      "Inspect the original operation and reconcile its journal; do not create a replacement allocation.",
      "Check the required capability for this selected profile; keep the existing lease tracked.",
    ]),
  })
  .strict();
export type RuntimeFailure = z.infer<typeof RuntimeFailureSchema>;
export type ExecutionFailure =
  | PortainerFailure
  | (RuntimeFailure & { statusCode: number })
  | {
      provider: "execution";
      stage: "provision" | "cleanup";
      category: "unclassified_error";
    };
export const RuntimeConflictSchema = z
  .object({ error: RuntimeFailureSchema })
  .strict();

/** Safe historical projection for existing scoped operation readers. */
const operationFailureFields = {
  operationId: z.string().min(1).max(200),
  observedAtMs: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  operation: z.enum(["provision", "cleanup"]),
};
export const OperationFailureSchema = z.union([
  PortainerFailureSchema.extend(operationFailureFields),
  RuntimeFailureSchema.omit({ message: true, requestId: true }).extend({
    ...operationFailureFields,
    statusCode: z.number().int().min(100).max(599),
  }),
  z
    .object({
      provider: z.literal("execution"),
      stage: z.enum(["provision", "cleanup"]),
      category: z.literal("unclassified_error"),
      ...operationFailureFields,
    })
    .strict(),
]);
