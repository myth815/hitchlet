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
current schema. The controller build copies both migrations into `dist`, and
the storage tests check baseline bytes and the v1-to-v2 upgrade. The
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
the tested macOS arm64 environment. Backup/restore and online backup API are
not implemented in this storage foundation.

D21 adds no migration: versioned HumanUsePolicy lives in existing Machine
management JSON and uses the existing root pool reserve columns. Migrations
001–005 remain byte-for-byte frozen. `human-use-guard.ts` owns one deterministic
read of the Machine dependency/budget/Host input and its exact comparison fence.
`domain/human-use.ts` owns the pure admission rule used by scheduling, internal
validation and management previews. Claim insertion and policy updates compare
the whole input inside the same short write batch, so a heartbeat, policy,
Hold or sibling allocation change between reading and writing causes rollback.
Historical released allocations are excluded unless still backing a child pool.
