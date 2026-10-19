import {
  ApiErrorResponseSchema,
  type ApiErrorResponse,
} from "@hitchlet/contracts";
import type { PreparedTicketCommand } from "@hitchlet/contracts/public";

export type SdkAuth =
  | { readonly kind: "bearer"; readonly token: string }
  | {
      readonly kind: "cookie";
      /** CSRF token supplied by the host application; never placed in a URL. */
      readonly csrfToken?: string | (() => string | Promise<string>);
    };

export interface SdkRuntime {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface SdkOptions extends SdkRuntime {
  readonly auth?: SdkAuth;
}

export interface RecoveryReference {
  readonly command: PreparedTicketCommand | null;
  readonly ticketId: string | null;
  readonly renewalId: string | null;
  readonly idempotencyKey: string | null;
}

export class ComputeClientError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly recovery: RecoveryReference;

  constructor(args: {
    code: string;
    message: string;
    requestId?: string | null;
    statusCode?: number | null;
    retryable?: boolean;
    recovery?: Partial<RecoveryReference>;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "ComputeClientError";
    this.code = args.code;
    this.requestId = args.requestId ?? null;
    this.statusCode = args.statusCode ?? null;
    this.retryable = args.retryable ?? false;
    this.recovery = Object.freeze({
      command: args.recovery?.command ?? null,
      ticketId: args.recovery?.ticketId ?? null,
      renewalId: args.recovery?.renewalId ?? null,
      idempotencyKey: args.recovery?.idempotencyKey ?? null,
    });
  }
}

export interface RequestContext {
  readonly command?: PreparedTicketCommand;
  readonly ticketId?: string;
  readonly renewalId?: string;
  readonly key?: string;
  /** One-shot bearer credential exchange; omitted from recovery data and never retried. */
  readonly authExchangeToken?: string;
  /** Require the configured cookie-mode CSRF provider, used by session logout. */
  readonly cookieCsrf?: boolean;
  /** Accept a contractually bodyless response such as DELETE /session 204. */
  readonly allowEmptyResponse?: boolean;
  /** Disable retry for credential-sensitive endpoints. */
  readonly retry?: boolean;
  readonly acceptedStatuses?: readonly number[];
  /** Bounds local network waiting; abort does not undo a write already accepted by the server. */
  readonly timeoutMilliseconds?: number;
  readonly isCancelled?: () => boolean;
}

function setCredentialHeader(
  headers: Headers,
  name: string,
  value: unknown,
  recovery: RecoveryReference,
): void {
  if (typeof value !== "string")
    throw new ComputeClientError({
      code: "AUTH_CONFIGURATION_ERROR",
      message: "Authentication material must be a valid HTTP header value.",
      recovery,
    });
  try {
    headers.set(name, value);
  } catch {
    // Headers implementations include the rejected value in TypeError messages.
    // Do not attach that exception as cause because it may contain a credential.
    throw new ComputeClientError({
      code: "AUTH_CONFIGURATION_ERROR",
      message: "Authentication material must be a valid HTTP header value.",
      recovery,
    });
  }
}

export class HttpTransport {
  readonly baseUrl: URL;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly fetcher: typeof fetch;

  constructor(
    baseUrl: string,
    private readonly options: SdkOptions = {},
  ) {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: unknown,
    parse: (value: unknown, response: Response) => T,
    context: RequestContext = {},
  ): Promise<T> {
    const timeoutMilliseconds = context.timeoutMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1)
      throw new ComputeClientError({
        code: "INVALID_REQUEST_TIMEOUT",
        message: "The request timeout must be a positive integer.",
      });
    const requestDeadline = Date.now() + timeoutMilliseconds;
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    const recovery: RecoveryReference = {
      command: context.command ?? null,
      ticketId: context.ticketId ?? null,
      renewalId: context.renewalId ?? null,
      idempotencyKey: context.key ?? null,
    };
    const headers = new Headers({ Accept: "application/json" });
    const auth = this.options.auth;
    if (context.authExchangeToken !== undefined) {
      if (!context.authExchangeToken.trim())
        throw new ComputeClientError({
          code: "INVALID_REQUEST",
          message: "A non-empty bearer token is required for session exchange.",
        });
      setCredentialHeader(
        headers,
        "Authorization",
        `Bearer ${context.authExchangeToken}`,
        recovery,
      );
    } else if (auth?.kind === "bearer")
      setCredentialHeader(
        headers,
        "Authorization",
        `Bearer ${auth.token}`,
        recovery,
      );
    if (
      (method === "POST" || method === "PUT") &&
      context.authExchangeToken === undefined
    ) {
      headers.set("Content-Type", "application/json");
      if (!context.key)
        throw new ComputeClientError({
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: "A prepared idempotency key is required for every write.",
          recovery,
        });
      headers.set("Idempotency-Key", context.key);
    }
    if (
      (method === "POST" || method === "PUT" || method === "DELETE") &&
      context.authExchangeToken === undefined &&
      (method === "DELETE" || auth?.kind === "cookie")
    ) {
      if (auth?.kind !== "cookie" || auth.csrfToken === undefined) {
        if (context.cookieCsrf || method === "DELETE")
          throw new ComputeClientError({
            code: "AUTH_CONFIGURATION_ERROR",
            message:
              "Cookie session writes require a configured CSRF token provider.",
            recovery,
          });
      } else {
        let token: string;
        try {
          token =
            typeof auth.csrfToken === "function"
              ? await auth.csrfToken()
              : auth.csrfToken;
        } catch {
          throw new ComputeClientError({
            code: "AUTH_CONFIGURATION_ERROR",
            message:
              "The CSRF token provider failed before the write was sent.",
            recovery,
          });
        }
        setCredentialHeader(headers, "X-CSRF-Token", token, recovery);
      }
    }
    const init: RequestInit = {
      method,
      headers,
      ...((method === "POST" || method === "PUT") &&
      context.authExchangeToken === undefined
        ? { body: JSON.stringify(body) }
        : {}),
      credentials:
        context.authExchangeToken !== undefined || auth?.kind === "cookie"
          ? "include"
          : "omit",
    };
    let response: Response | undefined;
    let networkError: unknown;
    let json: unknown;
    let bodyReadError: unknown;
    let bodyReadFailed = false;
    let responseTimedOut = false;
    let responseCancelled = false;
    // One bounded retry is safe for GET and an idempotent POST with the same body/key.
    const maxAttempts =
      context.retry === false || context.authExchangeToken !== undefined
        ? 1
        : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let controller: AbortController | undefined;
      let cancelTimer: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = requestDeadline - Date.now();
        if (remaining <= 0)
          throw new DOMException("Request deadline exceeded", "TimeoutError");
        controller = new AbortController();
        timer = setTimeout(() => controller?.abort(), remaining);
        cancelTimer =
          context.isCancelled === undefined
            ? undefined
            : setInterval(() => {
                if (context.isCancelled?.()) {
                  responseCancelled = true;
                  controller?.abort();
                }
              }, 50);
        response = await this.fetcher(url, {
          ...init,
          signal: controller.signal,
        });
        networkError = undefined;
        if (response.status >= 500 && attempt + 1 < maxAttempts) continue;
        if (response.status === 204 && context.allowEmptyResponse) {
          json = undefined;
          break;
        }
        try {
          json = await response.json();
        } catch (error) {
          bodyReadFailed = true;
          bodyReadError = error;
          responseTimedOut = controller.signal.aborted && !responseCancelled;
        }
        break;
      } catch (error) {
        if (error instanceof ComputeClientError) throw error;
        if (responseCancelled)
          throw new ComputeClientError({
            code: "WAIT_CANCELLED",
            message:
              "Local wait cancelled; the server-side resource was not changed.",
            retryable: false,
            recovery,
            cause: error,
          });
        networkError = error;
        if (attempt + 1 === maxAttempts) {
          throw new ComputeClientError({
            code: "NETWORK_RESULT_UNKNOWN",
            message:
              "The request result is unknown; a timeout or connection failure does not prove the server did not act.",
            retryable: true,
            recovery,
            cause: error,
          });
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (cancelTimer !== undefined) clearInterval(cancelTimer);
      }
    }
    if (networkError !== undefined || response === undefined) {
      throw new ComputeClientError({
        code: "NETWORK_RESULT_UNKNOWN",
        message:
          "The request result is unknown; recover with the original command and idempotency key.",
        retryable: true,
        recovery,
        cause: networkError,
      });
    }
    if (bodyReadFailed) {
      if (responseCancelled)
        throw new ComputeClientError({
          code: "WAIT_CANCELLED",
          message:
            "Local wait cancelled; the server-side resource was not changed.",
          retryable: false,
          recovery,
          cause: bodyReadError,
        });
      if (responseTimedOut)
        throw new ComputeClientError({
          code: "NETWORK_RESULT_UNKNOWN",
          message:
            "The response body timed out; the server may already have completed the request.",
          retryable: true,
          recovery,
          statusCode: response.status,
          cause: bodyReadError,
        });
      throw new ComputeClientError({
        code: response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR",
        message: response.ok
          ? "The server returned invalid JSON."
          : `The server returned HTTP ${response.status} with an unreadable error body.`,
        retryable: !response.ok && response.status >= 500,
        recovery,
        statusCode: response.status,
        cause: bodyReadError,
      });
    }
    if (!response.ok) {
      const error = ApiErrorResponseSchema.safeParse(json);
      if (error.success) {
        const payload: ApiErrorResponse["error"] = error.data.error;
        throw new ComputeClientError({
          code: payload.code,
          message: payload.message,
          requestId: payload.requestId,
          retryable: payload.retryable,
          statusCode: response.status,
          recovery,
        });
      }
      if (!context.acceptedStatuses?.includes(response.status)) {
        throw new ComputeClientError({
          code: "HTTP_ERROR",
          message: `The server returned HTTP ${response.status} with an invalid error body.`,
          retryable: response.status >= 500,
          recovery,
          statusCode: response.status,
        });
      }
    }
    try {
      return parse(json, response);
    } catch (error) {
      if (error instanceof ComputeClientError) throw error;
      throw new ComputeClientError({
        code: "INVALID_RESPONSE",
        message:
          "The server returned a response that does not match the public contract.",
        statusCode: response.status,
        recovery,
        cause: error,
      });
    }
  }
}

export function queryString(
  values: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
