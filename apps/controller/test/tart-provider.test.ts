import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { expect, it } from "vitest";
import type {
  TartAllocationIdentity,
  TartGuestBootstrapReceipt,
  TartInspection,
} from "@hitchlet/contracts/internal";
import { tartAllocationOwnerTuple } from "@hitchlet/contracts/internal";
import type { ProvisionPlan, ResourceJournal } from "../src/providers/port.js";
import {
  TartExecutionProvider,
  type TartExecutionProviderOptions,
} from "../src/providers/tart-provider.js";

const { utils: sshUtils } = ssh2;

function generatedKey() {
  const pair = sshUtils.generateKeyPairSync("ed25519");
  const parsed = sshUtils.parseKey(pair.private);
  if (parsed instanceof Error) throw parsed;
  const blob = parsed.getPublicSSH();
  const typeLength = blob.readUInt32BE(0);
  const type = blob.subarray(4, 4 + typeLength).toString("ascii");
  return {
    privateKey: pair.private,
    publicKey: pair.public,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

it("resumes one owned VM after guest apply failure and readies it with the same receipt nonce", async () => {
  const client = generatedKey();
  const host = generatedKey();
  const plan: ProvisionPlan = {
    deadlineMs: Date.now() + 60_000,
    identity: {
      installationId: "install-tart",
      runtimeIdentityId: "runtime-tart",
      connectionRevisionId: "connection-rev-1",
      allocationId: "allocation-tart",
      generation: 1,
      operationId: "operation-tart",
      controlVersion: 1,
      purpose: "validation",
    },
    artifact: {
      id: "artifact-tart",
      ref: "local-vm-template",
      digest: `sha256:${"a".repeat(64)}`,
      guestOS: "linux",
      architecture: "arm64",
    },
    resources: {
      request: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 1024 },
      limit: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 1024 },
      scratchEnforcement: "best_effort",
      isolation: "virtual_machine",
      accelerators: [],
    },
    resolved: {
      id: "resolved-tart",
      contractHash: "sha256-contract-tart",
      selectionHash: "sha256-selection-tart",
      network: {
        grantId: "grant-tart",
        revisionId: "network-rev-1",
        frozenPlatformDenyRevisionId: "deny-frozen-1",
        platformDenyRevisionId: "deny-live-1",
        mode: "isolated_vm",
        ipv6: "disabled",
        allowedEgress: [],
        allowedIngressSourceCidrs: ["192.0.2.0/24"],
        managementDenyRules: [],
        enforcement: "tart_agent",
        verificationRequired: true,
      },
      mounts: [],
    },
    accessProtocol: "ssh",
    bootstrap: {
      mechanism: "tart-guest-bootstrap-v1",
      contractVersion: "1",
      identityReset: true,
    },
    access: {
      accessProtocols: ["ssh"],
      ports: [22],
      account: "hitchlet",
      allowedSourceCidrs: ["192.0.2.0/24"],
      discovery: "guest_ipv4",
      readiness: "authenticated_ssh",
    },
  };
  const owner: TartAllocationIdentity = {
    installationId: plan.identity.installationId,
    runtimeIdentityId: plan.identity.runtimeIdentityId,
    connectionRevisionId: plan.identity.connectionRevisionId,
    allocationId: plan.identity.allocationId,
    generation: plan.identity.generation,
    operationId: plan.identity.operationId,
    controlVersion: plan.identity.controlVersion,
    purpose: plan.identity.purpose,
  };
  const ownerKey = JSON.stringify(tartAllocationOwnerTuple(owner));
  const vmName = `hitchlet-${createHash("sha256").update(ownerKey).digest("hex").slice(0, 32)}`;
  let observation: TartInspection = {
    presence: "absent",
    identity: owner,
    inventoryCompleteness: "complete",
  };
  let cloneCount = 0;
  let bootstrapRequest:
    | import("@hitchlet/contracts/internal").TartGuestBootstrapRequest
    | undefined;
  const runtime = {
    async inspect() {
      return structuredClone(observation);
    },
    async reconcile(
      request: import("@hitchlet/contracts/internal").TartReconcileRequest,
    ) {
      if (observation.presence === "absent") cloneCount += 1;
      bootstrapRequest = request.bootstrap ?? bootstrapRequest;
      observation = {
        presence: "present",
        identity: request.identity,
        vmName,
        state: "running",
        resources: request.resources,
        bootstrapStatus: bootstrapRequest ? "pending" : "not_requested",
        ipAddress: "192.0.2.44",
      };
      return structuredClone(observation);
    },
    async recordBootstrapReceipt(
      identity: TartAllocationIdentity,
      request: import("@hitchlet/contracts/internal").TartGuestBootstrapRequest,
      receipt: TartGuestBootstrapReceipt,
    ) {
      expect(request).toEqual(bootstrapRequest);
      observation = {
        presence: "present",
        identity,
        vmName,
        state: "running",
        resources: { cpus: 2, memoryMiB: 2048 },
        bootstrapStatus: "applied",
        bootstrapReceipt: receipt,
        ipAddress: "192.0.2.44",
      };
      return structuredClone(observation);
    },
    async destroy(identity: TartAllocationIdentity) {
      observation = {
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
      };
      return structuredClone(observation);
    },
  };
  let guestApplyAttempts = 0;
  const evidenceExpiry = new Date(plan.deadlineMs - 1_000).toISOString();
  const options: TartExecutionProviderOptions = {
    resolveRuntime: async () => ({
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      connectionRevisionId: plan.identity.connectionRevisionId,
      artifactDigest: plan.artifact.digest,
      template: {
        source: "local",
        name: plan.artifact.ref,
        guestOS: "linux",
        guestArch: "arm64",
        configSha256: "b".repeat(64),
      },
      runtime,
    }),
    accessMaterials: {
      getOrCreate: async () => ({ ...client, secretRef: "secret:test-only" }),
    },
    network: {
      verify: async () => ({
        runtimeIdentityId: plan.identity.runtimeIdentityId,
        allocationId: plan.identity.allocationId,
        generation: plan.identity.generation,
        revisionId: plan.resolved.network.revisionId,
        contractHash: createHash("sha256")
          .update(JSON.stringify(plan.resolved.network))
          .digest("hex"),
        reference: "network-proof-1",
        verifiedAt: new Date().toISOString(),
        expiresAt: evidenceExpiry,
      }),
    },
    guestBootstrap: {
      async apply(request) {
        guestApplyAttempts += 1;
        if (guestApplyAttempts === 1)
          throw new Error("synthetic guest hook failure");
        return {
          status: "applied",
          identity: request.identity,
          nonce: request.nonce,
          account: request.account,
          clientPublicKeyFingerprint: request.clientPublicKeyFingerprint,
          hostPublicKey: host.publicKey,
          hostKeyFingerprint: host.fingerprint,
          networkEvidenceReference: request.networkEvidence.reference,
          networkEvidenceExpiresAt: request.networkEvidence.expiresAt,
          observedAt: new Date().toISOString(),
        };
      },
    },
    ssh: {
      verify: async (input) => ({
        authenticated: true,
        username: input.username,
        hostKeyFingerprint: input.hostKeyFingerprint,
        clientPublicKeyFingerprint: input.clientPublicKeyFingerprint,
        observedScratchMiB: 640,
      }),
    },
  };
  const provider = new TartExecutionProvider(options);
  const mismatchedOS = {
    ...plan,
    artifact: { ...plan.artifact, guestOS: "macos" as const },
  };
  await expect(
    provider.create(mismatchedOS, {
      beforeCreate: async () => {
        throw new Error("must reject before journaling");
      },
      assertActive: async () => undefined,
      recordCreated: async () => undefined,
    }),
  ).rejects.toThrow("Resolved Tart runtime differs from the frozen plan");
  const unsupportedArch = {
    ...plan,
    artifact: { ...plan.artifact, architecture: "amd64" as const },
  };
  await expect(
    provider.create(unsupportedArch, {
      beforeCreate: async () => {
        throw new Error("must reject before journaling");
      },
      assertActive: async () => undefined,
      recordCreated: async () => undefined,
    }),
  ).rejects.toThrow("Tart supports only local isolated SSH virtual machines");
  const journalState: {
    effects: unknown[];
    resources: unknown[];
    active: number;
  } = {
    effects: [],
    resources: [],
    active: 0,
  };
  const journal: ResourceJournal = {
    async beforeCreate(effect) {
      journalState.effects.push(effect);
    },
    async assertActive() {
      journalState.active += 1;
    },
    async recordCreated(resource) {
      journalState.resources.push(resource);
    },
  };

  await provider.create(plan, journal);
  let inventory = await provider.inspect(plan);
  if (inventory.presence !== "present") throw new Error("expected present VM");
  await expect(provider.ready(plan, inventory.evidence)).rejects.toThrow(
    "synthetic guest hook failure",
  );

  await provider.create(plan, journal);
  inventory = await provider.inspect(plan);
  if (inventory.presence !== "present") throw new Error("expected present VM");
  const receipt = await provider.ready(plan, inventory.evidence);

  expect(cloneCount).toBe(1);
  expect(guestApplyAttempts).toBe(2);
  expect(bootstrapRequest?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(receipt.bootstrapComplete).toBe(true);
  expect(receipt.effectiveResources).toMatchObject({
    limits: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 640 },
    scratchEnforcement: "best_effort",
  });
  expect(receipt.access).toMatchObject({
    host: "192.0.2.44",
    port: 22,
    username: "hitchlet",
    hostKeyFingerprint: host.fingerprint,
    clientPublicKeyFingerprint: client.fingerprint,
  });
  expect(journalState.effects).toHaveLength(1);
  expect(journalState.resources.length).toBeGreaterThanOrEqual(4);
});
