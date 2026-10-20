import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../dist/storage/index.js";
import { LocalSecretStore } from "../src/storage/secret-store.js";
import { AdminService } from "../src/application/admin.js";
import {
  OperationWorker,
  AllocationCreateCalls,
} from "../src/application/operations.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { PersistentSimulator } from "../src/providers/simulator.js";
import type {
  ExecutionPort,
  ReadyReceipt,
  OwnedResource,
  ProvisionPlan,
} from "../src/providers/port.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
type ProcessMessage = {
  phase: string;
  snapshot?: {
    op: Record<string, string | number | bigint | null>;
    token: string;
    receipt: ReadyReceipt;
    objects: readonly OwnedResource[];
  };
  report?: {
    state: string;
    testOutcome: string;
    cleanupStatus: string;
    checks: Record<string, unknown>;
  };
  claim?: { state: string };
  cleanup?: { result_json: string };
  createCount?: number;
  sendCount?: number;
  effectPlan?: ProvisionPlan;
  effectResultJson?: string;
  claimed?: boolean;
  lateReadyCode?: string;
};
async function controllerProcess(
  input: Record<string, unknown>,
  expectedPhase: string,
) {
  const spec = join(String(input.dir), `process-${randomUUID()}.json`);
  await writeFile(
    spec,
    JSON.stringify(input, (_key, value) =>
      typeof value === "bigint" ? Number(value) : value,
    ),
  );
  const child = fork(
    fileURLToPath(
      new URL("./fixtures/validation-process.mjs", import.meta.url),
    ),
    [spec],
    {
      execPath: process.execPath,
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  const message = await new Promise<ProcessMessage>((resolve, reject) => {
    child.on("message", (value: ProcessMessage & { message?: string }) => {
      if (value.phase === expectedPhase) resolve(value);
      else if (value.phase === "error") reject(new Error(value.message));
    });
    child.once("error", reject);
    void exited.then(([code, signal]) =>
      reject(
        new Error(
          `Controller exited before ${expectedPhase}: ${String(code ?? signal)} ${stderr}`,
        ),
      ),
    );
  });
  return {
    message,
    kill: async () => {
      child.kill("SIGKILL");
      await exited;
    },
    exited,
  };
}

async function fixture(options: { blocked?: boolean; capacity?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-validation-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = await openStorage(dir);
  cleanup.push(() => db.close().catch(() => undefined));
  let time = Date.now();
  const now = () => time;
  const adminId = randomUUID(),
    installationId = randomUUID(),
    denyId = randomUUID();
  await db.batchTransaction([
    {
      kind: "run",
      sql: "INSERT INTO consumers(id,name,kind,role,authorization_json,quota_json,created_at_ms,updated_at_ms) VALUES(?,'validation test','human','admin',?, '{}',?,?)",
      params: [
        adminId,
        JSON.stringify({
          imageIds: "all",
          nodeIds: "all",
          networkProfileIds: "all",
          storageProfileIds: "all",
        }),
        time,
        time,
      ],
    },
    {
      kind: "run",
      sql: "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
      params: [installationId, time],
    },
    {
      kind: "run",
      sql: "INSERT INTO platform_network_deny_revisions(id,revision,management_deny_rules_json,reason,created_by_consumer_id,created_at_ms) VALUES(?,1,'[]','test baseline',?,?)",
      params: [denyId, adminId, time],
    },
  ]);
  const providerEvidence = {
    engineId: "validation-engine",
    dockerVersion: "29.5.2",
    apiVersion: "1.54",
    minimumApiVersion: "1.40",
    os: "linux",
    architecture: "amd64",
    portainerVersion: "2.45.2",
    cpuCount: 8,
    memoryBytes: 8 * 1024 ** 3,
    containerCount: 0,
    unmanagedContainerCount: 0,
  };
  const admin = new AdminService(
    db,
    async () => providerEvidence,
    now,
    false,
    async () => "test secret",
  );
  const discovered = await admin.discover({
    endpointUrl: "https://portainer.test",
    environmentId: "1",
    secretVersionRef: `secret:${"a".repeat(32)}`,
    apiKey: "test",
  });
  const connectionId = String(
    (discovered.result as Record<string, unknown>).connectionId,
  );
  const machine = await admin.createMachine({
    name: "fixture",
    hostOs: "linux",
    architecture: "amd64",
    capacity: {
      cpuMillis: options.capacity ?? 4000,
      memoryMiB: 4000,
      scratchMiB: 4000,
    },
    operatorId: adminId,
  });
  const node = await admin.registerNode({
    name: "fixture",
    machineId: machine.id,
    connectionId,
    operatorId: adminId,
  });
  const network = await admin.createProfile("network", {
    name: "test network",
    config: {
      allowedEgress: [],
      allowedIngressSourceCidrs: ["10.0.0.0/8"],
      ipv6: "disabled",
    },
    authorizedConsumerIds: [adminId],
  });
  const config = {
    accessHost: "10.0.0.2",
    networkCidrBase: "172.30.0.0/16",
    userlandProxy: false,
    runtimeAgent: {
      id: randomUUID(),
      baseUrl: "https://agent.test",
      tokenSecretRef: `secret:${"b".repeat(32)}`,
      caSecretRef: `secret:${"c".repeat(32)}`,
      clientCertSecretRef: `secret:${"d".repeat(32)}`,
      clientKeySecretRef: `secret:${"e".repeat(32)}`,
    },
    managementDenyRevisionId: denyId,
    managementDenyRules: [],
  };
  const configured = await admin.configureNodeRuntime({
    nodeId: node.id,
    expectedVersion: 1,
    config,
    operatorId: adminId,
    requestId: randomUUID(),
  });
  await db.run(
    "UPDATE system_maintenance SET runtime_disks_json=? WHERE singleton=1",
    [
      JSON.stringify({
        [node.id]: {
          nodeId: node.id,
          state: "healthy",
          availableMiB: 100000,
          reserveMiB: 128,
          observedAtMs: time,
        },
      }),
    ],
  );
  const attest = () =>
    admin.attestNodeCapabilities({
      nodeId: node.id,
      expectedVersion: configured.version,
      engineId: "validation-engine",
      dockerVersion: "29.5.2",
      portainerVersion: "2.45.2",
      architecture: "amd64",
      checkedAt: new Date(time).toISOString(),
      report: {
        runId: randomUUID(),
        sha256: "a".repeat(64),
        scopes: Object.fromEntries(
          [
            "resourceLimits",
            "firewallInput",
            "firewallForward",
            "ipv6",
            "sshBootstrap",
            "cleanupRecovery",
          ].map((k) => [
            k,
            {
              status: "passed" as const,
              summary: "unit fixture only",
              evidenceRef: "test fixture",
            },
          ]),
        ),
      },
      networkProfileRevisionIds: [network.revisionId],
      operatorId: adminId,
      requestId: randomUUID(),
    });
  if (!options.blocked) await attest();
  const draft = await admin.createDraft({
    name: "test image",
    version: "1",
    architecture: "amd64",
    artifactRef: `docker.io/example/node@sha256:${"1".repeat(64)}`,
    digest: `sha256:${"1".repeat(64)}`,
    minimumResources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
    bootstrap: {
      mechanism: "hitchlet-node-ssh-v1",
      contractVersion: "1",
      identityReset: true,
    },
    access: {
      accessProtocols: ["ssh"],
      ports: [22],
      account: "workspace",
      allowedSourceCidrs: ["10.0.0.0/8"],
      discovery: "portainer-published-port",
      readiness: "ssh-public-key-authenticated-fingerprint",
    },
    authorizedConsumerIds: [adminId],
  });
  const request = {
    versionId: draft.versionId,
    imageArtifactId: draft.artifactId,
    nodeId: node.id,
    networkProfileId: network.id,
    storage: [],
    resources: {
      request: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 0 },
      limit: { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 0 },
      scratchEnforcement: "best_effort" as const,
      isolation: "shared_kernel" as const,
      accelerators: [],
    },
    deadlineSeconds: 1800,
    requestedBy: adminId,
  };
  const simulator = new PersistentSimulator(join(dir, "external"));
  // These workers are explicitly part of the same live controller instance.
  const createCalls = new AllocationCreateCalls();
  const worker = (execution: ExecutionPort = simulator, epoch = 1) =>
    new OperationWorker({
      createCalls,
      storage: db,
      execution,
      installationId,
      controllerEpoch: epoch,
      now,
    });
  const version = async () =>
    Number(
      (await db.get<{ entity_version: bigint }>(
        "SELECT entity_version FROM image_versions WHERE id=?",
        [draft.versionId],
      ))!.entity_version,
    );
  const claim = async () =>
    db.get<{ state: string }>(
      "SELECT state FROM capacity_claims ORDER BY created_at_ms LIMIT 1",
    );
  const cleanupId = async () =>
    String(
      (await db.get<{ id: string }>(
        "SELECT id FROM operations WHERE kind='allocation.cleanup' ORDER BY created_at_ms LIMIT 1",
      ))!.id,
    );
  return {
    dir,
    db,
    now,
    advance: (ms: number) => {
      time += ms;
    },
    admin,
    request,
    draft,
    node,
    network,
    machine,
    attest,
    worker,
    simulator,
    version,
    claim,
    cleanupId,
    installationId,
    config,
    providerEvidence,
  };
}

describe("shared durable validation lifecycle (simulated execution; no hardware claim)", () => {
  it("applies the same attended Machine ceiling to internal validations and never releases previous claims on policy reduction", async () => {
    const f = await fixture();
    const first = await f.admin.scheduleValidation(f.request);
    expect(first.scheduler).toBe("queued");
    const machine = (await f.admin.machineDependencies())[0]!;
    const policy = {
      ...machine.humanUsePolicy!,
      attendedMaximum: { cpuMillis: 100, memoryMiB: 100, scratchMiB: 0 },
    };
    await f.admin.updateHumanUsePolicy({
      machineId: f.machine.id,
      expectedVersion: machine.version,
      policy,
      operatorId: f.request.requestedBy,
      requestId: randomUUID(),
    });
    const second = await f.admin.scheduleValidation(f.request);
    expect(second.scheduler).toBe("blocked");
    expect(
      Number(
        (await f.db.get<{ n: bigint }>(
          "SELECT count(*) n FROM capacity_claims WHERE state<>'released'",
        ))!.n,
      ),
    ).toBe(1);
    expect(await f.claim()).toMatchObject({ state: "reserved" });
  });
  it("rolls a validation reservation back when policy changes after its human-use read but before the transaction", async () => {
    const f = await fixture(),
      machine = (await f.admin.machineDependencies())[0]!;
    const original = f.db.batchTransaction.bind(f.db);
    let changed = false;
    vi.spyOn(f.db, "batchTransaction").mockImplementation(
      async (statements) => {
        if (
          !changed &&
          statements.some((s) => s.sql.startsWith("INSERT INTO allocations"))
        ) {
          changed = true;
          await f.admin.updateHumanUsePolicy({
            machineId: f.machine.id,
            expectedVersion: machine.version,
            policy: {
              ...machine.humanUsePolicy!,
              attendedMaximum: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
            },
            operatorId: f.request.requestedBy,
            requestId: randomUUID(),
          });
        }
        return original(statements);
      },
    );
    const run = await f.admin.scheduleValidation(f.request);
    expect(changed).toBe(true);
    expect(run.scheduler).toBe("blocked");
    expect(
      await f.db.get("SELECT id FROM allocations WHERE image_validation_id=?", [
        run.validationId,
      ]),
    ).toBeUndefined();
    expect(await f.claim()).toBeUndefined();
  });
  it("renews the bounded worker lease through slow readiness without extending the frozen deadline", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation(f.request);
    const deadline = await f.db.get(
      "SELECT deadline_ms FROM operations WHERE id=?",
      [run.operationId],
    );
    const realReady = f.simulator.ready.bind(f.simulator);
    f.simulator.ready = async (...args) => {
      for (let i = 0; i < 4; i++) {
        f.advance(10_000);
        await f.db.run("UPDATE system_maintenance SET runtime_disks_json=?", [
          JSON.stringify({
            [f.node.id]: {
              nodeId: f.node.id,
              state: "healthy",
              availableMiB: 100000,
              reserveMiB: 128,
              observedAtMs: f.now(),
            },
          }),
        ]);
        await vi.advanceTimersByTimeAsync(10_000);
        const lock = await f.db.get<{ locked_until_ms: bigint }>(
          "SELECT locked_until_ms FROM operations WHERE id=?",
          [run.operationId],
        );
        expect(Number(lock!.locked_until_ms)).toBeGreaterThan(f.now());
      }
      return realReady(...args);
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await f.worker().run(run.operationId);
    } finally {
      vi.useRealTimers();
    }
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      state: "releasing",
    });
    expect(
      await f.db.get("SELECT deadline_ms FROM operations WHERE id=?", [
        run.operationId,
      ]),
    ).toEqual(deadline);
  });

  it.each(["cancel", "deadline", "epoch"] as const)(
    "refuses late readiness after %s even while renewing the worker lease",
    async (reason) => {
      const f = await fixture();
      const run = await f.admin.scheduleValidation(f.request);
      const realReady = f.simulator.ready.bind(f.simulator);
      f.simulator.ready = async (...args) => {
        const receipt = await realReady(...args);
        if (reason === "cancel")
          await f.admin.cancelValidation(run.validationId);
        else if (reason === "deadline") f.advance(1_800_001);
        else
          await f.db.run(
            "UPDATE installations SET controller_epoch=controller_epoch+1",
          );
        return receipt;
      };
      // An epoch change rejects the old owner's defer as well; no ready transaction can commit.
      if (reason === "epoch")
        await expect(f.worker().run(run.operationId)).rejects.toMatchObject({
          code: "STORAGE_CAS_FAILED",
        });
      else await f.worker().run(run.operationId);
      expect((await f.admin.getValidation(run.validationId)).state).not.toBe(
        "succeeded",
      );
      expect(
        await f.db.get(
          "SELECT state FROM capacity_claims WHERE allocation_id=?",
          [run.allocationId],
        ),
      ).toEqual({ state: "reserved" });
      expect(
        await f.db.get("SELECT state FROM operations WHERE id=?", [
          run.operationId,
        ]),
      ).not.toEqual({ state: "succeeded" });
    },
  );

  it("stores immutable tested evidence before cleanup, retains capacity on deletion failure, resumes after epoch restart, then publishes and moves an alias", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation(f.request);
    expect(run.scheduler).toBe("queued");
    await expect(
      f.db.run("UPDATE operations SET intent_json='{}' WHERE id=?", [
        run.operationId!,
      ]),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    expect(await f.db.get("SELECT count(*) AS n FROM tickets")).toEqual({
      n: 0n,
    });
    expect(await f.db.get("SELECT count(*) AS n FROM leases")).toEqual({
      n: 0n,
    });
    await f.worker().run(run.operationId!);
    const tested = await f.admin.getValidation(run.validationId);
    expect(tested).toMatchObject({
      state: "releasing",
      testOutcome: "pending",
      cleanupStatus: "running",
      finishedAtMs: null,
    });
    expect(tested!.checks.testedEvidence).toMatchObject({
      source: "provider_execution",
    });
    await expect(
      f.db.run(
        "UPDATE image_validations SET checks_json=json_set(checks_json,'$.testedEvidence',json('{}')) WHERE id=?",
        [run.validationId],
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    await expect(
      f.admin.publishVersion(f.draft.versionId, await f.version()),
    ).rejects.toMatchObject({ code: "conflict" });
    await f
      .worker(
        new PersistentSimulator(join(f.dir, "external"), "delete_failure"),
      )
      .run(await f.cleanupId());
    expect(await f.claim()).toEqual({ state: "committed" });
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      state: "releasing",
      cleanupStatus: "blocked",
    });
    await f.db.run(
      "UPDATE installations SET controller_epoch=2 WHERE singleton=1",
    );
    f.advance(5_000);
    expect(await f.worker(f.simulator, 1).reconcile()).toBe(0);
    await f.worker(f.simulator, 2).reconcileBeforeScheduling();
    expect(await f.claim()).toEqual({ state: "released" });
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      state: "succeeded",
      testOutcome: "passed",
      cleanupStatus: "complete",
    });
    await f.db.run("UPDATE nodes SET admission='disabled' WHERE id=?", [
      f.node.id,
    ]);
    await expect(
      f.admin.publishVersion(f.draft.versionId, await f.version()),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.db.run("UPDATE nodes SET admission='enabled' WHERE id=?", [
      f.node.id,
    ]);
    const published = await f.admin.publishVersion(
      f.draft.versionId,
      await f.version(),
    );
    expect(published.status).toBe("published");
    const alias = await f.admin.moveImageAlias(
      f.draft.imageId,
      "stable",
      f.draft.versionId,
      0,
    );
    expect(alias.version).toBe(1);
    await expect(
      f.admin.moveImageAlias(f.draft.imageId, "stable", f.draft.versionId, 0),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    await expect(
      f.db.run(
        "UPDATE image_validations SET test_outcome='failed' WHERE id=?",
        [run.validationId],
      ),
    ).rejects.toMatchObject({ code: "STORAGE_CONSTRAINT" });
    const count = await f.db.get(
      "SELECT count(*) n FROM capacity_claims WHERE state='released'",
    );
    await f.worker(f.simulator, 2).reconcileBeforeScheduling();
    expect(
      await f.db.get(
        "SELECT count(*) n FROM capacity_claims WHERE state='released'",
      ),
    ).toEqual(count);
  });

  it.each([
    "create_receipt_lost",
    "create_response_lost",
    "create_after_first_object",
  ] as const)(
    "recovers %s using the same frozen plan and operation",
    async (fault) => {
      const f = await fixture();
      const run = await f.admin.scheduleValidation(f.request);
      await f
        .worker(new PersistentSimulator(join(f.dir, "external"), fault))
        .run(run.operationId!);
      f.advance(5_000);
      await f.worker().reconcileBeforeScheduling();
      expect(await f.admin.getValidation(run.validationId)).toMatchObject({
        state: "releasing",
        testOutcome: "pending",
      });
      await f.worker().reconcileBeforeScheduling();
      expect(await f.admin.getValidation(run.validationId)).toMatchObject({
        state: "succeeded",
        cleanupStatus: "complete",
      });
      expect(
        await f.db.get(
          "SELECT count(*) n FROM operations WHERE kind='allocation.provision'",
        ),
      ).toEqual({ n: 1n });
    },
  );

  it("retries a blocked run under its original profile and deadline and records expiry without any Ticket", async () => {
    const f = await fixture({ blocked: true });
    const run = await f.admin.scheduleValidation(f.request);
    expect(run.scheduler).toBe("blocked");
    const before = await f.admin.getValidation(run.validationId);
    await f.attest();
    await f.admin.newProfileRevision("network", f.network.id, 1, {
      config: {
        allowedEgress: [],
        allowedIngressSourceCidrs: ["192.0.2.0/24"],
        ipv6: "disabled",
      },
    });
    await f.worker().reconcileBeforeScheduling();
    const after = await f.admin.getValidation(run.validationId);
    expect(after!.acceptedContract).toEqual(before!.acceptedContract);
    expect(after!.deadlineMs).toBe(before!.deadlineMs);
    expect(after).toMatchObject({ state: "releasing", testOutcome: "pending" });
    await f.worker().reconcileBeforeScheduling();
    await expect(
      f.admin.publishVersion(f.draft.versionId, await f.version()),
    ).rejects.toMatchObject({ code: "conflict" });
    const blocked = await f.admin.scheduleValidation({
      ...f.request,
      deadlineSeconds: 1,
    });
    f.advance(1_000);
    await f.worker().reconcileBeforeScheduling();
    expect(await f.admin.getValidation(blocked.validationId)).toMatchObject({
      state: "failed",
      cleanupStatus: "complete",
    });
  });

  it("cancels partial creation, rejects stale ready and unknown absence, and cleans after the original deadline even with Node disabled", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation({
      ...f.request,
      deadlineSeconds: 1,
    });
    await f
      .worker(
        new PersistentSimulator(
          join(f.dir, "external"),
          "create_after_first_object",
        ),
      )
      .run(run.operationId!);
    await f.admin.cancelValidation(run.validationId);
    await f.db.run("UPDATE nodes SET admission='disabled' WHERE id=?", [
      f.node.id,
    ]);
    f.advance(30_000);
    await f
      .worker(new PersistentSimulator(join(f.dir, "external"), "wrong_runtime"))
      .run(await f.cleanupId());
    expect(await f.claim()).toEqual({ state: "reserved" });
    const unknown = await f.admin.getValidation(run.validationId);
    expect(unknown).toMatchObject({
      state: "releasing",
      cleanupStatus: "blocked",
    });
    f.advance(5_000);
    await f.worker().reconcileBeforeScheduling();
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      state: "cancelled",
      testOutcome: "failed",
      cleanupStatus: "complete",
    });
    expect(await f.claim()).toEqual({ state: "released" });
  });

  it("uses an explicitly shared controller guard for concurrent late create and cleanup calls", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation(f.request);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execution: ExecutionPort = {
      inspect: (p) => f.simulator.inspect(p),
      ready: (p, i) => f.simulator.ready(p, i),
      revokeStop: (p) => f.simulator.revokeStop(p),
      destroy: (p, r) => f.simulator.destroy(p, r),
      create: async (p, j) => {
        entered();
        await held;
        return f.simulator.create(p, j);
      },
    };
    const pending = f.worker(execution).run(run.operationId!);
    await started;
    await f.admin.cancelValidation(run.validationId);
    f.advance(31_000);
    await f.worker().run(await f.cleanupId());
    expect(await f.claim()).toEqual({ state: "reserved" });
    release();
    await pending;
    f.advance(5_000);
    await f.worker().reconcileBeforeScheduling();
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      state: "cancelled",
      cleanupStatus: "complete",
    });
    expect(await f.claim()).toEqual({ state: "released" });
  });

  it("recovers from a killed controller in fresh processes using the durable lease and epoch, without a shared guard", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation(f.request);
    await f.db.close();
    const base = {
      dir: f.dir,
      installationId: f.installationId,
      operationId: run.operationId,
      validationId: run.validationId,
    };
    const original = await controllerProcess(
      { ...base, mode: "hold-create", epoch: 1, now: f.now() },
      "held",
    );
    expect(original.message.snapshot!.op.state).toBe("running");
    expect(Number(original.message.snapshot!.op.locked_until_ms)).toBe(
      f.now() + 30_000,
    );
    await original.kill();

    const before = await controllerProcess(
      {
        ...base,
        mode: "before-expiry",
        epoch: 2,
        now: f.now() + 1_000,
        snapshot: original.message.snapshot,
      },
      "done",
    );
    await before.exited;
    expect(before.message.report).toMatchObject({
      state: "releasing",
      testOutcome: "failed",
      cleanupStatus: "blocked",
    });
    expect(before.message.report!.checks).not.toHaveProperty("testedEvidence");
    expect(before.message.claim).toEqual({ state: "reserved" });
    expect(JSON.parse(before.message.cleanup!.result_json)).toMatchObject({
      diagnostic: "create_worker_lease_active",
    });
    expect(before.message.lateReadyCode).toBe("STORAGE_CAS_FAILED");
    expect(before.message.createCount).toBe(0);

    const stale = await controllerProcess(
      { ...base, mode: "stale-epoch", epoch: 1, now: f.now() + 31_000 },
      "done",
    );
    await stale.exited;
    expect(stale.message.claimed).toBe(false);
    expect(stale.message.createCount).toBe(0);
    expect(stale.message.claim).toEqual({ state: "reserved" });

    const recovered = await controllerProcess(
      { ...base, mode: "recover", epoch: 3, now: f.now() + 31_000 },
      "done",
    );
    await recovered.exited;
    expect(recovered.message.report).toMatchObject({
      state: "cancelled",
      testOutcome: "failed",
      cleanupStatus: "complete",
    });
    expect(recovered.message.claim).toEqual({ state: "released" });
    expect(recovered.message.createCount).toBe(0);
  }, 20_000);

  it("retains capacity for a historical attempted Portainer operation without a create journal marker", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation(f.request);
    await f.db.run(
      "UPDATE operations SET attempt_count=1,state='unknown',result_json='{}' WHERE id=?",
      [run.operationId],
    );
    expect(await f.worker().run(run.operationId)).toBe(true);
    const op = await f.db.get<{ result_json: string }>(
      "SELECT result_json FROM operations WHERE id=?",
      [run.operationId],
    );
    expect(JSON.parse(op!.result_json)).toMatchObject({
      diagnostic: "untracked_create_outcome_unknown",
    });
    await f.admin.cancelValidation(run.validationId);
    f.advance(5000);
    await f.worker().reconcileBeforeScheduling();
    expect(
      await f.db.get(
        "SELECT state FROM capacity_claims WHERE allocation_id=?",
        [run.allocationId],
      ),
    ).toEqual({ state: "reserved" });
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      cleanupStatus: "blocked",
    });
  });
  it("keeps an unresolved create intent across clean processes and empty inventories, refuses resend, then adopts and cleans a late native object", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation(f.request);
    await f.db.close();
    const base = {
      dir: f.dir,
      installationId: f.installationId,
      operationId: run.operationId,
      validationId: run.validationId,
      effectName: `pending-network-${run.allocationId}`,
    };
    const original = await controllerProcess(
      { ...base, mode: "hold-effect", epoch: 1, now: f.now() },
      "held",
    );
    const originalResult = JSON.parse(
      String(original.message.snapshot!.op.result_json),
    );
    expect(originalResult.createJournalVersion).toBe(1);
    const originalEffect = originalResult.createEffects.network_policy;
    expect(originalEffect).toMatchObject({
      kind: "network_policy",
      name: base.effectName,
      state: "unknown",
      requestHash: "a".repeat(64),
    });
    await original.kill();

    const retried = await controllerProcess(
      { ...base, mode: "unknown-retry", epoch: 2, now: f.now() + 31_000 },
      "done",
    );
    await retried.exited;
    expect(retried.message.sendCount).toBe(0);
    expect(retried.message.claim).toEqual({ state: "reserved" });
    expect(
      JSON.parse(retried.message.effectResultJson!).createEffects
        .network_policy,
    ).toEqual(originalEffect);

    const empty = await controllerProcess(
      { ...base, mode: "unknown-empty", epoch: 3, now: f.now() + 36_000 },
      "done",
    );
    await empty.exited;
    expect(empty.message.claim).toEqual({ state: "reserved" });
    expect(empty.message.report).toMatchObject({
      state: "releasing",
      cleanupStatus: "blocked",
    });
    expect(JSON.parse(empty.message.cleanup!.result_json)).toMatchObject({
      diagnostic: "create_effect_outcome_unknown",
    });
    expect(
      JSON.parse(empty.message.effectResultJson!).createEffects.network_policy
        .state,
    ).toBe("unknown");

    const late = await controllerProcess(
      {
        ...base,
        mode: "materialize-effect",
        epoch: 4,
        now: f.now() + 41_000,
        effectPlan: original.message.effectPlan,
      },
      "done",
    );
    await late.exited;
    expect(late.message.createCount).toBe(0);
    expect(late.message.sendCount).toBe(0);
    expect(late.message.report).toMatchObject({
      state: "cancelled",
      cleanupStatus: "complete",
    });
    expect(late.message.claim).toEqual({ state: "released" });
    expect(
      JSON.parse(late.message.effectResultJson!).createEffects.network_policy,
    ).toMatchObject({
      name: base.effectName,
      state: "observed",
      requestHash: "a".repeat(64),
    });
  }, 20_000);

  it("rejects unavailable mount grants and never treats a manual capability attestation as an image validation report", async () => {
    const f = await fixture();
    await expect(
      f.admin.publishVersion(f.draft.versionId, await f.version()),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.admin.scheduleValidation({
        ...f.request,
        storage: [
          {
            storageProfileId: randomUUID(),
            authorizedSubpath: "input",
            mountPath: "/input",
            mode: "read_only",
          },
        ],
      }),
    ).rejects.toThrow("Storage profile unavailable");
    expect(await f.db.get("SELECT count(*) n FROM image_validations")).toEqual({
      n: 0n,
    });
  });
  it.each([
    [
      "artifact digest",
      "UPDATE image_artifacts SET content_digest='sha256:'||? WHERE id=?",
      "2".repeat(64),
    ],
    [
      "bootstrap contract",
      "UPDATE image_artifacts SET requirements_json=json_set(requirements_json,'$.bootstrap.contractVersion',?) WHERE id=?",
      "2",
    ],
    [
      "access contract",
      "UPDATE image_artifacts SET access_recipe_json=json_set(access_recipe_json,'$.account',?) WHERE id=?",
      "other",
    ],
    [
      "minimum resources",
      "UPDATE image_artifacts SET minimum_cpu_millis=? WHERE id=?",
      200,
    ],
  ])(
    "rejects a completed report after %s changes",
    async (_name, sql, value) => {
      const f = await fixture();
      const run = await f.admin.scheduleValidation(f.request);
      await f.worker().run(run.operationId!);
      await f.worker().run(await f.cleanupId());
      await f.db.run(String(sql), [value!, f.draft.artifactId]);
      await expect(
        f.admin.publishVersion(f.draft.versionId, await f.version()),
      ).rejects.toMatchObject({ code: "conflict" });
    },
  );

  it.each(["dockerVersion", "portainerVersion"] as const)(
    "rechecks live %s before publishing an otherwise current completed report",
    async (field) => {
      const f = await fixture();
      const run = await f.admin.scheduleValidation(f.request);
      await f.worker().run(run.operationId);
      await f.worker().run(await f.cleanupId());
      const expected = await f.version();
      const original = f.providerEvidence[field];
      f.providerEvidence[field] = "upgraded-with-same-engine";
      await expect(
        f.admin.publishVersion(f.draft.versionId, expected),
      ).rejects.toMatchObject({ code: "conflict" });
      f.providerEvidence[field] = original;
      await expect(
        f.admin.publishVersion(f.draft.versionId, expected),
      ).resolves.toMatchObject({ status: "published" });
    },
  );

  it("requires reports for every artifact and rechecks the expected image entity version", async () => {
    const f = await fixture();
    await f.admin.addDraftArtifact(f.draft.versionId, {
      architecture: "arm64",
      artifactRef: `docker.io/example/node@sha256:${"2".repeat(64)}`,
      digest: `sha256:${"2".repeat(64)}`,
      minimumResources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
      requirements: {
        bootstrap: {
          mechanism: "hitchlet-node-ssh-v1",
          contractVersion: "1",
          identityReset: true,
        },
      },
      access: {
        accessProtocols: ["ssh"],
        ports: [22],
        account: "workspace",
        allowedSourceCidrs: ["10.0.0.0/8"],
        discovery: "portainer-published-port",
        readiness: "ssh-public-key-authenticated-fingerprint",
      },
    });
    const run = await f.admin.scheduleValidation(f.request);
    await f.worker().run(run.operationId!);
    await f.worker().run(await f.cleanupId());
    await expect(
      f.admin.publishVersion(f.draft.versionId, await f.version()),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.admin.publishVersion(f.draft.versionId, 1),
    ).rejects.toMatchObject({ code: "STORAGE_CAS_FAILED" });
  });

  it("serves schema-validated query, publish CAS and alias routes through the management API", async () => {
    const f = await fixture();
    const token = `hcl_${"f".repeat(43)}`;
    await f.db.run(
      "INSERT INTO consumer_credentials(id,consumer_id,token_prefix,token_hash,scopes_json,created_at_ms) VALUES(?,?,?,?,?,?)",
      [
        randomUUID(),
        f.request.requestedBy,
        token.slice(0, 12),
        createHash("sha256").update(token).digest("hex"),
        JSON.stringify([
          "tickets:read",
          "tickets:write",
          "tickets:revoke",
          "images:read",
          "events:read",
        ]),
        f.now(),
      ],
    );
    const keyFile = join(f.dir, "fixture-master-key");
    await writeFile(keyFile, Buffer.alloc(32, 1));
    const secrets = await LocalSecretStore.open(f.dir, keyFile);
    vi.spyOn(secrets, "get").mockResolvedValue("test secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const path = new URL(String(input)).pathname;
        const e = f.providerEvidence;
        return new Response(
          JSON.stringify(
            path.endsWith("/info")
              ? {
                  ID: e.engineId,
                  ServerVersion: e.dockerVersion,
                  OSType: e.os,
                  Architecture: e.architecture,
                  NCPU: e.cpuCount,
                  MemTotal: e.memoryBytes,
                }
              : path === "/api/system/version"
                ? { ServerVersion: e.portainerVersion }
                : path.endsWith("/version")
                  ? {
                      Version: e.dockerVersion,
                      ApiVersion: e.apiVersion,
                      MinAPIVersion: e.minimumApiVersion,
                      Arch: e.architecture,
                    }
                  : [],
          ),
          { status: 200 },
        );
      }),
    );
    const app = await buildApp(loadConfig({ DATA_DIR: f.dir }), {
      storage: f.db,
      secrets,
    });
    cleanup.push(() => app.close());
    const headers = {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
    };
    const { versionId, requestedBy, deadlineSeconds, ...body } = f.request;
    const scheduled = await app.inject({
      method: "POST",
      url: `/v1/image-versions/${versionId}/validate`,
      headers,
      payload: body,
    });
    expect(scheduled.statusCode).toBe(202);
    const run = scheduled.json();
    expect(run.deadlineMs).toBeGreaterThan(f.now() + 1_790_000);
    f.advance(1_000);
    await f.worker().run(run.operationId);
    const premature = await app.inject({
      method: "POST",
      url: `/v1/image-versions/${versionId}/publish`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { expectedEntityVersion: await f.version() },
    });
    expect(premature.statusCode).toBe(409);
    await f.worker().run(await f.cleanupId());
    const query = await app.inject({
      method: "GET",
      url: `/v1/image-validations/${run.validationId}`,
      headers,
    });
    expect(query.statusCode).toBe(200);
    expect(query.json()).toMatchObject({
      state: "succeeded",
      reportId: run.validationId,
    });
    const stale = await app.inject({
      method: "POST",
      url: `/v1/image-versions/${versionId}/publish`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { expectedEntityVersion: 1 },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe("version_conflict");
    const published = await app.inject({
      method: "POST",
      url: `/v1/image-versions/${versionId}/publish`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { expectedEntityVersion: await f.version() },
    });
    expect(published.statusCode).toBe(200);
    const alias = await app.inject({
      method: "PUT",
      url: `/v1/images/${f.draft.imageId}/aliases/stable`,
      headers,
      payload: { versionId, expectedVersion: 0 },
    });
    expect(alias.statusCode).toBe(200);
    expect(alias.json()).toMatchObject({ versionId, version: 1 });
    const openapi = (await app.inject("/v1/openapi.json")).json();
    expect(
      openapi.paths["/v1/image-versions/{versionId}/publish"].post.requestBody,
    ).toBeDefined();
    expect(
      openapi.paths["/v1/images/{imageId}/aliases/{alias}"].put.responses[
        "200"
      ],
    ).toBeDefined();
  });
  it("times out a partially created validation at its original deadline and retains a failed audit report", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation({
      ...f.request,
      deadlineSeconds: 1,
    });
    await f
      .worker(
        new PersistentSimulator(
          join(f.dir, "external"),
          "create_after_first_object",
        ),
      )
      .run(run.operationId!);
    f.advance(1_000);
    await f.worker().reconcileBeforeScheduling();
    const report = await f.admin.getValidation(run.validationId);
    expect(report).toMatchObject({
      state: "failed",
      testOutcome: "failed",
      cleanupStatus: "complete",
      reportId: run.validationId,
    });
    expect(report!.checks).toMatchObject({
      terminationReason: "deadline_exceeded",
      failureEvidence: { reason: "deadline_exceeded" },
      cleanupEvidence: { inventory: { completeness: "complete" } },
    });
    expect(await f.claim()).toEqual({ state: "released" });
  });

  it("keeps the claim after a destroy acknowledgement is lost even when Docker inventory is absent, then retries journaled removal", async () => {
    const f = await fixture();
    const run = await f.admin.scheduleValidation(f.request);
    await f.worker().run(run.operationId!);
    let loseResponse = true,
      removals = 0;
    const execution: ExecutionPort = {
      inspect: (p) => f.simulator.inspect(p),
      create: (p, j) => f.simulator.create(p, j),
      ready: (p, i) => f.simulator.ready(p, i),
      revokeStop: (p) => f.simulator.revokeStop(p),
      destroy: async (p, r) => {
        await f.simulator.destroy(p, r);
        if (r.kind === "network_policy") {
          removals++;
          if (loseResponse) {
            loseResponse = false;
            throw new Error("simulated lost network removal ACK");
          }
        }
      },
    };
    await f.worker(execution).run(await f.cleanupId());
    expect(await f.claim()).toEqual({ state: "committed" });
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      state: "releasing",
      testOutcome: "pending",
      reportId: null,
    });
    f.advance(5_000);
    await f.worker(execution).reconcileBeforeScheduling();
    expect(removals).toBe(2);
    expect(await f.admin.getValidation(run.validationId)).toMatchObject({
      state: "succeeded",
      testOutcome: "passed",
      cleanupStatus: "complete",
    });
    expect(await f.claim()).toEqual({ state: "released" });
  });
});
