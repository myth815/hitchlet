import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { packageRuntime } from "./package-runtime.mjs";
test("assembles a dependency-closed Runtime candidate outside the workspace without configuration or credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-runtime-package-"));
  try {
    const out = join(root, "candidate");
    const result = await packageRuntime(out);
    const manifest = JSON.parse(
      await readFile(join(out, "bundle-manifest.json"), "utf8"),
    );
    assert.equal(result.sourceRevision, manifest.sourceRevision);
    assert.equal(manifest.nodeBinaryIncluded, false);
    assert.equal(manifest.windowsExecuted, false);
    assert.deepEqual((await readdir(out)).sort(), [
      "README.txt",
      "bundle-manifest.json",
      "dist",
      "node_modules",
      "package.json",
    ]);
    assert.deepEqual((await readdir(join(out, "node_modules"))).sort(), [
      "@hitchlet",
      "zod",
    ]);
    assert.equal(manifest.configOrCredentialsIncluded, false);
    assert.equal(manifest.packages.zod, "4.1.12");
    for (const name of [
      "dist/hyperv-main.js",
      "dist/drivers/hyperv-local.ps1",
      "node_modules/@hitchlet/contracts/dist/internal.js",
      "node_modules/zod/package.json",
    ]) {
      const data = await readFile(join(out, name));
      assert.equal(
        manifest.files[name].sha256,
        createHash("sha256").update(data).digest("hex"),
      );
    }
    const url = pathToFileURL(join(out, "dist/hyperv-main.js")).href;
    const stdout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(url)}); console.log('closed-runtime-loaded')`,
      ],
      {
        cwd: out,
        env: {
          ...process.env,
          NODE_PATH: "",
          HITCHLET_HYPERV_RUNTIME_CONFIG: "",
        },
        encoding: "utf8",
      },
    );
    assert.equal(stdout.trim(), "closed-runtime-loaded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("never overwrites or merges an existing candidate directory", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "hitchlet-runtime-package-existing-"),
  );
  try {
    await writeFile(join(root, "keep.txt"), "unchanged");
    await assert.rejects(packageRuntime(root), { code: "EEXIST" });
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "unchanged");
    assert.deepEqual(await readdir(root), ["keep.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
