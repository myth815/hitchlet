# Lease-bound native Windows console

This source candidate adds a supplemental console to a claimed Windows Hyper-V
Ticket. The acquire request and SSH access delivery remain unchanged. It uses
Windows Hyper-V WMI v2 through the existing authenticated Runtime route. It does
not use an installed remote-control application, add a network listener, enable
RDP, change a firewall, create an account, change a password, or change template
privileges. The current default template's existing `workspace` is a guest
administrator; an older preparation receipt saying ordinary user predates that
explicit template replacement.

## Consumer contract

`POST /v1/tickets/{ticketId}/console` uses the normal consumer bearer/session and
`tickets:write` scope. The SDK is `client.tickets.console(ticketId, command)`:

```ts
const frame = await client.tickets.console(ticket.id, {
  generation: ticket.lease.generation,
  commandId: crypto.randomUUID(),
  action: { kind: "frame", width: 1024, height: 768 },
});
```

Commands are `access`, `frame`, `key` (Windows virtual-key code), `text`,
`secure_attention` (Ctrl+Alt+Delete), and `pointer` (guest screen pixels with an
optional left click). Pointer coordinates refer to the guest's full display,
not the scaled thumbnail. The frame result is PNG; it is bounded to 1024×768.
The WMI result is converted from RGB565 without a new image dependency.

Persist the command ID before sending input, and retain the same action with
that ID when resolving an uncertain result. The SDK uses it as the HTTP
Idempotency-Key. A `completed` input replay returns the saved result without
retyping. An `unknown` input replay stays unknown and never retypes. Observe a
new frame and reconcile the intended UI effect before deciding on a different
command; do not blindly resend a password, click, or Enter with a new ID. The
Runtime manifest stores only ID, action hash, and state, never the input text.
Frames are not persisted in the Runtime manifest. Store captured images as
protected task evidence because they can contain application data.

The result contains `ticketId`, `generation`, `commandId`, `expiresAt`,
`protocol: "console"`, and `authentication: { kind:
"existing_account_login_required", username }`. This authentication field
expressly does **not** deliver a password, create a login session, or assert a
logged-in user. `available` reports a usable allocation and native method
presence; it is not GUI, Winlogon, DPAPI, notification, or Identity acceptance.
No independent console token, persistent session, or placement selector is
introduced.

## Lifecycle and ownership

Every command checks the current consumer's ready, claimed, active lease,
generation, desired/observed allocation state, expiry and revoked profile
grants. The provider resolves the original succeeded provision operation and
exact current authenticated Node transport. The Runtime serializes console and
cleanup on the same allocation and rechecks the complete manifest owner,
control version, native VM ID, paths, resource specification, running Windows
guest and original bootstrap account. Consumers cannot supply a VM ID, host
account, arbitrary shell command, or credential reference.

Release rejects new console calls. A request already admitted before release
may be in flight; release is not a promise to undo an input already sent.
Native input and cleanup share allocation ordering: cleanup waits for an
already executing native command, and a completed deletion fences later input.
The controller rechecks the lease before returning a frame/access result, so
release or revocation racing the native read suppresses that result. Capacity
and actual VM removal continue to use the normal cleanup-confirmed lifecycle.

## Existing account and remaining login delivery

The template setup generated passwords for both `workspace` and the separate
`hitchlet-bootstrap`. Only the latter was saved as the host-protected
PowerShell Direct bootstrap reference. Final template cleanup removed setup
answer caches and one-time autologon material. Per-lease initialization currently
injects an SSH public key into the existing `workspace`; `getAccess` returns an
SSH private key. The generic `rdp`/`ephemeral_password` schemas did not implement
actual Windows interactive credential delivery.

This candidate intentionally leaves that missing credential step explicit. It
does not use bootstrap as the desktop test identity or add another user.
Windows `WTSQueryUserToken` reuses an already logged-on session and requires a
highly trusted service context; it is not a password-free first login for this
SSH-only lease. `CreateProcessWithLogonW` needs credentials and does not itself
establish the visible desktop login required for full client acceptance. A
service/SSH process with a user profile is not substituted for Winlogon or a
successful real DPAPI test.

If no legitimate existing workspace interactive material/session is available,
the minimal pending real action is to set a new random password on **workspace
inside one owned disposable clone**, retain it only in an allocation-scoped
protected secret reference, log on through the native console, and destroy the
clone and secret reference at release. No shared template, host account,
workspace group membership, persistent access, or guest network change is
needed for that proposal. It has not been implemented or executed here and
requires the specific credential-action confirmation. Password reset/profile
and real safeStorage behavior must be verified; neither successful login nor
an administrative reset is automatically a DPAPI fix. The subsequent normal
access/credential implementation must persist its secret intent before guest
mutation, recover unknown outcomes with the same allocation/generation, and
remove the secret with lease cleanup.

## Validation boundary

Source regressions cover owner/claim/expiry/revocation/generation, exact Node
and operation SQL, restart-safe input deduplication without plaintext, native
input/cleanup ordering, malformed thumbnails, SDK command identity and the
existing real mTLS Runtime transport carrying a full-size frame. Native calls
in those tests are controlled fixtures. Windows WMI classes/methods were
previously observed read-only on the real host, but no live VM console, ordinary
interactive logon, or DPAPI success is claimed. No Vesta source or installer was
changed or rebuilt.

Microsoft references:

- [Hyper-V thumbnail](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/getvirtualsystemthumbnailimage-msvm-virtualsystemmanagementservice)
- [Virtual keyboard](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/typekey-msvm-keyboard)
- [Mouse pixel coordinates](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/setabsoluteposition-msvm-syntheticmouse)
- [Existing user token](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken)
- [Process with logon credentials](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)
