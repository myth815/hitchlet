import https from "node:https";
import { z } from "zod";
import {
  hostBootReceiptSchema,
  hostEnrollReceiptSchema,
  hostHeartbeatReceiptSchema,
  hostSessionViewSchema,
  type HostHeartbeat,
} from "@hitchlet/contracts/internal";

export class HostRequestError extends Error {
  constructor(readonly status: number) {
    super(`host_http_${status}`);
  }
}
/** Only explicit transport availability failures and temporary HTTP responses may be retried. */
export class HostTransientError extends Error {
  constructor() {
    super("host_temporarily_unavailable");
  }
}
export function isTransientHostFailure(error: unknown): boolean {
  return (
    error instanceof HostTransientError ||
    (error instanceof HostRequestError &&
      [408, 429, 500, 502, 503, 504].includes(error.status))
  );
}
export function hostConnectionFailure(error: unknown): Error {
  if (error instanceof HostTransientError) return error;
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" &&
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENETDOWN",
      "EHOSTDOWN",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "ERR_HTTP_REQUEST_TIMEOUT",
      "ABORT_ERR",
    ].includes(code)
    ? new HostTransientError()
    : new Error("host_request_failed");
}
/** TLS validation is mandatory. Credentials only go to the configured origin, with no redirects. */
export class HostClient {
  constructor(
    private readonly base: URL,
    private readonly ca?: Buffer,
    private readonly deadlineMs = 15_000,
  ) {
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    )
      throw new Error("Host controller must be an HTTPS origin");
  }
  async request(
    path: string,
    body: unknown,
    credential?: string,
  ): Promise<unknown> {
    const target = new URL(path, this.base);
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      target.origin !== this.base.origin
    )
      throw new Error("host_origin_mismatch");
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = https.request(
        target,
        {
          method: payload === undefined ? "GET" : "POST",
          ...(this.ca ? { ca: this.ca } : {}),
          rejectUnauthorized: true,
          signal: AbortSignal.timeout(this.deadlineMs),
          headers: {
            accept: "application/json",
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }
              : {}),
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          },
        },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            raw += String(chunk);
            if (raw.length > 1024 * 1024) {
              response.destroy();
              reject(new Error("host_response_too_large"));
            }
          });
          response.on("error", (error) => reject(hostConnectionFailure(error)));
          response.on("end", () => {
            if (response.statusCode !== 200 && response.statusCode !== 201) {
              reject(new HostRequestError(response.statusCode ?? 500));
              return;
            }
            try {
              resolve(JSON.parse(raw));
            } catch {
              reject(new Error("host_response_invalid"));
            }
          });
        },
      );
      request.setTimeout(15_000, () =>
        request.destroy(new HostTransientError()),
      );
      request.on("error", (error) => reject(hostConnectionFailure(error)));
      request.end(payload);
    });
  }
  async enroll(body: unknown) {
    return hostEnrollReceiptSchema.parse(
      await this.request("/v1/agents/enroll", body),
    );
  }
  async session(agentId: string, credential: string) {
    return hostSessionViewSchema.parse(
      await this.request(
        `/v1/agents/${z.string().uuid().parse(agentId)}/session`,
        undefined,
        credential,
      ),
    );
  }
  async boot(agentId: string, credential: string, body: unknown) {
    return hostBootReceiptSchema.parse(
      await this.request(
        `/v1/agents/${z.string().uuid().parse(agentId)}/boot`,
        body,
        credential,
      ),
    );
  }
  async heartbeat(agentId: string, credential: string, body: HostHeartbeat) {
    return hostHeartbeatReceiptSchema.parse(
      await this.request(
        `/v1/agents/${z.string().uuid().parse(agentId)}/heartbeat`,
        body,
        credential,
      ),
    );
  }
}
