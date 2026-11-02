import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { expect, it } from "vitest";
import type {
  TartAllocationIdentity,
  TartGuestBootstrapReceipt,
  TartGuestBootstrapRequest,
  TartInspection,
  TartNetworkCleanupReceipt,
  TartNetworkPlan,
} from "@hitchlet/contracts/internal";
import { tartAllocationOwnerTuple } from "@hitchlet/contracts/internal";
import type { ProvisionPlan, ResourceJournal } from "../src/providers/port.js";
import {
  TartExecutionProvider,
  tartNetworkPlanFor,
  type TartExecutionProviderOptions,
} from "../src/providers/tart-provider.js";
import { assertFactsMatchPlan } from "../src/providers/tart-runtime-resolver.js";

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

function networkObservation(
  identity: TartAllocationIdentity,
  network: TartNetworkPlan,
  vmName: string,
  at = Date.now(),
) {
  const readback = {
    allow: ["allow guest ssh"],
    block: ["block other"],
    // Native ruleCount is a compiled diagnostic and need not equal these arrays.
    ruleCount: 97,
  };
  return {
    backend: "softnet" as const,
    status: "policy_match" as const,
    identity,
    revisionId: network.revisionId,
    contractHash: network.contractHash,
    policyHash: softnetPolicyHash(readback),
    vm: {
      vmName,
      device: "41",
      inode: "2048",
      macAddress: "02:00:00:00:00:41",
    },
    process: { pid: 321, startedAt: new Date(at - 1000).toISOString() },
    control: { transport: "unix_stream_fd" as const, connected: true as const },
    readback,
    observedAt: new Date(at).toISOString(),
  };
}

function softnetPolicyHash(readback: {
  allow: readonly string[];
  block: readonly string[];
}) {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        allow: [...readback.allow].sort(),
        block: [...readback.block].sort(),
      }),
    )
    .digest("hex")}`;
}

function removedNetworkReceipt(
  identity: TartAllocationIdentity,
  network: TartNetworkPlan,
  vmName: string,
  at = Date.now(),
): TartNetworkCleanupReceipt {
  return {
    backend: "softnet",
    status: "removed",
    identity,
    revisionId: network.revisionId,
    contractHash: network.contractHash,
    policyHash: `sha256:${"c".repeat(64)}`,
    vm: {
      vmName,
      device: "41",
      inode: "2048",
      macAddress: "02:00:00:00:00:41",
    },
    process: { pid: 321, startedAt: new Date(at - 1000).toISOString() },
    processExitObserved: true,
    readback: {
      allow: [],
      block: ["in 0.0.0.0/0", "out 0.0.0.0/0"],
      ruleCount: 2,
    },
    observedAt: new Date(at).toISOString(),
  };
}

it("resumes one owned VM after guest apply failure and readies it with the same receipt nonce", async () => {
  const client = generatedKey();
  const host = generatedKey();
  let fakeNow = Date.now();
  const plan: ProvisionPlan = {
    deadlineMs: fakeNow + 60_000,
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
  const nativeRuntimeNamespaceId = "11111111-1111-4111-8111-111111111111";
  const facts = {
    nativeRuntimeNamespaceId,
    tartVersion: "2.41.1",
    hostOS: "macos" as const,
    hostArch: "arm64" as const,
    hostCpuCount: 8,
    hostMemoryBytes: 16 * 1024 * 1024 * 1024,
    templates: [
      {
        templateRef: {
          source: "local" as const,
          name: plan.artifact.ref,
          guestOS: "linux" as const,
          guestArch: "arm64" as const,
          configSha256: "b".repeat(64),
        },
        artifactDigest: plan.artifact.digest,
        proofKind: "sealed_local_bundle_v1" as const,
        sealedAt: new Date().toISOString(),
      },
    ],
  };
  const runtimeBinding = {
    installationId: plan.identity.installationId,
    runtimeIdentityId: plan.identity.runtimeIdentityId,
    connectionRevisionId: plan.identity.connectionRevisionId,
    nativeRuntimeNamespaceId,
    controllerEpoch: 1,
    profile: {},
    secrets: { get: async () => "unused-test-secret" },
  };
  expect(() => assertFactsMatchPlan(facts, runtimeBinding, plan)).not.toThrow();
  expect(() =>
    assertFactsMatchPlan(
      {
        ...facts,
        templates: [
          {
            ...facts.templates[0]!,
            artifactDigest: `sha256:${"c".repeat(64)}`,
          },
        ],
      },
      runtimeBinding,
      plan,
    ),
  ).toThrow("Tart sealed template proof does not match the frozen artifact");
  expect(() =>
    assertFactsMatchPlan(
      { ...facts, hostOS: "linux" as never },
      runtimeBinding,
      plan,
    ),
  ).toThrow("Tart Runtime Agent does not match the frozen plan");
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
  let cloneCount = 0;
  let guestApplyAttempts = 0;
  let bootstrapRequest: TartGuestBootstrapRequest | undefined;
  let currentNetwork: TartNetworkPlan | undefined;
  let cleanupReceipt: TartNetworkCleanupReceipt | undefined;
  let observation: TartInspection = {
    presence: "absent",
    identity: owner,
    inventoryCompleteness: "complete",
  };
  const runtime = {
    async inspect() {
      if (observation.presence === "present")
        observation = {
          ...observation,
          network: {
            ...observation.network,
            observedAt: new Date(fakeNow).toISOString(),
          },
        };
      return structuredClone(observation);
    },
    async reconcile(
      request: import("@hitchlet/contracts/internal").TartReconcileRequest,
    ) {
      if (observation.presence === "absent") cloneCount += 1;
      currentNetwork = request.network;
      bootstrapRequest = request.bootstrap ?? bootstrapRequest;
      observation = {
        presence: "present",
        identity: request.identity,
        vmName,
        state: "running",
        resources: request.resources,
        bootstrapStatus: bootstrapRequest ? "pending" : "not_requested",
        network: networkObservation(
          request.identity,
          request.network,
          vmName,
          fakeNow,
        ),
        ...(cleanupReceipt ? { networkCleanupReceipt: cleanupReceipt } : {}),
        ipAddress: "192.0.2.44",
      };
      return structuredClone(observation);
    },
    async bootstrapApply(
      identity: TartAllocationIdentity,
      request: TartGuestBootstrapRequest,
    ) {
      guestApplyAttempts += 1;
      if (guestApplyAttempts === 1)
        throw new Error("synthetic guest hook failure");
      expect(request).toEqual(bootstrapRequest);
      const receipt: TartGuestBootstrapReceipt = {
        status: "applied",
        identity,
        nonce: request.nonce,
        account: request.account,
        clientPublicKeyFingerprint: request.clientPublicKeyFingerprint,
        hostPublicKey: host.publicKey,
        hostKeyFingerprint: host.fingerprint,
        networkEvidenceReference: request.networkEvidence.reference,
        networkEvidenceExpiresAt: request.networkEvidence.expiresAt,
        observedAt: new Date(fakeNow).toISOString(),
      };
      if (!currentNetwork) throw new Error("network plan unavailable");
      observation = {
        presence: "present",
        identity,
        vmName,
        state: "running",
        resources: { cpus: 2, memoryMiB: 2048 },
        bootstrapStatus: "applied",
        network: networkObservation(identity, currentNetwork, vmName, fakeNow),
        bootstrapReceipt: receipt,
        ipAddress: "192.0.2.44",
      };
      return structuredClone(observation);
    },
    async revokeNetwork(
      identity: TartAllocationIdentity,
      network: TartNetworkPlan,
    ) {
      if (network.contractHash !== currentNetwork?.contractHash)
        throw new Error("wrong network plan");
      cleanupReceipt = removedNetworkReceipt(
        identity,
        network,
        vmName,
        fakeNow,
      );
      if (observation.presence === "present")
        observation = {
          ...observation,
          network: {
            backend: "softnet",
            status: "unknown",
            identity,
            revisionId: network.revisionId,
            contractHash: network.contractHash,
            reason: "network_control_closed",
            observedAt: new Date(fakeNow).toISOString(),
          },
          networkCleanupReceipt: cleanupReceipt,
        };
      return structuredClone(observation);
    },
    async destroy(identity: TartAllocationIdentity) {
      observation = {
        presence: "absent",
        identity,
        inventoryCompleteness: "complete",
        ...(cleanupReceipt ? { networkCleanupReceipt: cleanupReceipt } : {}),
      };
      return structuredClone(observation);
    },
  };

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
    resolveCleanupRuntime: async (cleanupPlan) => ({
      runtimeIdentityId: cleanupPlan.identity.runtimeIdentityId,
      connectionRevisionId: cleanupPlan.identity.connectionRevisionId,
      artifactDigest: cleanupPlan.artifact.digest,
      runtime: {
        inspect: (identity) => runtime.inspect(identity),
        revokeNetwork: (identity, network) =>
          runtime.revokeNetwork(identity, network),
        destroy: (identity) => runtime.destroy(identity),
      },
    }),
    accessMaterials: {
      getOrCreate: async () => ({ ...client, secretRef: "secret:test-only" }),
    },
    now: () => fakeNow,
    ssh: {
      verify: async (input) => ({
        authenticated: true,
        username: input.username,
        hostKeyFingerprint: input.hostKeyFingerprint,
        clientPublicKeyFingerprint: input.clientPublicKeyFingerprint,
        guestOS: input.guestOS,
        architecture: input.architecture,
        scratchWritable: true,
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

  const ownedResources = await provider.create(plan, journal);
  expect(currentNetwork).toMatchObject({
    allowedIngressSourceCidrs: ["192.0.2.0/24"],
    accessSourceCidrs: ["192.0.2.0/24"],
    accessPorts: [22],
  });
  const persistedBootstrap = bootstrapRequest;
  const firstObservedAt =
    observation.presence === "present" ? observation.network.observedAt : "";
  fakeNow += 1_000;
  inventory = await provider.inspect(plan);
  if (inventory.presence !== "present") throw new Error("expected present VM");
  expect(
    observation.presence === "present" && observation.network.observedAt,
  ).not.toBe(firstObservedAt);
  const receipt = await provider.ready(plan, inventory.evidence);
  expect(bootstrapRequest).toEqual(persistedBootstrap);

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
  if (observation.presence !== "present")
    throw new Error("expected present VM");
  const verifiedNetwork = observation.network;
  observation = {
    ...observation,
    network: {
      ...verifiedNetwork,
      readback: {
        ...verifiedNetwork.readback,
        allow: [...verifiedNetwork.readback.allow, "allow tampered rule"],
      },
    },
  };
  await expect(provider.ready(plan, inventory.evidence)).rejects.toThrow(
    "Tart network verification is stale or mismatched",
  );
  observation = { ...observation, network: verifiedNetwork };
  expect(journalState.effects).toHaveLength(1);
  expect(journalState.resources.length).toBeGreaterThanOrEqual(4);
  const cleanupPlan: ProvisionPlan = {
    ...plan,
    executionPhase: "cleanup",
    cleanupAuthorization: {
      cleanupOperationId: "cleanup-tart",
      createOperationId: plan.identity.operationId,
      ownerToken: "claimed-cleanup-token",
      operationVersion: 2,
    },
  };
  await expect(provider.create(cleanupPlan, journal)).rejects.toThrow(
    "Tart cleanup plans cannot create or bootstrap VMs",
  );
  await expect(provider.ready(cleanupPlan, inventory.evidence)).rejects.toThrow(
    "Tart cleanup plans cannot create or bootstrap VMs",
  );
  expect((await provider.inspect(cleanupPlan)).presence).toBe("present");
  await provider.revokeStop(cleanupPlan);
  const cleanup = await provider.destroy(cleanupPlan, ownedResources[0]!);
  expect(cleanup.networkRules).toBe("removed");
});
