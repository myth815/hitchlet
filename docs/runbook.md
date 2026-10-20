# Local operation and Docker integration runbook

## Fresh standalone M0 installation (no OpenClaw required)

Start from a clean Hitchlet checkout with Node24 and pnpm10 on PATH. The
controller is one process with one local SQLite ledger; no Docker daemon, NAS,
Host Agent, Portainer or other application is required for M0.

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
export HITCHLET_LAB_ROOT="$(mktemp -d)"
export DATA_DIR="$HITCHLET_LAB_ROOT/controller"
export SIMULATOR_DATA_DIR="$HITCHLET_LAB_ROOT/simulator"
mkdir -m 700 "$DATA_DIR" "$SIMULATOR_DATA_DIR"
pnpm --filter @hitchlet/controller init:simulator
HOST=127.0.0.1 COOKIE_SECURE=false EXECUTION_MODE=simulator \
GUI_DIR="$PWD/apps/gui/dist" pnpm --filter @hitchlet/controller start
```

The initializer prints one consumer token and one administrator token once.
Keep them in a controlled terminal/password manager; do not save terminal output
in source control. `mktemp` creates a disposable local lab; for persistent use
choose two protected local directories instead. Keep the Simulator directory
outside DATA_DIR. Visit `http://127.0.0.1:3000`, consistently using that hostname.
Login as the consumer, select the published Simulator version and authorized
network by name, run the eligibility preview, then submit. Open the Ticket,
explicitly claim, renew and release after both deletion confirmations. Wait for
`released`; Simulator provides no real SSH endpoint. Refresh during a prepared
write to exercise the original-key recovery panel. Logout does not release a
Ticket. Login as administrator to inspect the management overview and timelines.

The browser stores no long-lived token; only safe prepared request records are
kept per Consumer in this tab. Access/new credential output stays in memory.
The [API/SDK guide](api-sdk.md) gives the equivalent bounded SDK sequence and
recovery semantics. The remaining sections cover real Docker and maintenance.
Keep this Simulator lab separate from a real installation; `init:admin` and
`init:simulator` deliberately reject non-empty ledgers.

## Container installation and TLS/cookie boundary

The production Dockerfile builds Node24 artifacts, deploys production controller
dependencies and runs as container user `node` (UID1000). Base `compose.yaml`
publishes only `127.0.0.1:${PORT:-3000}`, starts with execution disabled and keeps
`COOKIE_SECURE=true`. Put an existing HTTPS reverse proxy in front for browser
sessions; proxy `/v1` and GUI to this same service and disable buffering for
`/v1/events/stream`. Retain the origin/hostname when forwarding. Do not set
`COOKIE_SECURE=false` with container `HOST=0.0.0.0`: configuration rejects it.
For a local plain-HTTP browser use the native loopback M0 launch above. Bearer
API requests to the loopback published port do not require a browser cookie.

```sh
cp .env.example .env
docker compose build
docker compose run --rm --no-deps hitchlet node dist/init-admin.js
docker compose up -d
```

The `hitchlet-data` volume holds SQLite, encrypted secrets, verified backups and
bounded logs. Do not mount Docker socket/NAS into the controller. Before enabling
Portainer execution, create an independently protected 32-byte master key file,
make it readable by UID1000 only, and set its absolute host path as
`HITCHLET_MASTER_KEY_HOST_FILE` in your protected `.env`. Do not place the key in
the data volume. On a Linux controller host an administrator can prepare it with:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /srv/hitchlet-key
sudo sh -c 'umask 077; openssl rand 32 > /srv/hitchlet-key/master.key'
sudo chown 1000:1000 /srv/hitchlet-key/master.key
sudo chmod 600 /srv/hitchlet-key/master.key
```

Preserve the original master key separately for restore. Never overwrite an
existing key used to encrypt stored secrets. Supply secrets to the CLI through
stdin, not argv. For example, with a protected Portainer key file:

```sh
docker compose -f compose.yaml -f compose.portainer.yaml run --rm --no-deps -T \
  hitchlet node dist/secret-cli.js add < /safe/portainer-service-key
```

Record only the printed `secret:...` version ref. Add Runtime bearer/CA/client
certificate/private-key files the same way, each as a separate fixed version.
The Docker override mounts the master key read-only at `/run/hitchlet/master.key`.
The already-running base container does not load a key added by a separate CLI.
Restart with the override **while execution remains disabled**, so discovery and
Node configuration can resolve the encrypted refs:

```sh
docker compose down
docker compose -f compose.yaml -f compose.portainer.yaml up -d
```

With the key loaded, complete disabled-mode discovery/configuration and trusted
Agent/evidence setup below. Then explicitly select Portainer execution:

```sh
docker compose -f compose.yaml -f compose.portainer.yaml down
HITCHLET_DOCKER_EXECUTION_MODE=portainer \
docker compose -f compose.yaml -f compose.portainer.yaml up -d
```

Stopping the old process is required before opening the same single-controller
ledger in another container. `compose down` keeps named volumes; do not pass
`-v`. The override loads the key and defaults to disabled; only its explicit
`HITCHLET_DOCKER_EXECUTION_MODE=portainer` enables the backend. `.env`
EXECUTION_MODE does not silently override base Compose. Disk, image-pull budget, backup and bounded-log
settings are passed through Compose with the documented defaults. HTTP to a
real Portainer/Runtime remains forbidden; use validated TLS/private CA trust.

## Real installation bootstrap and Portainer credential handling

`pnpm --filter @hitchlet/controller init:admin` bootstraps only the installation identity and one administrator credential in an empty data directory. Capture the one-time `hcl_...` output in a password manager. It creates an explicit empty platform management-deny baseline, but does not seed a Simulator, runtime identity, node, or capability. Read the installation ID, controller epoch and current baseline from the full-admin, no-store `GET /v1/admin/installation` endpoint. The empty baseline is not proof that management destinations have been inventoried. A non-empty database is rejected.

Create a separate 32-byte master-key file on the controller host, protect it from other users, and back it up separately from the SQLite directory. For a native Linux installation first create `/etc/hitchlet` owned by the controller service account, then run as that account:

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
   In the GUI use **网络与存储 → 平台管理保护基线** to replace the initial empty deny baseline with inventoried protected CIDRs/ports. `PUT /v1/admin/network-deny` takes `expectedRevisionId`, structured `rules`, and `reason`; the server appends an immutable revision and CASes the current pointer. Live Claims or unresolved allocations permit only retained/additional denies. To loosen an accidental rule, pause/drain, finish all cleanup, update the baseline and reconfigure disabled Nodes to the intended protection. Accepted Tickets retain their original constraints; never remove protection to rescue a pending create. Revalidate fingerprints before new publication.
5. `POST /v1/images` creates a logical image and its first draft. Add subsequent versions at `/v1/images/{imageId}/versions` and artifacts at `/v1/image-versions/{versionId}/artifacts`. Read drafts through `/v1/admin/image-versions/{versionId}`. Consumer image/version routes keep their existing published-only DTOs. A pinned digest/platform declaration is not manifest verification or publication.
6. `POST /v1/image-versions/{versionId}/validate` accepts the explicit image artifact, node, network profile, storage requests, resource contract, and bounded deadline. It freezes the selection and uses the shared capacity ledger, without a consumer Ticket, Lease, or access endpoint. Missing verified capabilities return a persisted blocked run, not running/success. Read `/v1/image-validations/{validationId}`.
7. Node `/image-cache/prewarm` and `/image-cache/gc` routes persist exact-artifact operations. Repeating the same action reuses its active operation; an opposite active action returns409. Read the safe receipt at `/v1/nodes/{nodeId}/image-cache/operations/{operationId}`. In Portainer execution mode, an already-present image can be adopted only after registry manifest, platform and local digest verification. GC rechecks pins, allocations and validation references before exact-image deletion; it never runs Docker prune. New pulls require fresh authenticated Runtime Agent facts for the actual DockerRootDir filesystem. Missing/unknown facts, local maintenance or low storage block pulls; safe exact-image GC remains available. Unknown image size uses the configured conservative IMAGE_PULL_BUDGET_MIB estimate, not a claim of exact registry disk usage. `queued`, `unknown` or `evicting` never means ready or deleted.

Do not enable a node by editing SQLite or reuse the Simulator as proof of Docker isolation. M1 experimental Docker and D23 maintenance/storage/recovery have passed independent review in the recorded Linux arm64 test environment; D24 delivery acceptance has passed; M2 still requires D25 formal Host admission and per-node release acceptance. Hyper-V, Tart, WOL, and smart-plug actions remain outside these steps.

## Experimental Docker validation and renting

Use an isolated Linux Engine. Follow the [Runtime Agent deployment instructions](../apps/runtime-agent/README.md) and the [Node SSH image recipe](../docker/node-ssh-v1/Dockerfile). The controller and Agent must agree on installation, runtime identity, native Engine and Agent identities; keep Agent credentials in the versioned secret store and journal data on persistent storage.

While the Node is disabled, configure `/v1/nodes/{nodeId}/runtime-config` with its current `If-Match` version. Supply the access host, allocation CIDR base, actual userland-proxy mode, Agent endpoint and secret version references, and explicit management-deny rules/baseline. The current schema is available in OpenAPI; the runtime profile is not a consumer-supplied shell or mount template.

Before admitting the Node, collect actual resource-limit, INPUT/FORWARD, IPv6, SSH-bootstrap and cleanup-recovery evidence for the exact Engine and network profile revisions. Submit the bounded manual report at `/v1/nodes/{nodeId}/capability-attestations` with `If-Match`. This temporary constant-online/manual-inventory mode expires after one hour; live observations do not extend that capability expiry. It does not establish human absence, safe power control, persistent storage or strict offline lease enforcement. Unsupported hard requirements are rejected.

Restart with `EXECUTION_MODE=portainer` and the same control directory/master key. Schedule the draft validation from the minimal administrator GUI or the validation API. Inspect both test outcome and cleanup status. Only a successful run with completed cleanup and its immutable report can support publication; a passing test whose resources are still being reclaimed is insufficient. Cancel through `/v1/image-validations/{validationId}/cancel` and allow the same worker to finish reclamation. An unknown result retains its capacity Claim until the owned native resources and remote effects are resolved.

Publish with `POST /v1/image-versions/{versionId}/publish` using `expectedEntityVersion`, then move the desired image alias using its own expected version. The server rechecks every required artifact, report, cleanup result, frozen contract and live runtime fingerprint. Consumers can then use the normal Ticket API/SDK: acquire, wait ready, claim, request access, renew and release. SSH material is per allocation and returned only through the authorized access endpoint. Release acceptance is not proof of cleanup: wait until released before considering capacity reusable.

The management workbench now covers actor-scoped overview/Tickets/operations, backend revisions, Machine/Node registration, fixed Runtime secret refs, network/storage revision forms, Consumer grants/quotas, draft versions/artifacts, cache intents, validation mounts/reports, publication/aliases/retirement and the existing machine/power-preview/system maintenance. Capability certification remains the trusted external evidence/API workflow: GUI fields cannot manufacture verified isolation or identity. D24 browser/clean-install and real Docker integration have **passed independent main-reviewer acceptance**; see [implementation evidence](IMPLEMENTATION.md). D25 remains final per-node release acceptance, not a substitute for these delivery obligations.

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
2. Select the published seeded version and authorized network by name in the
   request wizard, then request resources within quota and preview eligibility.
   Network/storage and per-architecture version choices come from `/v1/catalog`;
   no host source or secret reference is returned to consumers. Persistent
   mounts are optional and restricted to authorized prefixes/modes/targets.
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
credential expires or is revoked, or its Consumer is disabled. D23 provides full-administrator credential metadata and rotation through
`/v1/system/credentials` and `/v1/system/credentials/rotate`; full account
administration remains outside this operational API. Login failures are rate-limited per source
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

## D23 operational maintenance and isolated restore

D23 has passed independent Docker/local/NFS4.2 and isolated restore acceptance
in the recorded Linux arm64 review environment. A small fixture took 44 seconds
from backup through restored cleanup; this is not a general production RTO.
Daily-backup RPO ≤24 hours remains an operational objective; validate your data
volume, NAS and recovery procedure before relying on that objective. Automatic
daily snapshots continue while admission is administratively paused. Low/full/
unknown local disk and recovery isolation skip deferrable backups. Cleanup,
accepted lease continuation and history/log reclamation stay available. A disk
failure can still prevent durable writes; no software promises cleanup commits
on a physically unwritable filesystem. `/v1/system/health` exposes the gate and
per-Node Runtime capacity facts. Freshness uses the controller receipt time after
an authenticated nonce-bound complete HTTP exchange (default10-second total
deadline, configurable up to30 seconds). Agent sample time is retained separately
as diagnostic sampledAtMs; cross-host clock skew does not gate admission. Missing/
stale (>30 seconds since receipt) real Node facts block
reservation and creation even with no persistent mounts.

Full administrators may call (all responses `Cache-Control: no-store`):

- `GET /v1/system/health`, `/diagnostics`, `/backups`, `/credentials?consumerId=...`.
- `POST /v1/system/admission/pause` or `/resume`, body `{ "reason": "..." }`.
- `POST /v1/system/backups`, with JSON body `{}` and `Idempotency-Key`. Reusing the key returns the
  original receipt, including after a lost response; failed backups need a new key.
- `POST /v1/system/credentials/rotate`, body `{ "consumerId": "...", "credentialId": "..." }`.
  Obtain IDs from the metadata list, never SQLite. Old bearer and all its derived
  GUI sessions immediately fail. Save the one-time token securely. Restored
  consumers whose credentials were all revoked may receive a replacement through
  this same API. A lost rotation response requires explicit administrator recovery.
- `POST /v1/system/recovery/approve`, body `{ "reason": "...", "oldControllerStopped": true,
"oldProviderCredentialsRevoked": true, "oldRuntimeCredentialsRevoked": true }`.
  Approval checks evidence and leaves admission paused; resume is separate.

Use `client.admin.systemHealth/diagnostics/backups/backup/credentials`,
`pauseAdmission/resumeAdmission`, `rotateCredential` and `approveRecovery` in the
TypeScript SDK. Rotation never retries automatically. Browser one-time token
output lives only in memory, including when self-rotation invalidates that session.
Clear the output after safely recording it; closing/reloading the page loses it.

The worker uses better-sqlite3's online backup API, serializes it with SQL/close,
checks integrity and foreign keys, fsyncs and publishes a self-contained snapshot
under `DATA_DIR/backups/<id>.sqlite` plus safe metadata. Do not copy the active
SQLite file or ignore WAL. A filesystem snapshot alone is not a verified backup.
Copy completed snapshots to independently protected external storage using your
normal backup facility. Independently protect the encrypted `DATA_DIR/secrets`
directory and inject its original read-only master key file separately; the
controller never bundles that key into a backup or diagnostics response.

Offline restore sequence (run from `apps/controller`, Node24, compiled dist):

1. Stop and disable restart of the old controller. Preserve its whole fault data
   directory. Restore is allowed only into an empty, separate destination.
2. `BACKUP_FILE=/safe/snapshot.sqlite RESTORE_DATA_DIR=/new/isolated-data OLD_CONTROLLER_STOPPED=true RESTORE_SECRETS_DIR=/safe/encrypted-secrets HITCHLET_SECRET_KEY_FILE=/separate/master-key node dist/recovery-cli.js restore`.
   Secret directory may be omitted only when no encrypted backend secrets are
   needed. The fresh admin token is emitted once to the controlled terminal.
   Migration/integrity/FK failure leaves the isolated destination closed and the
   original fault directory untouched. Do not remove failure markers to force start.
3. Start the restored controller against this isolated DATA_DIR and separate key.
   The `controls_required` gate permits administration but no backend loops.
   All old consumer tokens/sessions and Host credentials were revoked; pair Hosts
   again through the normal enrollment API. Restored Nodes remain disabled.
4. Using independent provider administration, revoke **all** keys and control
   sessions held by the old controller account, including keys created after the
   backup (the restored ledger cannot enumerate facts it never recorded). Stop/
   disable old deployments and remove their access to replacement secrets. The
   takeover verifier additionally requires rejection of **every historical**
   Portainer key represented by the restored ledger,
   including inactive revisions. Create, probe and activate new revisions for
   each logical connection using the normal API, proving the same immutable
   Engine. Recreate/rotate the Runtime Agent bearer; retain trusted TLS material
   long enough to prove old bearer HTTP401/403 (network/TLS timeout is not proof).
   Preserve the Agent journal; its authenticated epoch is a fence, not identity.
   New secrets are added with `secret-cli.js` and their refs used in APIs/plan.
5. Stop the restored controller. Write a protected CONTROL_TAKEOVER_FILE JSON:
   `{ "oldControllerStopped": true, "connections": [{ "connectionId": "...", "revisionId": "new-current-revision" }], "runtimes": [{ "nodeId": "...", "runtimeProfile": { "...": "complete NodeRuntimeConfig including new bearer ref" } }] }`.
   Supply one new revision per logical connection and one Runtime profile per
   Node. `DATA_DIR=/new/isolated-data HITCHLET_SECRET_KEY_FILE=/separate/master-key CONTROL_TAKEOVER_FILE=/safe/plan.json node dist/recovery-cli.js takeover`.
   This performs read-only authenticated old-key rejection, same-Engine and owned
   inventory checks. Extra native objects, including reappearing completed
   allocations, quarantine their Node; none is destroyed automatically.
6. Restart in `reconciling`. Ordinary integrity audits inspect each restored ready
   tenant manifest with new authenticated transport, retaining the same container,
   lease deadline, Claim and entry when healthy. Expired/revoked leases follow
   normal cleanup; unknowns stay occupied and disabled. Internal validation has no
   tenant Lease: its authenticated inventory may remain isolated, never published
   or released merely to finish recovery. Resolve failures or explicitly terminate
   resources through normal APIs; do not edit SQLite.
7. Review fresh integrity and isolated Nodes, approve recovery, then explicitly
   resume admission. Enable/re-attest only Nodes whose identity, storage/network
   capability and Host inputs have been checked. Unknown Nodes remain disabled.

An activated connection/Agent credential is a replaceable authenticated transport
for the same runtime. Existing operation identity, labels and frozen network/
storage contract do not change; actual transport revision is recorded in result
metadata. The resolver changes only Agent transport credentials, preserving frozen
network semantics. A different Engine cannot take over the old runtime identity.

Retention defaults: resource events/success details30 days, released Ticket
summaries/acquire keys/audit180 days, terminal released-ticket renewal history7
days only without unresolved command/receipt/reference dependencies. Published
validation reports, unknown effects, current power restore obligations, active
Claims and referenced JSON/FK graphs survive. Agent completed receipts survive
command deadline+7 days; unresolved effects and active/revoked fences are retained.
A removed fence can expire after8 days only without unresolved commands. Very old
keys may become new requests; persist Ticket IDs. A pruned renewal404 never proves
success. Regular and pre-upgrade backups retain7 daily plus4 weekly buckets
(configurable); upgrade snapshots have fixed `upgrade-<ms>-v<schema>.sqlite` names.
Logs rotate to a bounded count; low storage discards archived logs before probing.

Configuration: DISK_LOW_WATER_MIB=1024, DISK_RESERVE_MIB=128,
IMAGE_PULL_BUDGET_MIB=8192, LOG_MAX_BYTES=10485760, LOG_FILES=5,
BACKUP_DAILY_COPIES=7, BACKUP_WEEKLY_COPIES=4. Reserve must be less than low water.
D23 adds migration007;001–006 remain byte-for-byte unchanged. Every upgrade from
an older schema first creates and verifies an online snapshot; failure leaves
maintenance markers and does not start a partially migrated service. Offline
lease enforcement remains unsupported; VM and actual power actions remain deferred.

## Docker onboarding and trial checklist

Use a dedicated Linux Engine/Portainer environment and a new real installation,
not the M0 seed. Each operation below has a normal GUI/API entry; do not create
Machine/Node, grant, capability or publication rows with SQLite tools.

1. Initialize `init:admin`, configure TLS and encrypted secret refs, then start
   in disabled execution mode. Open **后端与节点**, enter the Portainer endpoint,
   decimal environment number and fixed secret ref. Check the original discovery
   receipt and actual Engine/OS/architecture; 202/unknown is not registration
   success. A same-Engine credential/address change uses a proposed revision,
   its original proposal receipt, then explicit CAS activation.
2. Register the actual physical Machine OS/architecture and a conservative total
   budget within observed Engine CPU/memory. Register a disabled Node against
   that Machine and verified logical connection. The external always-on Docker
   base has an infrastructure Hold; foreign containers remain reported/unmanaged.
   In the machine page set system/human reserve and attended/unattended ceilings,
   preview effects, then save using the observed version. Human reserve is
   included in system reserve and is not charged twice.
3. In **网络与存储** inventory and configure the platform management deny baseline,
   network egress/ingress and IPv6-disabled profile. Grant only intended Consumers.
   For optional local/NFS/SMB data, the trusted Agent config must already map the
   approved source root; declare only the allowed relative prefixes and modes.
   There is no requirement to mount a NAS for a no-data trial. A profile revision
   does not attest that a host root is mounted or isolated.
4. Deploy Runtime Agent using its [deployment instructions](../apps/runtime-agent/README.md).
   The protected config binds installation, Agent, runtime identity and immutable
   Engine ID. Persist the Agent journal and mTLS/bearer files. In **后端与节点**
   configure the disabled Node's actual access host/CIDR/proxy mode and fixed
   secret refs; read the fresh Node version for CAS. Do not put plaintext secrets
   in a form. Use the physical [Host instructions](../apps/runtime-agent/HOST.md)
   for native Host identity, pairing, enrollment and boot supervision. A guest
   observer is not evidence of the enclosing physical host.
5. Execute the independent capability tests from the existing D10/D20/D23
   workflow: exact Engine/version/architecture, CPU/memory enforcement,
   INPUT/FORWARD and allowed ingress, management deny/data egress, IPv6,
   SSH/bootstrap identity, cleanup recovery; for storage also read-only,
   independent-write, source-boundary and persistent-survival tests. Submit the
   real recent report using `attestCapabilities` / the capability-attestations
   API. IDs/hash/checkboxes alone are not evidence. GUI only displays the result
   and expiry. Trial constant-online/manual-inventory evidence expires after one
   hour; re-run/import fresh evidence as required. Formal observed-host admission
   requires actual native observation and policy acceptance; do not mark other
   OS/architectures verified because their collector code or fixture tests exist.
6. Build and push the repository [Node SSH recipe](../docker/node-ssh-v1/Dockerfile)
   to your controlled registry, inspect its real Linux platform manifest and
   record `name@sha256:<immutable-manifest-digest>` for each actual architecture.
   In **镜像登记** create the draft, declare the supported fixed SSH recipe,
   resource minimums and consumer grants. Add versions/artifacts using the
   directory selectors. A tag, multi-architecture declaration or digest string
   is not a successful pull or platform test.
7. Restart execution in Portainer mode. In **验证、机器与系统维护** select the
   existing draft/artifact/Node/network and optional authorized validation mounts,
   then schedule once. Follow that original run through tests and cleanup; inspect
   the report, deadline and evidence expiry. Only passed tests plus complete
   verified cleanup can publish; old/mismatched report fingerprints remain invalid.
   Cancel uses the same cleanup path. Cache prewarm is an original intent with a
   receipt, and GC only deletes exact unreferenced cache objects.
8. Publish at current entityVersion, then explicitly move an alias using its own
   CAS. Configure a Consumer's image/Node/network/storage grants, concurrency,
   cumulative resources, TTL and maximum lifetime in **消费者与配额**. destroy
   policy edits only name/association; they do not introduce alternate expiry
   behavior. Explicitly issue a token once and store it securely; use separate
   read-only/operator credentials for permission checks.
9. Sign in as that Consumer. Choose an immutable published version and authorized
   network/storage, preview, acquire and wait ready. Claim, obtain the per-instance
   short-lived connection material, actually connect and check the intended mount
   modes and isolation. Renew using the manual original proposal; release after
   saving work. Verify `released`, owned resources absent and capacity returned;
   NAS output must survive. Repeat with a second independent Ticket and denied
   viewer/out-of-scope operator actions. Persist the evidence for this exact
   Node; current release evidence does not certify untested hardware.
10. Exercise D23 pause/backup, isolated offline restore and control credential
    takeover using the previous section. After restore keep admission paused
    until identity, inventory, frozen ready allocations, cleanup and fresh Host/
    Runtime facts have been checked; approve, then resume separately. Do not run
    the old and restored controllers simultaneously against the same runtime.

This is a Docker delivery checklist. Containers are `shared_kernel`; scratch is
`best_effort` unless a real hard-limit capability is verified (current Docker
does not claim it); strict offline enforcement is unsupported. The external
Linux base is manually maintained/always on; actual power execution is disabled.
Hyper-V, Tart, cloud expansion and physical WOL/smart-plug commissioning remain
later capabilities and are not prerequisites to completing Docker delivery.
The recorded real integration evidence is the specific Linux arm64 review
environment in IMPLEMENTATION; do not advertise all Linux/Windows/macOS or CPU
architectures as deployed and supported based on TypeScript or Simulator tests.

## Common incidents through normal APIs

| Symptom                                                   | Check and action                                                                                                                                                                                                                                           | What must remain true                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GUI/session fails over HTTP                               | Use the native loopback launch with insecure cookie only on loopback, or use the Compose HTTPS proxy. Re-login after rotation/role edit. Check CSRF cookie/header and hostname.                                                                            | Do not persist a bearer in browser storage or disable TLS validation.                                                                                        |
| Lost create/validation/cache reply                        | Keep the original key/body/CAS. Check **待调查**, `/v1/admin/commands`, original operation and resource directory. Use **按保存的原请求恢复**; it preserves the exact request across refresh.                                                              | No new create key while the original effect is unknown.                                                                                                      |
| Controller crashed after journalling a management command | `management_result_unknown` deliberately blocks replay of that effect. Inspect its original Operation/objects and the relevant directory. Record explicit human investigation with reason and the actual evidence target only after the outcome is known.  | Review is audit only; it cannot manufacture success or release Claims. Unrelated cleanup/maintenance stays usable.                                           |
| Lost credential issuance/rotation response                | Inspect full-admin credential metadata. Issuance keys have atomic safe metadata, never a recoverable token. Revoke/rotate that credential explicitly and store the new one-time output.                                                                    | Do not retry issuance automatically; old sessions must fail.                                                                                                 |
| 409/412 when saving                                       | Refresh current scope/configuration, discard or compare the stale form, then explicitly save a new intention with its current version/new key. Same key with changed body/If-Match is rejected.                                                            | Accepted Tickets retain their original image/profile/resource/lease contract.                                                                                |
| Ticket queued                                             | Read scheduling reasons, quota/limits, immutable image architecture, exact verified network/storage revisions, admission and Node/Host facts. Fix/authorize/attest the intended profile/Node through normal management, then allow the scheduler to retry. | A preview or displayed free budget does not reserve capacity. Unknown capacity/observations are not zero or healthy.                                         |
| Node/Engine identity changed or Portainer key expired     | Disable/drain new admission. Probe new credentials/address as a revision of the same logical connection and verify the same immutable Engine. Activate explicitly. A different Engine is another Node/runtime.                                             | 404 on a wrong Engine never proves old resources absent; original Claim remains occupied.                                                                    |
| Host/Runtime facts stale or incomplete                    | Inspect machine dependencies, native observer/Runtime service and trusted TLS/bearer configuration. Fix/re-enroll or rotate as documented, retain journals, then await authenticated fresh facts. Re-attest expired capability evidence.                   | Do not turn a GUI field into a verified capability or silently substitute a Simulator.                                                                       |
| Cleanup blocked/failed                                    | Open Ticket timeline/original operation, fix the actual reachability/identity/storage failure. An authorized operator supplies reason/current operation version and retries the **failed original** cleanup; unknown/running operations are inspected.     | No manual resource/Claim row deletion and no capacity release until owned objects/remote effects are actually absent.                                        |
| Validation passed but publish rejected                    | Check cleanup complete, deadline/evidence expiry, all architecture reports, current Node/connection/profile/deny revisions and image entityVersion. Revalidate the intended immutable artifact if fingerprint changed.                                     | Do not reuse an old report or publish solely because testOutcome is passed.                                                                                  |
| Disk low/full, cache pull blocked                         | Inspect system health/runtime facts. Pause new work, use bounded exact-cache GC for unreferenced objects and normal log/history retention. Move completed backups to independent protected storage. Fix actual filesystem capacity before explicit resume. | Cleanup/renewal/reconciliation retain priority; filesystem failure can still prevent a durable write. Never delete active SQLite/WAL or live Agent journals. |
| Bad platform deny rule                                    | With live Claims, only tighten/retain rules. Pause/drain and actually complete cleanup first before reducing a rule; update by baseline CAS and reconfigure disabled Nodes/real evidence.                                                                  | Existing frozen Tickets retain earlier restrictions. A policy edit cannot bypass old protection.                                                             |

Management Ticket export contains only the current authorized page's explicit
IDs, owner, phase/version, resource amounts, placement/lease/cleanup summary and
snapshot time; no access credential, secret ref, source, arbitrary labels or raw
provider intent/result. Timeline/operation projection likewise exposes only safe
fields. Historical or pruned records do not certify success. Event reconnects
resume decimal cursors and bounded snapshot polling compensates when disconnected.

Before accepting D24 independently, exercise the current GUI with real browser
sessions at narrow width and keyboard focus, long IDs/errors, local Chinese
time display, disconnect/reconnect, CAS conflict and prepared-command refresh.
Use real viewer/consumer/operator/full and restricted-admin credentials to test
server denials as well as disabled buttons. Run the clean M0 installation and
the dedicated real Docker checklist above, including D23 restore/rotation. Unit
fixtures are valuable regression evidence, not replacement hardware/browser
acceptance.
