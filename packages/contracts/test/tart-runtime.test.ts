import { describe, expect, it } from "vitest";
import {
  tartGuestBootstrapRequestSchema,
  tartGuestBootstrapReceiptSchema,
  tartInspectionSchema,
  tartReconcileRequestSchema,
} from "../src/tart-runtime.js";
import { createHash } from "node:crypto";
import {
  canonicalTartNetworkPlan,
  tartNetworkPlanSchema,
} from "../src/tart-network.js";

const identity = {
  installationId: "install-1",
  runtimeIdentityId: "runtime-1",
  connectionRevisionId: "revision-1",
  allocationId: "allocation-1",
  generation: 1,
  operationId: "operation-1",
  controlVersion: 1,
  purpose: "tenant" as const,
};
const key =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const fingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const networkWithoutHash = {
  grantId: "grant-1",
  revisionId: "network-revision-1",
  frozenPlatformDenyRevisionId: "frozen-deny-1",
  platformDenyRevisionId: "effective-deny-1",
  mode: "isolated_vm" as const,
  enforcement: "tart_agent" as const,
  ipv6: "disabled" as const,
  allowedEgress: [],
  allowedIngressSourceCidrs: ["192.0.2.0/24"],
  accessSourceCidrs: ["192.0.2.0/24"],
  accessPorts: [22],
  managementDenyRules: [],
};
const network = {
  ...networkWithoutHash,
  contractHash:
    "sha256:" +
    createHash("sha256")
      .update(canonicalTartNetworkPlan(networkWithoutHash))
      .digest("hex"),
};

describe("internal Tart contract", () => {
  it("keeps bootstrap requests public-key-only and binds them to the same immutable allocation", () => {
    const request = {
      identity,
      nonce: "nonce-0123456789abcdef",
      account: "tenant",
      clientPublicKey: key,
      clientPublicKeyFingerprint: fingerprint,
      networkEvidence: {
        reference: "network-1",
        revisionId: "revision-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    };
    expect(tartGuestBootstrapRequestSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      tartGuestBootstrapRequestSchema.safeParse({
        ...request,
        privateKey: "never",
      }).success,
    ).toBe(false);
    expect(
      tartReconcileRequestSchema.safeParse({
        identity,
        template: {
          source: "local",
          name: "base",
          guestOS: "linux",
          guestArch: "arm64",
          configSha256: "a".repeat(64),
        },
        resources: { cpus: 2, memoryMiB: 2048 },
        network,
        bootstrap: {
          ...request,
          identity: { ...identity, allocationId: "other" },
        },
      }).success,
    ).toBe(false);
  });

  it("models present-with-pending bootstrap separately from VM presence", () => {
    expect(
      tartInspectionSchema.parse({
        presence: "present",
        identity,
        vmName: "hitchlet-one",
        state: "running",
        resources: { cpus: 2, memoryMiB: 2048 },
        bootstrapStatus: "pending",
        network: {
          backend: "softnet",
          status: "unknown",
          identity,
          revisionId: "network-revision-1",
          contractHash: network.contractHash,
          reason: "network_process_untracked",
          observedAt: "2029-01-01T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ presence: "present", bootstrapStatus: "pending" });
    expect(
      tartInspectionSchema.safeParse({
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
        bootstrapStatus: "pending",
      }).success,
    ).toBe(false);
  });

  it("keeps unknown bootstrap receipts distinct from applied receipts", () => {
    expect(
      tartGuestBootstrapReceiptSchema.parse({
        status: "unknown",
        identity,
        nonce: "nonce-0123456789abcdef",
        reason: "guest_unreachable",
        observedAt: "2029-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "unknown" });
    expect(
      tartGuestBootstrapReceiptSchema.safeParse({
        status: "applied",
        identity,
        nonce: "nonce-0123456789abcdef",
        reason: "no-proof",
      }).success,
    ).toBe(false);
  });
});
