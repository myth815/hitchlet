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

管理端通过 `client.admin.machines()` / `machineDryRun(machineId)` 读取机器、
Node、容量池和活跃 Allocation 依赖树。`previewHumanUsePolicy(machineId,
{expectedVersion, policy})` 只预演，`updateHumanUsePolicy(machineId, body, key)`
以版本 CAS 保存；`updateNodeAdmissionMode(nodeId, {expectedVersion, mode, reason}, key)`
显式选择 `observed_host` 或常开手工预算试用。写命令不自动重试；响应未知后先
查询当前 Machine/Node，不能用新版本重放旧意图。策略中 `systemReserve` 已含
`humanReserved`，attended/unattendedMaximum 指物理根池占用包络（含底座），
不对嵌套子池再扣一次。partial Host 仅在明确有限有人预算下准入且显示未知负载；
人工试用与这种可信观测路径有独立解释，均不宣称支持自动电源或离线截止。

`client.admin.powerConfiguration(machineId)` returns the strict management power
projection. `previewPowerPolicy` and `updatePowerPolicy` accept
`{expectedVersion, policy}`; only the latter persists. `updatePowerCapabilities`
accepts `{expectedMachineVersion, conclusions}` with unsupported/unverified values
only. `updateSmartPlugBinding` accepts `{expectedMachineVersion, binding|null}`;
the binding uses exact device ID/MAC and fixed endpoint/secret-version references,
never plaintext credentials. `powerPreviews`, `powerPreview`, `startPowerPreview`
and `advancePowerPreview` expose persistent, explicitly synthetic cycles. Advance
uses `{expectedVersion,event}`; events are evaluate/cancel, simulated local
shutdown acceptance, simulated off confirmation, bounded wake, or exact plug
readback/off-result-unknown. All are admin-only; writes take an explicit key and
are not automatically retried. Query the original cycle/configuration after an
uncertain response. D22a never sends real power commands, marks hardware verified,
changes real Machine power/admission, or creates a real Agent receipt. Restore
supply responsibility survives cancellation, policy changes and restart with its
original minimum 600-second off deadline. See design section13 for the full schema
and dry-run/actual execution boundary.
