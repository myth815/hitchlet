import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";

const execute = promisify(execFile);
const commandDeadline = new AsyncLocalStorage<number>();
const COMMAND_TIMEOUT_MS = 5_000;

export class FixedCommandFailureError extends Error {
  constructor(
    readonly exitCode: number | string | undefined,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super("Fixed command failed");
    this.name = "FixedCommandFailureError";
  }
}

export class FixedCommandTimeoutError extends Error {
  readonly code = "FIXED_COMMAND_TIMEOUT";

  constructor() {
    super("Fixed command timed out");
    this.name = "FixedCommandTimeoutError";
  }
}

export function isFixedCommandTimeout(
  error: unknown,
): error is FixedCommandTimeoutError {
  return error instanceof FixedCommandTimeoutError;
}

export function withCommandDeadline<T>(
  deadlineMs: number,
  work: () => Promise<T>,
): Promise<T> {
  return commandDeadline.run(deadlineMs, work);
}

export function currentCommandDeadlineMs(): number | undefined {
  return commandDeadline.getStore();
}

/** Runs a fixed argv command with a hard kill and no command details in errors. */
export async function runFixedCommand(
  binary: string,
  args: readonly string[],
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
  }> = {},
): Promise<{ stdout: string; stderr: string }> {
  const remaining = commandDeadline.getStore();
  const timeout = Math.floor(
    Math.min(
      COMMAND_TIMEOUT_MS,
      remaining === undefined ? COMMAND_TIMEOUT_MS : remaining - Date.now(),
    ),
  );
  if (timeout <= 0) throw new FixedCommandTimeoutError();

  try {
    return await execute(binary, [...args], {
      ...options,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      timeout,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    const commandError = error as {
      code?: number | string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (
      commandError.code === "ETIMEDOUT" ||
      (commandError.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
        commandError.killed &&
        commandError.signal === "SIGKILL")
    )
      throw new FixedCommandTimeoutError();
    throw new FixedCommandFailureError(
      typeof commandError.code === "number" ||
      typeof commandError.code === "string"
        ? commandError.code
        : undefined,
      String(commandError.stdout ?? ""),
      String(commandError.stderr ?? ""),
    );
  }
}
