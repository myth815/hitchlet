import { AuthenticatedPrincipalSchema } from "@hitchlet/contracts";
import type { AuthenticatedPrincipal } from "@hitchlet/contracts/public";
import { ComputeClientError, HttpTransport } from "./transport.js";

/** Browser session operations. The caller owns credential storage and cookie lifecycle. */
export class SessionCommands {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Exchange a bearer token for same-origin session cookies. The token is used only for
   * this request; the SDK never stores it or includes it in recovery information.
   */
  async create(token: string): Promise<AuthenticatedPrincipal> {
    if (typeof token !== "string" || token.trim().length === 0)
      throw new ComputeClientError({
        code: "INVALID_REQUEST",
        message: "A non-empty bearer token is required to create a session.",
      });
    return this.http.request(
      "/v1/auth/session",
      "POST",
      undefined,
      (value, response) => {
        const principal = AuthenticatedPrincipalSchema.parse(value);
        if (
          response.status !== 201 ||
          principal.source !== "session" ||
          !response.headers.get("X-CSRF-Token")
        )
          throw new Error(
            "Session response is missing its public session metadata.",
          );
        return principal;
      },
      { authExchangeToken: token, retry: false },
    );
  }

  /** Read the principal associated with the configured bearer or cookie credentials. */
  async me(): Promise<AuthenticatedPrincipal> {
    return this.http.request("/v1/auth/me", "GET", undefined, (value) =>
      AuthenticatedPrincipalSchema.parse(value),
    );
  }

  /** End the cookie session; local cookie and CSRF providers remain application-owned. */
  async logout(): Promise<void> {
    return this.http.request(
      "/v1/auth/session",
      "DELETE",
      undefined,
      (value, response) => {
        if (response.status !== 204 || value !== undefined)
          throw new Error(
            "Session logout must return HTTP 204 without a body.",
          );
      },
      { cookieCsrf: true, allowEmptyResponse: true, retry: false },
    );
  }
}
