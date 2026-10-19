import type { PreparedTicketCommand } from "@hitchlet/sdk";

const PREFIX = "hitchlet.prepared.v1.";
const MAX_COMMANDS = 8;

export interface SavedCommand {
  // Kept untrusted until HitchletClient.tickets.resume applies the shared schema.
  readonly command: unknown;
  readonly savedAt: string;
}

export interface PreparedCommandHint {
  readonly kind: PreparedTicketCommand["kind"] | null;
  readonly idempotencyKey: string | null;
  readonly ticketId: string | null;
}

export function preparedHint(command: unknown): PreparedCommandHint {
  if (typeof command !== "object" || command === null)
    return { kind: null, idempotencyKey: null, ticketId: null };
  const candidate = command as Record<string, unknown>;
  const validKind = [
    "acquire",
    "renew",
    "release",
    "cancel",
    "access",
  ].includes(String(candidate.kind));
  return {
    kind: validKind ? (candidate.kind as PreparedTicketCommand["kind"]) : null,
    idempotencyKey:
      typeof candidate.idempotencyKey === "string"
        ? candidate.idempotencyKey
        : null,
    ticketId:
      typeof candidate.ticketId === "string" ? candidate.ticketId : null,
  };
}

function key(consumerId: string) {
  return `${PREFIX}${consumerId}`;
}

export function readPrepared(consumerId: string): readonly SavedCommand[] {
  try {
    const parsed: unknown = JSON.parse(
      sessionStorage.getItem(key(consumerId)) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SavedCommand =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Partial<SavedCommand>).savedAt === "string" &&
          "command" in item,
      )
      .slice(0, MAX_COMMANDS);
  } catch {
    return [];
  }
}

export function savePrepared(
  consumerId: string,
  command: PreparedTicketCommand,
) {
  const existing = readPrepared(consumerId);
  const current = existing.filter(
    (item) =>
      preparedHint(item.command).idempotencyKey !== command.idempotencyKey,
  );
  if (current.length >= MAX_COMMANDS)
    throw new Error(
      "待恢复操作已达 8 条上限，请先恢复或确认旧请求结果。新请求未发送。",
    );
  sessionStorage.setItem(
    key(consumerId),
    JSON.stringify([
      { command, savedAt: new Date().toISOString() },
      ...current,
    ]),
  );
}

export function forgetPrepared(consumerId: string, idempotencyKey: string) {
  const next = readPrepared(consumerId).filter(
    (item) => preparedHint(item.command).idempotencyKey !== idempotencyKey,
  );
  sessionStorage.setItem(key(consumerId), JSON.stringify(next));
}
