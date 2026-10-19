# Local operation and Docker integration runbook

## Real installation bootstrap and Portainer credential handling

`pnpm --filter @hitchlet/controller init:admin` bootstraps only the installation identity and one administrator credential in an empty data directory. Capture the one-time `hcl_...` output in a password manager. It creates an explicit empty platform management-deny baseline, but does not seed a Simulator, runtime identity, node, or capability. Read the installation ID, controller epoch and current baseline from the full-admin, no-store `GET /v1/admin/installation` endpoint. The empty baseline is not proof that management destinations have been inventoried. A non-empty database is rejected.

Create a separate 32-byte master-key file on the controller host, protect it from other users, and back it up separately from the SQLite directory. For example, on Linux:

```sh
umask 077
openssl rand 32 > /etc/hitchlet/secret-master.key
```

Set `HITCHLET_SECRET_KEY_FILE=/etc/hitchlet/secret-master.key` for the controller. Import a Portainer API key without placing its value in command arguments or shell history:

```sh
read -rs PORTAINER_API_KEY
printf '%s' "$PORTAINER_API_KEY" | DATA_DIR=/var/lib/hitchlet HITCHLET_SECRET_KEY_FILE=/etc/hitchlet/secret-master.key pnpm --filter @hitchlet/controller secret:add
unset PORTAINER_API_KEY
```

The command prints a version reference. Pass only that reference to the management API; the controller resolves the encrypted value locally. The API response and SQLite ledger never contain the key. HTTPS verifies certificates by default. For a private CA, configure the Node runtime's `NODE_EXTRA_CA_CERTS` with the CA file; do not disable certificate verification. Portainer endpoint URLs must be origin-root URLs with no path, query, or fragment because Portainer's environment proxy routes are rooted at `/api`; explicitly configure a reverse proxy at that root if needed. Plain HTTP requires the explicit `PORTAINER_ALLOW_LOOPBACK_HTTP=true` development setting and a loopback URL. The master key is not recoverable from the SQLite backup.

## Portainer registration workflow

Use a separate empty installation for real registration. Start the built controller with its `DATA_DIR`, `HITCHLET_SECRET_KEY_FILE`, and `EXECUTION_MODE=disabled`. Authenticate management requests with the full administrator bearer, or an administrator session with CSRF on writes. Restricted administrator credentials cannot manage resources. `GET /v1/openapi.json` describes the request and response schemas.

1. `POST /v1/provider-connections` with `endpointUrl`, decimal-string `environmentId`, and `secretVersionRef`. It persists a read-only discovery operation before probing. The 202 receipt includes `operationId`, `state`, and a safe `result`; check for `succeeded` rather than treating 202 as verified. A failed probe remains `unknown` and does not register an identity or node. Read `GET /v1/provider-discovery/{operationId}` and retry with `POST /v1/provider-discovery/{operationId}/retry`; retries retain the saved target and secret version.
2. To change an address or credential, `POST /v1/provider-connections/{connectionId}/revisions`. Read/retry its operation at `/v1/provider-connection-proposals/{operationId}` and the corresponding `/retry`. It must authenticate as the original Engine. Activate the verified revision explicitly at `/v1/provider-connections/{connectionId}/activate-revision` with `revisionId` and the current connection `If-Match` version. Existing operations retain their original revision.
3. Register a conservative machine budget at `POST /v1/machines`, then its Portainer node at `POST /v1/nodes`. Both remain disabled/unknown. An infrastructure Hold protects an external Docker base; observed foreign containers add an unmanaged-work Hold. Registration does not verify hard limits, network rules, storage, human absence, or power control and does not enable ordinary renting.
4. Create authorized network/storage profiles at `/v1/network-profiles` and `/v1/storage-profiles`; create immutable subsequent revisions at `/{profileId}/revisions` with `If-Match`. New current revisions do not rewrite existing frozen contracts. Storage profiles declare a fixed `sourceRef`, `allowedSubpaths`, `allowedModes`, protocol, and optional secret version; consumers cannot submit arbitrary host mount options.
5. `POST /v1/images` creates a logical image and its first draft. Add subsequent versions at `/v1/images/{imageId}/versions` and artifacts at `/v1/image-versions/{versionId}/artifacts`. Read drafts through `/v1/admin/image-versions/{versionId}`. Consumer image/version routes keep their existing published-only DTOs. A pinned digest/platform declaration is not manifest verification or publication.
6. `POST /v1/image-versions/{versionId}/validate` accepts the explicit image artifact, node, network profile, storage requests, resource contract, and bounded deadline. It freezes the selection and uses the shared capacity ledger, without a consumer Ticket, Lease, or access endpoint. Missing verified capabilities return a persisted blocked run, not running/success. Read `/v1/image-validations/{validationId}`.
7. Node `/image-cache/prewarm` and `/image-cache/gc` routes persist exact-artifact operations. Repeating the same action reuses its active operation; an opposite active action returns409. Read the safe receipt at `/v1/nodes/{nodeId}/image-cache/operations/{operationId}`. In Portainer execution mode, an already-present image can be adopted only after registry manifest, platform and local digest verification. GC rechecks pins, allocations and validation references before exact-image deletion; it never runs Docker prune. New pulls remain blocked with `capacity_unverified` until verified image-store capacity is supplied by the later Host/storage work. `queued`, `unknown` or `evicting` never means ready or deleted.

Do not enable a node by editing SQLite or reuse the Simulator as proof of Docker isolation. The Docker implementation below is still undergoing batch5 acceptance; its presence does not mean M1 or M2 has been released. Hyper-V, Tart, WOL, and smart-plug actions remain outside these steps.

## Experimental Docker validation and renting

Use an isolated Linux Engine. Follow the [Runtime Agent deployment instructions](../apps/runtime-agent/README.md) and the [Node SSH image recipe](../docker/node-ssh-v1/Dockerfile). The controller and Agent must agree on installation, runtime identity, native Engine and Agent identities; keep Agent credentials in the versioned secret store and journal data on persistent storage.

While the Node is disabled, configure `/v1/nodes/{nodeId}/runtime-config` with its current `If-Match` version. Supply the access host, allocation CIDR base, actual userland-proxy mode, Agent endpoint and secret version references, and explicit management-deny rules/baseline. The current schema is available in OpenAPI; the runtime profile is not a consumer-supplied shell or mount template.

Before admitting the Node, collect actual resource-limit, INPUT/FORWARD, IPv6, SSH-bootstrap and cleanup-recovery evidence for the exact Engine and network profile revisions. Submit the bounded manual report at `/v1/nodes/{nodeId}/capability-attestations` with `If-Match`. This temporary constant-online/manual-inventory mode expires after one hour; live observations do not extend that capability expiry. It does not establish human absence, safe power control, persistent storage or strict offline lease enforcement. Unsupported hard requirements are rejected.

Restart with `EXECUTION_MODE=portainer` and the same control directory/master key. Schedule the draft validation from the minimal administrator GUI or the validation API. Inspect both test outcome and cleanup status. Only a successful run with completed cleanup and its immutable report can support publication; a passing test whose resources are still being reclaimed is insufficient. Cancel through `/v1/image-validations/{validationId}/cancel` and allow the same worker to finish reclamation. An unknown result retains its capacity Claim until the owned native resources and remote effects are resolved.

Publish with `POST /v1/image-versions/{versionId}/publish` using `expectedEntityVersion`, then move the desired image alias using its own expected version. The server rechecks every required artifact, report, cleanup result, frozen contract and live runtime fingerprint. Consumers can then use the normal Ticket API/SDK: acquire, wait ready, claim, request access, renew and release. SSH material is per allocation and returned only through the authorized access endpoint. Release acceptance is not proof of cleanup: wait until released before considering capacity reusable.

The administrator GUI currently covers Node status, image versions, explicit validation selection/history, cleanup evidence, publication and alias changes. Full credential/profile/Node configuration forms, backup/restore and final installation acceptance remain in later batches. See [the implementation evidence](IMPLEMENTATION.md) for the exact accepted scope.

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
