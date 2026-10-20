import { describe, expect, it } from "vitest";
import {
  ConsumerInputSchema,
  AuthorizedCatalogSchema,
  PreparedManagementRequestSchema,
} from "../src/admin.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("D24 configuration contract", () => {
  it("allows only fixed non-secret prepared management endpoints and their real input schemas", () => {
    const safe = {
      kind: "management",
      idempotencyKey: "original-key",
      method: "POST",
      path: "/v1/machines",
      body: {
        name: "machine",
        hostOs: "linux",
        architecture: "arm64",
        capacity: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
      },
    };
    expect(PreparedManagementRequestSchema.safeParse(safe).success).toBe(true);
    for (const path of [
      "/v1/admin/credentials",
      "/v1/system/credentials/rotate",
      `/v1/tickets/${id}/access`,
      "https://other.example/shell",
    ]) {
      expect(
        PreparedManagementRequestSchema.safeParse({ ...safe, path }).success,
      ).toBe(false);
    }
    expect(
      PreparedManagementRequestSchema.safeParse({
        ...safe,
        body: { ...safe.body, command: "arbitrary shell" },
      }).success,
    ).toBe(false);
  });
  it("bounds quota, requires explicit grants and rejects unsupported configuration knobs", () => {
    const input = {
      name: "consumer",
      role: "consumer",
      kind: "service",
      status: "active",
      authorization: {
        imageIds: [],
        nodeIds: [],
        networkProfileIds: [],
        storageProfileIds: [],
      },
      quota: {
        maxQueuedTickets: 10,
        maxActiveTickets: 1,
        maxLeaseTtlSeconds: 900,
        maxLifetimeSeconds: 3600,
        maxResources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
        defaultExpiryPolicyId: id,
      },
    };
    expect(ConsumerInputSchema.safeParse(input).success).toBe(true);
    expect(
      ConsumerInputSchema.safeParse({
        ...input,
        quota: { ...input.quota, maxLeaseTtlSeconds: 4000 },
      }).success,
    ).toBe(false);
    expect(
      ConsumerInputSchema.safeParse({
        ...input,
        authorization: { ...input.authorization, nodeIds: "*" },
      }).success,
    ).toBe(false);
    expect(
      ConsumerInputSchema.safeParse({ ...input, shell: "echo unsafe" }).success,
    ).toBe(false);
  });
  it("rejects provider secret fields in the consumer directory at the runtime boundary", () => {
    const catalog = {
      observedAtMs: 1,
      quota: {
        maxQueuedTickets: 1,
        maxActiveTickets: 1,
        maxLeaseTtlSeconds: 1,
        maxLifetimeSeconds: 1,
        maxResources: { cpuMillis: 1, memoryMiB: 1, scratchMiB: 0 },
        defaultExpiryPolicyId: id,
      },
      versions: [],
      networks: [],
      nodes: [],
      storage: [
        {
          id,
          name: "safe",
          revisionId: id,
          revision: 1,
          allowedSubpaths: ["team"],
          allowedModes: ["read_only"],
        },
      ],
    };
    expect(AuthorizedCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(
      AuthorizedCatalogSchema.safeParse({
        ...catalog,
        storage: [
          {
            ...catalog.storage[0],
            sourceRef: "/private/host",
            secretVersionRef: "secret:private",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
