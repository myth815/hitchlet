import { describe, expect, it, vi } from "vitest";
import { ComputeClientError, HitchletClient } from "../src/index.js";

const principal = {
  consumerId: "00000000-0000-4000-8000-000000000001",
  role: "consumer" as const,
  scopes: ["ticket:read"],
  source: "session" as const,
};

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("HitchletClient session surface", () => {
  it("exchanges a one-shot bearer for cookies and validates session metadata", async () => {
    const fetcher = vi.fn(async () =>
      response(principal, 201, { "X-CSRF-Token": "csrf-value" }),
    );
    const client = new HitchletClient("http://localhost:3000", {
      fetch: fetcher,
      auth: { kind: "cookie", csrfToken: () => "csrf-cookie-value" },
    });

    await expect(client.session.create("bearer-secret")).resolves.toEqual(
      principal,
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:3000/v1/auth/session");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer bearer-secret",
    );
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeNull();
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBeNull();
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe("include");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the configured cookie and CSRF provider for me and bodyless logout", async () => {
    const fetcher = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockResolvedValueOnce(response(principal))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HitchletClient("http://localhost:3000", {
      fetch: fetcher as typeof fetch,
      auth: { kind: "cookie", csrfToken: () => "csrf-value" },
    });

    await expect(client.session.me()).resolves.toEqual(principal);
    await expect(client.session.logout()).resolves.toBeUndefined();
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe("http://localhost:3000/v1/auth/session");
    expect(init?.method).toBe("DELETE");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-value");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBeNull();
    expect(init?.body).toBeUndefined();
  });

  it("does not retry uncertain credential exchange or expose its token in recovery", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connection closed");
    });
    const client = new HitchletClient("http://localhost:3000", {
      fetch: fetcher,
    });

    let caught: unknown;
    try {
      await client.session.create("never-persist-this-token");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComputeClientError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const error = caught as ComputeClientError;
    expect(JSON.stringify(error.recovery)).not.toContain(
      "never-persist-this-token",
    );
    expect(JSON.stringify(error)).not.toContain("never-persist-this-token");
  });

  it("does not expose invalid or throwing CSRF credentials", async () => {
    const sensitive = "private-csrf-material";
    for (const csrfToken of [
      `${sensitive}\r\nInjected: value`,
      () => {
        throw new Error(sensitive);
      },
    ]) {
      const fetcher = vi.fn<typeof fetch>();
      const client = new HitchletClient("http://localhost:3000", {
        fetch: fetcher,
        auth: { kind: "cookie", csrfToken },
      });
      const error = await client.session
        .logout()
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ComputeClientError);
      expect(String(error)).not.toContain(sensitive);
      expect(JSON.stringify(error)).not.toContain(sensitive);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
});
