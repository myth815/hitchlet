import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./agent-worktree.mjs", import.meta.url));
const edit =
  "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1,8 +1,9 @@\n first\n-old\n+new\n last\n";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "hitchlet-agent-patch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "--quiet");
  await writeFile(join(cwd, "example.txt"), "first\nold\nlast\n");
  await writeFile(join(cwd, "another.txt"), "original\n");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-qm",
    "baseline",
  );
  await writeFile(join(cwd, "another.txt"), "already staged\n");
  git("add", "another.txt");
  await writeFile(join(cwd, "another.txt"), "unstaged on top\n");
  const apply = (patch) =>
    spawnSync(process.execPath, [entry, "apply-patch", patch], {
      cwd,
      encoding: "utf8",
    });
  return { cwd, git, apply };
}

test("a tracked edit recounts hunks and preserves every existing index entry", async (t) => {
  const { cwd, git, apply } = await fixture(t);
  const index = git("ls-files", "--stage");
  const result = apply(edit);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("ls-files", "--stage"), index);
  assert.equal(
    await readFile(join(cwd, "example.txt"), "utf8"),
    "first\nnew\nlast\n",
  );
  assert.equal(
    await readFile(join(cwd, "another.txt"), "utf8"),
    "unstaged on top\n",
  );
  assert.equal(git("show", ":another.txt"), "already staged\n");
  assert.notEqual(apply(edit).status, 0, "stale context must still fail");
  assert.equal(git("ls-files", "--stage"), index);
});

test("a failed mixed patch can be corrected and marks only its actual new paths intent-to-add", async (t) => {
  const { cwd, git, apply } = await fixture(t);
  const initial = git("ls-files", "--stage");
  await writeFile(join(cwd, "unrelated.txt"), "other work\n");
  const add =
    "diff --git a/new path.txt b/new path.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new path.txt\n@@ -0,0 +1 @@\n+new file\n";
  assert.notEqual(apply(add + edit.replace("-old\n", "-stale\n")).status, 0);
  assert.equal(git("ls-files", "--stage"), initial);
  await assert.rejects(readFile(join(cwd, "new path.txt")), { code: "ENOENT" });
  assert.equal(
    await readFile(join(cwd, "example.txt"), "utf8"),
    "first\nold\nlast\n",
  );

  const retry = apply(add + edit);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(
    git("ls-files", "--stage", "--", "example.txt", "another.txt"),
    initial,
  );
  assert.equal(git("ls-files", "-z", "--", "new path.txt"), "new path.txt\0");
  assert.equal(
    git("show", ":new path.txt"),
    "",
    "new file contents remain unstaged",
  );
  assert.equal(await readFile(join(cwd, "new path.txt"), "utf8"), "new file\n");
  assert.equal(git("diff", "--cached", "--name-only"), "another.txt\n");
  assert.equal(git("ls-files", "--", "unrelated.txt"), "");

  const del =
    "diff --git a/example.txt b/example.txt\ndeleted file mode 100644\n--- a/example.txt\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-first\n-new\n-last\n";
  const beforeDelete = git("ls-files", "--stage");
  const deleted = apply(del);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(
    git("ls-files", "--stage"),
    beforeDelete,
    "deletion belongs to the worktree",
  );
});

test("Git's quoted rename destination with a tab and a newline is kept as one path", async (t) => {
  const { cwd, git, apply } = await fixture(t);
  const renamed = "renamed\tentry\nname.txt";
  const quoted = '"renamed\\tentry\\nname.txt"';
  const patch =
    'diff --git a/example.txt "b/renamed\\tentry\\nname.txt"\nsimilarity index 100%\nrename from example.txt\nrename to ' +
    quoted +
    "\n";
  const index = git("ls-files", "--stage", "--", "example.txt", "another.txt");
  const result = apply(patch);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    git("ls-files", "--stage", "--", "example.txt", "another.txt"),
    index,
  );
  assert.equal(git("ls-files", "-z", "--", renamed), renamed + "\0");
  assert.equal(git("show", ":" + renamed), "");
  assert.equal(
    await readFile(join(cwd, renamed), "utf8"),
    "first\nold\nlast\n",
  );
  assert.equal(git("ls-files", "-z", "--others"), "");
});

test("failure to persist an intent tells the caller the working patch was applied", async (t) => {
  const { cwd, apply, git } = await fixture(t);
  const newPath = "locked.txt";
  const patch =
    "diff --git a/locked.txt b/locked.txt\nnew file mode 100644\n--- /dev/null\n+++ b/locked.txt\n@@ -0,0 +1 @@\n+written\n";
  const index = git("ls-files", "--stage");
  await writeFile(join(cwd, ".git", "index.lock"), "fixture lock");
  const result = apply(patch);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Patch applied to the worktree; Git could not register the new files/,
  );
  assert.equal(git("ls-files", "--stage"), index);
  assert.equal(await readFile(join(cwd, newPath), "utf8"), "written\n");
});
