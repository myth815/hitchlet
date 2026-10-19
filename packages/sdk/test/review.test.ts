import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputeClientError, HitchletClient } from "../src/index.js";
import { HttpTransport } from "../src/transport.js";
import type { PreparedTicketCommand } from "@hitchlet/contracts/public";

const command: PreparedTicketCommand = {
  schemaVersion: 1,
  kind: "renew",
  ticketId: "00000000-0000-4000-8000-000000000001",
  idempotencyKey: "review-renewal",
  request: { generation: 1, expectedLeaseVersion: 2 },
};

afterEach(() => vi.restoreAllMocks());

describe("independent SDK protocol review", () => {
  it("calls the default global fetch with its global receiver", async () => {
    let receiver: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(function (
      this: typeof globalThis,
    ) {
      receiver = this;
      return Promise.resolve(Response.json({ status: "ok" }));
    });
    const transport = new HttpTransport("http://localhost");

    await expect(
      transport.request("/healthz", "GET", undefined, (value) => value),
    ).resolves.toEqual({ status: "ok" });
    expect(receiver).toBe(globalThis);
  });

  it("rejects malformed bearer material without exposing it through Headers errors", async () => {
    const sensitive = "review-sensitive-credential-material";
    const token = `${sensitive}\r\nextra-header`;
    const fetcher = vi.fn<typeof fetch>();
    for (const run of [
      () =>
        new HitchletClient("http://localhost", {
          fetch: fetcher,
        }).session.create(token),
      () =>
        new HitchletClient("http://localhost", {
          fetch: fetcher,
          auth: { kind: "bearer", token },
        }).health(),
    ]) {
      const error = await run().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ComputeClientError);
      expect(String(error)).not.toContain(sensitive);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves an ordinary 409 API error without preparing a new renewal", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "renewal_in_progress",
            message: "A proposal is already pending.",
            details: {},
            retryable: false,
            requestId: "00000000-0000-4000-8000-000000000002",
          },
        },
        { status: 409 },
      ),
    );
    const client = new HitchletClient("http://localhost", { fetch: fetcher });
    await expect(client.tickets.resume(command)).rejects.toMatchObject({
      code: "renewal_in_progress",
      statusCode: 409,
      recovery: { command, idempotencyKey: command.idempotencyKey },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the request deadline active until the response body is consumed", async () => {
    let aborted = false;
    const fetcher: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const transport = new HttpTransport("http://localhost", { fetch: fetcher });
    const result = await Promise.race([
      transport
        .request("/healthz", "GET", undefined, (value) => value, {
          timeoutMilliseconds: 10,
        })
        .then(
          () => "unexpected_success",
          () => "deadline_rejected",
        ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("body_still_hanging"), 80),
      ),
    ]);
    expect(result).toBe("deadline_rejected");
    expect(aborted).toBe(true);
  });
});
