import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AcquireRequestSchema,
  ApiErrorResponseSchema,
  EventQuerySchema,
  ImageSelectorSchema,
  ResourceAmountsSchema,
  ResourceEventSchema,
  TicketViewSchema,
  PublicSchemas,
  StorageRequestSchema,
  toPublicJsonSchema,
  LeaseRenewalViewSchema,
  AccessGrantSchema,
} from "../src/index.js";
import type { AcquireRequest } from "../src/public.js";

const id = "00000000-0000-4000-8000-000000000001";
const request: AcquireRequest = {
  image: { versionId: id },
  networkProfileId: id,
  resources: { cpuMillis: 1000, memoryMiB: 512, scratchMiB: 0 },
};
const utc = "2026-10-19T00:00:00.000Z";
const resources = {
  request: { cpuMillis: 1000, memoryMiB: 512, scratchMiB: 0 },
  limit: { cpuMillis: 1000, memoryMiB: 512, scratchMiB: 0 },
  scratchEnforcement: "best_effort",
  isolation: "shared_kernel",
  accelerators: [],
};
const acceptedRequest = {
  image: { versionId: id },
  resources,
  networkProfileId: id,
  kind: "container",
  allowedArchitectures: ["amd64"],
  allowedProviders: ["portainer"],
  locality: "local_only",
  siteIds: [],
  requiredLabels: {},
  requiredCapabilities: [],
  storage: [],
  access: { protocol: "ssh" },
  lease: {
    requestedSeconds: 900,
    maximumLifetimeSeconds: 86400,
    queueTimeoutSeconds: 1800,
    provisioningTimeoutSeconds: 1200,
    expiryPolicyId: id,
    maximumTtlSeconds: 3600,
  },
  labels: {},
};
const queuedTicket = {
  id,
  consumerId: id,
  phase: "queued",
  version: 1,
  pinnedImageVersionId: id,
  terminalReason: null,
  cleanupStatus: "not_needed",
  createdAt: utc,
  updatedAt: utc,
  readyAt: null,
  releasedAt: null,
  acceptedRequest,
  pinnedProfileRevisions: {
    networkProfileRevisionId: id,
    storageProfileRevisionIds: [],
  },
  queueDeadline: utc,
  provisioningDeadline: null,
  lease: null,
  placement: null,
  health: { state: "unknown", observedAt: null, reasonCodes: [] },
  scheduling: {
    checkedAt: null,
    reasonCodes: [],
    matchingNodeCount: 0,
    nextCheckAt: null,
  },
  renewalPending: null,
  cleanupBlockedResources: [],
};
const readyTicket = {
  ...queuedTicket,
  phase: "ready",
  readyAt: utc,
  lease: {
    id,
    generation: 1,
    version: 1,
    state: "active",
    claimBy: utc,
    claimedAt: utc,
    expiresAt: utc,
    renewUntil: utc,
    revokedAt: null,
  },
  placement: {
    machineId: id,
    nodeId: id,
    provider: "portainer",
    architecture: "amd64",
    imageArtifactId: id,
  },
  health: { state: "healthy", observedAt: utc, reasonCodes: [] },
};
const renewalFields = {
  id,
  leaseId: id,
  proposedVersion: 2,
  proposedExpiresAt: utc,
  isInitialClaim: false,
  decisionDeadline: utc,
  createdAt: utc,
  updatedAt: utc,
};
const receipt = {
  renewalId: id,
  ticketId: id,
  generation: 1,
  leaseId: id,
  leaseVersion: 2,
  claimedAt: utc,
  expiresAt: utc,
  renewUntil: utc,
  offlineEnforcement: "confirmed",
  guardAcknowledgementId: id,
};
const grantFields = {
  ticketId: id,
  leaseId: id,
  leaseVersion: 1,
  generation: 1,
  access: {
    protocol: "ssh",
    host: "worker.local",
    port: 22,
    username: "tenant",
    hostKeyFingerprint: null,
    expiresAt: utc,
  },
};

describe("public runtime contracts", () => {
  it("rejects unknown writes, invalid numbers, incompatible kind/isolation and mixed selectors", () => {
    expect(
      AcquireRequestSchema.safeParse({ ...request, unexpected: true }).success,
    ).toBe(false);
    expect(
      AcquireRequestSchema.safeParse({ ...request, allowedNodeIds: [] })
        .success,
    ).toBe(false);
    expect(
      AcquireRequestSchema.safeParse({
        ...request,
        resources: {
          ...request.resources,
          cpuMillis: Number.POSITIVE_INFINITY,
        },
      }).success,
    ).toBe(false);
    expect(
      ImageSelectorSchema.safeParse({
        versionId: id,
        imageId: id,
        alias: "latest",
      }).success,
    ).toBe(false);
    expect(
      ImageSelectorSchema.safeParse({
        imageId: id,
        alias: "latest",
        versionId: undefined,
      }).success,
    ).toBe(false);
    expect(
      ResourceAmountsSchema.safeParse({
        cpuMillis: 0,
        memoryMiB: 0,
        scratchMiB: 0,
      }).success,
    ).toBe(true);
    expect(
      AcquireRequestSchema.safeParse({
        ...request,
        kind: "container",
        resources: { ...request.resources, isolation: "virtual_machine" },
      }).success,
    ).toBe(false);
    expect(
      AcquireRequestSchema.safeParse({
        ...request,
        kind: "vm",
        resources: { ...request.resources, isolation: "shared_kernel" },
      }).success,
    ).toBe(false);
  });

  it("rejects traversal and bounds event cursors to SQLite int64", () => {
    expect(
      StorageRequestSchema.safeParse({
        storageProfileId: id,
        authorizedSubpath: "safe/../secret",
        mountPath: "/data",
        mode: "read_only",
      }).success,
    ).toBe(false);
    expect(
      StorageRequestSchema.safeParse({
        storageProfileId: id,
        authorizedSubpath: "C:/outside",
        mountPath: "/data",
        mode: "read_only",
      }).success,
    ).toBe(false);
    expect(
      StorageRequestSchema.safeParse({
        storageProfileId: id,
        authorizedSubpath: "safe\0secret",
        mountPath: "/data",
        mode: "read_only",
      }).success,
    ).toBe(false);
    expect(
      StorageRequestSchema.safeParse({
        storageProfileId: id,
        authorizedSubpath: "safe/folder",
        mountPath: "/data",
        mode: "read_only",
      }).success,
    ).toBe(true);
    expect(
      StorageRequestSchema.safeParse({
        storageProfileId: id,
        authorizedSubpath: "safe",
        mountPath: "/data/../../etc",
        mode: "read_only",
      }).success,
    ).toBe(false);
    expect(EventQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(EventQuerySchema.safeParse({ after: "-1" }).success).toBe(false);
    expect(
      EventQuerySchema.safeParse({ after: "9223372036854775808" }).success,
    ).toBe(false);
    expect(
      EventQuerySchema.safeParse({ after: "9223372036854775807" }).success,
    ).toBe(true);
  });

  it("keeps public responses registered and emits standard JSON Schema", () => {
    expect(Object.keys(PublicSchemas)).toContain("AcquireRequest");
    expect(toPublicJsonSchema()).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    });
    expect(
      ApiErrorResponseSchema.safeParse({
        error: {
          code: "E",
          message: "bad",
          details: {},
          retryable: false,
          requestId: id,
        },
      }).success,
    ).toBe(true);
    expect(z.toJSONSchema(AcquireRequestSchema)).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(PublicSchemas).toHaveProperty("TicketView");
    expect(PublicSchemas).toHaveProperty("LeaseRenewalView");
    expect(PublicSchemas).toHaveProperty("AccessGrant");
    expect(TicketViewSchema.safeParse(queuedTicket).success).toBe(true);
    expect(TicketViewSchema.safeParse(readyTicket).success).toBe(true);
    expect(
      TicketViewSchema.safeParse({ ...readyTicket, unknownField: true })
        .success,
    ).toBe(false);
    expect(
      TicketViewSchema.safeParse({
        ...readyTicket,
        placement: { ...readyTicket.placement, provider: "unknown" },
      }).success,
    ).toBe(false);
    expect(
      ResourceEventSchema.safeParse({
        id: "1",
        aggregateType: "ticket",
        aggregateId: id,
        aggregateVersion: 1,
        eventType: "queued",
        occurredAt: "2026-10-19T00:00:00+00:00",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("accepts every consistent lease renewal state and rejects contradictions", () => {
    const states = [
      {
        ...renewalFields,
        state: "pending",
        reasonCode: null,
        confirmedReceipt: null,
      },
      {
        ...renewalFields,
        state: "confirmed",
        reasonCode: null,
        confirmedReceipt: receipt,
      },
      {
        ...renewalFields,
        state: "rejected",
        reasonCode: "POLICY_REJECTED",
        confirmedReceipt: null,
      },
      {
        ...renewalFields,
        state: "cancelled",
        reasonCode: "CANCELLED",
        confirmedReceipt: null,
      },
    ];
    for (const state of states)
      expect(LeaseRenewalViewSchema.safeParse(state).success).toBe(true);
    expect(
      LeaseRenewalViewSchema.safeParse({
        ...states[0],
        reasonCode: "SHOULD_BE_NULL",
      }).success,
    ).toBe(false);
    expect(
      LeaseRenewalViewSchema.safeParse({ ...states[1], confirmedReceipt: null })
        .success,
    ).toBe(false);
    expect(
      LeaseRenewalViewSchema.safeParse({
        ...states[2],
        confirmedReceipt: receipt,
      }).success,
    ).toBe(false);
    expect(
      LeaseRenewalViewSchema.safeParse({ ...states[0], unexpected: true })
        .success,
    ).toBe(false);
  });

  it("accepts all access grant authentication variants and rejects mismatched fields", () => {
    const variants = [
      { kind: "client_public_key", publicKeyFingerprint: "SHA256:tenant" },
      {
        kind: "ssh_certificate",
        certificate: "ssh-ed25519-cert-v01@openssh.com AAAA",
      },
      {
        kind: "ephemeral_private_key",
        privateKey: "test-only-private-key",
      },
      { kind: "ephemeral_password", password: "temporary-secret" },
    ];
    for (const authentication of variants) {
      expect(
        AccessGrantSchema.safeParse({ ...grantFields, authentication }).success,
      ).toBe(true);
    }
    expect(
      AccessGrantSchema.safeParse({
        ...grantFields,
        authentication: { kind: "ssh_certificate", password: "wrong-field" },
      }).success,
    ).toBe(false);
    expect(
      AccessGrantSchema.safeParse({
        ...grantFields,
        access: { ...grantFields.access, port: 0 },
        authentication: variants[0],
      }).success,
    ).toBe(false);
    expect(
      AccessGrantSchema.safeParse({
        ...grantFields,
        authentication: { ...variants[0], unknown: true },
      }).success,
    ).toBe(false);
  });
});
