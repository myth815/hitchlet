import Database from "better-sqlite3";
import {
  readFile,
  mkdir,
  writeFile,
  unlink,
  chmod,
  statfs,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { dirname, join } from "node:path";
import type { Command, Request, Reply, Statement } from "./protocol.js";

if (!parentPort) throw new Error("Storage worker requires a parent port");
const port = parentPort;
const dbPath = workerData as string;
let db: Database.Database | undefined;
let migrating = false;

function sqliteErrorCode(error: unknown): string {
  const nativeCode =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (
    error instanceof Error &&
    [
      "new admission is paused",
      "new allocation is paused",
      "runtime storage capacity is unavailable",
      "new prewarm is paused",
    ].includes(error.message)
  )
    return "STORAGE_MAINTENANCE";
  if (nativeCode.startsWith("SQLITE_CONSTRAINT")) return "STORAGE_CONSTRAINT";
  if (nativeCode === "SQLITE_BUSY" || nativeCode === "SQLITE_LOCKED")
    return "STORAGE_BUSY";
  if (nativeCode === "SQLITE_FULL") return "STORAGE_FULL";
  if (
    nativeCode.startsWith("SQLITE_CORRUPT") ||
    nativeCode.startsWith("SQLITE_NOTADB")
  )
    return "STORAGE_CORRUPT";
  if (
    nativeCode.startsWith("SQLITE_IOERR") ||
    nativeCode.startsWith("SQLITE_CANTOPEN")
  )
    return "STORAGE_IO";
  if (nativeCode.startsWith("SQLITE_READONLY")) return "STORAGE_READ_ONLY";
  return error instanceof Error && error.name === "SqliteError"
    ? "STORAGE_SQLITE_ERROR"
    : "STORAGE_QUERY_FAILED";
}

function bind(
  params: readonly (string | number | bigint | Buffer | null | Uint8Array)[],
) {
  return params.map((value) =>
    value instanceof Uint8Array && !Buffer.isBuffer(value)
      ? Buffer.from(value)
      : value,
  );
}

function execute(statement: Statement): unknown {
  if (!db) throw new Error("Database is not open");
  const stmt = db.prepare(statement.sql);
  const params = bind(statement.params ?? []);
  if (statement.kind === "run") {
    const result = stmt.run(...params);
    if (statement.expectChanges !== undefined) {
      if (BigInt(result.changes) !== BigInt(statement.expectChanges)) {
        const error = new Error("Compare-and-swap condition failed");
        error.name = "StorageCasError";
        throw error;
      }
    }
    return {
      changes: BigInt(result.changes),
      lastInsertRowid: BigInt(result.lastInsertRowid),
    };
  }
  if (statement.kind === "get") return stmt.get(...params);
  return stmt.all(...params);
}

async function open(): Promise<void> {
  db = new Database(dbPath, { timeout: 5000 });
  db.defaultSafeIntegers(true);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const mode = db.pragma("journal_mode = WAL", { simple: true });
  db.pragma("synchronous = FULL");
  if (mode !== "wal") throw new Error("SQLite WAL mode unavailable");
  const sqliteVersion = db
    .prepare("SELECT sqlite_version() AS version")
    .get() as { version: string };
  const [major, minor, patch] = sqliteVersion.version.split(".").map(Number);
  if (
    major! < 3 ||
    (major === 3 && (minor! < 51 || (minor === 51 && patch! < 3)))
  ) {
    throw new Error(
      `SQLite ${sqliteVersion.version} is below the required 3.51.3 baseline`,
    );
  }
  const lockMode = db.pragma("locking_mode = EXCLUSIVE", { simple: true });
  if (lockMode !== "exclusive")
    throw new Error("SQLite exclusive locking unavailable");

  const hasMigrations = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  const versionRow = hasMigrations
    ? (db
        .prepare(
          "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get() as { version: bigint } | undefined)
    : undefined;
  migrating = !versionRow || versionRow.version < 7n;
  if (versionRow && versionRow.version < 7n) {
    // Snapshot the original schema before any migration changes it.
    const backupDir = join(dirname(dbPath), "backups");
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const space = await statfs(dirname(dbPath));
    const required =
      Number(db.pragma("page_count", { simple: true })) *
        Number(db.pragma("page_size", { simple: true })) +
      128 * 1048576;
    if (Number(space.bavail) * Number(space.bsize) <= required)
      throw new Error(
        "Insufficient reserve for pre-upgrade backup; remain in maintenance",
      );
    const snapshot = join(
      backupDir,
      `upgrade-${Date.now()}-v${versionRow.version}.sqlite`,
    );
    await db.backup(snapshot);
    await chmod(snapshot, 0o600);
    const check = new Database(snapshot, { fileMustExist: true });
    try {
      check.pragma("journal_mode = DELETE");
      verify(check);
    } finally {
      check.close();
    }
  }
  if (!versionRow) {
    const sql = await readFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "migrations/001-initial.sql",
      ),
      "utf8",
    );
    db.exec(sql);
  }
  let applied = db
    .prepare(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    )
    .get() as { version: bigint } | undefined;
  if (applied?.version === 1n) {
    const sql = await readFile(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "migrations/002-session-credential-lineage.sql",
      ),
      "utf8",
    );
    db.exec(sql);
    applied = db
      .prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: bigint } | undefined;
  }
  if (applied?.version === 2n) {
    db.exec(
      await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "migrations/003-validation-evidence.sql",
        ),
        "utf8",
      ),
    );
    applied = db
      .prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: bigint } | undefined;
  }
  if (applied?.version === 3n) {
    db.exec(
      await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "migrations/004-managed-resource-identities.sql",
        ),
        "utf8",
      ),
    );
    applied = db
      .prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: bigint } | undefined;
  }
  if (applied?.version === 4n) {
    db.exec(
      await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "migrations/005-host-observations.sql",
        ),
        "utf8",
      ),
    );
    applied = db
      .prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: bigint } | undefined;
  }
  if (applied?.version === 5n) {
    db.exec(
      await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "migrations/006-power-dry-run.sql",
        ),
        "utf8",
      ),
    );
    applied = db
      .prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: bigint } | undefined;
  }
  if (applied && applied.version < 7n) {
    db.exec(
      await readFile(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "migrations/007-operations-maintenance.sql",
        ),
        "utf8",
      ),
    );
    applied = db
      .prepare(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get() as { version: bigint };
  }
  if (applied?.version !== 7n)
    throw new Error(
      `Unsupported schema version ${String(applied?.version ?? "none")}`,
    );
  db.pragma("user_version = 7");
  const fk = db.pragma("foreign_keys", { simple: true });
  const sync = db.pragma("synchronous", { simple: true });
  if ((fk !== 1 && fk !== 1n) || (sync !== 2 && sync !== 2n))
    throw new Error("SQLite durability configuration mismatch");
  // Acquire and retain SQLite's exclusive lock before accepting requests.
  db.exec("BEGIN EXCLUSIVE; SELECT 1 FROM schema_migrations; COMMIT;");
  migrating = false;
  await unlink(join(dirname(dbPath), "maintenance-state.json")).catch(
    () => undefined,
  );
}

async function handle(command: Command): Promise<unknown> {
  if (!db) throw new Error("Database is not open");
  if (command.kind === "backup") {
    await db.backup(command.destination);
    const backup = new Database(command.destination, { fileMustExist: true });
    try {
      backup.pragma("journal_mode = DELETE");
      verify(backup);
    } finally {
      backup.close();
    }
    return true;
  }
  if (command.kind === "check") {
    verify(db);
    return true;
  }
  if (command.kind === "close") {
    db.close();
    return true;
  }
  if (command.kind === "batch") {
    const tx = db.transaction((statements: readonly Statement[]) =>
      statements.map(execute),
    );
    return tx.immediate(command.statements);
  }
  if (command.kind === "run") {
    const stmt = db.prepare(command.sql);
    const result = stmt.run(...bind(command.params ?? []));
    return {
      changes: BigInt(result.changes),
      lastInsertRowid: BigInt(result.lastInsertRowid),
    };
  }
  const stmt = db.prepare(command.sql);
  const params = bind(command.params ?? []);
  return command.kind === "get" ? stmt.get(...params) : stmt.all(...params);
}

void open().then(
  () =>
    port.postMessage({
      id: 0,
      result: {
        sqliteVersion: db?.prepare("SELECT sqlite_version() AS version").get(),
        schemaVersion: 7,
      },
    }),
  async (error: unknown) => {
    if (migrating)
      await writeFile(
        join(dirname(dbPath), "maintenance-state.json"),
        JSON.stringify({
          state: "migration_failed",
          admission: "closed",
          preservedLedger: true,
        }),
        { mode: 0o600 },
      ).catch(() => undefined);
    port.postMessage({
      id: 0,
      error: {
        code: "STORAGE_OPEN_FAILED",
        message: error instanceof Error ? error.message : "Storage open failed",
      },
    });
    db?.close();
    process.exitCode = 1;
  },
);

// backup() is asynchronous. Queue all messages, including close, behind it.
// A plain async event callback would allow SQL/close to interleave with backup.
let queue = Promise.resolve();
port.on("message", (request: Request) => {
  queue = queue.then(async () => {
    try {
      const result = await handle(request.command);
      port.postMessage({ id: request.id, result } satisfies Reply);
    } catch (error) {
      const isCas = error instanceof Error && error.name === "StorageCasError";
      const code = isCas ? "STORAGE_CAS_FAILED" : sqliteErrorCode(error);
      const message = isCas
        ? "Compare-and-swap condition failed"
        : code === "STORAGE_CONSTRAINT"
          ? "SQLite constraint rejected the operation"
          : "Storage operation failed";
      port.postMessage({
        id: request.id,
        error: { code, message },
      } satisfies Reply);
    }
  });
});

function verify(database: Database.Database): void {
  const integrity = database.pragma("integrity_check") as {
    integrity_check: string;
  }[];
  if (
    integrity.length !== 1 ||
    integrity[0]?.integrity_check !== "ok" ||
    (database.pragma("foreign_key_check") as unknown[]).length !== 0
  )
    throw new Error("SQLite consistency check failed");
}
