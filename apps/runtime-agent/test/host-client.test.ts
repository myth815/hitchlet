import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { HostClient } from "../src/host-client.js";
let dir: string, server: https.Server, origin: URL, ca: Buffer;
const timers = new Set<ReturnType<typeof setInterval>>();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hitchlet-host-tls-"));
  const key = join(dir, "key.pem"),
    cert = join(dir, "cert.pem");
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
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  ca = await readFile(cert);
  server = https.createServer(
    { key: await readFile(key), cert: ca },
    (request, response) => {
      if (request.url === "/drip") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"value":"');
        const timer = setInterval(() => response.write("x"), 10);
        timers.add(timer);
        response.on("close", () => {
          clearInterval(timer);
          timers.delete(timer);
        });
      } else if (request.url === "/redirect") {
        response
          .writeHead(302, { location: "https://example.invalid/steal" })
          .end();
      } else
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            authenticated: request.headers.authorization !== undefined,
          }),
        );
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  origin = new URL(`https://127.0.0.1:${address.port}/`);
});
afterAll(async () => {
  for (const timer of timers) clearInterval(timer);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});
describe("outbound Host HTTPS boundary", () => {
  it("validates TLS, rejects redirects, and sends credentials only to the configured origin", async () => {
    const client = new HostClient(origin, ca);
    expect(
      await client.request("/ok", undefined, "fixture-credential"),
    ).toEqual({ authenticated: true });
    await expect(
      new HostClient(origin).request("/ok", undefined, "fixture-credential"),
    ).rejects.toThrow("host_request_failed");
    await expect(
      client.request(
        "https://example.invalid/steal",
        undefined,
        "fixture-credential",
      ),
    ).rejects.toThrow("host_origin_mismatch");
    await expect(
      client.request(
        "//example.invalid/steal",
        undefined,
        "fixture-credential",
      ),
    ).rejects.toThrow("host_origin_mismatch");
    await expect(
      client.request("/redirect", undefined, "fixture-credential"),
    ).rejects.toMatchObject({ status: 302 });
    expect(() => new HostClient(new URL("http://127.0.0.1/"))).toThrow();
  });
  it("enforces a total deadline even when the server continuously sends body bytes", async () => {
    const start = Date.now();
    await expect(
      new HostClient(origin, ca, 80).request(
        "/drip",
        undefined,
        "fixture-credential",
      ),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
