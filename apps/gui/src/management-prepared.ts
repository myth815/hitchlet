import {
  PreparedManagementRequestSchema,
  ComputeClientError,
  type PreparedManagementRequest,
} from "@hitchlet/sdk";
const storageKey = (consumerId: string) =>
  `hitchlet.management.requests.${consumerId}`;
/** Safe replay whitelist is defined by contracts. Secret issuance/access and arbitrary URLs cannot enter this tab store. */
export function managementPrepared(
  consumerId: string,
): PreparedManagementRequest[] {
  const raw = sessionStorage.getItem(storageKey(consumerId));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed))
    throw new Error("Invalid management recovery store");
  return parsed.map((value) => PreparedManagementRequestSchema.parse(value));
}
export function saveManagementPrepared(
  consumerId: string,
  command: PreparedManagementRequest,
) {
  const parsed = PreparedManagementRequestSchema.parse(command),
    existing = managementPrepared(consumerId),
    original = existing.find((c) => c.idempotencyKey === parsed.idempotencyKey);
  if (original && JSON.stringify(original) !== JSON.stringify(parsed))
    throw new Error("Original management command changed");
  if (
    !original &&
    existing.some(
      (c) =>
        c.method === parsed.method &&
        c.path === parsed.path &&
        c.expectedVersion === parsed.expectedVersion &&
        canonical(c.body) === canonical(parsed.body),
    )
  )
    throw new ComputeClientError({
      code: "MANAGEMENT_INTENT_PENDING",
      message: "同一对象的原意图尚未确认；请恢复已保存的原命令键。",
    });
  sessionStorage.setItem(
    storageKey(consumerId),
    JSON.stringify(original ? existing : [...existing, parsed]),
  );
}
export function forgetManagementPrepared(consumerId: string, key: string) {
  sessionStorage.setItem(
    storageKey(consumerId),
    JSON.stringify(
      managementPrepared(consumerId).filter((c) => c.idempotencyKey !== key),
    ),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
