import { Worker } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Command,
  Reply,
  Request,
  RunResult,
  SqlValue,
  Statement,
} from "./protocol.js";

export class StorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export type Storage = {
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  get<T = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T | undefined>;
  all<T = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;
  batchTransaction(statements: readonly Statement[]): Promise<unknown[]>;
  close(): Promise<void>;
};

async function openStorageUsing(
  dataDir: string,
  workerUrl: URL,
): Promise<Storage> {
  const dir = resolve(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const worker = new Worker(workerUrl, {
    workerData: resolve(dir, "hitchlet.sqlite"),
  });
  let nextId = 1;
  let closed = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let failed: StorageError | undefined;
  let resolveReady!: (value: {
    sqliteVersion: { version: string };
    schemaVersion: number;
  }) => void;
  let rejectReady!: (error: StorageError) => void;
  const ready = new Promise<{
    sqliteVersion: { version: string };
    schemaVersion: number;
  }>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  worker.on("message", (reply: Reply) => {
    if (reply.id === 0) {
      if (reply.error)
        rejectReady(new StorageError(reply.error.code, reply.error.message));
      else
        resolveReady(
          reply.result as {
            sqliteVersion: { version: string };
            schemaVersion: number;
          },
        );
      return;
    }
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    if (reply.error)
      item.reject(new StorageError(reply.error.code, reply.error.message));
    else item.resolve(reply.result);
  });
  const fail = (error: StorageError) => {
    failed = error;
    rejectReady(error);
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  worker.on("error", () =>
    fail(new StorageError("STORAGE_WORKER_FAILED", "Storage worker failed")),
  );
  worker.on("exit", () => {
    if (!closed)
      fail(
        new StorageError(
          "STORAGE_WORKER_FAILED",
          "Storage worker stopped unexpectedly",
        ),
      );
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }

  const send = <T>(command: Command): Promise<T> => {
    if (closed || (closing && command.kind !== "close"))
      return Promise.reject(
        new StorageError("STORAGE_CLOSED", "Storage is closed"),
      );
    if (failed) return Promise.reject(failed);
    const id = nextId++;
    return new Promise<T>((resolvePromise, rejectPromise) => {
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      worker.postMessage({ id, command } satisfies Request);
    });
  };
  return {
    run: (sql, params = []) => send({ kind: "run", sql, params }),
    get: (sql, params = []) => send({ kind: "get", sql, params }),
    all: (sql, params = []) => send({ kind: "all", sql, params }),
    batchTransaction: (statements) => send({ kind: "batch", statements }),
    close() {
      if (closePromise) return closePromise;
      if (closed) return Promise.resolve();
      if (failed) return Promise.reject(failed);
      closing = true;
      closePromise = send({ kind: "close" })
        .then(async () => {
          closed = true;
          await worker.terminate();
        })
        .catch((error: unknown) => {
          closed = true;
          throw error;
        });
      return closePromise;
    },
  };
}

export function openStorage(dataDir: string): Promise<Storage> {
  return openStorageUsing(dataDir, new URL("./worker.js", import.meta.url));
}

/** Internal fault injection point for worker failure tests. */
export function openStorageWithWorker(
  dataDir: string,
  workerUrl: URL,
): Promise<Storage> {
  return openStorageUsing(dataDir, workerUrl);
}
