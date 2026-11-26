import { execFileSync, spawnSync } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import yaml from "./vendor/js-yaml-4.3.2/js-yaml.min.cjs";
import picomatch from "./vendor/picomatch-4.0.7/index.js";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  matchesGlob,
  normalize,
  relative,
  resolve,
  sep,
  win32,
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

const roomFile = ".turbocli/project.json";
const workspaceFile = "pnpm-workspace.yaml";
const categories = ["implementation", "tests", "assets"];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function checkedPatterns(value = []) {
  if (
    !Array.isArray(value) ||
    !value.every(
      (p) =>
        typeof p === "string" &&
        p.length > 0 &&
        !isAbsolute(p.replace(/^!/, "")) &&
        !win32.isAbsolute(p.replace(/^!/, "")) &&
        !p.includes("\\") &&
        !p.split("/").includes(".."),
    )
  )
    throw Error("Invalid project-relative rules");
  return value;
}

function checkedRules(value) {
  if (!object(value)) throw Error("Invalid write set");
  return Object.fromEntries(
    categories.map((kind) => [kind, checkedPatterns(value[kind])]),
  );
}

function matchingRules(file, patterns) {
  if (patterns.some((p) => p.startsWith("!") && matchesGlob(file, p.slice(1))))
    return [];
  return patterns.filter((p) => !p.startsWith("!") && matchesGlob(file, p));
}

// Use the same YAML parser and glob engine as pnpm's workspace discovery.
// Package manifests and membership are both read from the same Git revision.
function findMember(target, git, revision) {
  const ancestors = [];
  for (let dir = dirname(target); dir !== "."; dir = dirname(dir))
    ancestors.push(dir + "/package.json");
  if (!ancestors.length) return;
  const paths = new Set(
    git(
      "--literal-pathspecs",
      "ls-tree",
      "-z",
      "--name-only",
      revision,
      "--",
      workspaceFile,
      ...ancestors,
    ).split("\0"),
  );
  const candidates = ancestors.filter((path) => paths.has(path));
  if (!candidates.length) return;
  if (!paths.has(workspaceFile))
    throw Error("pnpm workspace manifest is missing");
  const workspace = yaml.load(git("show", revision + ":" + workspaceFile));
  if (workspace !== undefined && !object(workspace))
    throw Error("Invalid pnpm workspace manifest");
  const patterns = workspace?.packages ?? [".", "**"];
  if (
    !Array.isArray(patterns) ||
    !patterns.every((p) => typeof p === "string" && p.length > 0)
  )
    throw Error("Invalid pnpm workspace package patterns");
  const include = [],
    exclude = ["**/node_modules/**", "**/bower_components/**"];
  // pnpm appends a manifest suffix and tinyglobby distinguishes !(...) from a negation.
  for (const raw of patterns) {
    const p = raw.replace(/\/?$/, "/package.json");
    if (!p.startsWith("!") || p.startsWith("!(")) include.push(normalize(p));
    else if (!p.startsWith("!!") || p.startsWith("!!("))
      exclude.push(normalize(p.slice(1)));
  }
  const included = picomatch(include, { posix: true }),
    excluded = picomatch(exclude, { posix: true });
  const owner = candidates.find((path) => included(path) && !excluded(path));
  return owner && dirname(owner);
}

function findFeature(input) {
  const target = normalize(input);
  if (
    !target ||
    target === "." ||
    isAbsolute(target) ||
    win32.isAbsolute(target) ||
    target === ".." ||
    target.startsWith(".." + sep)
  )
    throw Error("Expected a file path relative to the worktree root.");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  const revision = git("rev-parse", "HEAD").trim();
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
  const directory = findMember(target, git, revision);
  if (!directory) {
    console.log(JSON.stringify(result));
    return;
  }
  const prefix = directory + "/",
    file = target.slice(prefix.length);
  const read = (path) => JSON.parse(git("show", revision + ":" + path));
  const pkg = read(prefix + "package.json"),
    roomSource = prefix + roomFile;
  result.module = { directory, name: pkg.name ?? directory };
  const featureDir = prefix + ".turbocli/features/";
  const paths = git(
    "--literal-pathspecs",
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    revision,
    "--",
    roomSource,
    featureDir,
  ).split("\0");
  let hasScope = false;
  if (paths.includes(roomSource)) {
    try {
      const project = read(roomSource);
      if (!object(project) || project.protocolVersion !== "1.0") throw Error();
      if (project.featureRoom !== undefined) {
        checkedRules(project.featureRoom.scope);
        const room = ["projectLevel", "shared", "exclude"].flatMap((name) =>
          matchingRules(file, checkedPatterns(project.featureRoom[name])).map(
            (pattern) => ({ name, pattern, source: roomSource }),
          ),
        );
        hasScope = true;
        roomRules.push(...room);
      }
    } catch {
      unavailable.push({
        source: roomSource,
        error: "feature_room_configuration_invalid",
      });
    }
  }

  const declarations = [];
  const idCounts = new Map();
  for (const source of paths) {
    if (
      !source.startsWith(featureDir) ||
      !/^[^/]+\.json$/.test(source.slice(featureDir.length))
    )
      continue;
    try {
      const feature = read(source);
      if (
        !object(feature) ||
        typeof feature.id !== "string" ||
        !/^[\w][\w.-]*$/.test(feature.id) ||
        !Array.isArray(feature.testEntries)
      )
        throw Error();
      const writeSet = checkedRules(feature.writeSet);
      const missingScripts = [];
      const entries = feature.testEntries
        .map((entry) => {
          if (!object(entry)) throw Error();
          if (
            typeof entry.command === "string" &&
            entry.command.trim() &&
            entry.script === undefined
          )
            return entry.command;
          if (
            typeof entry.script !== "string" ||
            !entry.script ||
            entry.command !== undefined
          )
            throw Error();
          if (
            Object.hasOwn(pkg.scripts ?? {}, entry.script) &&
            pkg.scripts[entry.script]
          )
            return pkg.scripts[entry.script];
          missingScripts.push({
            source,
            feature: feature.id,
            error: "feature_test_script_missing",
          });
        })
        .filter(Boolean);
      declarations.push({ id: feature.id, source, writeSet, entries });
      idCounts.set(feature.id, (idCounts.get(feature.id) ?? 0) + 1);
      unavailable.push(...missingScripts);
    } catch {
      unavailable.push({ source, error: "feature_definition_invalid" });
    }
  }
  if (declarations.length && !hasScope)
    unavailable.push({
      source: roomSource,
      error: "feature_room_scope_missing",
    });
  for (const { id, source, writeSet, entries } of declarations) {
    if (idCounts.get(id) > 1) {
      unavailable.push({ source, feature: id, error: "feature_id_conflict" });
      continue;
    }
    const rules = categories.flatMap((kind) =>
      matchingRules(file, writeSet[kind]).map((pattern) => ({ kind, pattern })),
    );
    if (rules.length)
      matches.push({ feature: id, source, rules, testEntries: entries });
    else {
      const clues = entries.filter((command) =>
        command
          .split(/[\s"']+/)
          .some((arg) => arg === file || arg === "./" + file),
      );
      if (clues.length)
        testReferences.push({ feature: id, source, commands: clues });
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
  const endMarker = /(?:^|\n)\*\*\* End Patch(?:\r?\n|$)/;
  if (endMarker.test(patch)) {
    const body = patch.replace(/\n\*\*\* End Patch(?:\r?\n)?$/, "\n");
    if (
      endMarker.test(body) ||
      !/(?:^|\n)(?:diff --git [^\r\n]+|--- [^\r\n]+\r?\n\+\+\+ [^\r\n]+)/.test(
        body,
      )
    )
      throw Error(
        "Expected one optional final *** End Patch after a Git unified diff.",
      );
    patch = body;
  }
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
