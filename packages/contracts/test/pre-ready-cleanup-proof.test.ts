import { expect, it } from "vitest";
import {
  PreReadyTicketCleanupProofSchema,
  TicketCleanupProofSchema,
} from "../src/cleanup-proof.js";

const create = {
  installationId: "install",
  allocationId: "allocation",
  generation: 1,
  operationId: "create",
  controlVersion: 1,
  purpose: "tenant",
  runtimeIdentityId: "runtime",
  connectionRevisionId: "connection",
};
const end = { ...create, controlVersion: 2 };
const none = {
  version: "1.1",
  basis: "pre_ready_cleanup",
  outcome: "not_created",
  ticketId: "ticket",
  consumerId: "consumer",
  leaseId: "lease",
  generation: 1,
  allocationId: "allocation",
  cleanupOperationId: "cleanup",
  cleanupControlVersion: 2,
  createIdentity: create,
  cleanupIdentity: end,
  cleanupManifest: { id: "cleanup-manifest", hash: "a".repeat(64) },
  createJournal: { operationId: "create", attemptCount: 0, effects: [] },
  objects: [],
  receipts: [],
  after: null,
  claimState: "released",
  leaseState: "revoked",
  providerCleanup: "complete",
  producer: "controller.allocation.cleanup",
  readAtMs: 123,
  io: "unknown",
  wholeScopeWriteExclusion: "unknown",
};
const runtime = {
  runtimeIdentityId: "runtime",
  connectionRevisionId: "connection",
};
const partial = {
  ...none,
  outcome: "reclaimed",
  createJournal: {
    operationId: "create",
    attemptCount: 1,
    effects: [
      { key: "network_policy", kind: "network_policy", resourceId: "network" },
    ],
  },
  objects: [{ id: "network", kind: "network_policy", ownership: "owned" }],
  receipts: [
    {
      resourceId: "network",
      kind: "network_policy",
      presence: "absent",
      runtime,
      identity: end,
      networkRules: "removed",
      verifiedAtMs: 122,
    },
  ],
  after: {
    presence: "absent",
    completeness: "complete",
    identity: end,
    runtime,
    verifiedAtMs: 122,
  },
};
it("represents no create without inventing a native observation or ready manifest", () => {
  expect(TicketCleanupProofSchema.parse(none)).toEqual(none);
  expect(PreReadyTicketCleanupProofSchema.parse(partial)).toEqual(partial);
});
it.each([
  { ...partial, receipts: [] },
  { ...partial, createJournal: none.createJournal },
  { ...partial, objects: [...partial.objects, ...partial.objects] },
  { ...partial, after: null },
  { ...partial, outcome: "not_created" },
  { ...none, outcome: "reclaimed" },
  { ...none, cleanupManifest: undefined },
  { ...none, manifest: { id: "invented-ready", hash: "a".repeat(64) } },
])("rejects contradictory or incomplete terminal evidence %j", (value) => {
  expect(TicketCleanupProofSchema.safeParse(value).success).toBe(false);
});
