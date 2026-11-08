import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { FileJournal } from "../src/journal.js";
import { currentCommandDeadlineMs } from "../src/command-exec.js";
import { HyperVRuntimeHttpClient } from "../../controller/src/providers/hyperv-runtime-client.js";
import { RuntimeAgentHttpTransport } from "../../controller/src/providers/runtime-network-client.js";
import { createHyperVRuntimeServer } from "../src/hyperv-server.js";
import type {
  VmAllocationIdentity as TartAllocationIdentity,
  HyperVInspection as TartInspection,
  HyperVRequest as TartReconcileRequest,
  HyperVRuntimeFacts as TartRuntimeFacts,
} from "@hitchlet/contracts/internal";

const identity: TartAllocationIdentity = {
  installationId: "install-1",
  runtimeIdentityId: "runtime-1",
  connectionRevisionId: "rev-1",
  allocationId: "alloc-1",
  generation: 1,
  operationId: "op-1",
  controlVersion: 1,
  purpose: "tenant",
};
const inspection: TartInspection = {
  presence: "absent",
  identity,
  inventoryComplete: true,
  bootstrapStatus: "not_implemented",
};
const facts: TartRuntimeFacts = {
  nativeRuntimeNamespaceId: "3b241101-e2bb-4255-8caf-4136c566a962",
  available: false,
  reason: "hyperv_cmdlets_unavailable",
  hostArchitecture: "AMD64",
  implementedOperations: [],
};

let root = "";
let server: https.Server;
let cert: Buffer;
let key: Buffer;
let origin: URL;
let journal: FileJournal;
let calls: string[];
let destroyLog: string[];
let destroyHook: (owner: TartAllocationIdentity) => Promise<TartInspection>;
let reconcileHook: (request: TartReconcileRequest) => Promise<TartInspection>;
let observedActionDeadline: number | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hitchlet-hyperv-server-"));
  const keyPath = join(root, "key.pem"),
    certPath = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  cert = await readFile(certPath);
  key = await readFile(keyPath);
  await writeFile(join(root, "token"), "fixture-token\n", { mode: 0o600 });
  journal = new FileJournal(join(root, "journal.json"));
  await journal.initialize();
  calls = [];
  destroyLog = [];
  destroyHook = async () => inspection;
  reconcileHook = async () => inspection;
  observedActionDeadline = undefined;
  const driver = {
    consoleCredentials: async (
      request: import("@hitchlet/contracts/internal").HyperVInteractiveRequest,
    ) => {
      calls.push("console.credentials:" + request.mode);
      return {
        identity: request.identity,
        nonce: request.nonce,
        passwordHash: request.passwordHash,
        account: "workspace" as const,
        status: "applied" as const,
      };
    },
    console: async (
      request: import("@hitchlet/contracts/internal").HyperVConsoleRequest,
    ) => {
      calls.push("console");
      return {
        identity: request.identity,
        commandId: request.commandId,
        account: "workspace",
        status: "captured" as const,
        frame: {
          width: 1024,
          height: 768,
          pixelFormat: "rgb565le" as const,
          dataBase64: Buffer.alloc(1024 * 768 * 2).toString("base64"),
        },
      };
    },
    inspect: async () => {
      calls.push("inspect");
      observedActionDeadline = currentCommandDeadlineMs();
      return inspection;
    },
    reconcile: async (request: TartReconcileRequest) => {
      calls.push("reconcile");
      return reconcileHook(request);
    },
    bootstrapApply: async () => {
      calls.push("bootstrap.apply");
      return inspection;
    },
    stop: async () => {
      calls.push("stop");
      return inspection;
    },
    facts: async () => {
      const { nativeRuntimeNamespaceId: _, ...native } = facts;
      return native;
    },
    destroy: async (owner: TartAllocationIdentity) => {
      calls.push("destroy");
      destroyLog.push(owner.allocationId);
      return destroyHook(owner);
    },
  };
  server = await createHyperVRuntimeServer(
    {
      host: "127.0.0.1",
      port: 0,
      installationId: identity.installationId,
      runtimeIdentityId: identity.runtimeIdentityId,
      nativeRuntimeNamespaceId: facts.nativeRuntimeNamespaceId,
      tokenFile: join(root, "token"),
      caFile: certPath,
      certFile: certPath,
      keyFile: keyPath,
    },
    driver,
    journal,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  origin = new URL(`https://127.0.0.1:${address.port}/`);
});

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

it("serves only authenticated, runtime-bound, nonce-echoed Hyper-V actions and persists epoch fencing", async () => {
  const request = {
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a963",
    deadline: new Date(Date.now() + 120_000).toISOString(),
    controllerEpoch: 5,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    action: { kind: "inspect", identity },
  };
  const response = await post("/v1/hyperv/actions", request);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    requestNonce: request.requestNonce,
    installationId: identity.installationId,
    result: inspection,
  });
  expect(observedActionDeadline).toBe(Date.parse(request.deadline));
  expect(journal.epoch).toBe(5);
  const reloaded = new FileJournal(join(root, "journal.json"));
  await reloaded.initialize();
  expect(reloaded.epoch).toBe(5);

  const stale = await post("/v1/hyperv/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a964",
    controllerEpoch: 4,
  });
  expect(stale.status).toBe(409);
  expect(calls).toEqual(["inspect"]);

  const mismatch = await post("/v1/hyperv/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a965",
    runtimeIdentityId: "foreign-runtime",
  });
  expect(mismatch.status).toBe(400);
  const unauthorized = await post("/v1/hyperv/actions", request, {
    token: "wrong-token",
  });
  expect(unauthorized.status).toBe(401);
  expect(calls).toEqual(["inspect"]);
  const expired = await post("/v1/hyperv/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a967",
    deadline: new Date(Date.now() - 1_000).toISOString(),
  });
  expect(expired.status).toBe(408);
  const overlongDeadline = await post("/v1/hyperv/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a968",
    deadline: new Date(Date.now() + 300_000).toISOString(),
  });
  expect(overlongDeadline.status).toBe(400);
  expect(calls).toEqual(["inspect"]);
  const stopped = await post("/v1/hyperv/actions", {
    ...request,
    action: { kind: "stop", identity },
  });
  expect(stopped.status).toBe(200);
  expect(calls).toEqual(["inspect", "stop"]);
  const bootstrap = await post("/v1/hyperv/actions", {
    ...request,
    action: { kind: "bootstrap.apply", identity },
  });
  expect(bootstrap.status).toBe(400);
  expect(calls).toEqual(["inspect", "stop"]);
  await expect(
    postRaw("/v1/hyperv/actions", Buffer.from(JSON.stringify(request)), {
      clientCertificate: false,
    }),
  ).rejects.toBeDefined();
});

it("keeps allocation actions ordered while another allocation advances the epoch", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const ownerA = { ...identity, allocationId: "alloc-a" };
  const ownerB = { ...identity, allocationId: "alloc-b" };
  reconcileHook = async (request) => {
    if (request.identity.allocationId === ownerA.allocationId) {
      entered();
      await gate;
    }
    return inspection;
  };
  const request = (
    owner: TartAllocationIdentity,
    epoch: number,
    suffix: string,
    lifetimeMs = 120_000,
  ) => ({
    requestNonce: `3b241101-e2bb-4255-8caf-4136c566a${suffix}`,
    deadline: new Date(Date.now() + lifetimeMs).toISOString(),
    controllerEpoch: epoch,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    action: { kind: "destroy", identity: owner },
  });
  const cloneRequest: TartReconcileRequest = {
    identity: ownerA,
    template: {
      configPath: "E:\\Templates\\base.vmcx",
      configSha256: "a".repeat(64),
      guestOs: "windows",
      architecture: "amd64",
      generation: 2,
    },
    resources: { cpus: 4, memoryMiB: 4096 },
    switchName: "Existing Switch",
  };
  const active = post("/v1/hyperv/actions", {
    ...request(ownerA, 4, "971"),
    action: { kind: "reconcile", request: cloneRequest },
  });
  await started;
  const queuedOldEpoch = post("/v1/hyperv/actions", request(ownerA, 4, "972"));
  const queuedCurrentEpoch = post(
    "/v1/hyperv/actions",
    request(ownerA, 5, "975"),
  );
  const queuedExpired = post(
    "/v1/hyperv/actions",
    request(ownerA, 5, "974", 100),
  );
  const independentCleanup = await post(
    "/v1/hyperv/actions",
    request(ownerB, 5, "973"),
  );
  expect(independentCleanup.status).toBe(200);
  expect(journal.epoch).toBe(5);
  await new Promise((resolve) => setTimeout(resolve, 150));
  release();
  expect((await active).status).toBe(200);
  expect((await queuedOldEpoch).status).toBe(409);
  expect((await queuedCurrentEpoch).status).toBe(200);
  expect((await queuedExpired).status).toBe(408);
  expect(calls).toEqual(["reconcile", "destroy", "destroy"]);
  expect(destroyLog).toEqual(["alloc-b", "alloc-a"]);
});

it("returns fixed read-only host facts and enforces the request body limit", async () => {
  const response = await post("/v1/hyperv/facts", {
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a966",
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    facts,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a966",
  });
  expect(calls).toEqual([]);
  const foreign = await post("/v1/hyperv/facts", {
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a966",
    installationId: "other",
    runtimeIdentityId: identity.runtimeIdentityId,
  });
  expect(foreign.status).toBe(409);
  const unsupportedRoute = await post("/v1/tart/facts", {});
  expect(unsupportedRoute.status).toBe(404);
  const oversized = await postRaw(
    "/v1/hyperv/facts",
    Buffer.alloc(256 * 1024 + 1, 0x20),
  );
  expect(oversized.status).toBe(413);
});

async function post(
  path: string,
  value: unknown,
  options: { token?: string } = {},
) {
  return postRaw(path, Buffer.from(JSON.stringify(value)), options);
}

async function postRaw(
  path: string,
  body: Buffer,
  options: { token?: string; clientCertificate?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const useClientCert = options.clientCertificate !== false;
    const request = https.request(
      new URL(path, origin),
      {
        method: "POST",
        ca: cert,
        ...(useClientCert ? { cert, key } : {}),
        rejectUnauthorized: true,
        headers: {
          authorization: `Bearer ${options.token ?? "fixture-token"}`,
          "content-type": "application/json",
          "content-length": body.byteLength,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* status-only response */
          }
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

it("connects the controller client through the existing real mTLS transport, without native actions", async () => {
  let token = "fixture-token";
  const transport = new RuntimeAgentHttpTransport({
    baseUrl: origin.toString(),
    timeoutMs: 10_000,
    loadCredentials: async () => ({ token, ca: cert, cert, key }),
  });
  const client = new HyperVRuntimeHttpClient({
    transport,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    controllerEpoch: 3,
    deadlineMs: Date.now() + 60_000,
  });
  expect(await client.inspect(identity)).toEqual(inspection);
  expect(await client.facts()).toEqual({ ...facts, templates: [] });
  const request = {
    identity,
    vmId: "11111111-1111-4111-8111-111111111111",
    nonce: "bootstrap-nonce-0123456789",
    account: "workspace",
    guestOs: "windows" as const,
    architecture: "amd64" as const,
    clientPublicKey: "ssh-ed25519 " + "A".repeat(68),
    clientPublicKeyFingerprint: "SHA256:" + "A".repeat(43),
  };
  expect((await client.bootstrapApply(request)).bootstrapStatus).toBe(
    "not_implemented",
  );
  expect(calls).toEqual(["inspect", "bootstrap.apply"]);
  token = "revoked-fixture-token";
  await expect(client.destroy(identity)).rejects.toThrow();
  expect(calls).toEqual(["inspect", "bootstrap.apply"]);
});

it("console frame uses the existing authenticated Runtime route with a bounded full-size image", async () => {
  const transport = new RuntimeAgentHttpTransport({
    baseUrl: origin.toString(),
    timeoutMs: 5000,
    loadCredentials: async () => ({
      token: "fixture-token",
      ca: cert,
      cert,
      key,
    }),
  });
  const client = new HyperVRuntimeHttpClient({
    transport,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    controllerEpoch: 1,
    deadlineMs: Date.now() + 5000,
  });
  const result = await client.console({
    identity,
    commandId: "5a0f42b6-94d1-462c-953a-e8cc1622981c",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    action: { kind: "frame", width: 1024, height: 768 },
  });
  expect(result).toMatchObject({
    status: "captured",
    account: "workspace",
    frame: { width: 1024, height: 768 },
  });
  expect(Buffer.from(result.frame!.dataBase64, "base64").length).toBe(
    1024 * 768 * 2,
  );
  expect(calls).toEqual(["console"]);
});

it("credential preparation/recovery retain separate typed envelopes over real local mTLS and no secret journal", async () => {
  const transport = new RuntimeAgentHttpTransport({
    baseUrl: origin.toString(),
    timeoutMs: 5000,
    loadCredentials: async () => ({
      token: "fixture-token",
      ca: cert,
      cert,
      key,
    }),
  });
  const client = new HyperVRuntimeHttpClient({
    transport,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    controllerEpoch: 1,
    deadlineMs: Date.now() + 5000,
  });
  const request = {
    identity,
    nonce: "5a0f42b6-94d1-462c-953a-e8cc1622981c",
    passwordHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  expect(
    (
      await client.consoleCredentials({
        ...request,
        mode: "prepare",
        password: "Aa1!" + "private-fixture-".repeat(3),
      })
    ).status,
  ).toBe("applied");
  expect(
    (await client.consoleCredentials({ ...request, mode: "inspect" })).status,
  ).toBe("applied");
  expect(calls).toEqual([
    "console.credentials:prepare",
    "console.credentials:inspect",
  ]);
  expect(await readFile(join(root, "journal.json"), "utf8")).not.toContain(
    "private-fixture",
  );
});
