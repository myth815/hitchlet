import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { dirname, join } from "node:path";
import type { Command, Request, Reply, Statement } from "./protocol.js";

if (!parentPort) throw new Error("Storage worker requires a parent port");
const port = parentPort;
const dbPath = workerData as string;
let db: Database.Database | undefined;

function sqliteErrorCode(error: unknown): string {
  const nativeCode =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
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
  const applied = db
    .prepare(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    )
    .get() as { version: bigint } | undefined;
  if (applied?.version !== 1n)
    throw new Error(
      `Unsupported schema version ${String(applied?.version ?? "none")}`,
    );
  db.pragma("user_version = 1");
  const fk = db.pragma("foreign_keys", { simple: true });
  const sync = db.pragma("synchronous", { simple: true });
  if ((fk !== 1 && fk !== 1n) || (sync !== 2 && sync !== 2n))
    throw new Error("SQLite durability configuration mismatch");
  // Acquire and retain SQLite's exclusive lock before accepting requests.
  db.exec("BEGIN EXCLUSIVE; SELECT 1 FROM schema_migrations; COMMIT;");
}

function handle(command: Command): unknown {
  if (!db) throw new Error("Database is not open");
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
        schemaVersion: 1,
      },
    }),
  (error: unknown) => {
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

port.on("message", (request: Request) => {
  try {
    const result = handle(request.command);
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
