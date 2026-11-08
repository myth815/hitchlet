import {
  ConsoleCommandSchema,
  ConsoleResultSchema,
  type ConsoleCommand,
} from "@hitchlet/contracts";
import {
  vmAllocationIdentitySchema,
  hyperVConsoleResultSchema,
  type HyperVConsoleRequest,
} from "@hitchlet/contracts/internal";
import type { Storage } from "../storage/index.js";
import { SQLiteReadStore } from "../storage/read-store.js";
import { conflict, notFound } from "./errors.js";
import { rgb565Png } from "../domain/console-frame.js";
export type ConsoleExecutor = (
  request: HyperVConsoleRequest,
) => Promise<unknown>;
/** No independent bearer or long-lived console session. Every operation is lease/owner scoped. */
export class ConsoleService {
  private readonly store: SQLiteReadStore;
  constructor(
    private readonly storage: Storage,
    private readonly execute: ConsoleExecutor,
    private readonly now = Date.now,
  ) {
    this.store = new SQLiteReadStore(storage);
  }
  async command(consumerId: string, ticketId: string, raw: ConsoleCommand) {
    const command = ConsoleCommandSchema.parse(raw);
    const { identity, expires } = await readConsoleLease(
      this.storage,
      consumerId,
      ticketId,
      command.generation,
      this.now,
    );
    const result = hyperVConsoleResultSchema.parse(
      await this.execute({
        identity,
        commandId: command.commandId,
        expiresAt: new Date(expires).toISOString(),
        action: command.action,
      }),
    );
    if (
      JSON.stringify(result.identity) !== JSON.stringify(identity) ||
      result.commandId !== command.commandId
    )
      throw conflict("access_material_unavailable");
    // Never return an image/access receipt after a release or expiry that raced the native read.
    const after = await this.store.accessContext(ticketId, consumerId);
    if (
      !after ||
      after.phase !== "ready" ||
      after.lease_state !== "active" ||
      after.desired_state !== "present" ||
      after.observed_state !== "running" ||
      after.claimed_at_ms === null ||
      Number(after.generation) !== command.generation ||
      Number(after.expires_at_ms) <= this.now() ||
      Number(after.network_revoked) !== 0 ||
      Number(after.storage_revoked) !== 0
    )
      throw conflict("lease_not_accessible");
    return ConsoleResultSchema.parse({
      ticketId,
      generation: command.generation,
      commandId: command.commandId,
      expiresAt: new Date(Number(after.expires_at_ms)).toISOString(),
      protocol: "console",
      status: result.status,
      authentication: {
        kind: "existing_account_login_required",
        username: result.account,
      },
      ...(result.frame
        ? {
            frame: {
              width: result.frame.width,
              height: result.frame.height,
              mimeType: "image/png",
              dataBase64: rgb565Png(
                Buffer.from(result.frame.dataBase64, "base64"),
                result.frame.width,
                result.frame.height,
              ).toString("base64"),
            },
          }
        : {}),
    });
  }
}

export async function readConsoleLease(
  storage: Storage,
  consumerId: string,
  ticketId: string,
  generation: number,
  now = Date.now,
) {
  const row = await new SQLiteReadStore(storage).accessContext(
    ticketId,
    consumerId,
  );
  if (!row) throw notFound();
  const expires = Number(row.expires_at_ms);
  if (row.execution_mode !== "hyperv")
    throw conflict("execution_mode_unsupported");
  if (
    row.phase !== "ready" ||
    row.lease_state !== "active" ||
    row.claimed_at_ms === null ||
    row.desired_state !== "present" ||
    row.observed_state !== "running" ||
    Number(row.generation) !== generation ||
    !Number.isSafeInteger(expires) ||
    expires <= now() ||
    Number(row.network_revoked) !== 0 ||
    Number(row.storage_revoked) !== 0
  )
    throw conflict("lease_not_accessible");
  const resources = await storage.all<{ ownership_json: string }>(
    `SELECT r.ownership_json FROM managed_resources r JOIN allocations a ON a.id=r.allocation_id
       JOIN leases l ON l.allocation_id=a.id JOIN tickets t ON t.id=l.ticket_id
       WHERE t.id=? AND t.consumer_id=? AND r.kind='vm' AND r.ownership='owned' AND r.observed_state='present'
       AND r.generation=l.generation AND r.generation=a.generation AND a.desired_state='present'`,
    [ticketId, consumerId],
  );
  if (resources.length !== 1) throw conflict("access_material_unavailable");
  const owner = JSON.parse(resources[0]!.ownership_json) as Record<
    string,
    unknown
  >;
  const identity = vmAllocationIdentitySchema.parse(
    Object.fromEntries(
      Object.keys(vmAllocationIdentitySchema.shape).map((k) => [k, owner[k]]),
    ),
  );
  if (identity.generation !== generation || identity.purpose !== "tenant")
    throw conflict("lease_not_accessible");
  return { identity, expires };
}
