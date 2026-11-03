# Resumable Node tenant example

`resumable-tenant.mjs` is a small consumer-side workflow built only on the public
`@hitchlet/sdk` API. It shows explicit catalog selection, a read-only preview,
durable ticket-command recovery, confirmed lease tracking, an access handoff, and
confirmed cleanup. It does not initialize or authorize a platform, publish images,
or perform work on the tenant's behalf.
It is intended for a recoverable experimental deployment, not production
operations.

## Install the SDK in a separate consumer project

The workspace build can produce a paired local candidate without publishing to a
registry. After an authorized clean build, run the pairing command from the
repository root with an empty absolute output directory:

```sh
export HITCHLET_BUILD_REVISION="$(git rev-parse HEAD)"
pnpm --filter @hitchlet/contracts build
pnpm --filter @hitchlet/sdk build
node scripts/prepare-sdk-pair.mjs /absolute/path/to/hitchlet-sdk-candidate
```

The command refuses missing or stale build provenance, requires the SDK and
contracts versions to match, packs both packages, checks the packed export files
and exact dependency, and writes `hitchlet-sdk-pair.json` with each tarball's
SHA-256. Use both tarballs in a separate consumer project:

```sh
mkdir /absolute/path/to/sdk-consumer
cd /absolute/path/to/sdk-consumer
npm init -y
npm install \
  /absolute/path/to/hitchlet-sdk-candidate/hitchlet-contracts-0.1.0.tgz \
  /absolute/path/to/hitchlet-sdk-candidate/hitchlet-sdk-0.1.0.tgz
```

Run the package-name import and read-only health request against an API you
already operate:

```sh
HITCHLET_ORIGIN=https://hitchlet.example \
  node node_modules/@hitchlet/sdk/examples/consumer-import.mjs
```

For a traceable candidate, build the exact reviewed source revision and set
`HITCHLET_BUILD_REVISION` to its full Git commit before both package builds. The
pair manifest records that supplied revision, source/build fingerprints, and
tarball hashes. It records `null` when no revision is supplied. The tarballs are
local files; this flow does not publish them. Provenance is a consistency record
for the successful build inputs and outputs, not cryptographic build attestation;
never use it to bless existing stale output.

See the [Studio ARM release candidate guide](../../../docs/STUDIO-ARM-RELEASE-CANDIDATE.md)
for the paired Docker image and consumer workflow.

The current checkout's legacy `dist` files have no provenance manifest and are
rejected by the pairing command until a fresh build succeeds.

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
`lastConfirmedLeaseExpiresAt`. If the SDK reports a renewal error, the example
checks the owner-visible renewal record before recording a rejected or cancelled
decision. It moves the original command and key to a durable decision record,
clears the now-resolved prepared command, and leaves the confirmed expiry
unchanged. It does not replay a recorded final decision. You can then use the
same CLI's normal output-confirmation and release workflow. `resume` after that
queries the Ticket and reports the final decision without sending another
renewal.

If an access, renewal, release, or cancel command remains prepared after its
Ticket has already reached `released` through the owner workflow, `resume` first
queries that same Ticket. It archives and clears the command only when the
authenticated owner query returns the matching released Ticket. A failed or
unknown read leaves the prepared command untouched; `acquire` is never started
automatically. Once cleared, an explicit `preview` can begin another lifecycle.

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
The reusable reference adapter is a separate file and does not import or add an
SSH dependency to the SDK.

### Optional ssh2 reference adapter

`ssh-access-adapter.mjs` exports `createSshAdapter({ Client, readyTimeoutMs,
commandTimeoutMs })`. The consumer's wrapper supplies its existing `ssh2` client
constructor and default-exports the returned callback:

```js
import { Client } from "ssh2";
import { createSshAdapter } from "./ssh-access-adapter.mjs";

export default createSshAdapter({
  Client,
  readyTimeoutMs: 10_000,
  commandTimeoutMs: 10_000,
});
```

Place that wrapper beside a copy of `ssh-access-adapter.mjs` in the consumer's
adapter directory so the relative import resolves there. The `ssh2` dependency
must be provided by the consumer project containing the wrapper; the SDK and
controller do not supply it. If the reference adapter is kept elsewhere, change
the wrapper import to a path that resolves from the wrapper module. Pass the
wrapper's absolute path to the CLI's `--adapter` option.

The factory accepts only `ssh` grants with `ephemeral_private_key` authentication.
It passes the grant's host, port, username, and private-key string to `ssh2`,
provides the raw-key verifier callback without `hostHash`, and runs only the fixed
read-only probe `id -un && id -u && id -g && node --version`. Its result contains
only the numeric uid/gid and Node version. On completion, timeout, or the earlier
confirmed lease/access deadline, it closes the local channel and calls the
client's protocol `end()` followed by socket `destroy()`. That does not kill
remote work or provide strict offline enforcement. In addition to the controlled
fake `Client` tests, this factory completed a real API-fingerprint-verified SSH
probe through the public SDK/CLI on the isolated Studio stack on 2026-11-02. The
single Ticket was released with verified cleanup. See the
[exact environment, receipt, and limits](../../../docs/STUDIO-SSH-ADAPTER-REAL-2026-11-02.md).
The repeatable Simulator workflow remains synthetic; its results do not replace
the separate real-connection evidence or establish other platforms as tested.

Run the focused adapter tests with:

```sh
pnpm --filter @hitchlet/sdk exec vitest run test/ssh-access-adapter.test.ts
```

These tests use a controlled fake `Client`; they do not open a network connection
or authenticate to an SSH server.

## Persisted state and recovery boundary

Set `HITCHLET_DEMO_STATE_DIR` to a dedicated absolute directory. The example
creates it with mode `0700` or requires an existing directory already have that
mode, creates the state file and exclusive process lock with mode `0600`, fsyncs
and atomically renames each update. Only one process may
use a state directory at a time. If a process is killed while holding the lock,
first verify it has exited, then remove `.tenant-state.lock` manually. The state
contains the request, prepared command, the latest owner-verified terminal
decision (and a replaced prior decision), Ticket ID, last confirmed lease expiry,
and an explicit output-saved confirmation.
The bearer token, access grant,
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
