import {
  AcquireRequestSchema,
  AcquireReceiptSchema,
  AccessGrantSchema,
  CancelRequestSchema,
  LeaseRenewalViewSchema,
  PreparedTicketCommandSchema,
  RenewOutcomeSchema,
  RenewReceiptSchema,
  ReadyTicketViewSchema,
  ReleasedTicketViewSchema,
  ReleaseRequestSchema,
  RenewRequestSchema,
  TicketListQuerySchema,
  TicketSummaryPageSchema,
  TicketViewSchema,
} from "@hitchlet/contracts";
import type {
  AccessGrant,
  AcquireRequest,
  AcquireReceipt,
  ClientRenewRequest,
  ClientWriteOptions,
  Id,
  LeaseRenewalView,
  PreparedTicketCommand,
  ReadyTicketView,
  ReleasedTicketView,
  RenewReceipt,
  TicketCommandResult,
  TicketListQuery,
  TicketSummary,
  TicketView,
  WaitOptions,
} from "@hitchlet/contracts/public";
import { ComputeClientError, HttpTransport, queryString } from "./transport.js";

const ReadyTicketSchema = ReadyTicketViewSchema;
const ReleasedTicketSchema = ReleasedTicketViewSchema;

interface CacheEntry {
  readonly intent: string;
  readonly command: PreparedTicketCommand;
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
      );
    return item;
  });
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}
function read<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  return schema.parse(value);
}
function readRequest<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return read(schema, value);
  } catch (error) {
    throw new ComputeClientError({
      code: "INVALID_REQUEST",
      message: "The request does not match the public contract.",
      cause: error,
    });
  }
}
function randomKey(): string {
  if (!globalThis.crypto?.randomUUID)
    throw new ComputeClientError({
      code: "SDK_RANDOMNESS_UNAVAILABLE",
      message:
        "A cryptographic randomUUID implementation is required to create idempotency keys.",
    });
  return globalThis.crypto.randomUUID();
}

export class TicketCommands {
  private readonly prepared = new Map<string, CacheEntry>();
  constructor(private readonly http: HttpTransport) {}

  private scope(
    kind: PreparedTicketCommand["kind"],
    _ticketId: string | null,
    key: string,
  ): string {
    return `${kind}:${key}`;
  }

  private intentFrom(command: PreparedTicketCommand): unknown {
    switch (command.kind) {
      case "acquire":
        return command.request;
      case "renew":
        return { requestedTtlSec: command.request.requestedTtlSec };
      case "release":
        return { reclaimable: command.request.reclaimable };
      case "cancel":
        return command.request;
      case "access":
        return {};
    }
  }

  private cached<K extends PreparedTicketCommand["kind"]>(
    kind: K,
    ticketId: string | null,
    key: string,
    intent: unknown,
  ): Extract<PreparedTicketCommand, { kind: K }> | undefined {
    const existing = this.prepared.get(this.scope(kind, ticketId, key));
    if (!existing) return undefined;
    if (existing.intent !== stable({ ticketId, intent })) {
      throw new ComputeClientError({
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message:
          "This idempotency key is already bound to a different command.",
        recovery: { command: existing.command, ticketId, idempotencyKey: key },
      });
    }
    return existing.command as Extract<PreparedTicketCommand, { kind: K }>;
  }

  private async prepare<K extends PreparedTicketCommand["kind"]>(
    kind: K,
    ticketId: string | null,
    key: string,
    body: unknown,
    intent: unknown,
    onPrepared?: ClientWriteOptions["onPrepared"],
    deadlineAt?: number,
  ): Promise<Extract<PreparedTicketCommand, { kind: K }>> {
    const scope = this.scope(kind, ticketId, key);
    const fingerprint = stable({ ticketId, intent });
    const existing = this.prepared.get(scope);
    if (existing) {
      if (existing.intent !== fingerprint)
        throw new ComputeClientError({
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message:
            "This idempotency key is already bound to a different command.",
          recovery: {
            command: existing.command,
            ticketId,
            idempotencyKey: key,
          },
        });
      return existing.command as Extract<PreparedTicketCommand, { kind: K }>;
    }
    const candidate = {
      schemaVersion: 1,
      kind,
      idempotencyKey: key,
      ...(ticketId ? { ticketId } : {}),
      request: body,
    };
    let command: Extract<PreparedTicketCommand, { kind: K }>;
    try {
      command = freezeDeep(
        read(PreparedTicketCommandSchema, candidate),
      ) as Extract<PreparedTicketCommand, { kind: K }>;
    } catch (error) {
      throw new ComputeClientError({
        code: "INVALID_PREPARED_COMMAND",
        message: "The SDK could not construct a valid prepared command.",
        recovery: { ticketId, idempotencyKey: key },
        cause: error,
      });
    }
    if (onPrepared) {
      let persistenceTimedOut = false;
      try {
        const persistence = onPrepared(command);
        if (deadlineAt === undefined) {
          await persistence;
        } else {
          const remaining = deadlineAt - this.http.now();
          if (remaining <= 0) {
            persistenceTimedOut = true;
            throw new Error("Renewal preparation deadline exceeded");
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              persistence,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  persistenceTimedOut = true;
                  reject(new Error("Renewal preparation deadline exceeded"));
                }, remaining);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
      } catch (error) {
        throw new ComputeClientError({
          code: persistenceTimedOut
            ? "RENEWAL_PREPARATION_TIMEOUT"
            : "PREPARED_COMMAND_SAVE_FAILED",
          message:
            "The prepared command was not sent because it could not be persisted before the deadline.",
          retryable: true,
          recovery: { command, ticketId, idempotencyKey: key },
          cause: error,
        });
      }
    }
    this.prepared.set(scope, { intent: fingerprint, command });
    return command;
  }

  private context(command: PreparedTicketCommand) {
    return {
      command,
      key: command.idempotencyKey,
      ...("ticketId" in command ? { ticketId: command.ticketId } : {}),
    };
  }

  private recovery(command: PreparedTicketCommand) {
    return {
      command,
      ticketId: "ticketId" in command ? command.ticketId : null,
      idempotencyKey: command.idempotencyKey,
    };
  }

  private async send(
    command: PreparedTicketCommand,
    deadlineAt?: number,
  ): Promise<TicketCommandResult<typeof command>> {
    const context = this.context(command);
    switch (command.kind) {
      case "acquire": {
        const receipt = await this.http.request(
          "/v1/tickets",
          "POST",
          command.request,
          (v) => read(AcquireReceiptSchema, v),
          context,
        );
        if (receipt.idempotencyKey !== command.idempotencyKey)
          throw new ComputeClientError({
            code: "INVALID_RESPONSE",
            message:
              "The server response idempotency key does not match the prepared command.",
            recovery: this.recovery(command),
          });
        return {
          ticket: receipt.ticket,
          idempotencyKey: receipt.idempotencyKey,
        } as TicketCommandResult<typeof command>;
      }
      case "renew":
        return (await this.submitRenewal(
          command,
          deadlineAt ?? this.http.now() + 15_000,
        )) as TicketCommandResult<typeof command>;
      case "release":
        return (await this.http.request(
          `/v1/tickets/${encodeURIComponent(command.ticketId)}/release`,
          "POST",
          command.request,
          (v) => read(TicketViewSchema, v),
          context,
        )) as TicketCommandResult<typeof command>;
      case "cancel":
        return (await this.http.request(
          `/v1/tickets/${encodeURIComponent(command.ticketId)}/cancel`,
          "POST",
          command.request,
          (v) => read(TicketViewSchema, v),
          context,
        )) as TicketCommandResult<typeof command>;
      case "access":
        return (await this.http.request(
          `/v1/tickets/${encodeURIComponent(command.ticketId)}/access`,
          "POST",
          command.request,
          (v) => read(AccessGrantSchema, v),
          context,
        )) as TicketCommandResult<typeof command>;
    }
  }

  private async submitRenewal(
    command: Extract<PreparedTicketCommand, { kind: "renew" }>,
    deadlineAt: number,
  ): Promise<RenewReceipt> {
    const remainingBeforePost = deadlineAt - this.http.now();
    if (remainingBeforePost <= 0)
      throw new ComputeClientError({
        code: "RENEWAL_PREPARATION_TIMEOUT",
        message: "The renewal deadline elapsed before the write was sent.",
        retryable: true,
        recovery: {
          command,
          ticketId: command.ticketId,
          idempotencyKey: command.idempotencyKey,
        },
      });
    const submission = await this.http.request(
      `/v1/tickets/${encodeURIComponent(command.ticketId)}/renew`,
      "POST",
      command.request,
      (value) => {
        const receipt = RenewReceiptSchema.safeParse(value);
        if (receipt.success)
          return { kind: "receipt" as const, receipt: receipt.data };
        return {
          kind: "outcome" as const,
          outcome: read(RenewOutcomeSchema, value),
        };
      },
      {
        ...this.context(command),
        acceptedStatuses: [409],
        timeoutMilliseconds: remainingBeforePost,
      },
    );
    if (submission.kind === "receipt") return freezeDeep(submission.receipt);
    const outcome = submission.outcome;
    if (outcome.outcome === "confirmed") return freezeDeep(outcome.receipt);
    if (outcome.outcome === "rejected")
      throw new ComputeClientError({
        code: outcome.reasonCode,
        message: "The original renewal proposal was rejected.",
        recovery: {
          command,
          ticketId: command.ticketId,
          renewalId: outcome.renewal.id,
          idempotencyKey: command.idempotencyKey,
        },
      });
    let renewal: LeaseRenewalView = outcome.renewal;
    const deadline = Math.min(deadlineAt, Date.parse(renewal.decisionDeadline));
    while (renewal.state === "pending" && this.http.now() < deadline) {
      await this.http.sleep(
        Math.min(500, Math.max(1, deadline - this.http.now())),
      );
      renewal = await this.http.request(
        `/v1/tickets/${encodeURIComponent(command.ticketId)}/renewals/${encodeURIComponent(renewal.id)}`,
        "GET",
        undefined,
        (v) => read(LeaseRenewalViewSchema, v),
        {
          ...this.context(command),
          renewalId: renewal.id,
          timeoutMilliseconds: Math.max(
            1,
            Math.min(30_000, deadline - this.http.now()),
          ),
        },
      );
    }
    if (renewal.state === "confirmed" && renewal.confirmedReceipt)
      return freezeDeep(renewal.confirmedReceipt);
    if (renewal.state === "rejected" || renewal.state === "cancelled") {
      throw new ComputeClientError({
        code: renewal.reasonCode ?? "RENEWAL_REJECTED",
        message: "The original renewal proposal was rejected.",
        recovery: {
          command,
          ticketId: command.ticketId,
          renewalId: renewal.id,
          idempotencyKey: command.idempotencyKey,
        },
      });
    }
    throw new ComputeClientError({
      code: "RENEWAL_PENDING",
      message:
        "The original renewal is still pending; no extension is confirmed.",
      retryable: true,
      recovery: {
        command,
        ticketId: command.ticketId,
        renewalId: renewal.id,
        idempotencyKey: command.idempotencyKey,
      },
    });
  }

  async resume<C extends PreparedTicketCommand>(
    command: C,
  ): Promise<TicketCommandResult<C>> {
    const deadlineAt = this.http.now() + 15_000;
    let parsed: PreparedTicketCommand;
    try {
      const validated = read(PreparedTicketCommandSchema, command);
      parsed = freezeDeep(
        read(PreparedTicketCommandSchema, structuredClone(validated)),
      );
    } catch (error) {
      throw new ComputeClientError({
        code: "INVALID_PREPARED_COMMAND",
        message:
          "The saved command has an unknown version, invalid body, or unsupported fields.",
        cause: error,
      });
    }
    const target = "ticketId" in parsed ? parsed.ticketId : null;
    const intent = stable({
      ticketId: target,
      intent: this.intentFrom(parsed),
    });
    const scope = this.scope(parsed.kind, target, parsed.idempotencyKey);
    const existing = this.prepared.get(scope);
    if (existing && stable(existing.command) !== stable(parsed))
      throw new ComputeClientError({
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message:
          "This idempotency key is already bound to a different command.",
        recovery: {
          command: existing.command,
          ticketId: "ticketId" in parsed ? parsed.ticketId : null,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    this.prepared.set(scope, { intent, command: parsed });
    return (await this.send(parsed, deadlineAt)) as TicketCommandResult<C>;
  }

  async acquire(
    request: AcquireRequest,
    options: ClientWriteOptions = {},
  ): Promise<AcquireReceipt> {
    const checked = readRequest(AcquireRequestSchema, request);
    const key = options.idempotencyKey ?? randomKey();
    const command =
      this.cached("acquire", null, key, checked) ??
      (await this.prepare(
        "acquire",
        null,
        key,
        checked,
        checked,
        options.onPrepared,
      ));
    return (await this.send(command)) as AcquireReceipt;
  }

  async get(ticketId: Id): Promise<TicketView> {
    return this.http.request(
      `/v1/tickets/${encodeURIComponent(ticketId)}`,
      "GET",
      undefined,
      (v) => read(TicketViewSchema, v),
      { ticketId },
    );
  }

  async list(query: TicketListQuery = {}): Promise<{
    readonly items: readonly TicketSummary[];
    readonly nextCursor: string | null;
  }> {
    const checked = readRequest(TicketListQuerySchema, query);
    return this.http.request(
      `/v1/tickets${queryString(checked)}`,
      "GET",
      undefined,
      (v) => read(TicketSummaryPageSchema, v),
    );
  }

  async waitUntilReady(
    ticketId: Id,
    options: WaitOptions = {},
  ): Promise<ReadyTicketView> {
    return this.wait(ticketId, options, 3_600_000, "ready");
  }
  async waitUntilReleased(
    ticketId: Id,
    options: WaitOptions = {},
  ): Promise<ReleasedTicketView> {
    return this.wait(ticketId, options, 300_000, "released");
  }
  private wait(
    ticketId: Id,
    options: WaitOptions,
    defaultMs: number,
    target: "ready",
  ): Promise<ReadyTicketView>;
  private wait(
    ticketId: Id,
    options: WaitOptions,
    defaultMs: number,
    target: "released",
  ): Promise<ReleasedTicketView>;
  private async wait(
    ticketId: Id,
    options: WaitOptions,
    defaultMs: number,
    target: "ready" | "released",
  ): Promise<ReadyTicketView | ReleasedTicketView> {
    const timeout = options.timeoutMilliseconds ?? defaultMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000)
      throw new ComputeClientError({
        code: "INVALID_WAIT_OPTIONS",
        message: "timeoutMilliseconds must be an integer from 1 to 86400000.",
      });
    const deadline = this.http.now() + timeout;
    let delay = 250;
    while (this.http.now() < deadline) {
      if (options.isCancelled?.())
        throw new ComputeClientError({
          code: "WAIT_CANCELLED",
          message:
            "Local wait cancelled; the server-side Ticket was not changed.",
          recovery: { ticketId },
        });
      let ticket: TicketView;
      try {
        ticket = await this.http.request(
          `/v1/tickets/${encodeURIComponent(ticketId)}`,
          "GET",
          undefined,
          (value) => read(TicketViewSchema, value),
          {
            ticketId,
            timeoutMilliseconds: Math.max(
              1,
              Math.min(30_000, deadline - this.http.now()),
            ),
            ...(options.isCancelled
              ? { isCancelled: options.isCancelled }
              : {}),
          },
        );
      } catch (error) {
        if (
          error instanceof ComputeClientError &&
          error.code === "NETWORK_RESULT_UNKNOWN" &&
          this.http.now() >= deadline
        )
          break;
        throw error;
      }
      if (target === "ready") {
        if (ticket.phase === "ready") {
          try {
            return read(ReadyTicketSchema, ticket);
          } catch (error) {
            throw new ComputeClientError({
              code: "INVALID_RESPONSE",
              message: "Ticket does not satisfy the ready response contract.",
              recovery: { ticketId },
              cause: error,
            });
          }
        }
        if (ticket.phase === "releasing" || ticket.phase === "released")
          throw new ComputeClientError({
            code: "TICKET_TERMINATED",
            message: "Ticket terminated before becoming ready.",
            recovery: { ticketId },
          });
      } else if (ticket.phase === "released") {
        try {
          return read(ReleasedTicketSchema, ticket);
        } catch (error) {
          throw new ComputeClientError({
            code: "INVALID_RESPONSE",
            message: "Ticket does not satisfy the released response contract.",
            recovery: { ticketId },
            cause: error,
          });
        }
      }
      const remaining = deadline - this.http.now();
      if (remaining <= 0) break;
      await this.http.sleep(Math.min(delay, remaining));
      delay = Math.min(Math.round(delay * 1.6), 5_000);
    }
    throw new ComputeClientError({
      code: "WAIT_TIMEOUT",
      message:
        "The local wait timed out; the server-side Ticket was not changed.",
      retryable: true,
      recovery: { ticketId },
    });
  }

  async claim(
    ticketId: Id,
    options: ClientWriteOptions = {},
  ): Promise<RenewReceipt> {
    return this.renewTicket(
      ticketId,
      {},
      options,
      true,
      this.http.now() + 15_000,
    );
  }
  async renew(
    ticketId: Id,
    request: ClientRenewRequest = {},
    options: ClientWriteOptions = {},
  ): Promise<RenewReceipt> {
    return this.renewTicket(
      ticketId,
      request,
      options,
      false,
      this.http.now() + 15_000,
    );
  }

  private async renewTicket(
    ticketId: Id,
    request: ClientRenewRequest,
    options: ClientWriteOptions,
    initial: boolean,
    deadlineAt: number,
  ): Promise<RenewReceipt> {
    if (
      typeof request !== "object" ||
      request === null ||
      Object.keys(request).some((key) => key !== "requestedTtlSec")
    ) {
      throw new ComputeClientError({
        code: "INVALID_REQUEST",
        message: "Only requestedTtlSec may be set in the renewal preference.",
      });
    }
    const checkedRequest = readRequest(RenewRequestSchema, {
      generation: 1,
      expectedLeaseVersion: 1,
      ...(request.requestedTtlSec === undefined
        ? {}
        : { requestedTtlSec: request.requestedTtlSec }),
    });
    const key = options.idempotencyKey ?? randomKey();
    const intent = { requestedTtlSec: checkedRequest.requestedTtlSec };
    const saved = this.cached("renew", ticketId, key, intent);
    if (saved) return this.submitRenewal(saved, deadlineAt);
    const remainingBeforeRead = deadlineAt - this.http.now();
    if (remainingBeforeRead <= 0)
      throw new ComputeClientError({
        code: "RENEWAL_PREPARATION_TIMEOUT",
        message:
          "The renewal deadline elapsed before the Ticket could be read.",
        retryable: true,
        recovery: { ticketId, idempotencyKey: key },
      });
    const ticket = await this.http.request(
      `/v1/tickets/${encodeURIComponent(ticketId)}`,
      "GET",
      undefined,
      (value) => read(TicketViewSchema, value),
      { ticketId, timeoutMilliseconds: remainingBeforeRead },
    );
    if (!ticket.lease)
      throw new ComputeClientError({
        code: "LEASE_NOT_FOUND",
        message: "Ticket has no lease to renew.",
        recovery: { ticketId },
      });
    if (
      initial &&
      (ticket.phase !== "ready" ||
        ticket.lease.state !== "active" ||
        ticket.lease.claimedAt !== null)
    )
      throw new ComputeClientError({
        code: "ALREADY_CLAIMED",
        message:
          "A new claim requires a ready environment whose lease has not been claimed.",
        recovery: { ticketId },
      });
    const body = readRequest(RenewRequestSchema, {
      generation: ticket.lease.generation,
      expectedLeaseVersion: ticket.lease.version,
      ...(checkedRequest.requestedTtlSec === undefined
        ? {}
        : { requestedTtlSec: checkedRequest.requestedTtlSec }),
    });
    const command = await this.prepare(
      "renew",
      ticketId,
      key,
      body,
      intent,
      options.onPrepared,
      deadlineAt,
    );
    return (await this.submitRenewal(command, deadlineAt)) as RenewReceipt;
  }
  async getRenewal(ticketId: Id, renewalId: Id): Promise<LeaseRenewalView> {
    return this.http.request(
      `/v1/tickets/${encodeURIComponent(ticketId)}/renewals/${encodeURIComponent(renewalId)}`,
      "GET",
      undefined,
      (v) => read(LeaseRenewalViewSchema, v),
      { ticketId, renewalId },
    );
  }
  async getAccess(
    ticketId: Id,
    options: ClientWriteOptions = {},
  ): Promise<AccessGrant> {
    const key = options.idempotencyKey ?? randomKey();
    const cached = this.cached("access", ticketId, key, {});
    if (cached)
      return this.http.request(
        `/v1/tickets/${encodeURIComponent(ticketId)}/access`,
        "POST",
        cached.request,
        (v) => read(AccessGrantSchema, v),
        this.context(cached),
      );
    const ticket = await this.get(ticketId);
    if (!ticket.lease)
      throw new ComputeClientError({
        code: "LEASE_NOT_FOUND",
        message: "Ticket has no lease to access.",
        recovery: { ticketId },
      });
    const command = await this.prepare(
      "access",
      ticketId,
      key,
      { generation: ticket.lease.generation },
      {},
      options.onPrepared,
    );
    return (await this.send(command)) as AccessGrant;
  }
  async release(
    ticketId: Id,
    request: { readonly reclaimable: true },
    options: ClientWriteOptions = {},
  ): Promise<TicketView> {
    const key = options.idempotencyKey ?? randomKey();
    const cached = this.cached("release", ticketId, key, request);
    if (cached)
      return this.http.request(
        `/v1/tickets/${encodeURIComponent(ticketId)}/release`,
        "POST",
        cached.request,
        (v) => read(TicketViewSchema, v),
        this.context(cached),
      );
    const ticket = await this.get(ticketId);
    if (!ticket.lease)
      throw new ComputeClientError({
        code: "LEASE_NOT_FOUND",
        message: "Ticket has no lease to release.",
        recovery: { ticketId },
      });
    const checkedRequest = readRequest(ReleaseRequestSchema, {
      generation: ticket.lease.generation,
      ...request,
    });
    const body = checkedRequest;
    const command = await this.prepare(
      "release",
      ticketId,
      key,
      body,
      request,
      options.onPrepared,
    );
    return (await this.send(command)) as TicketView;
  }
  async cancel(
    ticketId: Id,
    request: { readonly reason?: string } = {},
    options: ClientWriteOptions = {},
  ): Promise<TicketView> {
    const body = readRequest(CancelRequestSchema, request);
    const key = options.idempotencyKey ?? randomKey();
    const command =
      this.cached("cancel", ticketId, key, body) ??
      (await this.prepare(
        "cancel",
        ticketId,
        key,
        body,
        body,
        options.onPrepared,
      ));
    return (await this.send(command)) as TicketView;
  }
}
