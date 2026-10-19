# M0 local Simulator runbook

This runbook starts the controller against an explicitly initialized local
Simulator. It does not configure Docker, Portainer, VM isolation, host power,
or real SSH access. The GUI acceptance status is recorded in
`docs/IMPLEMENTATION.md`; running this fixture does not establish real-node readiness.

## Requirements and directories

Use Node.js 24 and pnpm 10. Install the workspace dependencies with
`pnpm install --frozen-lockfile`. Choose two separate absolute, writable
directories: one for the SQLite control ledger (`DATA_DIR`) and another for
Simulator resource state (`SIMULATOR_DATA_DIR`). Do not put the Simulator
directory inside `DATA_DIR`; both are durable state and should be backed up
together when preserving a test environment.

The examples below use `/absolute/path/hitchlet-data` and
`/absolute/path/hitchlet-simulator`. Replace both with paths on your machine.

## Initialize an empty M0 installation

Stop the controller before initializing. The initializer refuses a directory
that already contains an installation; it does not reset or migrate user data.
Run this from the repository root:

```sh
DATA_DIR=/absolute/path/hitchlet-data pnpm --filter @hitchlet/controller init:simulator
```

The command builds the shared contracts and controller, applies the SQLite migrations, and seeds an
explicit Simulator fixture. It prints two bearer credentials once: a sample
consumer token for API testing and an initial administrator token for
administrative/browser sign-in. The database stores credential hashes, not the
printed tokens. Treat both outputs as secrets and keep them out of shell
history, logs, and source control.

The output also contains the sample image ID, its published version UUID, the
network profile ID, and the image alias. The alias is `latest` for that seeded
image; consumer requests can select it with
`image: { "imageId": "<image-id>", "alias": "latest" }`. The printed version
UUID remains available for exact-version selection.

## Start the controller and GUI

Build the workspace from the repository root before serving the production GUI:

```sh
pnpm build
```

For a local HTTP-only run, explicitly bind to loopback and set the independent
Simulator directory. `COOKIE_SECURE=false` is accepted only with a loopback
`HOST`; it allows the local browser session to work over plain HTTP. Secure
cookies remain enabled by default and should stay enabled behind HTTPS.

```sh
HOST=127.0.0.1 \
COOKIE_SECURE=false \
DATA_DIR=/absolute/path/hitchlet-data \
EXECUTION_MODE=simulator \
SIMULATOR_DATA_DIR=/absolute/path/hitchlet-simulator \
GUI_DIR="$PWD/apps/gui/dist" \
pnpm --filter @hitchlet/controller start
```

The initializer builds `dist`, so the `start` command uses the compiled
controller. Open `http://127.0.0.1:3000` for the built GUI. To run the API and
development GUI together instead, use the same environment variables with
`pnpm dev` and open `http://localhost:5173`; Vite proxies `/v1` and `/healthz`
to the local controller. Use the same hostname consistently for a browser session.

The controller recovers persisted operations and pending renewals before it
accepts new work, then periodically reserves queued Tickets, reconciles
operations, decides pending Simulator renewals, and processes expiration and
cleanup. `GET http://127.0.0.1:3000/healthz` reports process stage,
`executionMode`, and `recoveryState`; it is not proof of real compute-node
health.

## Exercise the GUI

1. Sign in with the printed sample consumer token. The administrator token can
   also operate its own Tickets when it has `tickets:write`; viewers remain read-only.
   The password field clears on submission. The GUI exchanges the bearer for an
   HttpOnly session and does not store the bearer in browser storage.
2. Keep the seeded image alias `latest`, enter the printed `networkProfileId`,
   and request resources within the sample quota. An exact version UUID is also
   supported. The GUI does not invent a network-profile directory or arbitrary mounts.
3. Select the Ticket and wait for `ready`. Opening a detail page only reads state;
   use **首次接用 / Claim** explicitly, then request access material or renew manually.
   Simulator material is for contract testing and cannot establish a real connection.
4. To return the environment, check both saved-data and deletion confirmations.
   Wait for **已释放**; an accepted release or **回收中** does not prove cleanup finished.
5. On an uncertain write, use **待恢复操作 → 恢复原操作**. The GUI saves the prepared
   command before sending and replays its original key and body. Up to eight
   unresolved commands are kept per consumer in this tab's `sessionStorage`;
   a full store blocks new commands instead of discarding old ones. Refreshing
   retains these records, but closing the tab can discard them. Automated clients
   that need cross-process recovery should persist SDK `onPrepared` records durably.

Logout ends the browser session and stops local waiting; it does not cancel or
release existing Tickets. Reopening a Ticket does not extend its lease. Access
material stays only in page memory, is hidden after 60 seconds, and is cleared
on detail changes or session exit. The console labels Simulator and unsupported
offline lease enforcement explicitly.

## Exercise the API

Use the sample consumer bearer for tenant API calls:

```sh
curl -H 'Authorization: Bearer <consumer-token>' \
  http://127.0.0.1:3000/v1/images
```

`GET /v1/events` returns a paginated JSON `ResourceEventPage`. The resumable
server-sent event stream is `GET /v1/events/stream`; pass `Last-Event-ID` as a
decimal string to resume. Ticket-scoped JSON history is
`GET /v1/tickets/{ticketId}/events`.

The initial administrator bearer can be exchanged for a browser session:

```sh
curl -i -X POST http://127.0.0.1:3000/v1/auth/session \
  -H 'Authorization: Bearer <admin-token>'
```

The response sets an HttpOnly `hitchlet_session` cookie and a readable
`hitchlet_csrf` cookie, and returns the CSRF value in `X-CSRF-Token`. The
browser uses the cookie for same-origin requests and sends the CSRF value in
`X-CSRF-Token` on writes and logout. `GET /v1/auth/me` returns the safe
principal summary and is `no-store`. Logout is
`DELETE /v1/auth/session` with the session cookies and `X-CSRF-Token`; it
revokes that session. A session also stops authenticating when its issuing
credential expires or is revoked, or its Consumer is disabled. There is no
D05 credential-management API; credential rotation and full account
administration remain future work. Login failures are rate-limited per source
IP.

## Migrations, shutdown, and limitations

The controller applies migrations from
`apps/controller/src/storage/migrations/`. Migration 001 is the frozen v1
baseline; migration 002 adds the issuing-credential link for browser sessions.
On upgrade, old v1 session rows have no source credential and are rejected;
the existing Consumer, Ticket, Event, and migration ledger data remain in
place. `docs/design/schema.sql` is the complete current schema snapshot, not a
replacement for already-applied migration files. Back up both persistent
directories before upgrading and keep failed upgrades stopped for diagnosis.

Stop with Ctrl-C or SIGTERM. The controller closes active SSE streams and the
SQLite worker, releasing its single-controller lock. Do not reset persistent
state unless both directories contain only disposable test data; stop the
controller first and then remove them before running the initializer again.

Simulator access responses explicitly use simulated material and do not
provide a real SSH endpoint. Simulator reports
`offlineLeaseEnforcement=unsupported`; strict offline lease guards remain
future work. This runbook does not establish real-provider, Docker/network,
storage-mount, VM, or machine-power acceptance.
