import { execFileSync, spawnSync } from "node:child_process";
import { constants, lstatSync } from "node:fs";
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
  return result.status === 0;
}

function applyPatch(patch) {
  // Git 2.39 can replace the existing index when apply --intent-to-add is used.
  // Use Git's NUL-separated output to identify the patch destinations, including renames.
  const numstat = execFileSync(
    "git",
    ["apply", "--recount", "--numstat", "-z", "-"],
    {
      input: patch,
      encoding: "utf8",
    },
  );
  const fileExists = (path) => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat !== undefined && !stat.isDirectory();
  };
  const destinations = numstat
    .split("\0")
    .filter(Boolean)
    .map((row) => row.replace(/^[^\t]+\t[^\t]+\t/, ""));
  const additions = destinations.filter((path) => !fileExists(path));
  if (!run("git", ["apply", "--recount", "-"], patch)) return;
  const created = additions.filter(fileExists);
  if (
    created.length &&
    !run(
      "git",
      [
        "--literal-pathspecs",
        "add",
        "--intent-to-add",
        "--force",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
      ],
      created.join("\0") + "\0",
    )
  )
    console.error(
      "Patch applied to the worktree; Git could not register the new files as intent-to-add.",
    );
}

try {
  const [task, value, ...extra] = process.argv.slice(2);
  if (!value || extra.length) throw Error("Expected one tool parameter.");
  if (task === "read-file") await readTrackedFile(value);
  else if (task === "apply-patch") {
    applyPatch(value);
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
