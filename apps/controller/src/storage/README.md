# Controller storage

`openStorage(DATA_DIR)` starts one compiled JavaScript worker and opens
`DATA_DIR/hitchlet.sqlite`. The worker serializes all SQL, enables foreign
keys, WAL, FULL synchronous writes and a 5-second busy timeout, and holds
SQLite's EXCLUSIVE locking mode for its lifetime. A second controller opening
the same local database fails during startup. Closing the returned handle waits
for the worker to close SQLite and release that lock.

`src/storage/migrations/001-initial.sql` is the frozen v1 baseline. Migration
002 adds the browser session's issuing credential foreign key; older sessions
have no lineage and are rejected. `docs/design/schema.sql` shows the complete
current schema. The controller build copies all migrations into `dist`, and
storage tests check frozen baseline bytes and historical upgrade paths. The
`schema_migrations` table is authoritative; `PRAGMA user_version` mirrors the
latest applied version. Unknown migration versions fail closed.

The API offers parameterized `run`, `get`, `all`, and `batchTransaction` calls.
Each batch entry declares `run`, `get`, or `all`; entries are data, not callbacks.
Only `run` entries accept `expectChanges`, which adds a compare-and-swap condition whose failure
rolls back the whole batch. SQLite and CAS errors are typed and returned without SQL text or bound values. Integer reads use BigInt,
so SQLite event cursors remain exact beyond JavaScript's safe integer range.
Only short local transactions belong here. Provider/network work and HTTP must
remain outside the worker; this API is an internal package interface, not an
HTTP surface.

SQLite 3.53.4 is the version embedded by the pinned `better-sqlite3` package in
the tested macOS arm64 environment. D23 adds serialized online `backup` and `check` worker commands. Snapshot checks
include integrity/FK and conversion to self-contained DELETE journal mode.
Migration007 adds one local maintenance row and database-side admission gates;
001–006 are unchanged. Pre-upgrade snapshots precede migrations; failures preserve
maintenance/restore markers. See the [operational runbook](../../../../docs/runbook.md#d23-operational-maintenance-and-isolated-restore)
for offline restore, independent secrets, credential revocation and retention.

D21 adds no migration: versioned HumanUsePolicy lives in existing Machine
management JSON and uses the existing root pool reserve columns. Migrations
001–005 remain byte-for-byte frozen. `human-use-guard.ts` owns one deterministic
read of the Machine dependency/budget/Host input and its exact comparison fence.
`domain/human-use.ts` owns the pure admission rule used by scheduling, internal
validation and management previews. Claim insertion and policy updates compare
the whole input inside the same short write batch, so a heartbeat, policy,
Hold or sibling allocation change between reading and writing causes rollback.
Historical released allocations are excluded unless still backing a child pool.

D22a adds migration006 only: exclusive indexes for plug binding/device ID/MAC
in Machine management JSON and one unresolved power intent per Machine in
Operations. Migrations001–005 remain unchanged. Power policies use existing
versioned policies.config_json; isolated `power.dry-run` Operations hold virtual
state, accepted IDs, frozen binding versions and restore duties. They never
write real Machine admission/power/epoch fields or agent_receipts. The allocation
worker continues to recognize only allocation.provision/cleanup. Power fences
include active/preparing/cleanup allocations even before a Claim exists, pending
operations, dependency/Host inputs and policy version. Completed unrelated
history is excluded. Due restore duties are continued every five seconds without
network/device calls; cancellation/restart never resets their original deadline.


D23 keeps SQL/history/CAS and local operational filesystem work in
`maintenance-store.ts`, `history-retention.ts` and `recovery-store.ts`; application
services decide gates and orchestrate external evidence. Recovery never copies a
live database file or overwrites the current data directory. The volatile write
failure latch blocks new work even if a full filesystem cannot persist its own
maintenance row. Healthy disk sampling clears it only after a successful write.
Retention uses fixed candidate-reference guards in the same deletion transaction;
no full-ledger JSON snapshot or second ownership ledger is created.
