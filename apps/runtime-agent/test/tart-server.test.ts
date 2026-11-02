import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { FileJournal } from "../src/journal.js";
import { currentCommandDeadlineMs } from "../src/command-exec.js";
import { createTartRuntimeServer } from "../src/tart-server.js";
import type {
  TartAllocationIdentity,
  TartInspection,
  TartRuntimeFacts,
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
  inventoryCompleteness: "complete",
};
const facts: TartRuntimeFacts = {
  nativeRuntimeNamespaceId: "3b241101-e2bb-4255-8caf-4136c566a962",
  tartVersion: "tart 2.fixture",
  hostOS: "macos",
  hostArch: "arm64",
  hostCpuCount: 12,
  hostMemoryBytes: 64 * 1024 * 1024 * 1024,
  templates: [],
};

let root = "";
let server: https.Server;
let cert: Buffer;
let key: Buffer;
let origin: URL;
let journal: FileJournal;
let calls: string[];
let observedActionDeadline: number | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hitchlet-tart-server-"));
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
  observedActionDeadline = undefined;
  const driver = {
    inspect: async () => {
      calls.push("inspect");
      observedActionDeadline = currentCommandDeadlineMs();
      return inspection;
    },
    reconcile: async () => {
      calls.push("reconcile");
      return inspection;
    },
    bootstrapApply: async () => {
      calls.push("bootstrap.apply");
      return inspection;
    },
    destroy: async () => {
      calls.push("destroy");
      return inspection;
    },
  };
  server = await createTartRuntimeServer(
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
    async () => facts,
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

it("serves only authenticated, runtime-bound, nonce-echoed Tart actions and persists epoch fencing", async () => {
  const request = {
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a963",
    deadline: new Date(Date.now() + 120_000).toISOString(),
    controllerEpoch: 5,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    action: { kind: "inspect", identity },
  };
  const response = await post("/v1/tart/actions", request);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    requestNonce: request.requestNonce,
    installationId: identity.installationId,
    result: inspection,
  });
  expect(observedActionDeadline).toBe(Date.parse(request.deadline));
  expect(journal.epoch).toBe(5);

  const stale = await post("/v1/tart/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a964",
    controllerEpoch: 4,
  });
  expect(stale.status).toBe(409);
  expect(calls).toEqual(["inspect"]);

  const mismatch = await post("/v1/tart/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a965",
    runtimeIdentityId: "foreign-runtime",
  });
  expect(mismatch.status).toBe(400);
  const unauthorized = await post("/v1/tart/actions", request, {
    token: "wrong-token",
  });
  expect(unauthorized.status).toBe(401);
  expect(calls).toEqual(["inspect"]);
  const expired = await post("/v1/tart/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a967",
    deadline: new Date(Date.now() - 1_000).toISOString(),
  });
  expect(expired.status).toBe(408);
  const overlongDeadline = await post("/v1/tart/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a968",
    deadline: new Date(Date.now() + 300_000).toISOString(),
  });
  expect(overlongDeadline.status).toBe(400);
  expect(calls).toEqual(["inspect"]);
  const bootstrap = await post("/v1/tart/actions", {
    ...request,
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a970",
    action: {
      kind: "bootstrap.apply",
      identity,
      request: {
        identity,
        nonce: "nonce-0123456789abcdef",
        account: "admin",
        clientPublicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        clientPublicKeyFingerprint:
          "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        networkEvidence: {
          reference: "network-evidence",
          revisionId: "network-revision",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      },
    },
  });
  expect(bootstrap.status).toBe(200);
  expect(calls).toEqual(["inspect", "bootstrap.apply"]);
  await expect(
    postRaw("/v1/tart/actions", Buffer.from(JSON.stringify(request)), {
      clientCertificate: false,
    }),
  ).rejects.toBeDefined();
});

it("returns fixed read-only host facts and enforces the request body limit", async () => {
  const response = await post("/v1/tart/facts", {
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
  const oversized = await postRaw(
    "/v1/tart/facts",
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
