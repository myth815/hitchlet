import {
  PreparedManagementRequestSchema,
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
  if (!original && existing.length >= 8)
    throw new Error("Management recovery store full");
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
