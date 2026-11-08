import { expect, it } from "vitest";
import { HitchletClient } from "../src/index.js";
it("console SDK preserves caller command identity without provisioning or automatic input retry", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = new HitchletClient("https://hitchlet.invalid", {
    auth: { kind: "bearer", token: "synthetic" },
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          ticketId: "t",
          generation: 1,
          commandId: "5a0f42b6-94d1-462c-953a-e8cc1622981c",
          expiresAt: "2099-01-01T00:00:00.000Z",
          protocol: "console",
          status: "unknown",
          authentication: {
            kind: "existing_account_login_required",
            username: "workspace",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const command = {
    generation: 1,
    commandId: "5a0f42b6-94d1-462c-953a-e8cc1622981c",
    action: { kind: "key" as const, keyCode: 13 },
  };
  expect((await client.tickets.console("t", command)).status).toBe("unknown");
  expect(calls).toEqual([
    { url: "https://hitchlet.invalid/v1/tickets/t/console", body: command },
  ]);
});

it("interactive SDK prepares once and recovers by GET with caller key and generation", async () => {
  const calls: any[] = [];
  const client = new HitchletClient("https://hitchlet.invalid", {
    auth: { kind: "bearer", token: "synthetic" },
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body,
        key: new Headers(init?.headers).get("idempotency-key"),
      });
      return new Response(
        JSON.stringify({
          ticketId: "t",
          generation: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          status: "unknown",
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  await client.tickets.prepareConsoleCredentials("t", 1, {
    idempotencyKey: "persisted-key",
  });
  await client.tickets.getConsoleCredentials("t", 1);
  expect(calls).toEqual([
    {
      url: "https://hitchlet.invalid/v1/tickets/t/console-credentials",
      method: "POST",
      body: '{"generation":1}',
      key: "persisted-key",
    },
    {
      url: "https://hitchlet.invalid/v1/tickets/t/console-credentials?generation=1",
      method: "GET",
      body: undefined,
      key: null,
    },
  ]);
});
