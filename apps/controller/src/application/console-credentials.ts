import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ConsoleCredentialViewSchema,
  type ConsoleCredentialView,
} from "@hitchlet/contracts";
import {
  hyperVInteractiveReceiptSchema,
  type HyperVInteractiveRequest,
} from "@hitchlet/contracts/internal";
import type { Storage } from "../storage/index.js";
import type { LocalSecretStore } from "../storage/secret-store.js";
import {
  ConsoleCredentialStore,
  type ConsoleCredentialIntent,
} from "../storage/console-credential-store.js";
import { SQLiteIdempotencyStore } from "../storage/idempotency-store.js";
import { SQLiteReadStore } from "../storage/read-store.js";
import { readConsoleLease } from "./console.js";
import { conflict, notFound } from "./errors.js";
export type ConsoleCredentialExecutor = (
  request: HyperVInteractiveRequest,
) => Promise<unknown>;
/** One durable intent per lease generation. Reads recover outcomes; they never change a password. */
export class ConsoleCredentialService {
  private readonly intents: ConsoleCredentialStore;
  private readonly keys: SQLiteIdempotencyStore;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: Storage,
    private readonly secrets: Pick<
      LocalSecretStore,
      "get" | "getOrCreate" | "remove"
    >,
    private readonly execute: ConsoleCredentialExecutor,
    private readonly enabled = false,
    private readonly now = Date.now,
  ) {
    this.intents = new ConsoleCredentialStore(db);
    this.keys = new SQLiteIdempotencyStore(db);
  }
  private locked<T>(
    owner: string,
    ticket: string,
    gen: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([owner, ticket, gen]);
    const next = (this.locks.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.locks.set(key, next);
    void next
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      })
      .catch(() => {});
    return next;
  }
  prepare(owner: string, ticket: string, generation: number, key: string) {
    if (!this.enabled)
      return Promise.reject(conflict("console_credentials_disabled"));
    return this.locked(owner, ticket, generation, async () => {
      const lease = await readConsoleLease(
        this.db,
        owner,
        ticket,
        generation,
        this.now,
      );
      const hash = createHash("sha256")
        .update(JSON.stringify({ ticket, generation }))
        .digest("hex");
      const reservation = await this.keys.reserve({
        consumerId: owner,
        scope: "tickets.console.credentials",
        key,
        hash,
        ticketId: ticket,
        now: this.now(),
      });
      if (reservation.row.request_hash !== hash)
        throw conflict("idempotency_key_reused");
      let intent =
        (await this.intents.get(owner, ticket, generation)) ??
        (await this.intents.reserve(
          owner,
          ticket,
          {
            version: 1,
            allocationId: lease.identity.allocationId,
            generation,
            nonce: randomUUID(),
            secretRef: `secret:${randomBytes(16).toString("hex")}`,
            state: "reserved",
          },
          this.now(),
        ));
      if (["destroyed", "destroying"].includes(intent.state))
        throw conflict("lease_not_accessible");
      if (intent.state === "reserved") {
        // The reference is in SQLite before encrypted material is created; crashes reuse the same reference.
        await this.secrets.getOrCreate(
          intent.secretRef!,
          () => "Aa1!" + randomBytes(32).toString("base64url"),
        );
        intent = await this.intents.update(owner, ticket, intent, {
          ...intent,
          state: "prepared",
        });
      }
      return this.observe(owner, ticket, intent, "prepare");
    });
  }
  read(owner: string, ticket: string, generation: number) {
    return this.locked(owner, ticket, generation, async () => {
      const row = await new SQLiteReadStore(this.db).accessContext(
        ticket,
        owner,
      );
      if (!row) throw notFound();
      const intent = await this.intents.get(owner, ticket, generation);
      const base = {
        ticketId: ticket,
        generation,
        expiresAt: new Date(Number(row.expires_at_ms)).toISOString(),
      };
      if (!intent)
        return ConsoleCredentialViewSchema.parse({
          ...base,
          status: "not_prepared",
        });
      if (intent.state === "destroyed" || intent.state === "destroying")
        return ConsoleCredentialViewSchema.parse({
          ...base,
          credentialId: intent.nonce,
          status:
            intent.state === "destroyed" ? "destroyed" : "cleanup_pending",
        });
      if (
        row.phase !== "ready" ||
        row.lease_state !== "active" ||
        Number(row.generation) !== generation ||
        Number(row.expires_at_ms) <= this.now()
      )
        return ConsoleCredentialViewSchema.parse({
          ...base,
          credentialId: intent.nonce,
          status: "cleanup_pending",
        });
      // A released lease never exposes its former password, even while deletion proof is pending.
      await readConsoleLease(this.db, owner, ticket, generation, this.now);
      if (intent.state === "reserved")
        return ConsoleCredentialViewSchema.parse({
          ...base,
          credentialId: intent.nonce,
          status: "pending",
        });
      return this.observe(owner, ticket, intent, "inspect");
    });
  }
  private async observe(
    owner: string,
    ticket: string,
    intent: ConsoleCredentialIntent,
    mode: "inspect" | "prepare",
  ): Promise<ConsoleCredentialView> {
    const lease = await readConsoleLease(
      this.db,
      owner,
      ticket,
      intent.generation,
      this.now,
    );
    if (lease.identity.allocationId !== intent.allocationId)
      throw conflict("lease_not_accessible");
    // Missing/corrupt prepared material is NOT regenerated. The guest may already have applied it.
    let password: string;
    try {
      password = await this.secrets.get(intent.secretRef!);
    } catch {
      throw conflict("access_material_unavailable");
    }
    const passwordHash = createHash("sha256").update(password).digest("hex");
    let status: "unknown" | "not_applied" | "applied" = "unknown";
    try {
      const result = hyperVInteractiveReceiptSchema.parse(
        await this.execute({
          identity: lease.identity,
          nonce: intent.nonce,
          passwordHash,
          expiresAt: new Date(lease.expires).toISOString(),
          mode,
          ...(mode === "prepare" ? { password } : {}),
        }),
      );
      if (
        JSON.stringify(result.identity) !== JSON.stringify(lease.identity) ||
        result.nonce !== intent.nonce ||
        result.passwordHash !== passwordHash
      )
        throw Error("Credential receipt mismatch");
      status = result.status;
    } catch {
      /* Unknown delivery remains recoverable by inspection with the saved nonce. */
    }
    await this.intents.update(owner, ticket, intent, {
      ...intent,
      state: status === "applied" ? "applied" : "unknown",
    });
    const after = await readConsoleLease(
      this.db,
      owner,
      ticket,
      intent.generation,
      this.now,
    );
    return ConsoleCredentialViewSchema.parse({
      ticketId: ticket,
      generation: intent.generation,
      credentialId: intent.nonce,
      expiresAt: new Date(after.expires).toISOString(),
      status:
        status === "applied"
          ? "ready"
          : status === "not_applied"
            ? "pending"
            : "unknown",
      ...(status === "applied"
        ? {
            authentication: {
              kind: "ephemeral_password",
              username: "workspace",
              password,
            },
          }
        : {}),
    });
  }
  async cleanup() {
    for (const row of await this.intents.pendingCleanup()) {
      const value = row.intent;
      await this.locked(
        row.consumer_id,
        row.ticket_id,
        value.generation,
        async () => {
          let intent = await this.intents.get(
            row.consumer_id,
            row.ticket_id,
            value.generation,
          );
          if (
            !intent ||
            intent.state === "destroyed" ||
            !(await this.intents.cleaned(
              row.consumer_id,
              row.ticket_id,
              intent,
            ))
          )
            return;
          if (intent.state !== "destroying")
            intent = await this.intents.update(
              row.consumer_id,
              row.ticket_id,
              intent,
              { ...intent, state: "destroying" },
            );
          await this.secrets.remove(intent.secretRef!);
          await this.intents.update(row.consumer_id, row.ticket_id, intent, {
            ...intent,
            secretRef: null,
            state: "destroyed",
          });
        },
      );
    }
  }
}
