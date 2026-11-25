import { execFileSync, spawnSync } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  matchesGlob,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
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

function findFeature(input) {
  const target = normalize(input);
  if (
    !target ||
    target === "." ||
    isAbsolute(target) ||
    target === ".." ||
    target.startsWith("../")
  )
    throw Error("Expected a file path relative to the worktree root.");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  const revision = git("rev-parse", "HEAD").trim();
  const tracked = git("ls-tree", "-r", "-z", "--name-only", revision).split(
    "\0",
  );
  const roomFile = ".turbocli/project.json";
  let directory = dirname(target);
  while (directory !== "." && !tracked.includes(directory + "/" + roomFile))
    directory = dirname(directory);
  const prefix = directory === "." ? "" : directory + "/";
  const read = (path) =>
    JSON.parse(git("show", revision + ":" + prefix + path));
  const matches = [],
    testReferences = [],
    roomRules = [],
    unavailable = [];
  const result = {
    revision,
    path: target,
    module: null,
    matches,
    testReferences,
    roomRules,
    unavailable,
  };
  if (tracked.includes(prefix + roomFile)) {
    const file = target.slice(prefix.length);
    const pkg = read("package.json"),
      room = read(roomFile).featureRoom;
    result.module = { directory, name: pkg.name };
    const matching = (patterns = []) => {
      if (
        patterns.some((p) => p.startsWith("!") && matchesGlob(file, p.slice(1)))
      )
        return [];
      return patterns.filter((p) => !p.startsWith("!") && matchesGlob(file, p));
    };
    for (const name of ["projectLevel", "shared", "exclude"]) {
      for (const pattern of matching(room?.[name]))
        roomRules.push({ name, pattern, source: prefix + roomFile });
    }
    const start = prefix + ".turbocli/features/";
    for (const source of tracked) {
      if (
        !source.startsWith(start) ||
        !/^[^/]+\.json$/.test(source.slice(start.length))
      )
        continue;
      try {
        const feature = read(source.slice(prefix.length)),
          rules = [];
        if (
          typeof feature.id !== "string" ||
          !feature.writeSet ||
          !Array.isArray(feature.testEntries)
        )
          throw Error("Invalid feature declaration");
        for (const kind of ["implementation", "tests", "assets"]) {
          for (const pattern of matching(feature.writeSet[kind]))
            rules.push({ kind, pattern });
        }
        const entries = feature.testEntries
          .map((entry) => entry.command ?? pkg.scripts?.[entry.script])
          .filter(Boolean);
        if (rules.length)
          matches.push({
            feature: feature.id,
            source,
            rules,
            testEntries: entries,
          });
        else {
          const clues = entries.filter((command) =>
            command
              .split(/[\s"']+/)
              .some((arg) => arg === file || arg === "./" + file),
          );
          if (clues.length)
            testReferences.push({
              feature: feature.id,
              source,
              commands: clues,
            });
        }
      } catch (error) {
        unavailable.push({ source, error: error.message });
      }
    }
  }
  console.log(JSON.stringify(result));
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
  else if (task === "find-feature") findFeature(value);
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
