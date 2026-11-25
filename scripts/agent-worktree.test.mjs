import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Agent patches can miscount hunk lines but must still match the current worktree", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "hitchlet-agent-patch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd });
  const file = join(cwd, "example.txt");
  await writeFile(file, "first\nold\nlast\n");
  execFileSync("git", ["add", "example.txt"], { cwd });
  const entry = fileURLToPath(new URL("./agent-worktree.mjs", import.meta.url));
  const patch =
    "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1,8 +1,9 @@\n first\n-old\n+new\n last\n";
  const apply = () =>
    spawnSync(process.execPath, [entry, "apply-patch", patch], {
      cwd,
      encoding: "utf8",
    });
  const first = apply();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await readFile(file, "utf8"), "first\nnew\nlast\n");
  assert.notEqual(apply().status, 0);
  assert.equal(await readFile(file, "utf8"), "first\nnew\nlast\n");
});
