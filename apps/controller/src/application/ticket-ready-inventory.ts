import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import {
  ReadyInventoryQuerySchema,
  TicketReadyInventorySchema,
  CleanupProofIdentitySchema,
  type ReadyInventoryQuery,
  type TicketReadyInventory,
} from "@hitchlet/contracts";
import type { Storage } from "../storage/index.js";
import { ApplicationError } from "./errors.js";
import { resourceManifest } from "../domain/resource-manifest.js";

const Id = z.string().min(1).max(512),
  Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = CleanupProofIdentitySchema;
const ObjectRecord = z.object({
  id: Id,
  kind: z.enum(["container", "volume", "network_policy"]),
  ownership: z.literal("owned"),
  identity: Identity,
  contractHash: Hash,
});
// Account for every receipt entry; only owned entries belong to the public proof.
const InventoryObject = z.discriminatedUnion("ownership", [
  ObjectRecord,
  ObjectRecord.extend({
    kind: z.literal("storage_reference"),
    ownership: z.literal("reference"),
  }),
]);
const Ready = z.object({
  identity: Identity,
  contractHash: Hash,
  manifestId: Id,
  manifestHash: Hash,
  objectIds: z.array(Id).min(3),
});
// managed ownership_json also contains internal referenceKey; strip it, never expose it.
const Managed = z.object({
  id: Id,
  kind: z.enum(["container", "volume", "network_policy"]),
  ownership: z.literal("owned"),
  state: z.literal("present"),
  identity: z.object(Identity.shape),
});
const ManagedObject = z.discriminatedUnion("ownership", [
  Managed,
  Managed.extend({
    kind: z.literal("storage_reference"),
    ownership: z.literal("reference"),
  }),
]);
type Row = Record<string, string | number | bigint | null>;
const requireProof = (value: unknown): void => {
  if (!value) throw new ApplicationError("conflict");
};
function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new ApplicationError("conflict");
  return n;
}
function parse(value: unknown): unknown {
  if (typeof value !== "string") throw new ApplicationError("conflict");
  return JSON.parse(value);
}
const ids = (items: readonly { id: string; kind: string }[]) =>
  items.map((x) => x.kind + ":" + x.id).sort();

/** One controller-local read snapshot. Only the existing authenticated consumer
 * can select its ticket/lease/generation; no caller-supplied inventory or SQL.
 * This is the original certified ready inventory, NOT a new native inspection.
 * No access, key, raw resource details or provider response is selected. */
export const TICKET_READY_INVENTORY_SQL = `SELECT
 t.id AS ticketId,t.consumer_id AS consumerId,t.phase AS ticketPhase,t.ready_at_ms AS readyAtMs,
 l.id AS leaseId,l.generation AS generation,l.state AS leaseState,l.expires_at_ms AS expiresAtMs,
 l.claimed_at_ms AS claimedAtMs,l.claim_by_ms AS claimByMs,
 a.id AS allocationId,a.generation AS allocationGeneration,a.control_version AS controlVersion,
 a.desired_state AS desiredState,a.observed_state AS observedState,a.cleanup_status AS allocationCleanup,
 a.manifest_complete AS manifestComplete,a.manifest_id AS manifestId,r.contract_hash AS contractHash,
 json_extract(a.actual_resources_json,'$.executionMode') AS executionMode,
 json_object('identity',json_extract(a.actual_resources_json,'$.receipt.identity'),
 'contractHash',json_extract(a.actual_resources_json,'$.receipt.contractHash'),
 'manifestId',json_extract(a.actual_resources_json,'$.receipt.manifestId'),
 'manifestHash',json_extract(a.actual_resources_json,'$.receipt.manifestHash'),
 'objectIds',json_extract(a.actual_resources_json,'$.receipt.objectIds')) AS readyJson,
 (SELECT json_group_array(json_object('id',json_extract(j.value,'$.id'),'kind',json_extract(j.value,'$.kind'),
 'ownership',json_extract(j.value,'$.ownership'),'identity',json_extract(j.value,'$.identity'),
 'contractHash',json_extract(j.value,'$.contractHash'))) FROM json_each(a.actual_resources_json,'$.objects') j) AS objectsJson,
 (SELECT json_group_array(json_object('id',COALESCE(m.provider_id,m.id),'kind',m.kind,'ownership',m.ownership,
 'state',m.observed_state,'identity',json(m.ownership_json))) FROM managed_resources m
 WHERE m.allocation_id=a.id AND m.generation=l.generation) AS managedJson,
 p.id AS provisionId,p.state AS provisionState,p.kind AS provisionKind,
 COALESCE(p.installation_id, (SELECT i.installation_id FROM installations i WHERE i.singleton=1 AND p.allocation_id=a.id)) AS provisionInstallationId,p.generation AS provisionGeneration,
 p.control_version AS provisionControlVersion,p.runtime_identity_id AS provisionRuntimeId,
 p.connection_revision_id AS provisionConnectionId,
 (SELECT count(*) FROM capacity_claims c WHERE c.allocation_id=a.id) AS claimCount,
 (SELECT count(*) FROM capacity_claims c WHERE c.allocation_id=a.id AND c.state<>'committed') AS uncommittedClaims,
 (SELECT count(*) FROM operations o WHERE o.allocation_id=a.id AND o.generation=l.generation
 AND (o.state='unknown' OR EXISTS(SELECT 1 FROM json_each(COALESCE(o.result_json,'{}'),'$.createEffects') e
 WHERE json_extract(e.value,'$.state')='unknown'))) AS unknownOperations
 FROM tickets t JOIN leases l ON l.ticket_id=t.id
 JOIN allocations a ON a.id=l.allocation_id AND a.ticket_id=t.id AND a.purpose='tenant'
 JOIN resolved_provision_contracts r ON r.id=a.resolved_provision_contract_id
 JOIN operations p ON p.id=json_extract(a.actual_resources_json,'$.receipt.identity.operationId') AND p.allocation_id=a.id
 WHERE t.id=? AND t.consumer_id=? AND l.id=? AND l.generation=? AND a.generation=l.generation
 AND a.runtime_identity_id=json_extract(a.actual_resources_json,'$.receipt.identity.runtimeIdentityId')
 AND json_extract(a.actual_resources_json,'$.receipt.identity.installationId')=(SELECT installation_id FROM installations WHERE singleton=1)`;

export class TicketReadyInventoryReader {
  constructor(
    private readonly storage: Pick<Storage, "get">,
    private readonly now = Date.now,
    private readonly rejectDiagnostic?: (value: {
      consumerId: string;
      ticketId: string;
      leaseId: string;
      generation: number;
      check: string;
      path?: string;
    }) => void,
  ) {}
  async read(
    consumerId: string,
    ticketId: string,
    input: ReadyInventoryQuery,
  ): Promise<TicketReadyInventory | null> {
    Id.parse(consumerId);
    z.string().uuid().parse(ticketId);
    const q = ReadyInventoryQuerySchema.parse(input);
    const row = await this.storage.get<Row>(TICKET_READY_INVENTORY_SQL, [
      ticketId,
      consumerId,
      q.leaseId,
      q.generation,
    ]);
    if (!row) return null;
    let check = "record_shape";
    try {
      const readAtMs = this.now(),
        ready = Ready.parse(parse(row.readyJson)),
        rawObjects = parse(row.objectsJson),
        inventory = z.array(InventoryObject).parse(rawObjects),
        objects = z
          .array(ObjectRecord)
          .length(3)
          .parse(inventory.filter((o) => o.ownership === "owned")),
        managed = z.array(ManagedObject).parse(parse(row.managedJson)),
        identity = ready.identity;
      check = "ticket_lease_identity";
      requireProof(
        row.ticketId === ticketId &&
          row.consumerId === consumerId &&
          row.leaseId === q.leaseId &&
          num(row.generation) === q.generation &&
          num(row.allocationGeneration) === q.generation,
      );
      check = "ready_lifecycle";
      requireProof(
        row.ticketPhase === "ready" &&
          row.leaseState === "active" &&
          num(row.expiresAtMs) > readAtMs &&
          (row.claimedAtMs !== null
            ? num(row.claimedAtMs) > 0 && num(row.claimedAtMs) <= readAtMs
            : num(row.claimByMs) > readAtMs) &&
          row.desiredState === "present" &&
          row.observedState === "running" &&
          row.allocationCleanup === "running" &&
          num(row.manifestComplete) === 1 &&
          row.executionMode === "portainer" &&
          num(row.readyAtMs) > 0 &&
          num(row.readyAtMs) <= readAtMs &&
          num(row.claimCount) > 0 &&
          num(row.uncommittedClaims) === 0 &&
          num(row.unknownOperations) === 0,
      );
      check = "provision_binding";
      requireProof(
        identity.allocationId === row.allocationId &&
          identity.generation === q.generation &&
          identity.controlVersion === num(row.controlVersion) &&
          ready.contractHash === row.contractHash &&
          ready.manifestId === row.manifestId &&
          row.provisionId === identity.operationId &&
          row.provisionKind === "allocation.provision" &&
          row.provisionState === "succeeded" &&
          row.provisionInstallationId === identity.installationId &&
          num(row.provisionGeneration) === identity.generation &&
          num(row.provisionControlVersion) === identity.controlVersion &&
          row.provisionRuntimeId === identity.runtimeIdentityId &&
          row.provisionConnectionId === identity.connectionRevisionId,
      );
      check = "manifest_membership";
      requireProof(
        new Set(ids(objects)).size === 3 &&
          ["container", "volume", "network_policy"].every(
            (kind) => objects.filter((o) => o.kind === kind).length === 1,
          ),
      );
      check = "owned_identity";
      requireProof(
        inventory.every(
          (o) =>
            equal(o.identity, identity) &&
            o.contractHash === ready.contractHash,
        ) &&
          managed.every((o) => equal(o.identity, identity)) &&
          equal(ids(inventory), ids(managed)) &&
          new Set(ready.objectIds).size === inventory.length &&
          equal([...ready.objectIds].sort(), inventory.map((o) => o.id).sort()),
      );
      // Preserve producer key order when recomputing the existing manifest.
      const rawReady = parse(row.readyJson) as typeof ready;
      const actual = resourceManifest(
        {
          identity: rawReady.identity,
          resolved: { contractHash: ready.contractHash },
        },
        rawObjects as z.infer<typeof InventoryObject>[],
      );
      check = "manifest_digest";
      requireProof(
        actual.manifestId === ready.manifestId &&
          actual.manifestHash === ready.manifestHash,
      );
      check = "output_schema";
      const output = TicketReadyInventorySchema.parse({
        version: "1.0",
        ticketId,
        consumerId,
        leaseId: q.leaseId,
        generation: q.generation,
        allocationId: row.allocationId,
        controlVersion: identity.controlVersion,
        manifest: { id: ready.manifestId, hash: ready.manifestHash },
        createIdentity: identity,
        objects,
        completeness: "complete",
        ticketPhase: "ready",
        leaseState: "active",
        readyAtMs: num(row.readyAtMs),
        readAtMs,
        producer: "controller.allocation.ready",
        basis: "persisted_ready_manifest",
        nativeObservedAtRead: false,
      });
      const expected = {
        allocationId: output.allocationId,
        controlVersion: output.controlVersion,
        manifestId: output.manifest.id,
        manifestHash: output.manifest.hash,
      };
      check = "expected_query";
      for (const [key, value] of Object.entries(q.expected ?? {}))
        requireProof(expected[key as keyof typeof expected] === value);
      return output;
    } catch (error) {
      try {
        const first = error instanceof z.ZodError ? error.issues[0] : undefined;
        const path = first?.path
          .filter(
            (part) =>
              typeof part === "number" ||
              (typeof part === "string" && /^[A-Za-z0-9_]+$/.test(part)),
          )
          .slice(0, 12)
          .join(".");
        this.rejectDiagnostic?.({
          consumerId,
          ticketId,
          leaseId: q.leaseId,
          generation: q.generation,
          check,
          ...(path ? { path } : {}),
        });
      } catch {
        /* Diagnostic failure never changes the original rejection. */
      }
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("conflict");
    }
  }
}
