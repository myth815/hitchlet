import { describe, expect, it, vi } from "vitest";
import { HitchletClient, ComputeClientError } from "../src/index.js";
import type { PreparedManagementRequest } from "../src/index.js";
const id = "00000000-0000-4000-8000-000000000001",
  ref = `secret:${"a".repeat(32)}`;
describe("D24 SDK management boundaries", () => {
  it("persists before send and explicitly replays the same safe body/key; a save failure sends nothing", async () => {
    let original: PreparedManagementRequest | undefined,
      lose = true;
    const calls: { body: unknown; key: string | null }[] = [];
    const source = new HitchletClient("https://controller.test", {
      fetch: async (_input, init) => {
        expect(original).toBeDefined();
        calls.push({
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get("Idempotency-Key"),
        });
        if (lose) {
          lose = false;
          throw new TypeError("unknown");
        }
        return Response.json({
          id,
          poolId: id,
          admission: "disabled",
          observedPower: "unknown",
          offline: false,
          powerEnabled: false,
          capacity: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
        });
      },
    });
    const client = source.withManagementPreparation((command) => {
      original = structuredClone(command);
    });
    await expect(
      client.admin.inventory.createMachine(
        {
          name: "original",
          hostOs: "linux",
          architecture: "arm64",
          capacity: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
        },
        "original-key",
      ),
    ).rejects.toMatchObject({ code: "NETWORK_RESULT_UNKNOWN" });
    await client.admin.resumeManagement(original!);
    expect(calls[1]).toEqual(calls[0]);
    const fetcher = vi.fn<typeof fetch>();
    const blocked = new HitchletClient("https://controller.test", {
      fetch: fetcher,
    }).withManagementPreparation(() => {
      throw new Error("quota storage full");
    });
    await expect(
      blocked.admin.inventory.createMachine(
        {
          name: "never sent",
          hostOs: "linux",
          architecture: "arm64",
          capacity: { cpuMillis: 1, memoryMiB: 1, scratchMiB: 0 },
        },
        "blocked-key",
      ),
    ).rejects.toMatchObject({ code: "PREPARED_MANAGEMENT_SAVE_FAILED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates fixed-reference runtime configuration and sends quoted CAS once", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        nodeId: id,
        runtimeConfigured: true,
        admission: "disabled",
        version: 8,
      }),
    );
    const client = new HitchletClient("https://controller.test", {
      fetch: fetcher,
      auth: { kind: "cookie", csrfToken: "csrf" },
    });
    await client.admin.inventory.configureRuntime(
      id,
      {
        accessHost: "192.0.2.4",
        networkCidrBase: "172.28.0.0/16",
        userlandProxy: false,
        runtimeAgent: {
          id,
          baseUrl: "https://agent.test",
          tokenSecretRef: ref,
          caSecretRef: ref,
          clientCertSecretRef: ref,
          clientKeySecretRef: ref,
        },
        managementDenyRevisionId: id,
        managementDenyRules: [],
      },
      7,
      "stable-key",
    );
    const init = fetcher.mock.calls[0]![1]!,
      headers = new Headers(init.headers);
    expect(headers.get("If-Match")).toBe('"7"');
    expect(headers.get("Idempotency-Key")).toBe("stable-key");
    expect(headers.get("X-CSRF-Token")).toBe("csrf");
    expect(init.credentials).toBe("include");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never automatically retries a creation or one-time credential after an unknown response", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("lost response");
    });
    const client = new HitchletClient("https://controller.test", {
      fetch: fetcher,
    });
    await expect(
      client.admin.inventory.createMachine(
        {
          name: "machine",
          hostOs: "linux",
          architecture: "arm64",
          capacity: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
        },
        "persisted-machine-key",
      ),
    ).rejects.toMatchObject({
      code: "NETWORK_RESULT_UNKNOWN",
      recovery: { idempotencyKey: "persisted-machine-key" },
    });
    await expect(
      client.admin.management.issueCredential(id, "one-time-key"),
    ).rejects.toBeInstanceOf(ComputeClientError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("validates SSE frames and preserves decimal cursors beyond JavaScript's integer precision", async () => {
    const event = {
      id: "9007199254740993",
      aggregateType: "ticket",
      aggregateId: id,
      aggregateVersion: 1,
      eventType: "ticket.queued",
      occurredAt: "2026-10-20T00:00:00.000Z",
      payload: { phase: "queued" },
    };
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  `: keepalive\n\nid: ${event.id}\nevent: ticket.queued\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
              c.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const client = new HitchletClient("https://controller.test", {
        fetch: fetcher,
        auth: { kind: "bearer", token: "hcl_fixture_token" },
      }),
      events: unknown[] = [];
    await client.watchEvents(
      "9007199254740992",
      new AbortController().signal,
      (e) => events.push(e),
    );
    expect(events).toEqual([event]);
    const headers = new Headers(fetcher.mock.calls[0]![1]!.headers);
    expect(headers.get("Last-Event-ID")).toBe("9007199254740992");
    expect(headers.get("Authorization")).toBe("Bearer hcl_fixture_token");
  });
});
