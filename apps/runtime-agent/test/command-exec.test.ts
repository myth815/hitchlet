import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  FixedCommandFailureError,
  FixedCommandTimeoutError,
  runFixedCommand,
  withCommandDeadline,
} from "../src/command-exec.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("SIGKILLs a child that ignores SIGTERM at the command deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hitchlet-command-timeout-"));
  directories.push(directory);
  const pidFile = join(directory, "child.pid");
  const started = Date.now();

  await expect(
    withCommandDeadline(Date.now() + 750, () =>
      runFixedCommand(process.execPath, [
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
        pidFile,
      ]),
    ),
  ).rejects.toBeInstanceOf(FixedCommandTimeoutError);

  expect(Date.now() - started).toBeLessThan(3000);
  const childPid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(childPid, 0)).toThrow();
});

it("does not include the binary or argv in fixed command errors", async () => {
  const marker = "private-argv-marker";
  let message = "";
  try {
    await runFixedCommand(process.execPath, ["-e", "process.exit(7)", marker]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe("Fixed command failed");
  expect(message).not.toContain(marker);
  expect(message).not.toContain(process.execPath);
});

it("does not misclassify maxBuffer termination as a deadline timeout", async () => {
  await expect(
    runFixedCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      { maxBuffer: 32 },
    ),
  ).rejects.toMatchObject({
    constructor: FixedCommandFailureError,
    message: "Fixed command failed",
    exitCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  });
});
