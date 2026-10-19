# `@hitchlet/sdk`

The SDK provides one consumer client for browser and Node.js callers. Contracts and runtime validation come from `@hitchlet/contracts`; SDK methods never expose controller actors, provider handles, storage paths, or internal database records.

```ts
import { HitchletClient } from "@hitchlet/sdk";

const client = new HitchletClient("https://hitchlet.example", {
  auth: { kind: "bearer", token: process.env.HITCHLET_TOKEN! },
});
const { ticket, idempotencyKey } = await client.tickets.acquire(request, {
  onPrepared: async (command) => saveRecoveryCommand(command),
});
await client.tickets.waitUntilReady(ticket.id);
await client.tickets.claim(ticket.id);
const grant = await client.tickets.getAccess(ticket.id);
```

Cookie authentication uses `auth: { kind: "cookie", csrfToken }`; browser requests include credentials and write requests send `X-CSRF-Token`. The application supplies the session cookie and CSRF token through its session setup. The SDK does not obtain, store, log, or cache authentication material.

For a browser login, `client.session.create(bearerToken)` exchanges the supplied bearer for the server's HttpOnly session cookie and returns the authenticated principal. The bearer is used only for that request, which is never retried. `client.session.me()` reads the current principal, and `client.session.logout()` sends the configured cookie and CSRF token and accepts the API's bodyless `204` response. The host application remains responsible for reading the browser's `hitchlet_csrf` cookie and supplying it through the cookie-mode `csrfToken` provider after reload.

Every write is prepared and deeply frozen before sending. Persist the `PreparedTicketCommand` in `onPrepared` to recover across process restarts with `client.tickets.resume(command)`. Saving only an idempotency key is insufficient because renewals also bind the lease generation and version observed before the first attempt. The callback is awaited before the first network send and if it fails the write is not sent. A network retry reuses the same body and key. Same-key requests that change command kind, target, or intent are rejected locally.

`renew` and `claim` return only an immutable confirmed receipt. Their 15-second local deadline covers the initial Ticket read, prepared-command persistence, write request, and polling of the original renewal ID. If it remains pending, `ComputeClientError.recovery` carries the saved command, ticket and renewal IDs, and idempotency key; that error does not imply the lease was extended. `409` and `412` version conflicts are surfaced without preparing a second proposal.

`waitUntilReady` and `waitUntilReleased` poll with bounded backoff (60 minutes and 5 minutes by default). Their timeout or `isCancelled` callback stops only local waiting; it does not cancel a ticket or release a lease. No background lease renewal or automatic release is performed.

The client accepts a `fetch` override as its second constructor argument for existing callers, or a `SdkOptions` object for authentication and deterministic wait/fetch dependencies. Responses, requests, and saved prepared commands are validated against shared contracts before use.
