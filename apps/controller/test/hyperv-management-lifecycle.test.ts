import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import ssh2 from "ssh2";
import { openStorage } from "../dist/storage/index.js";
import { AccessService } from "../src/application/access.js";
import { TicketQueries } from "../src/application/queries.js";
import { AdminService } from "../src/application/admin.js";
import { LocalSecretStore } from "../src/storage/secret-store.js";
import { createHyperVExecutionComposition } from "../src/providers/hyperv-runtime-composition.js";
import type {
  HyperVInspection,
  HyperVRuntimeFacts,
  HyperVGuestBootstrapRequest,
  VmAllocationIdentity,
} from "@hitchlet/contracts/internal";
import {
  ProviderConnectionViewSchema,
  HyperVCapabilityAttestationSchema,
} from "@hitchlet/contracts/admin";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
it("normal Hyper-V discovery → disabled registration → qualification → validation/cleanup → publication (synthetic Runtime only)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-hyperv-management-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = await openStorage(dir);
  cleanup.push(() => db.close());
  let clock = Date.now();
  const now = () => clock;
  const adminId = randomUUID(),
    installationId = randomUUID(),
    namespace = randomUUID(),
    runtimeId = randomUUID(),
    denyId = randomUUID();
  const authorization = {
    imageIds: "all",
    nodeIds: "all",
    networkProfileIds: "all",
    storageProfileIds: "all",
  };
  await db.run(
    "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms)VALUES(?,'synthetic','human','admin',?,'{}',?,?)",
    [adminId, JSON.stringify(authorization), clock, clock],
  );
  await db.run(
    "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms)VALUES(1,?,1,?)",
    [installationId, clock],
  );
  await db.run(
    "INSERT INTO platform_network_deny_revisions(id,revision,management_deny_rules_json,reason,created_by_consumer_id,created_at_ms)VALUES(?,1,'[]','synthetic',?,?)",
    [denyId, adminId, clock],
  );
  const keyFile = join(dir, "key");
  await writeFile(keyFile, Buffer.alloc(32, 18), { mode: 0o600 });
  const secrets = await LocalSecretStore.open(dir, keyFile);
  const secretRef = await secrets.put("synthetic-runtime-reference");
  const template = {
    configPath: "E:\\Templates\\windows\\Virtual Machines\\base.vmcx",
    configSha256: "b".repeat(64),
    guestOs: "windows" as const,
    architecture: "amd64" as const,
    generation: 2 as const,
  };
  const facts: HyperVRuntimeFacts = {
    nativeRuntimeNamespaceId: namespace,
    available: true,
    hostOS: "windows",
    hostArchitecture: "AMD64",
    hostCpuCount: 8,
    hostMemoryBytes: 16 * 1024 ** 3,
    hyperVVersion: "fixture-1",
    implementedOperations: [
      "inspect",
      "import",
      "configure",
      "start",
      "stop",
      "remove",
    ],
    templates: [
      {
        name: "windows-base",
        template,
        artifactDigest: "sha256:" + "c".repeat(64),
        proofKind: "sealed_export_bundle_v1",
        sealedAt: new Date(clock).toISOString(),
      },
    ],
  };
  const probe = vi.fn(async () => {
    throw Error("Hyper-V must never use Docker probe");
  });
  const admin = new AdminService(
    db,
    probe,
    now,
    false,
    (ref) => secrets.get(ref),
    undefined,
    "hyperv",
    async () => structuredClone(facts),
  );
  const profile = {
    switchName: "Default Switch",
    runtimeAgent: {
      id: runtimeId,
      baseUrl: "https://synthetic.invalid",
      tokenSecretRef: secretRef,
      caSecretRef: secretRef,
      clientCertSecretRef: secretRef,
      clientKeySecretRef: secretRef,
    },
    managementDenyRevisionId: denyId,
    managementDenyRules: [],
  };
  const discovered = await admin.discoverHyperV({
    backendKind: "hyperv",
    runtimeIdentityId: runtimeId,
    runtimeProfile: profile,
  });
  expect(discovered.state).toBe("succeeded");
  const connectionId = String(
    (discovered.result as Record<string, unknown>).connectionId,
  );
  expect(
    ProviderConnectionViewSchema.array().parse(
      await admin.listConnections(),
    )[0],
  ).toMatchObject({
    backendKind: "hyperv",
    evidence: { nativeRuntimeNamespaceId: namespace },
  });
  const duplicate = await admin.discoverHyperV({
    backendKind: "hyperv",
    runtimeIdentityId: randomUUID(),
    runtimeProfile: profile,
  });
  expect(duplicate.result).toMatchObject({
    duplicateRuntime: true,
    connectionId,
  });
  const machine = await admin.createMachine({
    name: "synthetic Hyper-V host",
    hostOs: "windows",
    architecture: "amd64",
    capacity: { cpuMillis: 4000, memoryMiB: 8192, scratchMiB: 0 },
    operatorId: adminId,
  });
  const node = await admin.registerNode({
    name: "synthetic Hyper-V node",
    machineId: machine.id,
    connectionId,
    operatorId: adminId,
  });
  expect(node.admission).toBe("disabled");
  const configured = await admin.configureHyperVNodeRuntime({
    nodeId: node.id,
    expectedVersion: 1,
    config: profile,
    operatorId: adminId,
    requestId: randomUUID(),
  });
  expect(configured.version).toBe(2);
  const network = await admin.createProfile("network", {
    name: "synthetic trusted NAT",
    config: {
      allowedEgress: [],
      allowedIngressSourceCidrs: [],
      ipv6: "disabled",
    },
    authorizedConsumerIds: [adminId],
  });
  const scope = {
    status: "passed" as const,
    summary: "SYNTHETIC ONLY: not hardware qualification",
    evidenceRef: "synthetic-only",
  };
  const attestation = {
    backendKind: "hyperv" as const,
    expectedNamespaceId: namespace,
    expectedHyperVVersion: "fixture-1",
    templateRef: "windows-base",
    templateDigest: facts.templates[0]!.artifactDigest,
    guestOs: "windows" as const,
    architecture: "amd64" as const,
    checkedAt: new Date(clock).toISOString(),
    report: {
      runId: randomUUID(),
      sha256: "e".repeat(64),
      scopes: {
        resourceLimits: scope,
        sshBootstrap: scope,
        cleanupRecovery: scope,
      },
    },
    networkProfileRevisionIds: [],
    storageProfileRevisionIds: [],
  };
  expect(HyperVCapabilityAttestationSchema.safeParse(attestation).success).toBe(
    true,
  );
  await expect(
    admin.attestHyperVNodeCapabilities({
      ...attestation,
      nodeId: node.id,
      expectedVersion: configured.version,
      expectedNamespaceId: randomUUID(),
      operatorId: adminId,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow("qualification");
  const qualified = await admin.attestHyperVNodeCapabilities({
    ...attestation,
    nodeId: node.id,
    expectedVersion: configured.version,
    operatorId: adminId,
    requestId: randomUUID(),
  });
  expect(qualified.admission).toBe("enabled");
  clock += 46000;
  expect(await admin.refreshHyperVObservations()).toMatchObject({
    checked: 1,
    refreshed: 1,
  });
  const proof = facts.templates[0]!;
  facts.templates = [];
  clock += 46000;
  expect(await admin.refreshHyperVObservations()).toMatchObject({
    checked: 1,
    unhealthy: 1,
  });
  facts.templates = [proof];
  clock += 46000;
  expect(await admin.refreshHyperVObservations()).toMatchObject({
    refreshed: 1,
  });
  const draft = await admin.createDraft({
    name: "Synthetic Windows VM",
    version: "v1",
    backendKind: "hyperv",
    kind: "vm",
    architecture: "amd64",
    guestOs: "windows",
    artifactRef: "windows-base",
    digest: proof.artifactDigest,
    minimumResources: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
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
    authorizedConsumerIds: [adminId],
  });
  const resources = {
    request: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
    limit: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
    isolation: "virtual_machine" as const,
    scratchEnforcement: "best_effort" as const,
    accelerators: [],
  };
  const validation = await admin.scheduleValidation({
    versionId: draft.versionId,
    imageArtifactId: draft.artifactId,
    nodeId: node.id,
    networkProfileId: network.id,
    storage: [],
    resources,
    deadlineSeconds: 300,
    requestedBy: adminId,
  });
  expect(validation.scheduler).toBe("queued");
  const host = ssh2.utils.generateKeyPairSync("ed25519");
  const parsed = ssh2.utils.parseKey(host.private);
  if (parsed instanceof Error) throw parsed;
  const fingerprint =
    "SHA256:" +
    createHash("sha256")
      .update(parsed.getPublicSSH())
      .digest("base64")
      .replace(/=+$/, "");
  const states = new Map<string, HyperVInspection>();
  let creates = 0;
  const runtime = {
    inspect: async (identity: VmAllocationIdentity) =>
      structuredClone({
        ...states.get(identity.allocationId),
        identity,
        ...(states.has(identity.allocationId)
          ? {}
          : {
              presence: "absent" as const,
              inventoryComplete: true,
              bootstrapStatus: "not_implemented" as const,
            }),
      }),
    reconcile: async (request: any) => {
      creates++;
      const v: HyperVInspection = {
        identity: request.identity,
        presence: "present",
        inventoryComplete: true,
        bootstrapStatus: "not_implemented",
        requestedEnvironment: { guestOs: "windows", architecture: "amd64" },
        vm: {
          id: randomUUID(),
          owner: "synthetic",
          directory: "E:\\Hitchlet\\allocation",
          configurationPath: "E:\\Hitchlet\\allocation\\base.vmcx",
          diskPaths: ["E:\\Hitchlet\\allocation\\disk.vhdx"],
          cpus: 2,
          memoryMiB: 2048,
          dynamicMemory: false,
          generation: 2,
          state: "running",
          switchNames: ["Default Switch"],
          dynamicMac: true,
          ipv4: ["192.0.2.7"],
        },
      };
      states.set(request.identity.allocationId, v);
      return structuredClone(v);
    },
    bootstrapApply: async (request: HyperVGuestBootstrapRequest) => {
      const v = states.get(request.identity.allocationId)!;
      const { clientPublicKey: _, ...fields } = request;
      v.bootstrapStatus = "applied";
      v.bootstrapReceipt = {
        ...fields,
        status: "applied",
        hostPublicKey: host.public,
        hostKeyFingerprint: fingerprint,
        observedAt: new Date(clock).toISOString(),
      };
      return structuredClone(v);
    },
    stop: async (identity: VmAllocationIdentity) => {
      const v = states.get(identity.allocationId);
      if (v?.vm) v.vm.state = "stopped";
      return runtime.inspect(identity);
    },
    destroy: async (identity: VmAllocationIdentity) => {
      states.delete(identity.allocationId);
      return runtime.inspect(identity);
    },
  };
  const composition = createHyperVExecutionComposition({
    storage: db,
    secrets,
    installationId,
    controllerEpoch: 1,
    now,
    resolveRuntime: async (plan) => ({
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      connectionRevisionId: plan.identity.connectionRevisionId,
      artifactDigest: plan.artifact.digest,
      template,
      switchName: "Default Switch",
      runtime,
    }),
    resolveCleanupRuntime: async (plan) => ({
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      connectionRevisionId: plan.identity.connectionRevisionId,
      artifactDigest: plan.artifact.digest,
      runtime,
    }),
    ssh: {
      verify: async (i) => ({
        authenticated: true,
        username: i.username,
        hostKeyFingerprint: i.hostKeyFingerprint,
        clientPublicKeyFingerprint: i.clientPublicKeyFingerprint,
        guestOs: i.guestOs,
        architecture: i.architecture,
        scratchWritable: true,
      }),
    },
  });
  expect(await composition.worker.run(validation.operationId!)).toBe(true);
  const provision = await db.get<{ state: string; result_json: string }>(
    "SELECT state,result_json FROM operations WHERE id=?",
    [validation.operationId],
  );
  expect(provision?.state, JSON.stringify(provision)).toBe("succeeded");
  const cleanupOp = await db.get<{ id: string }>(
    "SELECT id FROM operations WHERE kind='allocation.cleanup' AND allocation_id=?",
    [validation.allocationId],
  );
  expect(cleanupOp).toBeTruthy();
  expect(await composition.worker.run(cleanupOp!.id)).toBe(true);
  expect(await admin.getValidation(validation.validationId)).toMatchObject({
    testOutcome: "passed",
    cleanupStatus: "complete",
  });
  const version = await admin.getDraftVersion(draft.versionId);
  facts.templates = [];
  await expect(
    admin.publishVersion(draft.versionId, version.version.entityVersion),
  ).rejects.toMatchObject({ code: "conflict" });
  facts.templates = [proof];
  expect(
    await admin.publishVersion(draft.versionId, version.version.entityVersion),
  ).toMatchObject({ status: "published" });
  // The tenant describes the environment, never a host/backend/node.
  const request = {
    image: { versionId: draft.versionId },
    kind: "vm",
    guestOs: "windows",
    allowedArchitectures: ["amd64"],
    resources: {
      cpuMillis: 2000,
      memoryMiB: 2048,
      scratchMiB: 0,
      isolation: "virtual_machine",
    },
    networkProfileId: network.id,
    lease: { requestedSeconds: 900 },
  };
  await db.run(
    "INSERT INTO policies(id,name,kind,config_json,created_at_ms,updated_at_ms) VALUES(?,'destroy','lifecycle','{}',?,?)",
    [randomUUID(), clock, clock],
  );
  await db.run("UPDATE consumers SET quota_json=? WHERE id=?", [
    JSON.stringify({
      maxQueuedTickets: 10,
      maxActiveTickets: 2,
      maxLeaseTtlSeconds: 1800,
      maxLifetimeSeconds: 86400,
      maxResources: { cpuMillis: 4000, memoryMiB: 8192, scratchMiB: 1024 },
    }),
    adminId,
  ]);
  const ticket = await composition.tickets.acquire(
    adminId,
    "hyperv-tenant",
    request,
  );
  expect(
    await composition.tickets.acquire(adminId, "hyperv-tenant", request),
  ).toMatchObject({ ticketId: ticket.ticketId, replayed: true });
  const allocation = await composition.tickets.reserveNext();
  expect(allocation).toMatchObject({
    ticketId: ticket.ticketId,
    nodeId: node.id,
  });
  const operation = await db.get<{ id: string }>(
    "SELECT id FROM operations WHERE allocation_id=? AND kind='allocation.provision'",
    [allocation!.allocationId],
  );
  expect(await composition.worker.run(operation!.id)).toBe(true);
  const queries = new TicketQueries(db, now);
  const ready = await queries.get(adminId, ticket.ticketId);
  expect(ready).toMatchObject({
    phase: "ready",
    networkMode: "trusted_nat",
    placement: {
      provider: "hyperv",
      architecture: "amd64",
      guestOs: "windows",
    },
  });
  const claim = await composition.leases.renew(
    adminId,
    ticket.ticketId,
    "claim",
    {
      generation: 1,
      expectedLeaseVersion: ready!.lease!.version,
      maximumTtlSeconds: 900,
    },
  );
  expect(claim.outcome).toBe("pending");
  if (claim.outcome !== "pending") throw Error("claim not pending");
  expect(await composition.leases.reconcilePending()).toBe(1);
  expect(
    (await composition.leases.get(adminId, ticket.ticketId, claim.renewal.id))
      ?.state,
  ).toBe("confirmed");
  const access = await new AccessService(db, now, secrets).get(
    adminId,
    ticket.ticketId,
    "access",
    1,
  );
  expect(access.access).toMatchObject({
    host: "192.0.2.7",
    hostKeyFingerprint: fingerprint,
  });
  expect(access.authentication.kind).toBe("ephemeral_private_key");
  const claimed = await queries.get(adminId, ticket.ticketId);
  clock += 1000;
  const renewal = await composition.leases.renew(
    adminId,
    ticket.ticketId,
    "renew",
    {
      generation: 1,
      expectedLeaseVersion: claimed!.lease!.version,
      maximumTtlSeconds: 900,
    },
  );
  expect(renewal.outcome).toBe("pending");
  if (renewal.outcome !== "pending") throw Error("renewal not pending");
  expect(await composition.leases.reconcilePending()).toBe(1);
  expect(
    (await composition.leases.get(adminId, ticket.ticketId, renewal.renewal.id))
      ?.state,
  ).toBe("confirmed");
  await composition.tickets.cancel(ticket.ticketId, adminId);
  const termination = await db.get<{ id: string }>(
    "SELECT id FROM operations WHERE allocation_id=? AND kind='allocation.cleanup'",
    [allocation!.allocationId],
  );
  expect(await composition.worker.run(termination!.id)).toBe(true);
  expect(await queries.get(adminId, ticket.ticketId)).toMatchObject({
    phase: "released",
    cleanupStatus: "complete",
  });
  expect(creates).toBe(2);
  expect(states.size).toBe(0);
  expect(
    await db.get(
      "SELECT count(*) as n FROM capacity_claims WHERE state!='released'",
    ),
  ).toEqual({ n: 0n });
  expect(probe).not.toHaveBeenCalled();
});
