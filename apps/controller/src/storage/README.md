# Controller storage

`openStorage(DATA_DIR)` starts one compiled JavaScript worker and opens
`DATA_DIR/hitchlet.sqlite`. The worker serializes all SQL, enables foreign
keys, WAL, FULL synchronous writes and a 5-second busy timeout, and holds
SQLite's EXCLUSIVE locking mode for its lifetime. A second controller opening
the same local database fails during startup. Closing the returned handle waits
for the worker to close SQLite and release that lock.

The authoritative initial schema remains `docs/design/schema.sql`. The
controller build copies those exact bytes to `dist/storage/migrations/001-initial.sql`;
the storage test checks for drift. The `schema_migrations` table is the authority
for whether and which migrations have applied. `PRAGMA user_version` is set to
the latest applied schema version as a SQLite metadata mirror; it does not
decide whether the initial migration ran. A schema with an unknown migration
version fails closed.

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
