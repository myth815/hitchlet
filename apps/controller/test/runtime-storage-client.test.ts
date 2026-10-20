import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import https from "node:https";
import { RuntimeNetworkHttpClient } from "../src/providers/runtime-network-client.js";
import {
  runtimeStorageRequestSchema,
  type RuntimeStorageRequest,
} from "@hitchlet/contracts/internal";

let directory: string,
  server: https.Server,
  baseUrl: string,
  cert: Buffer,
  key: Buffer;
let sampleTime = 1,
  mismatch:
    | keyof Pick<
        RuntimeStorageRequest,
        "requestId" | "installationId" | "runtimeIdentityId" | "nativeEngineId"
      >
    | undefined,
  drip = false;
const timers = new Set<ReturnType<typeof setInterval>>();
beforeAll(async () => {
  directory = await mkdtemp("/private/tmp/hitchlet-storage-client-tls-");
  const keyPath = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
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
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  cert = await readFile(certPath);
  key = await readFile(keyPath);
  server = https.createServer(
    { key, cert, ca: cert, requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      if (request.headers.authorization !== "Bearer fixture-token") {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        if (drip) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"pending":"');
          const timer = setInterval(() => response.write("x"), 10);
          timers.add(timer);
          response.on("close", () => {
            clearInterval(timer);
            timers.delete(timer);
          });
          return;
        }
        const input = runtimeStorageRequestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        const result = {
          requestId: input.requestId,
          installationId: input.installationId,
          runtimeIdentityId: input.runtimeIdentityId,
          nativeEngineId: input.nativeEngineId,
          observedAtMs: sampleTime,
          controllerEpoch: 7,
          imageStore: { root: "/fixture/docker-root", availableMiB: 50000 },
          inventory: null,
          mounts: [],
        };
        if (mismatch) result[mismatch] = randomUUID();
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(result));
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  baseUrl = `https://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const timer of timers) clearInterval(timer);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
function client(timeoutMs = 1000, token = "fixture-token") {
  return new RuntimeNetworkHttpClient({
    baseUrl,
    timeoutMs,
    loadCredentials: async () => ({ token, ca: cert, cert, key }),
  });
}
function request() {
  return {
    requestId: randomUUID(),
    installationId: "installation",
    runtimeIdentityId: "runtime",
    nativeEngineId: "engine",
    mounts: [],
  };
}
describe("authenticated storage receipt clock over real HTTPS", () => {
  it.each([10, 5000, 60000, -60000])(
    "uses controller receipt time with remote sample offset %ims",
    async (offset) => {
      mismatch = undefined;
      drip = false;
      sampleTime = Date.now() + offset;
      const start = Date.now(),
        result = await client().storageFacts(request());
      expect(result.observedAtMs).toBe(sampleTime);
      expect(result.receivedAtMs).toBeGreaterThanOrEqual(start);
      expect(result.receivedAtMs).toBeLessThanOrEqual(Date.now());
    },
  );
  it.each([
    "requestId",
    "installationId",
    "runtimeIdentityId",
    "nativeEngineId",
  ] as const)("still rejects mismatching %s", async (field) => {
    mismatch = field;
    drip = false;
    sampleTime = Date.now() + 5000;
    await expect(client().storageFacts(request())).rejects.toThrow(
      "identity mismatch",
    );
    mismatch = undefined;
  });
  it("rejects a revoked bearer even with matching nonce and clock", async () => {
    mismatch = undefined;
    drip = false;
    await expect(
      client(1000, "revoked-token").storageFacts(request()),
    ).rejects.toThrow("HTTP 401");
  });
  it("enforces the complete request deadline even while authenticated response bytes keep arriving", async () => {
    mismatch = undefined;
    drip = true;
    const start = Date.now();
    await expect(client(80).storageFacts(request())).rejects.toThrow(
      "request failed",
    );
    expect(Date.now() - start).toBeLessThan(1500);
    drip = false;
  });
});
