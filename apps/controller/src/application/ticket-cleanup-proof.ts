import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import {
  CleanupProofQuerySchema,
  CleanupProofIdentitySchema,
  CleanupProofRuntimeSchema,
  CleanupProofObjectSchema,
  CleanupProofReceiptSchema,
  TicketCleanupProofSchema,
  type CleanupProofQuery,
  type TicketCleanupProof,
} from "@hitchlet/contracts";
import type { Storage } from "../storage/index.js";
import { ApplicationError } from "./errors.js";
import { resourceManifest } from "../domain/resource-manifest.js";

const Id = z.string().min(1).max(512),
  Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Owned = z.object({
  id: Id,
  kind: z.enum(["container", "volume", "network_policy"]),
  ownership: z.literal("owned"),
  identity: CleanupProofIdentitySchema,
  contractHash: Hash,
  evidence: z.object({
    artifactDigest: Id,
    resourcesHash: Id,
    networkHash: Id,
    mountsHash: Id,
    accessProtocol: z.literal("ssh"),
  }),
});
const Ready = z.object({
  identity: CleanupProofIdentitySchema,
  contractHash: Hash,
  manifestId: Id,
  manifestHash: Hash,
  objectIds: z.array(Id).length(3),
});
const Managed = z.object({
  id: Id,
  kind: z.enum(["container", "volume", "network_policy"]),
  ownership: z.literal("owned"),
  state: z.literal("absent"),
  identity: CleanupProofIdentitySchema,
});
const Evidence = z.object({
  verifiedAbsentAtMs: z.number().int().positive(),
  noExternalCreate: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .nullable()
    .optional(),
  inventory: z.object({
    completeness: z.literal("complete"),
    runtime: CleanupProofRuntimeSchema,
    identity: CleanupProofIdentitySchema,
  }),
  resources: z.array(CleanupProofObjectSchema).length(3),
  destructionReceipts: z.array(CleanupProofReceiptSchema).length(3),
});
const Operation = z.object({
  id: Id,
  allocationId: Id,
  installationId: Id,
  generation: z.number().int().positive(),
  controlVersion: z.number().int().positive(),
  runtimeIdentityId: Id,
  connectionRevisionId: Id,
  kind: z.literal("allocation.cleanup"),
  state: z.literal("succeeded"),
  createdAtMs: z.number().int().positive(),
  updatedAtMs: z.number().int().positive(),
  evidence: Evidence,
});
type Row = Record<string, string | number | bigint | null>;
const unavailable = () => new ApplicationError("conflict");
const requireProof = (value: unknown): void => {
  if (!value) throw unavailable();
};
function number(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw unavailable();
  return n;
}
function json(value: unknown): unknown {
  if (typeof value !== "string") throw unavailable();
  return JSON.parse(value);
}
function ids(items: readonly { id: string; kind: string }[]): string[] {
  return items.map((x) => x.kind + ":" + x.id).sort();
}
function identityWithoutControl(
  value: z.infer<typeof CleanupProofIdentitySchema>,
) {
  const { controlVersion: _, ...stable } = value;
  return stable;
}

// One SQLite statement/read snapshot. No arbitrary SQL, broad account, latest
// operation guess, secret/Access fields, or raw operation-result projection.
// The two code-only rejected renewal results are local decisions, not provider
// effects. Any additional result metadata remains unresolved.
export const TICKET_CLEANUP_PROOF_SQL = `SELECT
 t.id AS ticketId,t.consumer_id AS consumerId,t.phase AS ticketPhase,t.cleanup_status AS ticketCleanup,
 l.id AS leaseId,l.generation AS generation,l.state AS leaseState,l.revoked_at_ms AS revokedAtMs,
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
   'contractHash',json_extract(j.value,'$.contractHash'),'evidence',json_extract(j.value,'$.evidence')))
   FROM json_each(a.actual_resources_json,'$.objects') j) AS objectsJson,
 (SELECT json_group_array(json_object('id',COALESCE(m.provider_id,m.id),'kind',m.kind,'ownership',m.ownership,
   'state',m.observed_state,'identity',json_remove(json(m.ownership_json),'$.referenceKey'))) FROM managed_resources m
   WHERE m.allocation_id=a.id AND m.generation=l.generation) AS managedJson,
 (SELECT json_group_array(json_object('id',o.id,'allocationId',o.allocation_id,'installationId',COALESCE(o.installation_id, (SELECT i.installation_id FROM installations i WHERE i.singleton=1 AND o.allocation_id=a.id)),
   'generation',o.generation,'controlVersion',o.control_version,'runtimeIdentityId',o.runtime_identity_id,
   'connectionRevisionId',o.connection_revision_id,'kind',o.kind,'state',o.state,
   'createdAtMs',o.created_at_ms,'updatedAtMs',o.updated_at_ms,
   'evidence',json_object('verifiedAbsentAtMs',json_extract(o.result_json,'$.verifiedAbsentAtMs'),
     'noExternalCreate',json_extract(o.result_json,'$.noExternalCreate'),
     'inventory',json_extract(o.result_json,'$.inventory'),'resources',json_extract(o.result_json,'$.resources'),
     'destructionReceipts',json((SELECT json_group_array(json_object('resourceId',json_extract(d.value,'$.resourceId'),
       'kind',json_extract(d.value,'$.kind'),'presence',json_extract(d.value,'$.presence'),
       'runtime',json_extract(d.value,'$.runtime'),'identity',json_extract(d.value,'$.identity'),
       'networkRules',json_extract(d.value,'$.networkRules'),'verifiedAtMs',json_extract(d.value,'$.verifiedAtMs')))
       FROM json_each(o.result_json,'$.destructionReceipts') d))))) FROM operations o
   WHERE o.allocation_id=a.id AND o.generation=l.generation AND o.control_version=a.control_version
     AND o.kind='allocation.cleanup') AS cleanupJson,
 (SELECT count(*) FROM capacity_claims c WHERE c.allocation_id=a.id) AS claimCount,
 (SELECT count(*) FROM capacity_claims c WHERE c.allocation_id=a.id AND c.state<>'released') AS unreleasedClaims,
 (SELECT count(*) FROM operations p WHERE p.allocation_id=a.id AND p.generation=l.generation
   AND (p.state IN ('pending','running','unknown') OR (p.state='failed' AND NOT (p.kind='lease.renew' AND COALESCE(json(p.result_json),'') IN ('{"code":"lease_or_authorization_changed"}','{"code":"decision_deadline_expired"}'))) OR EXISTS(SELECT 1
     FROM json_each(COALESCE(p.result_json,'{}'),'$.createEffects') e WHERE json_extract(e.value,'$.state')='unknown'))) AS unresolvedOperations
 FROM tickets t JOIN leases l ON l.ticket_id=t.id JOIN allocations a ON a.id=l.allocation_id AND a.ticket_id=t.id AND a.purpose='tenant'
 JOIN resolved_provision_contracts r ON r.id=a.resolved_provision_contract_id
 WHERE t.id=? AND t.consumer_id=? AND l.id=? AND l.generation=? AND a.generation=l.generation
 AND a.runtime_identity_id=json_extract(a.actual_resources_json,'$.receipt.identity.runtimeIdentityId')
 AND json_extract(a.actual_resources_json,'$.receipt.identity.installationId')=(SELECT installation_id FROM installations WHERE singleton=1)`;

/** Authenticated controller use only. The existing HTTP authenticator supplies
 * consumerId; the caller cannot select another owner or provide proof arrays.
 * This does not open a DB/pool, issue authority or call a native/provider API. */
export class TicketCleanupProofReader {
  constructor(
    private readonly storage: Pick<Storage, "get">,
    private readonly now = Date.now,
  ) {}
  async read(
    consumerId: string,
    ticketId: string,
    input: CleanupProofQuery,
  ): Promise<TicketCleanupProof | null> {
    Id.parse(consumerId);
    z.string().uuid().parse(ticketId);
    const query = CleanupProofQuerySchema.parse(input);
    const row = await this.storage.get<Row>(TICKET_CLEANUP_PROOF_SQL, [
      ticketId,
      consumerId,
      query.leaseId,
      query.generation,
    ]);
    if (!row) return null;
    try {
      requireProof(
        row.ticketId === ticketId &&
          row.consumerId === consumerId &&
          row.leaseId === query.leaseId &&
          number(row.generation) === query.generation &&
          number(row.allocationGeneration) === query.generation,
      );
      requireProof(
        row.ticketPhase === "released" &&
          row.ticketCleanup === "complete" &&
          row.leaseState === "revoked" &&
          row.desiredState === "absent" &&
          row.observedState === "absent" &&
          row.allocationCleanup === "complete" &&
          number(row.manifestComplete) === 1 &&
          row.executionMode === "portainer" &&
          number(row.revokedAtMs) > 0 &&
          number(row.claimCount) > 0 &&
          number(row.unreleasedClaims) === 0 &&
          number(row.unresolvedOperations) === 0,
      );
      const readyRaw = json(row.readyJson),
        objectsRaw = json(row.objectsJson);
      const ready = Ready.parse(readyRaw),
        objects = z.array(Owned).length(3).parse(objectsRaw);
      const managed = z.array(Managed).length(3).parse(json(row.managedJson));
      const operations = z
          .array(Operation)
          .length(1)
          .parse(json(row.cleanupJson)),
        op = operations[0]!;
      const evidence = op.evidence,
        create = ready.identity;
      requireProof(
        create.allocationId === row.allocationId &&
          create.generation === query.generation &&
          ready.contractHash === row.contractHash &&
          row.manifestId === ready.manifestId &&
          evidence.noExternalCreate !== true &&
          evidence.noExternalCreate !== 1,
      );
      const set = ids(objects);
      requireProof(
        new Set(set).size === 3 &&
          ["container", "volume", "network_policy"].every(
            (kind) => objects.filter((o) => o.kind === kind).length === 1,
          ),
      );
      requireProof(
        objects.every(
          (o) =>
            equal(o.identity, create) && o.contractHash === ready.contractHash,
        ),
      );
      // Producer hashes JSON property order, not a normalized DTO. Both raw values
      // are runtime validated above; retain their original identity key order.
      const rawReady = readyRaw as z.infer<typeof Ready>,
        rawObjects = objectsRaw as z.infer<typeof Owned>[];
      const manifest = resourceManifest(
        {
          identity: rawReady.identity,
          resolved: { contractHash: ready.contractHash },
        },
        rawObjects,
      );
      requireProof(
        manifest.manifestId === ready.manifestId &&
          manifest.manifestHash === ready.manifestHash &&
          equal([...ready.objectIds].sort(), objects.map((o) => o.id).sort()) &&
          equal(ids(managed), set),
      );
      const cleanup = { ...create, controlVersion: number(row.controlVersion) };
      requireProof(
        cleanup.controlVersion > create.controlVersion &&
          op.allocationId === create.allocationId &&
          op.installationId === create.installationId &&
          op.generation === create.generation &&
          op.controlVersion === cleanup.controlVersion &&
          op.runtimeIdentityId === create.runtimeIdentityId &&
          op.connectionRevisionId === create.connectionRevisionId,
      );
      requireProof(
        managed.every(
          (o) =>
            equal(
              identityWithoutControl(o.identity),
              identityWithoutControl(create),
            ) &&
            [create.controlVersion, cleanup.controlVersion].includes(
              o.identity.controlVersion,
            ),
        ),
      );
      requireProof(
        equal(ids(evidence.resources), set) &&
          equal(evidence.inventory.identity, cleanup) &&
          equal(evidence.inventory.runtime, {
            runtimeIdentityId: create.runtimeIdentityId,
            connectionRevisionId: create.connectionRevisionId,
          }),
      );
      const receiptSet = evidence.destructionReceipts.map((x) => ({
        id: x.resourceId,
        kind: x.kind,
      }));
      requireProof(equal(ids(receiptSet), set));
      const readAtMs = this.now();
      requireProof(
        evidence.verifiedAbsentAtMs >= op.createdAtMs &&
          evidence.verifiedAbsentAtMs <= op.updatedAtMs &&
          op.updatedAtMs <= readAtMs &&
          number(row.revokedAtMs) <= readAtMs,
      );
      for (const receipt of evidence.destructionReceipts)
        requireProof(
          equal(receipt.identity, cleanup) &&
            equal(receipt.runtime, evidence.inventory.runtime) &&
            receipt.verifiedAtMs >= op.createdAtMs &&
            receipt.verifiedAtMs <= evidence.verifiedAbsentAtMs &&
            (receipt.kind === "network_policy"
              ? receipt.networkRules === "removed"
              : receipt.networkRules === "not_applicable"),
        );
      const actual = {
        allocationId: create.allocationId,
        cleanupOperationId: op.id,
        cleanupControlVersion: cleanup.controlVersion,
        manifestId: manifest.manifestId,
        manifestHash: manifest.manifestHash,
      };
      for (const [key, value] of Object.entries(query.expected ?? {}))
        requireProof(value === actual[key as keyof typeof actual]);
      return TicketCleanupProofSchema.parse({
        version: "1.0",
        ticketId,
        consumerId,
        leaseId: query.leaseId,
        generation: query.generation,
        allocationId: create.allocationId,
        cleanupOperationId: op.id,
        cleanupControlVersion: cleanup.controlVersion,
        manifest: { id: manifest.manifestId, hash: manifest.manifestHash },
        createIdentity: create,
        cleanupIdentity: cleanup,
        objects: objects.map(({ id, kind, ownership }) => ({
          id,
          kind,
          ownership,
        })),
        receipts: evidence.destructionReceipts,
        after: {
          presence: "absent",
          ...evidence.inventory,
          verifiedAtMs: evidence.verifiedAbsentAtMs,
        },
        claimState: "released",
        leaseState: "revoked",
        providerCleanup: "complete",
        producer: "controller.allocation.cleanup",
        readAtMs,
        io: "unknown",
        wholeScopeWriteExclusion: "unknown",
      });
    } catch {
      throw unavailable();
    }
  }
}
