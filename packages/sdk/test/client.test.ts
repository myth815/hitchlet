import { describe, expect, it, vi } from "vitest";
import { HitchletApiError, HitchletClient } from "../src/index.js";
describe("HitchletClient", () => {
  it("returns health payload", async () => {
    const client = new HitchletClient(
      "http://localhost:3000",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "ok",
              stage: "D00",
              simulator: "not_implemented",
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(client.health()).resolves.toMatchObject({
      status: "ok",
      stage: "D00",
    });
  });
  it("rejects invalid health payloads", async () => {
    const client = new HitchletClient(
      "http://localhost:3000",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "ok", stage: "M0", simulator: "ready" }),
            { status: 200 },
          ),
      ),
    );
    await expect(client.health()).rejects.toThrow("invalid health response");
  });

  it("rejects failed responses", async () => {
    const client = new HitchletClient(
      "http://localhost:3000",
      vi.fn(async () => new Response("no", { status: 503 })),
    );
    await expect(client.health()).rejects.toBeInstanceOf(HitchletApiError);
  });
});
