import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import {
  CleanupProofIdentitySchema as Identity,
  CleanupProofObjectSchema as ObjectRecord,
  CleanupProofReceiptSchema as Receipt,
  CleanupProofRuntimeSchema as Runtime,
  PreReadyTicketCleanupProofSchema,
  type CleanupProofQuery,
  type PreReadyTicketCleanupProof,
} from "@hitchlet/contracts";
import { containerGroupFromRequirements } from "@hitchlet/contracts/internal";
import type { Storage } from "../storage/index.js";
import { ApplicationError } from "./errors.js";

// This branch has no ready receipt. One snapshot binds the original create
// journal, actual managed objects, final cleanup receipts and released capacity.
export const PRE_READY_CLEANUP_PROOF_SQL = `SELECT
 t.id AS ticketId,t.consumer_id AS consumerId,t.phase AS phase,t.cleanup_status AS ticketCleanup,
 t.ready_at_ms AS readyAt,l.id AS leaseId,l.generation AS generation,l.state AS leaseState,l.revoked_at_ms AS revokedAt,
 a.id AS allocationId,a.control_version AS controlVersion,a.runtime_identity_id AS runtimeIdentityId,
 a.desired_state AS desiredState,a.observed_state AS observedState,a.cleanup_status AS allocationCleanup,
 a.manifest_id AS manifestId,a.manifest_complete AS manifestComplete,
 a.resolved_provision_contract_id AS resolvedId,r.contract_hash AS contractHash,ia.requirements_json AS requirementsJson,
 COALESCE(json_extract(r.network_binding_json,'$.enforcement'),'docker_iptables') AS networkEnforcement,
 (SELECT installation_id FROM installations WHERE singleton=1) AS installationId,
 (SELECT count(*) FROM capacity_claims c WHERE c.allocation_id=a.id) AS claimCount,
 (SELECT count(*) FROM capacity_claims c WHERE c.allocation_id=a.id AND c.state<>'released') AS unreleasedClaims,
 (SELECT count(*) FROM operations o WHERE o.allocation_id=a.id AND
   (o.generation<>l.generation OR o.state IN ('planned','running','unknown') OR
    (o.state='failed' AND NOT (o.kind='lease.renew' AND COALESCE(json(o.result_json),'') IN
      ('{"code":"lease_or_authorization_changed"}','{"code":"decision_deadline_expired"}'))) OR
    EXISTS(SELECT 1 FROM json_each(COALESCE(o.result_json,'{}'),'$.createEffects') e
      WHERE json_extract(e.value,'$.state')='unknown'))) AS unresolvedOperations,
 (SELECT json_group_array(json_object('identity',json_object(
   'installationId',COALESCE(p.installation_id,(SELECT i.installation_id FROM installations i WHERE i.singleton=1 AND p.allocation_id=a.id)),
   'allocationId',p.allocation_id,'generation',p.generation,'controlVersion',p.control_version,'operationId',p.id,
   'runtimeIdentityId',p.runtime_identity_id,'connectionRevisionId',p.connection_revision_id,'purpose',a.purpose),
   'state',p.state,'attemptCount',p.attempt_count,'createdAt',p.created_at_ms,'updatedAt',p.updated_at_ms,
   'executionMode',json_extract(p.intent_json,'$.executionMode'),'journalVersion',json_extract(p.result_json,'$.createJournalVersion'),
   'effects',json((SELECT json_group_array(json_object('key',e.key,'kind',json_extract(e.value,'$.kind'),
     'name',json_extract(e.value,'$.name'),'state',json_extract(e.value,'$.state'),
     'resourceId',json_extract(e.value,'$.resourceId'),'requestedAt',json_extract(e.value,'$.requestedAtMs'),
     'observedAt',json_extract(e.value,'$.observedAtMs'))) FROM json_each(COALESCE(p.result_json,'{}'),'$.createEffects') e))))
   FROM operations p WHERE p.allocation_id=a.id AND p.kind='allocation.provision') AS createsJson,
 (SELECT json_group_array(json_object('identity',json_object(
   'installationId',COALESCE(o.installation_id,(SELECT i.installation_id FROM installations i WHERE i.singleton=1 AND o.allocation_id=a.id)),
   'allocationId',o.allocation_id,'generation',o.generation,'controlVersion',o.control_version,'operationId',o.id,
   'runtimeIdentityId',o.runtime_identity_id,'connectionRevisionId',o.connection_revision_id,'purpose',a.purpose),
   'state',o.state,'createdAt',o.created_at_ms,'updatedAt',o.updated_at_ms,
   'verifiedAt',json_extract(o.result_json,'$.verifiedAbsentAtMs'),'noExternalCreate',json_extract(o.result_json,'$.noExternalCreate'),
   'inventory',json_extract(o.result_json,'$.inventory'),'resources',json_extract(o.result_json,'$.resources'),
   'receipts',json((SELECT json_group_array(json_object('resourceId',json_extract(d.value,'$.resourceId'),
     'kind',json_extract(d.value,'$.kind'),'presence',json_extract(d.value,'$.presence'),
     'runtime',json_extract(d.value,'$.runtime'),'identity',json_extract(d.value,'$.identity'),
     'networkRules',json_extract(d.value,'$.networkRules'),'verifiedAtMs',json_extract(d.value,'$.verifiedAtMs')))
     FROM json_each(o.result_json,'$.destructionReceipts') d))))
   FROM operations o WHERE o.allocation_id=a.id AND o.kind='allocation.cleanup' AND o.control_version=a.control_version) AS cleanupJson,
 (SELECT json_group_array(json_object('id',COALESCE(m.provider_id,m.id),'kind',m.kind,'ownership',m.ownership,
   'state',m.observed_state,'identity',json_remove(json(m.ownership_json),'$.referenceKey'),
   'memberName',json_extract(m.details_json,'$.memberName'),'nativeName',json_extract(m.details_json,'$.nativeName'),
   'contractHash',json_extract(m.details_json,'$.contractHash')))
   FROM managed_resources m WHERE m.allocation_id=a.id) AS managedJson
 FROM tickets t JOIN leases l ON l.ticket_id=t.id
 JOIN allocations a ON a.id=l.allocation_id AND a.ticket_id=t.id AND a.generation=l.generation AND a.purpose='tenant'
 JOIN image_artifacts ia ON ia.id=a.image_artifact_id
 LEFT JOIN resolved_provision_contracts r ON r.id=a.resolved_provision_contract_id AND r.node_id=a.node_id
 WHERE t.id=? AND t.consumer_id=? AND l.id=? AND l.generation=?
 AND t.ready_at_ms IS NULL AND json_type(a.actual_resources_json,'$.receipt') IS NULL`;

const id = z.string().min(1).max(512),
  positive = z.number().int().positive();
const Effect =
  PreReadyTicketCleanupProofSchema.shape.createJournal.shape.effects.element.extend(
    {
      name: id,
      state: z.literal("observed"),
      requestedAt: positive,
      observedAt: positive,
    },
  );
const Create = z.object({
  identity: Identity,
  state: z.literal("cancelled"),
  attemptCount: z.number().int().nonnegative(),
  createdAt: positive,
  updatedAt: positive,
  executionMode: z.literal("portainer"),
  journalVersion: z.literal(1).nullable(),
  effects: z.array(Effect),
});
const Cleanup = z.object({
  identity: Identity,
  state: z.literal("succeeded"),
  createdAt: positive,
  updatedAt: positive,
  verifiedAt: positive,
  noExternalCreate: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .nullable(),
  inventory: z
    .object({
      completeness: z.literal("complete"),
      identity: Identity,
      runtime: Runtime,
    })
    .nullable(),
  resources: z.array(ObjectRecord).nullable(),
  receipts: z.array(Receipt),
});
const Managed = z.object({
  id,
  kind: z.enum(["container", "volume", "network_policy"]),
  ownership: z.enum(["owned", "reference"]),
  state: z.literal("absent"),
  identity: Identity,
  memberName: z.enum(["workload", "gateway"]).nullable(),
  nativeName: id.nullable(),
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const requireProof = (value: unknown) => {
  if (!value) throw new ApplicationError("conflict");
};
const num = (v: unknown) =>
  z
    .number()
    .int()
    .nonnegative()
    .parse(typeof v === "bigint" ? Number(v) : v);
const parse = (v: unknown): unknown => JSON.parse(z.string().parse(v));
const ids = (rows: readonly { id: string; kind: string }[]) =>
  rows.map((r) => `${r.kind}:${r.id}`).sort();
const stable = (value: z.infer<typeof Identity>) => {
  const { controlVersion: _, ...rest } = value;
  return rest;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function readPreReadyCleanupProof(
  storage: Pick<Storage, "get">,
  now: () => number,
  consumerId: string,
  ticketId: string,
  query: CleanupProofQuery,
): Promise<PreReadyTicketCleanupProof | null> {
  const row = await storage.get<Record<string, unknown>>(
    PRE_READY_CLEANUP_PROOF_SQL,
    [ticketId, consumerId, query.leaseId, query.generation],
  );
  if (!row) return null;
  try {
    const readAtMs = now();
    requireProof(
      row.ticketId === ticketId &&
        row.consumerId === consumerId &&
        row.leaseId === query.leaseId &&
        num(row.generation) === query.generation,
    );
    requireProof(
      row.phase === "released" &&
        row.ticketCleanup === "complete" &&
        row.leaseState === "revoked" &&
        row.desiredState === "absent" &&
        row.observedState === "absent" &&
        row.allocationCleanup === "complete" &&
        row.manifestId === null &&
        num(row.manifestComplete) === 0 &&
        row.readyAt === null &&
        num(row.claimCount) > 0 &&
        num(row.unreleasedClaims) === 0 &&
        num(row.unresolvedOperations) === 0 &&
        num(row.revokedAt) > 0 &&
        num(row.revokedAt) <= readAtMs,
    );
    const create = z.array(Create).length(1).parse(parse(row.createsJson))[0]!;
    const cleanup = z
      .array(Cleanup)
      .length(1)
      .parse(parse(row.cleanupJson))[0]!;
    const managed = z.array(Managed).parse(parse(row.managedJson));
    const owner = create.identity,
      operation = cleanup.identity;
    // Native cleanup keeps the original provision operation identity, just as the ready proof does.
    const end = { ...owner, controlVersion: operation.controlVersion };
    requireProof(
      owner.installationId === row.installationId &&
        owner.allocationId === row.allocationId &&
        owner.generation === query.generation &&
        owner.runtimeIdentityId === row.runtimeIdentityId &&
        end.controlVersion === num(row.controlVersion) &&
        end.controlVersion > owner.controlVersion &&
        operation.operationId !== owner.operationId &&
        equal(
          stable({ ...operation, operationId: owner.operationId }),
          stable(owner),
        ) &&
        create.createdAt <= create.updatedAt &&
        create.updatedAt <= readAtMs &&
        cleanup.createdAt <= cleanup.verifiedAt &&
        cleanup.verifiedAt <= cleanup.updatedAt &&
        cleanup.updatedAt <= readAtMs,
    );
    const group = containerGroupFromRequirements(parse(row.requirementsJson));
    const owned = managed.filter((m) => m.ownership === "owned");
    requireProof(
      new Set(ids(managed)).size === managed.length &&
        managed.every(
          (m) =>
            equal(stable(m.identity), stable(owner)) &&
            [owner.controlVersion, end.controlVersion].includes(
              m.identity.controlVersion,
            ) &&
            m.contractHash === row.contractHash &&
            (m.ownership !== "reference" || m.kind === "volume"),
        ),
    );
    const kinds: Record<string, string> = {
      container: "container",
      volume: "volume",
      network_policy: "network_policy",
      container_gateway: "container",
      volume_gateway: "volume",
    };
    requireProof(
      new Set(create.effects.map((e) => e.key)).size ===
        create.effects.length &&
        create.effects.every((e) => {
          const object = owned.find(
            (m) => m.id === e.resourceId && m.kind === e.kind,
          );
          const member = e.key.endsWith("_gateway") ? "gateway" : "workload";
          return (
            e.kind === kinds[e.key] &&
            (group !== undefined || !e.key.endsWith("_gateway")) &&
            object &&
            object.nativeName === e.name &&
            (!group ||
              e.kind === "network_policy" ||
              object.memberName === member) &&
            e.requestedAt >= create.createdAt &&
            e.requestedAt <= e.observedAt &&
            e.observedAt <= cleanup.verifiedAt
          );
        }) &&
        equal(
          ids(owned),
          ids(create.effects.map((e) => ({ id: e.resourceId, kind: e.kind }))),
        ),
    );
    const noExternal =
      cleanup.noExternalCreate === true || cleanup.noExternalCreate === 1;
    if (noExternal) {
      requireProof(
        (create.attemptCount === 0 || row.resolvedId === null) &&
          (create.attemptCount === 0 || create.journalVersion === 1) &&
          managed.length === 0 &&
          create.effects.length === 0 &&
          cleanup.inventory === null &&
          (cleanup.resources === null || cleanup.resources.length === 0) &&
          cleanup.receipts.length === 0,
      );
    } else {
      requireProof(
        create.attemptCount > 0 &&
          create.journalVersion === 1 &&
          typeof row.contractHash === "string" &&
          equal(ids(cleanup.resources ?? []), ids(owned)) &&
          equal(
            ids(
              cleanup.receipts.map((r) => ({ id: r.resourceId, kind: r.kind })),
            ),
            ids(owned),
          ) &&
          equal(cleanup.inventory?.identity, end) &&
          equal(cleanup.inventory?.runtime, {
            runtimeIdentityId: owner.runtimeIdentityId,
            connectionRevisionId: owner.connectionRevisionId,
          }),
      );
      for (const receipt of cleanup.receipts)
        requireProof(
          equal(receipt.identity, end) &&
            equal(receipt.runtime, cleanup.inventory!.runtime) &&
            receipt.verifiedAtMs >= cleanup.createdAt &&
            receipt.verifiedAtMs <= cleanup.verifiedAt &&
            (receipt.kind === "network_policy"
              ? (row.networkEnforcement === "docker_bridge"
                  ? ["not_applicable"]
                  : ["removed", "never_installed"]
                ).includes(receipt.networkRules)
              : receipt.networkRules === "not_applicable"),
        );
    }
    const objects = owned
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        ownership: "owned" as const,
        ...(group && m.memberName && m.kind !== "network_policy"
          ? { memberName: m.memberName }
          : {}),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const effects = create.effects
      .map(({ key, kind, resourceId }) => ({ key, kind, resourceId }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const cleanupManifest = {
      id: `cleanup-manifest-${hash({ allocationId: owner.allocationId, generation: owner.generation, operationId: operation.operationId })}`,
      hash: hash({
        create: owner,
        cleanup: end,
        cleanupOperationId: operation.operationId,
        contractHash: row.contractHash,
        objects,
        effects,
      }),
    };
    const expected = {
      allocationId: owner.allocationId,
      cleanupOperationId: operation.operationId,
      cleanupControlVersion: end.controlVersion,
      manifestId: cleanupManifest.id,
      manifestHash: cleanupManifest.hash,
    };
    for (const [key, value] of Object.entries(query.expected ?? {}))
      requireProof(value === expected[key as keyof typeof expected]);
    return PreReadyTicketCleanupProofSchema.parse({
      version: "1.1",
      basis: "pre_ready_cleanup",
      outcome: objects.length ? "reclaimed" : "not_created",
      ticketId,
      consumerId,
      leaseId: query.leaseId,
      generation: query.generation,
      allocationId: owner.allocationId,
      cleanupOperationId: operation.operationId,
      cleanupControlVersion: end.controlVersion,
      createIdentity: owner,
      cleanupIdentity: end,
      cleanupManifest,
      createJournal: {
        operationId: owner.operationId,
        attemptCount: create.attemptCount,
        effects,
      },
      objects,
      receipts: cleanup.receipts,
      after: cleanup.inventory
        ? {
            presence: "absent",
            ...cleanup.inventory,
            verifiedAtMs: cleanup.verifiedAt,
          }
        : null,
      claimState: "released",
      leaseState: "revoked",
      providerCleanup: "complete",
      producer: "controller.allocation.cleanup",
      readAtMs,
      io: "unknown",
      wholeScopeWriteExclusion: "unknown",
    });
  } catch {
    throw new ApplicationError("conflict");
  }
}
