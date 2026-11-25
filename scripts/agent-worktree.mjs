import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

async function readTrackedFile(input) {
  const root = await realpath(".");
  const path = relative(root, resolve(root, input));
  if (
    !path ||
    isAbsolute(input) ||
    path === ".." ||
    path.startsWith(".." + sep)
  )
    throw Error("Expected a tracked path relative to this worktree.");

  const absolute = resolve(root, path);
  if ((await realpath(dirname(absolute))) !== dirname(absolute))
    throw Error("The tracked path's parent was replaced with a symlink.");
  const tracked = execFileSync(
    "git",
    ["--literal-pathspecs", "ls-files", "-z", "--error-unmatch", "--", path],
    { encoding: "utf8" },
  );
  if (!tracked.split("\0").includes(path))
    throw Error("Expected one tracked file.");

  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    process.stdout.write(await readlink(absolute));
    return;
  }
  if (!stat.isFile()) throw Error("Expected one tracked file.");
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await pipeline(file.createReadStream(), process.stdout);
  } finally {
    await file.close();
  }
}

function run(command, argv, input) {
  const result = spawnSync(command, argv, {
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    ...(input !== undefined && { input }),
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

try {
  const [task, value, ...extra] = process.argv.slice(2);
  if (!value || extra.length) throw Error("Expected one tool parameter.");
  if (task === "read-file") await readTrackedFile(value);
  else if (task === "apply-patch") {
    // Newly created files stay visible to read-file and diff without staging their contents.
    run("git", ["apply", "--recount", "--intent-to-add", "-"], value);
  } else if (task === "package-build" || task === "package-test") {
    if (!/^@hitchlet\/[a-z0-9][a-z0-9-]*$/.test(value))
      throw Error(
        "Expected one exact workspace member name such as @hitchlet/gui.",
      );
    run("pnpm", [
      "--filter",
      value,
      "--fail-if-no-match",
      "run",
      task === "package-build" ? "build" : "test",
    ]);
  } else throw Error("Unknown worktree operation.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
