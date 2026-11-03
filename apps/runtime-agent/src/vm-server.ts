import https from "node:https";
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import type { VmAllocationIdentity } from "@hitchlet/contracts/internal";
import { equalSecret } from "./canonical.js";
import { withCommandDeadline } from "./command-exec.js";
import type { FileJournal } from "./journal.js";
import type { ServerConfig } from "./server.js";

const MAX_BODY_BYTES = 256 * 1024;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ACTION_DEADLINE_MS = 240_000;

export type VmRuntimeServerConfig = ServerConfig &
  Readonly<{
    installationId: string;
    runtimeIdentityId: string;
    nativeRuntimeNamespaceId: string;
  }>;

type Binding = {
  requestNonce: string;
  installationId: string;
  runtimeIdentityId: string;
};
type ActionRequest<A> = Binding & {
  controllerEpoch: number;
  deadline: string;
  action: A;
};
/** Shared transport for the two concrete VM drivers, not a provider registry. */
export async function createVmRuntimeServer<
  A,
  R,
  F extends { nativeRuntimeNamespaceId: string },
>(
  config: VmRuntimeServerConfig,
  journal: FileJournal,
  protocol: {
    backend: "tart" | "hyperv";
    actionRequest: z.ZodType<ActionRequest<A>>;
    actionResponse: z.ZodType;
    factsRequest: z.ZodType<Binding>;
    factsResponse: z.ZodType;
    identity(action: A): VmAllocationIdentity;
    execute(action: A): Promise<R>;
    facts(): Promise<F>;
  },
): Promise<https.Server> {
  const [tokenText, ca, cert, key] = await Promise.all([
    readFile(config.tokenFile, "utf8"),
    readFile(config.caFile),
    readFile(config.certFile),
    readFile(config.keyFile),
  ]);
  const token = tokenText.trim();
  const allocationTails = new Map<string, Promise<unknown>>();
  if (!token || token.includes("\n"))
    throw new Error("Runtime Agent token file is empty or invalid");

  const server = https.createServer(
    { key, cert, ca, requestCert: true, rejectUnauthorized: true },
    (request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          reply(response, 404);
          return;
        }
        if (
          request.url !== `/v1/${protocol.backend}/actions` &&
          request.url !== `/v1/${protocol.backend}/facts`
        ) {
          reply(response, 404);
          return;
        }
        const authorization = request.headers.authorization ?? "";
        const received = authorization.startsWith("Bearer ")
          ? authorization.slice(7)
          : "";
        if (!equalSecret(received, token)) {
          reply(response, 401);
          return;
        }

        const raw = await readBoundedBody(request);
        if (raw === "too_large") {
          reply(response, 413);
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          reply(response, 400);
          return;
        }

        if (request.url === `/v1/${protocol.backend}/facts`) {
          const parsed = protocol.factsRequest.safeParse(json);
          if (!parsed.success) {
            reply(response, 400);
            return;
          }
          if (
            parsed.data.installationId !== config.installationId ||
            parsed.data.runtimeIdentityId !== config.runtimeIdentityId
          ) {
            reply(response, 409);
            return;
          }
          try {
            const observedFacts = await protocol.facts();
            if (
              observedFacts.nativeRuntimeNamespaceId !==
              config.nativeRuntimeNamespaceId
            )
              throw new Error("native_namespace_mismatch");
            const result = protocol.factsResponse.parse({
              requestNonce: parsed.data.requestNonce,
              installationId: config.installationId,
              runtimeIdentityId: config.runtimeIdentityId,
              facts: observedFacts,
            });
            reply(response, 200, result);
          } catch {
            reply(response, 409);
          }
          return;
        }

        const parsed = protocol.actionRequest.safeParse(json);
        if (!parsed.success) {
          reply(response, 400);
          return;
        }
        if (
          parsed.data.installationId !== config.installationId ||
          parsed.data.runtimeIdentityId !== config.runtimeIdentityId
        ) {
          reply(response, 409);
          return;
        }
        const requestedDeadline = Date.parse(parsed.data.deadline);
        if (requestedDeadline <= Date.now()) {
          reply(response, 408);
          return;
        }
        if (requestedDeadline > Date.now() + MAX_ACTION_DEADLINE_MS) {
          reply(response, 400);
          return;
        }

        try {
          const action = parsed.data.action;
          const allocationId = protocol.identity(action).allocationId;
          const prior = allocationTails.get(allocationId) ?? Promise.resolve();
          const run = prior.then(async () => {
            if (Date.parse(parsed.data.deadline) <= Date.now())
              throw new Error("vm_action_deadline_expired");
            await journal.serialize(async () => {
              if (Date.parse(parsed.data.deadline) <= Date.now())
                throw new Error("vm_action_deadline_expired");
              if (parsed.data.controllerEpoch < journal.epoch)
                throw new Error("stale_controller_epoch");
              if (parsed.data.controllerEpoch > journal.epoch) {
                journal.setEpoch(parsed.data.controllerEpoch);
                await journal.save();
              }
            });
            if (Date.parse(parsed.data.deadline) <= Date.now())
              throw new Error("vm_action_deadline_expired");
            return withCommandDeadline(Date.parse(parsed.data.deadline), () =>
              protocol.execute(action),
            );
          });
          const tail = run.catch(() => undefined);
          allocationTails.set(allocationId, tail);
          let result: Awaited<typeof run>;
          try {
            result = await run;
          } finally {
            if (allocationTails.get(allocationId) === tail)
              allocationTails.delete(allocationId);
          }
          reply(
            response,
            200,
            protocol.actionResponse.parse({
              requestNonce: parsed.data.requestNonce,
              installationId: config.installationId,
              runtimeIdentityId: config.runtimeIdentityId,
              result,
            }),
          );
        } catch (error) {
          reply(
            response,
            error instanceof Error &&
              error.message === "vm_action_deadline_expired"
              ? 408
              : 409,
          );
        }
      })().catch(() => {
        if (!response.headersSent) reply(response, 500);
      });
    },
  );
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function readBoundedBody(
  request: import("node:http").IncomingMessage,
): Promise<string | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) return "too_large";
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(
  response: import("node:http").ServerResponse,
  status: number,
  body?: unknown,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
