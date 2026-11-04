import { createHash, generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { expect, it, vi } from "vitest";
import {
  hyperVGuestBootstrapReceiptSchema,
  type HyperVInspection,
  type HyperVGuestBootstrapRequest,
} from "@hitchlet/contracts/internal";
import {
  registerHyperVExecutionProvider,
  type HyperVExecutionProviderOptions,
} from "../src/providers/hyperv-provider.js";
import { encodeEd25519OpenSshKey } from "../src/storage/access-material-store.js";
import type {
  ProvisionPlan,
  OwnedResource,
  ResourceJournal,
  InventoryEvidence,
} from "../src/providers/port.js";
function key() {
  const privateKey = encodeEd25519OpenSshKey(
    generateKeyPairSync("ed25519").privateKey,
  );
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  return {
    privateKey,
    publicKey: "ssh-ed25519 " + parsed.getPublicSSH().toString("base64"),
    fingerprint:
      "SHA256:" +
      createHash("sha256")
        .update(parsed.getPublicSSH())
        .digest("base64")
        .replace(/=+$/, ""),
  };
}
function fixture(os: "windows" | "linux" = "windows") {
  const client = key(),
    host = key();
  const identity = {
    installationId: "i",
    runtimeIdentityId: "r",
    connectionRevisionId: "c",
    allocationId: "a",
    generation: 1,
    operationId: "create",
    controlVersion: 1,
    purpose: "validation" as const,
  };
  const plan: ProvisionPlan = {
    deadlineMs: Date.now() + 60_000,
    runtimeConfig: { executionMode: "hyperv" },
    identity,
    artifact: {
      id: "artifact",
      ref: "template",
      digest: "sha256:" + "a".repeat(64),
      guestOS: os,
      architecture: "amd64",
    },
    resources: {
      request: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
      limit: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
      isolation: "virtual_machine",
      scratchEnforcement: "best_effort",
      accelerators: [],
    },
    resolved: {
      id: "resolved",
      contractHash: "contract",
      selectionHash: "selection",
      mounts: [],
      network: {
        grantId: "n",
        revisionId: "n1",
        frozenPlatformDenyRevisionId: "d1",
        platformDenyRevisionId: "d1",
        mode: "trusted_nat",
        ipv6: "not_enforced",
        allowedEgress: [],
        allowedIngressSourceCidrs: [],
        managementDenyRules: [],
        enforcement: "hyperv_nat",
        verificationRequired: false,
      },
    },
    accessProtocol: "ssh",
    bootstrap: {
      mechanism: "hyperv-guest-bootstrap-v1",
      contractVersion: "1",
      identityReset: true,
    },
    access: {
      accessProtocols: ["ssh"],
      ports: [22],
      account: "workspace",
      allowedSourceCidrs: [],
      discovery: "guest_ipv4",
      readiness: "authenticated_ssh",
    },
  };
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    owner: "owned",
    directory: "E:\\Hitchlet\\allocation",
    configurationPath: "E:\\Hitchlet\\allocation\\config",
    diskPaths: ["E:\\Hitchlet\\allocation\\os.vhdx"],
    cpus: 2,
    memoryMiB: 2048,
    dynamicMemory: false,
    generation: 2 as const,
    state: "running" as const,
    switchNames: ["Default Switch"],
    dynamicMac: true,
    ipv4: ["192.0.2.10"],
  };
  let observation: HyperVInspection = {
    identity,
    presence: "absent",
    inventoryComplete: true,
    bootstrapStatus: "not_implemented",
  };
  let unknownCleanup = false;
  const runtime = {
    inspect: vi.fn(async () => structuredClone(observation)),
    reconcile: vi.fn(async () => {
      observation = {
        identity,
        presence: "present",
        inventoryComplete: true,
        bootstrapStatus: "not_implemented",
        requestedEnvironment: { guestOs: os, architecture: "amd64" },
        vm: base,
      };
      return structuredClone(observation);
    }),
    bootstrapApply: vi.fn(async (request: HyperVGuestBootstrapRequest) => {
      const { clientPublicKey: _, ...fields } = request;
      const receipt = hyperVGuestBootstrapReceiptSchema.parse({
        ...fields,
        status: "applied",
        hostPublicKey: host.publicKey,
        hostKeyFingerprint: host.fingerprint,
        observedAt: new Date().toISOString(),
      });
      observation = {
        ...observation,
        bootstrapStatus: "applied",
        bootstrapReceipt: receipt,
      };
      return structuredClone(observation);
    }),
    stop: vi.fn(async () => {
      if (observation.vm)
        observation = {
          ...observation,
          vm: { ...observation.vm, state: "stopped" },
        };
      return structuredClone(observation);
    }),
    destroy: vi.fn(async () => {
      observation = unknownCleanup
        ? {
            identity,
            presence: "unknown",
            inventoryComplete: false,
            bootstrapStatus: "not_implemented",
          }
        : {
            identity,
            presence: "absent",
            inventoryComplete: true,
            bootstrapStatus: "not_implemented",
          };
      return structuredClone(observation);
    }),
  };
  const binding = {
    runtimeIdentityId: "r",
    connectionRevisionId: "c",
    artifactDigest: plan.artifact.digest,
  };
  const options: HyperVExecutionProviderOptions = {
    resolveRuntime: vi.fn(async () => ({
      ...binding,
      template: {
        configPath: "E:\\Templates\\base.vmcx",
        configSha256: "b".repeat(64),
        guestOs: os,
        architecture: "amd64",
        generation: 2,
      },
      switchName: "Default Switch",
      runtime,
    })),
    resolveCleanupRuntime: vi.fn(async () => ({ ...binding, runtime })),
    accessMaterials: {
      getOrCreate: vi.fn(async () => ({ ...client, secretRef: "fixture" })),
      readExisting: vi.fn(async () => ({ ...client, secretRef: "fixture" })),
    },
    ssh: {
      verify: vi.fn(async () => ({
        authenticated: true,
        username: "workspace",
        hostKeyFingerprint: host.fingerprint,
        clientPublicKeyFingerprint: client.fingerprint,
        guestOs: os,
        architecture: "amd64",
        scratchWritable: true,
      })),
    },
  };
  const { execution, dispatcher } = registerHyperVExecutionProvider(options);
  const recorded: OwnedResource[] = [];
  const journal: ResourceJournal = {
    beforeCreate: vi.fn(async () => undefined),
    assertActive: vi.fn(async () => undefined),
    recordCreated: vi.fn(async (resource) => {
      recorded.push(resource);
    }),
  };
  const cleanup: ProvisionPlan = {
    ...plan,
    executionPhase: "cleanup",
    cleanupAuthorization: {
      createOperationId: "create",
      cleanupOperationId: "cleanup",
      ownerToken: "fixture-owner",
      operationVersion: 7,
    },
  };
  const inventory = (objects: readonly OwnedResource[]): InventoryEvidence => ({
    identity,
    completeness: "complete",
    runtime: { runtimeIdentityId: "r", connectionRevisionId: "c" },
    objects,
  });
  return {
    plan,
    cleanup,
    execution,
    dispatcher,
    options,
    runtime,
    journal,
    recorded,
    inventory,
    setUnknownCleanup() {
      unknownCleanup = true;
    },
    setObservation(o: HyperVInspection) {
      observation = o;
    },
    get observation() {
      return observation;
    },
  };
}
it.each(["windows", "linux"] as const)(
  "uses shared ExecutionPort for %s/amd64 creation, guest evidence, SSH and precise cleanup",
  async (os) => {
    const f = fixture(os);
    const objects = await f.dispatcher.create(f.plan, f.journal);
    expect(f.journal.beforeCreate).toHaveBeenCalledOnce();
    expect(f.recorded).toEqual(objects);
    expect(objects[0]!.details?.nativeName).toBe(
      vi.mocked(f.journal.beforeCreate!).mock.calls[0]![0].name,
    );
    expect(objects[0]!.details?.nativeVmId).toBe(objects[0]!.id);
    expect(objects[0]!.evidence.resourcesHash).toBe(
      createHash("sha256")
        .update(JSON.stringify(f.plan.resources))
        .digest("hex"),
    );
    const ready = await f.dispatcher.ready(f.plan, f.inventory(objects));
    expect(ready).toMatchObject({
      bootstrapComplete: true,
      offlineLeaseEnforcement: "unsupported",
      objectIds: [objects[0]!.id],
      access: { host: "192.0.2.10", username: "workspace" },
    });
    expect(f.runtime.bootstrapApply.mock.calls[0]![0].guestOs).toBe(os);
    expect((f.options.ssh.verify as any).mock.calls[0]![0].guestOs).toBe(os);
    await f.dispatcher.revokeStop(f.cleanup);
    expect((await f.dispatcher.inspect(f.cleanup)).presence).toBe("present");
    const cleanup = await f.dispatcher.destroy(f.cleanup, objects[0]!);
    expect(cleanup).toMatchObject({
      presence: "absent",
      networkRules: "not_applicable",
      resourceId: objects[0]!.id,
    });
    expect((await f.dispatcher.inspect(f.cleanup)).presence).toBe("absent");
  },
);
it("returns no ready receipt before initialization, and does not create a second VM on recovery", async () => {
  const f = fixture();
  const objects = await f.execution.create(f.plan, f.journal);
  f.runtime.bootstrapApply.mockImplementation(async () => f.observation);
  await expect(
    f.execution.ready(f.plan, f.inventory(objects)),
  ).rejects.toThrow();
  await f.execution.create(f.plan, f.journal);
  expect(f.journal.beforeCreate).toHaveBeenCalledOnce();
  expect(f.options.ssh.verify).not.toHaveBeenCalled();
});
it("retains unknown cleanup and does not confuse release intent with absence", async () => {
  const f = fixture();
  const objects = await f.execution.create(f.plan, f.journal);
  f.setUnknownCleanup();
  await expect(f.execution.destroy(f.cleanup, objects[0]!)).rejects.toThrow(
    "absence not confirmed",
  );
  expect((await f.execution.inspect(f.cleanup)).presence).toBe("unknown");
});
it("rejects foreign owner and missing cleanup authorization before native delete", async () => {
  const f = fixture();
  const objects = await f.execution.create(f.plan, f.journal);
  await expect(
    f.execution.destroy(f.cleanup, {
      ...objects[0]!,
      identity: { ...f.plan.identity, allocationId: "foreign" },
    }),
  ).rejects.toThrow("owner mismatch");
  await expect(f.execution.revokeStop(f.plan)).rejects.toThrow(
    "durable operation",
  );
  expect(f.runtime.destroy).not.toHaveBeenCalled();
  expect(f.runtime.stop).not.toHaveBeenCalled();
});
it("cleans existing allocations through the cleanup resolver even if publication is unavailable", async () => {
  const f = fixture();
  const objects = await f.execution.create(f.plan, f.journal);
  (f.options.resolveRuntime as any).mockRejectedValue(
    Error("connection disabled/template expired"),
  );
  await f.execution.revokeStop(f.cleanup);
  expect((await f.execution.destroy(f.cleanup, objects[0]!)).presence).toBe(
    "absent",
  );
  expect(f.options.resolveCleanupRuntime).toHaveBeenCalled();
  await expect(f.execution.create(f.plan, f.journal)).rejects.toThrow(
    "disabled",
  );
});
it("rejects inaccurate guest OS or SSH fingerprint before publishing access", async () => {
  const f = fixture();
  const objects = await f.execution.create(f.plan, f.journal);
  (f.options.ssh.verify as any).mockResolvedValue({
    authenticated: true,
    username: "workspace",
    hostKeyFingerprint: "wrong",
    clientPublicKeyFingerprint: "wrong",
    guestOs: "linux",
    architecture: "amd64",
    scratchWritable: true,
  });
  await expect(f.execution.ready(f.plan, f.inventory(objects))).rejects.toThrow(
    "guest facts mismatch",
  );
});
it("does not claim strong network isolation or platform mounts it cannot deliver", async () => {
  const f = fixture();
  await expect(
    f.execution.create(
      {
        ...f.plan,
        resolved: {
          ...f.plan.resolved,
          network: {
            ...f.plan.resolved.network,
            mode: "isolated_vm",
            verificationRequired: true,
          },
        },
      },
      f.journal,
    ),
  ).rejects.toThrow("existing trusted network");
  expect(f.runtime.reconcile).not.toHaveBeenCalled();
});

it("continues exact owned-file cleanup after native inventory is unknown, without claiming absence early", async () => {
  const f = fixture();
  const objects = await f.execution.create(f.plan, f.journal);
  f.setObservation({
    identity: f.plan.identity,
    presence: "unknown",
    inventoryComplete: true,
    bootstrapStatus: "not_implemented",
    reason: "owned_files_remain",
  });
  expect((await f.execution.destroy(f.cleanup, objects[0]!)).presence).toBe(
    "absent",
  );
  expect(f.runtime.destroy).toHaveBeenCalledOnce();
});
it("refreshes explicit ready integrity over existing SSH material and does not mint keys", async () => {
  const f = fixture();
  const objects = await f.execution.create(f.plan, f.journal);
  await f.execution.ready(f.plan, f.inventory(objects));
  const issued = (f.options.accessMaterials.getOrCreate as any).mock.calls
    .length;
  expect(
    await f.execution.inspect({ ...f.plan, executionPhase: "observe" }),
  ).toMatchObject({
    presence: "present",
    integrity: { state: "healthy" },
    accessEndpointUpdate: { host: "192.0.2.10" },
  });
  expect((f.options.accessMaterials.getOrCreate as any).mock.calls.length).toBe(
    issued,
  );
  (f.options.ssh.verify as any).mockRejectedValue(Error("offline"));
  expect(
    (await f.execution.inspect({ ...f.plan, executionPhase: "observe" }))
      .presence,
  ).toBe("unknown");
});

it("distinguishes an observed stopped VM from an uncertain SSH connection, and keeps observe read-only", async () => {
  const f = fixture();
  await f.execution.create(f.plan, f.journal);
  await f.runtime.stop();
  expect(
    await f.execution.inspect({ ...f.plan, executionPhase: "observe" }),
  ).toMatchObject({
    presence: "present",
    integrity: { state: "lost", reason: "native_vm_not_running" },
  });
  const calls = f.runtime.reconcile.mock.calls.length;
  await expect(
    f.execution.create({ ...f.plan, executionPhase: "observe" }, f.journal),
  ).rejects.toThrow();
  expect(f.runtime.reconcile.mock.calls.length).toBe(calls);
});

it("probes and delivers the relay endpoint, refreshes it after recovery, then closes it on exact cleanup", async () => {
  const f = fixture();
  const resolved = await f.options.resolveRuntime(f.plan);
  vi.mocked(f.options.resolveRuntime).mockResolvedValue({
    ...resolved,
    sshRelay: {
      host: "192.0.2.100",
      username: "maint",
      hostKeyFingerprint: "SHA256:" + "a".repeat(43),
      passwordSecretRef: "secret:fixture",
    },
  });
  const endpoints = {
    ensure: vi.fn(async () => ({ host: "127.0.0.1", port: 41001 })),
    close: vi.fn(async () => undefined),
  };
  const { execution } = registerHyperVExecutionProvider({
    ...f.options,
    endpoints,
  });
  const objects = await execution.create(f.plan, f.journal);
  expect(
    (await execution.ready(f.plan, f.inventory(objects))).access,
  ).toMatchObject({ host: "127.0.0.1", port: 41001 });
  expect(f.options.ssh.verify).toHaveBeenLastCalledWith(
    expect.objectContaining({ host: "127.0.0.1", port: 41001 }),
  );
  expect(endpoints.ensure).toHaveBeenLastCalledWith(
    expect.objectContaining({
      vmId: objects[0]!.id,
      guestHost: "192.0.2.10",
      identity: f.plan.identity,
    }),
  );
  endpoints.ensure.mockResolvedValue({ host: "127.0.0.1", port: 41002 });
  expect(
    await execution.inspect({ ...f.plan, executionPhase: "observe" }),
  ).toMatchObject({
    integrity: { state: "healthy" },
    accessEndpointUpdate: { host: "127.0.0.1", port: 41002 },
  });
  await expect(execution.revokeStop(f.plan)).rejects.toThrow(
    "durable operation",
  );
  expect(endpoints.close).not.toHaveBeenCalled();
  await execution.revokeStop(f.cleanup);
  await execution.destroy(f.cleanup, objects[0]!);
  expect(endpoints.close).toHaveBeenCalledWith(f.cleanup.identity);
});
it("does not publish access when the configured remote relay is unavailable", async () => {
  const f = fixture();
  const resolved = await f.options.resolveRuntime(f.plan);
  vi.mocked(f.options.resolveRuntime).mockResolvedValue({
    ...resolved,
    sshRelay: {
      host: "192.0.2.100",
      username: "maint",
      hostKeyFingerprint: "SHA256:" + "a".repeat(43),
      passwordSecretRef: "secret:fixture",
    },
  });
  const objects = await f.execution.create(f.plan, f.journal);
  await expect(f.execution.ready(f.plan, f.inventory(objects))).rejects.toThrow(
    "relay transport is not configured",
  );
  expect(f.options.ssh.verify).not.toHaveBeenCalled();
});
