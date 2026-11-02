# Resumable Node tenant example

`resumable-tenant.mjs` is a small consumer-side workflow built only on the public
`@hitchlet/sdk` API. It shows explicit catalog selection, a read-only preview,
durable ticket-command recovery, confirmed lease tracking, an access handoff, and
confirmed cleanup. It does not initialize or authorize a platform, publish images,
or perform work on the tenant's behalf.
It is intended for a recoverable experimental deployment, not production
operations.

## Run against the isolated Simulator

Use an already initialized localhost Simulator with an existing consumer token.
The Simulator fixture mode deliberately accepts only its sentinel access response;
it performs no socket connection and does not claim that any SSH host key was
verified.

```sh
export HITCHLET_ORIGIN=http://127.0.0.1:PORT
export HITCHLET_TOKEN='token supplied outside this example'
export HITCHLET_DEMO_STATE_DIR=/absolute/path/to/private-state
export HITCHLET_DEMO_MODE=SIMULATOR_ONLY
node packages/sdk/examples/resumable-tenant.mjs catalog
```

From a clean checkout, install the locked workspace dependencies and build the
public contracts, SDK, and controller packages:

```sh
pnpm install --frozen-lockfile
pnpm --filter @hitchlet/contracts build
pnpm --filter @hitchlet/sdk build
pnpm --filter @hitchlet/controller build
```

The repeatable isolated demonstration is covered by the controller test command
below. It creates a temporary Simulator database, uses a real localhost HTTP
server and CLI subprocess restarts, then removes the temporary fixture; it does
not start a real stack:

```sh
pnpm --filter @hitchlet/controller exec vitest run test/sdk-example.test.ts
```

Inspect the authorized catalog and choose the exact existing version, Node,
network profile, and (optionally) storage profile/subpath/mode. Use the IDs returned
by `catalog`; do not guess IDs. A preview stores the request and one generated
idempotency key only when the selected Node is eligible:

```sh
node packages/sdk/examples/resumable-tenant.mjs preview \
  --version VERSION_ID --node NODE_ID --network NETWORK_PROFILE_ID
node packages/sdk/examples/resumable-tenant.mjs acquire-or-resume
node packages/sdk/examples/resumable-tenant.mjs status
node packages/sdk/examples/resumable-tenant.mjs wait-ready
node packages/sdk/examples/resumable-tenant.mjs claim
```

An optional authorized storage request uses the fixed guest mount path
`/workspace/data`:

```sh
node packages/sdk/examples/resumable-tenant.mjs preview \
  --version VERSION_ID --node NODE_ID --network NETWORK_PROFILE_ID \
  --storage STORAGE_PROFILE_ID --subpath AUTHORIZED_RELATIVE_SUBPATH --mode RO
```

`preview` reports feasibility only; it does not guarantee capacity. If an Acquire
response is lost, restart the command. The saved `PreparedTicketCommand` and its
original key are resumed; the example will not make a second logical Acquire.
For a pending or unknown renewal, `status` leaves the original prepared command
and confirmed expiry in the state file. Run `resume` explicitly to query/replay
that same proposal. Only a confirmed SDK receipt advances
`lastConfirmedLeaseExpiresAt`.

Renew well before the saved confirmed expiry, leaving enough time for network
retries and any pending server-side renewal decision. For example, after the
initial claim is confirmed:

```sh
node packages/sdk/examples/resumable-tenant.mjs renew 1200
```

The requested duration is not an extension until the SDK returns a confirmed
receipt. If the result is pending or unknown, use `resume`; do not wait until the
old confirmed deadline to begin recovery.

`access-with-adapter` in `SIMULATOR_ONLY` mode passes the sentinel grant to an
in-memory callback and reports that no network connection or host-key verification
occurred. For a consumer-managed SSH adapter, unset `HITCHLET_DEMO_MODE`, provide
the normal consumer API origin and an absolute ES module path:

```sh
node packages/sdk/examples/resumable-tenant.mjs access-with-adapter \
  --adapter /absolute/path/to/consumer-ssh-adapter.mjs
```

The adapter module must default-export an async function receiving
`{ grant, verifyServerHostKey, confirmedExpiresAt }`. Before access is handed off,
the example requires both the last confirmed lease deadline and the API grant
deadline to be valid, and requires the grant deadline not to exceed the confirmed
lease deadline. The adapter must stop use by `confirmedExpiresAt`; the consumer
owns any explicit renewal or stopping decision. No background renewal is started.
The adapter owns the connection and must call
`verifyServerHostKey(rawPublicKeyBlob)` from its SSH library's server host-key
verification callback before accepting the connection. The helper computes the
OpenSSH `SHA256:` fingerprint from those raw key bytes and compares it exactly to
the API-provided `grant.access.hostKeyFingerprint`; a missing/malformed API
fingerprint or mismatch fails closed. The adapter is trusted consumer code. Access
materials are held in memory for the callback, never printed or written to state.
This example does not include an SSH implementation or SSH dependency.

## Persisted state and recovery boundary

Set `HITCHLET_DEMO_STATE_DIR` to a dedicated absolute directory. The example
creates it with mode `0700` or requires an existing directory already have that
mode, creates the state file and exclusive process lock with mode `0600`, fsyncs
and atomically renames each update. Only one process may
use a state directory at a time. If a process is killed while holding the lock,
first verify it has exited, then remove `.tenant-state.lock` manually. The state
contains the request, prepared command, Ticket ID, last confirmed lease expiry,
and an explicit output-saved confirmation. The bearer token, access grant,
passwords, private keys and other authentication materials are never persisted or
logged. Supply the token through the environment on each invocation.
The mode-bit protection described here targets POSIX-like systems.

State is bound to the normalized API origin and authenticated
`session.me().consumerId`. Resume with the same consumer identity; bearer rotation
for that consumer is allowed. This prevents replaying a prepared command under a
different tenant identity where the server's idempotency scope could differ.

After the tenant has saved its intended output, explicitly confirm that fact and
release:

```sh
node packages/sdk/examples/resumable-tenant.mjs confirm-output-and-release --output-saved
```

Without `--output-saved`, the example refuses to release. The confirmation is a
human assertion; this sample neither checks output content nor guarantees
application-level or atomic output publication. It waits for the SDK's
`waitUntilReleased` confirmation before reporting cleanup complete. If release or
cleanup is still pending, keep the saved prepared command and explicitly run
`resume`; do not make a new release command while the original is unresolved.

## Operational limits

- A previous Studio experiment deployment used an explicitly configured Host
  with partial observations, a finite attended budget, and a visible 90%
  admission threshold. Those are prior Studio experiment observations, not
  properties established by this tutorial's Simulator fixture and not a
  recommendation to change a real machine's defaults. The repeatable fixture
  uses `init-simulator` synthetic observations; it does not prove live Host
  admission or an SSH connection.
- Host memory availability is an available-derived estimate (for example,
  `MemAvailable` on Linux or the OS-provided available-memory value), not a
  comprehensive Activity Monitor or PSI pressure score. The availability
  estimate and partial Host admission evidence refer to the prior Studio
  experiment. Linux/Windows native availability handling has only
  synthetic-input validation; this sample does not claim a real Windows
  integration test.
- The current Portainer Runtime has no strict offline lease guard: a controller
  outage does not guarantee that a running container stops. After connectivity
  returns, the coordinator checks cleanup; a Claim remains held until cleanup is
  confirmed. Consumers must stop use no later than the **last confirmed** lease
  expiry even if a container still appears to be running or the API is
  unreachable. A pending renewal does not extend that deadline.
- The adapter and tenant application own business correctness and output
  durability. The SDK's ready/confirmed/cleanup states describe platform
  lifecycle boundaries, not successful application work.

`HITCHLET_ORIGIN` may be HTTPS for a consumer deployment; plain HTTP is accepted
only for loopback development. Use the isolated localhost Simulator for the
repeatable demonstration. This example does not provision Colima, Docker, or
services.
