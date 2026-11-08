# Collaborator maintenance Holds

Maintenance use by a collaborator is represented by an owner-bound Hold on one machine. The caller uses the existing Hitchlet SDK/authentication bridge and its current consumer identity with `tickets:write` plus an authorization grant to at least one Node on that machine. The API derives ownership from that authenticated identity; callers cannot provide an owner ID. No new credential or long-lived identity is required.

The SDK calls are:

```ts
const holdId = crypto.randomUUID();
const acquireKey = crypto.randomUUID();
const releaseKey = crypto.randomUUID();

await client.admin.acquireMaintenanceHold(
  machineId,
  holdId,
  { reason: "Collaborator maintenance session" },
  acquireKey,
);

const current = await client.admin.maintenanceHold(machineId, holdId);
await client.admin.releaseMaintenanceHold(machineId, holdId, releaseKey);
const final = await client.admin.maintenanceHold(machineId, holdId);
```

The SDK’s existing transport supplies authentication; examples intentionally contain no credential material. The UUID in the PUT path makes an identical retry idempotent. Reusing it with a different owner, machine, or reason conflicts, and a released ID cannot be reactivated. Repeating release returns the original released receipt. GET-by-ID returns the caller’s own active or released Hold; the machine list shows only the caller’s active holds and requires a current Node grant.

These Holds have `expiresAtMs: null` and remain active until their owner explicitly releases them. They protect the machine from power shutdown but do not add a global Compute-admission veto. The controller rejects acquisition during an already committed or uncertain shutdown phase. A Hold acquired during an earlier drain uses the existing power-cancellation handshake before the API returns success. Releasing invalidates any stored idle timer so a fresh idle grace period must elapse.
