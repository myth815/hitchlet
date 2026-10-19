import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { SQLiteIdentityStore } from "../storage/identity-store.js";

type Row = Record<string, string | number | bigint | null>;
export interface Principal {
  readonly principalId: string;
  readonly consumerId: string;
  readonly role: "viewer" | "consumer" | "operator" | "admin";
  readonly scopes: readonly string[];
  readonly source: "bearer" | "session";
  readonly csrfHash?: string;
}
export class AuthFailure extends Error {
  constructor(readonly code: "unauthenticated" | "forbidden" | "csrf_failed") {
    super(code);
  }
}

/** Resolves identities exclusively from persisted credential/session records. */
export class Authenticator {
  private readonly store: SQLiteIdentityStore;
  constructor(
    storage: import("../storage/index.js").Storage,
    private readonly now = Date.now,
  ) {
    this.store = new SQLiteIdentityStore(storage, now);
  }
  async createSession(consumerId: string, credentialId: string) {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const now = this.now();
    await this.store.createSession({
      id: randomUUID(),
      consumerId,
      sourceCredentialId: credentialId,
      tokenHash: digest(token),
      csrfHash: digest(csrfToken),
      now,
      expires: now + 8 * 60 * 60 * 1000,
    });
    return { token, csrfToken };
  }
  async revokeSession(request: FastifyRequest) {
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("hitchlet_session="));
    if (!cookie) throw new AuthFailure("unauthenticated");
    let token: string;
    try {
      token = decodeURIComponent(cookie.slice("hitchlet_session=".length));
    } catch {
      throw new AuthFailure("unauthenticated");
    }
    await this.store.revokeSession(digest(token), this.now());
  }
  async bearerPrincipal(request: FastifyRequest): Promise<Principal> {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) throw new AuthFailure("unauthenticated");
    return this.bearer(auth.slice(7));
  }
  async authenticate(
    request: FastifyRequest,
    write: boolean,
  ): Promise<Principal> {
    const auth = request.headers.authorization;
    if (auth?.startsWith("Bearer ")) return this.bearer(auth.slice(7));
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("hitchlet_session="));
    if (!cookie) throw new AuthFailure("unauthenticated");
    let token: string;
    try {
      token = decodeURIComponent(cookie.slice("hitchlet_session=".length));
    } catch {
      throw new AuthFailure("unauthenticated");
    }
    const hash = digest(token);
    const row = await this.store.session(hash);
    if (!row || row.status !== "active")
      throw new AuthFailure("unauthenticated");
    if (write) {
      const csrf = request.headers["x-csrf-token"];
      const csrfCookie = request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("hitchlet_csrf="));
      let cookieValue: string | undefined;
      try {
        cookieValue = csrfCookie
          ? decodeURIComponent(csrfCookie.slice("hitchlet_csrf=".length))
          : undefined;
      } catch {
        throw new AuthFailure("csrf_failed");
      }
      if (
        typeof csrf !== "string" ||
        !cookieValue ||
        csrf !== cookieValue ||
        digest(csrf) !== row.csrf_token_hash
      )
        throw new AuthFailure("csrf_failed");
    }
    return principal(row, "session", String(row.csrf_token_hash));
  }
  private async bearer(token: string): Promise<Principal> {
    if (token.length < 32 || token.length > 4096)
      throw new AuthFailure("unauthenticated");
    const prefix = token.slice(0, 12);
    const row = await this.store.bearer(prefix, digest(token));
    if (!row || row.status !== "active")
      throw new AuthFailure("unauthenticated");
    const raw = JSON.parse(String(row.scopes_json)) as unknown;
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string"))
      throw new AuthFailure("unauthenticated");
    return principal(row, "bearer", undefined, raw);
  }
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function principal(
  row: Row,
  source: "bearer" | "session",
  csrfHash?: string,
  scopes?: readonly string[],
): Principal {
  const role = String(row.role);
  if (
    !(
      role === "viewer" ||
      role === "consumer" ||
      role === "operator" ||
      role === "admin"
    )
  )
    throw new AuthFailure("unauthenticated");
  return {
    principalId: String(row.id),
    consumerId: String(row.consumer_id),
    role,
    source,
    scopes:
      scopes ??
      (role === "viewer"
        ? ["tickets:read", "images:read", "events:read"]
        : role === "operator" || role === "admin"
          ? [
              "tickets:read",
              "tickets:write",
              "tickets:revoke",
              "images:read",
              "events:read",
            ]
          : ["tickets:read", "tickets:write", "images:read", "events:read"]),
    ...(csrfHash ? { csrfHash } : {}),
  };
}
