import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RuntimeWorkloadFacts } from "../src/workloads.js";
import { FileJournal } from "../src/journal.js";
import { createRuntimeServer, listenRuntimeServer } from "../src/server.js";
import type { NetworkWorker } from "../src/worker.js";
import {
  RuntimeAgentHttpTransport,
  readRuntimeWorkloadFacts,
} from "../../controller/src/providers/runtime-network-client.js";
import {
  runtimeWorkloadResultSchema,
  type RuntimeNativeWorkload,
  type RuntimeContainerWorkload,
} from "@hitchlet/contracts/internal";

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close();
});
const identity = {
  installationId: "installation",
  runtimeIdentityId: "runtime",
  nativeEngineId: "engine",
  agentId: "agent",
};
const native = (): RuntimeNativeWorkload => ({
  complete: true,
  distributionMachineId: "a".repeat(32),
  bootId: "147eae63-b612-40f5-82b3-3ee921df5e3d",
  namespaces: {
    pid: "pid:[1]",
    user: "user:[2]",
    mount: "mnt:[3]",
    network: "net:[4]",
  },
  processes: [
    {
      pid: 42,
      parentPid: 1,
      uid: 1000,
      executable: "/usr/bin/node",
      unit: "runtime.service",
      startTicks: "123",
    },
  ],
  backgroundPids: [],
  errorCodes: [],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-workload-"));
  clean.push(() => rm(root, { recursive: true, force: true }));
  const journal = new FileJournal(join(root, "journal.json"));
  await journal.initialize();
  journal.setEpoch(9);
  const engine = {
    workloadInventory: vi.fn(async () => ({
      complete: true,
      containers: [] as RuntimeContainerWorkload[],
    })),
  };
  const facts = native();
  const collector = vi.fn(async () => facts);
  const subject = new RuntimeWorkloadFacts(
    identity,
    engine,
    journal,
    collector,
    [],
    Date.now,
    42,
  );
  const request = { ...identity, requestId: randomUUID() };
  return { root, journal, engine, facts, collector, subject, request };
}

it("rejects a different Engine/owner before reading native processes", async () => {
  const f = await fixture();
  expect(() =>
    f.subject.inspect({ ...f.request, nativeEngineId: "other" }),
  ).toThrow(/identity/);
  expect(f.collector).not.toHaveBeenCalled();
});
it("keeps pending commands and revoked allocations held even with no containers", async () => {
  const f = await fixture();
  f.journal.setCommand("unknown", { hash: "digest" });
  f.journal.setAllocation("a", {
    generation: 1,
    controlVersion: 1,
    state: "revoked",
    rulesetHash: null,
  });
  const result = await f.subject.inspect(f.request);
  expect(result.workloadState).toBe("unknown");
  expect(result.pendingCommandCount).toBe(1);
  expect(result.retainedAllocationCount).toBe(1);
});
it("distinguishes a known background MainPID from jobs spawned under the same service", async () => {
  const f = await fixture();
  f.facts.processes.push({
    pid: 90,
    parentPid: 1,
    uid: 0,
    executable: "/usr/sbin/sshd",
    unit: "sshd.service",
    startTicks: "55",
  });
  f.facts.backgroundPids.push(90);
  expect((await f.subject.inspect(f.request)).workloadState).toBe("idle");
  f.facts.processes.push({
    pid: 91,
    parentPid: 90,
    uid: 1000,
    executable: "/bin/bash",
    unit: "sshd.service",
    startTicks: "56",
  });
  const held = await f.subject.inspect(f.request);
  expect(held.complete).toBe(true);
  expect(held.workloadState).toBe("busy");
  expect(held.unapprovedProcessCount).toBe(1);
});
it("counts stopped owned resources and active foreign containers without trusting labels as cleanup proof", async () => {
  const f = await fixture();
  f.engine.workloadInventory.mockResolvedValue({
    complete: true,
    containers: [
      {
        id: "a".repeat(64),
        running: false,
        paused: false,
        installationId: identity.installationId,
        runtimeIdentityId: identity.runtimeIdentityId,
        allocationId: "a",
        generation: 1,
      },
    ],
  });
  expect((await f.subject.inspect(f.request)).reasons).toContain(
    "owned_container_resources_present",
  );
  f.engine.workloadInventory.mockResolvedValue({
    complete: true,
    containers: [
      {
        id: "b".repeat(64),
        running: true,
        paused: false,
        installationId: null,
        runtimeIdentityId: null,
        allocationId: null,
        generation: null,
      },
    ],
  });
  expect((await f.subject.inspect(f.request)).reasons).toContain(
    "unmanaged_active_containers",
  );
});
it.each(["native", "containers"])(
  "keeps %s incomplete evidence unknown",
  async (kind) => {
    const f = await fixture();
    if (kind === "native") {
      f.facts.complete = false;
      f.facts.errorCodes.push("native_process_unverifiable");
    } else
      f.engine.workloadInventory.mockResolvedValue({
        complete: false,
        containers: [],
      });
    expect((await f.subject.inspect(f.request)).workloadState).toBe("unknown");
  },
);
it("serializes observation behind the existing network lifecycle queue", async () => {
  const f = await fixture();
  let release!: () => void;
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const pending = f.journal.serialize(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        notify();
      }),
  );
  await started;
  const result = f.subject.inspect(f.request);
  await Promise.resolve();
  expect(f.collector).not.toHaveBeenCalled();
  release();
  await pending;
  expect((await result).workloadState).toBe("idle");
});
it("rejects stale/replayed or contradictory idle facts at the normal client boundary", async () => {
  const f = await fixture();
  const result = await f.subject.inspect(f.request);
  const transport = { exchangeJson: vi.fn(async () => result) };
  await expect(
    readRuntimeWorkloadFacts(transport, {
      ...f.request,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow(/identity/);
  await expect(
    readRuntimeWorkloadFacts(
      transport,
      f.request,
      () => Date.parse(result.observedAt) + 5000,
    ),
  ).rejects.toThrow(/stale/);
  expect(
    runtimeWorkloadResultSchema.safeParse({ ...result, complete: false })
      .success,
  ).toBe(false);
});
it("serves only authenticated read-only facts over the existing mTLS transport", async () => {
  const f = await fixture();
  const key = join(f.root, "key.pem"),
    cert = join(f.root, "cert.pem"),
    token = join(f.root, "token");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  await writeFile(token, "fixture-token", { mode: 0o600 });
  const execute = vi.fn();
  const server = await createRuntimeServer(
    {
      host: "127.0.0.1",
      port: 0,
      caFile: cert,
      certFile: cert,
      keyFile: key,
      tokenFile: token,
    },
    { execute } as unknown as NetworkWorker,
    undefined,
    f.subject,
  );
  const address = await listenRuntimeServer(server, "127.0.0.1", 0);
  clean.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  );
  const credentials = {
    token: "fixture-token",
    ca: await readFile(cert),
    cert: await readFile(cert),
    key: await readFile(key),
  };
  const transport = new RuntimeAgentHttpTransport({
    baseUrl: `https://127.0.0.1:${address.port}`,
    loadCredentials: async () => credentials,
    timeoutMs: 5000,
  });
  expect(
    (await readRuntimeWorkloadFacts(transport, f.request)).workloadState,
  ).toBe("idle");
  credentials.token = "wrong-token";
  await expect(readRuntimeWorkloadFacts(transport, f.request)).rejects.toThrow(
    /401/,
  );
  expect(execute).not.toHaveBeenCalled();
});
