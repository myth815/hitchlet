import type { RuntimeStorageFacts } from "./storage.js";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import {
  runtimeStorageRequestSchema,
  runtimeNetworkCommandSchema,
  runtimeNetworkResultSchema,
} from "@hitchlet/contracts/internal";
import { equalSecret } from "./canonical.js";
import type { NetworkWorker } from "./worker.js";

export type ServerConfig = Readonly<{
  host: string;
  port: number;
  tokenFile: string;
  caFile: string;
  certFile: string;
  keyFile: string;
}>;

export async function createRuntimeServer(
  config: ServerConfig,
  worker: NetworkWorker,
  storage?: RuntimeStorageFacts,
): Promise<https.Server> {
  const [tokenText, ca, cert, key] = await Promise.all([
    readFile(config.tokenFile, "utf8"),
    readFile(config.caFile),
    readFile(config.certFile),
    readFile(config.keyFile),
  ]);
  const token = tokenText.trim();
  if (!token || token.includes("\n"))
    throw new Error("Runtime Agent token file is empty or invalid");
  const server = https.createServer(
    { key, cert, ca, requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      void (async () => {
        if (
          request.method !== "POST" ||
          (request.url !== "/v1/network-actions" &&
            request.url !== "/v1/storage-facts")
        ) {
          response.writeHead(404).end();
          return;
        }
        const authorization = request.headers.authorization ?? "";
        const received = authorization.startsWith("Bearer ")
          ? authorization.slice(7)
          : "";
        if (!equalSecret(received, token)) {
          response.writeHead(401).end();
          return;
        }
        let raw = "";
        for await (const chunk of request) {
          raw += chunk.toString("utf8");
          if (raw.length > 256 * 1024) {
            response.writeHead(413).end();
            return;
          }
        }
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          response.writeHead(400).end();
          return;
        }
        if (request.url === "/v1/storage-facts") {
          const facts = runtimeStorageRequestSchema.safeParse(json);
          if (!storage || !facts.success) {
            response.writeHead(400).end();
            return;
          }
          try {
            const result = await storage.inspect(facts.data);
            response
              .writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
              })
              .end(JSON.stringify(result));
          } catch {
            response.writeHead(409, { "cache-control": "no-store" }).end();
          }
          return;
        }
        const parsed = runtimeNetworkCommandSchema.safeParse(json);
        if (!parsed.success) {
          response.writeHead(400).end();
          return;
        }
        try {
          const result = runtimeNetworkResultSchema.parse(
            await worker.execute(parsed.data),
          );
          response
            .writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
            })
            .end(JSON.stringify(result));
        } catch {
          // Fixed, credential-free errors; command payloads and engine output are never logged or reflected.
          response.writeHead(409, { "cache-control": "no-store" }).end();
        }
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
    },
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function listenRuntimeServer(
  server: https.Server,
  host: string,
  port: number,
): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address() as AddressInfo;
}
