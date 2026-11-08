# Lease-bound Windows interactive access

This supplements the existing Hyper-V console and SSH access. The account is the
clone's existing `workspace`; its existing group membership is unchanged. No new
user, autologon, RDP listener, host credential or template change is introduced.

## Candidate and activation boundary

`HITCHLET_CONSOLE_PASSWORDS` defaults to `false`. A prepare request while disabled
does not reserve an intent, generate material or contact the guest. This source
candidate has only controlled runner, SQLite, encrypted-store, SDK/HTTP and local
mTLS coverage. It has not changed a Windows password or established interactive
login, native DPAPI or GUI acceptance. Deploying code does not authorize enabling
this option or setting a clone password: those are separate operational actions.

The controller, contracts, SDK and Hyper-V Runtime must be paired. The Runtime
reuses its existing authenticated controller transport and protected PowerShell
Direct bootstrap credential solely for setup. That credential is never returned
or used as the interactive account. No alternate transport or persistent bearer
is created.

## Public calls

Both calls require the owner identity with `tickets:write`; the owner must have a
ready, claimed, active Hyper-V lease to receive material. The generation must be
current and the exact owned Windows clone must be running. Revoked profile grants
prevent access. Responses are `Cache-Control: no-store` and `Pragma: no-cache`.

```ts
// Save only ticketId, generation and this request key before the write.
const access = await client.tickets.prepareConsoleCredentials(
  ticketId,
  generation,
  {
    idempotencyKey: savedKey,
  },
);
// After an uncertain response, use this read; do not generate a new password.
const recovered = await client.tickets.getConsoleCredentials(
  ticketId,
  generation,
);
```

Equivalent endpoints:

- `POST /v1/tickets/:ticketId/console-credentials`, `Idempotency-Key`, body
  `{ "generation": 1 }`.
- `GET /v1/tickets/:ticketId/console-credentials?generation=1`.

The view contains `ticketId`, `generation`, `expiresAt`, optional stable
`credentialId`, and `status`. Only `ready` includes
`authentication: { kind: "ephemeral_password", username: "workspace", password }`.
`pending`/`unknown` do not authorize login. `cleanup_pending`/`destroyed` never
return former authentication. `not_prepared` means no intent exists. A disabled
prepare returns `console_credentials_disabled` (409). Missing/corrupt previously
prepared material is an error, never permission to regenerate it.

The caller must keep returned authentication out of logs, command arguments and
source/state archives. A returned password is not proof that Windows logon or
Electron safeStorage succeeds; those require separate real acceptance.

## Persistence and uncertain outcomes

The single controller ledger stores one private intent per owner/ticket/generation
in the existing `idempotency_keys` table, under
`tickets.console.credentials.intent`. It stores the allocation ID, generation,
nonce, encrypted secret reference and state, not the password. Caller write keys
are bound separately to the ticket/generation. A different retry key for the same
lease resolves the same intent. No migration or second ledger is required.

The intent is reserved before encrypted material is written. `LocalSecretStore`
uses AES-GCM, an exclusive encrypted staging file, atomic no-replace publication
and fsync. Restart reuses the reserved reference; only an unprepared reservation
may create missing material. Before guest mutation, the state is durable. Normal
reads only inspect; they never invoke password preparation.

The Runtime retains a non-secret attempted marker before its one possible guest
apply. The guest atomically creates its own non-secret `preparing` marker before
the sole `Set-LocalUser` call. An `applied` receipt must match the exact clone,
nonce/hash, existing account SID and password-last-set metadata. A lost reply
after an applied marker can be recovered by inspection without another reset.
Missing, partial or inconsistent markers after an attempt remain `unknown`.
The narrow crash window between the actual password change and the guest's
applied marker cannot be automatically resolved by resetting again. Release the
clone through normal cleanup if that outcome cannot be established.

No old password is read, extracted or tested. The new password travels over the
existing authenticated Runtime connection and private process stdin; the fixed
host wrapper passes a SecureString to the guest. Neither marker, Runtime journal
nor controller idempotency response contains plaintext. Windows NTFS/power-loss
durability and PowerShell Direct SecureString behavior remain real-test items;
controlled runner tests do not establish them.

## Release and deletion

Expiry/release immediately prevents password delivery. A regular controller
maintenance tick removes material only after the authoritative ticket/allocation
cleanup is complete, owned resources are absent, and capacity claims are released.
It records `destroying`, deletes the exact encrypted file and that reference's
orphan encrypted staging files, then records `destroyed` and clears the reference.
A missing directory/file is already deleted. I/O failures retain the intent for
retry and do not stop disk monitoring. Cleanup also runs while prepare is disabled.

History pruning retains unresolved intent references even beyond the normal
history horizon. Destroyed clones have no remaining guest account/session, and
local logical material is removed. This is filesystem deletion, not a claim of
secure erasure of historical backups or storage media. Shared templates and other
secrets are untouched.

## Real activation checklist

After the separate clone-password action is explicitly authorized: use one normal
owned lease, enable only the paired implementation, prepare once, verify its
readback/recovery, and log in through the native console as that existing account.
Then test the actual client GUI/native integrations. Save non-secret results,
release normally, verify owned clone/Claim absence and credential status
`destroyed`, and restore the prior prepare setting. Do not reuse a released lease,
bootstrap credentials or another consumer's identity.
