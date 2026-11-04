import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, it, expect } from "vitest";
import {
  hashHyperVExport,
  HyperVTemplateRegistry,
} from "../src/hyperv-templates.js";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
async function root() {
  const r = await mkdtemp(join(tmpdir(), "hitchlet-export-"));
  roots.push(r);
  return r;
}
it("streams every nested export file so changing a VHDX changes content identity", async () => {
  const r = await root();
  await mkdir(join(r, "Virtual Machines"));
  await mkdir(join(r, "Virtual Hard Disks"));
  await writeFile(join(r, "Virtual Machines/base.vmcx"), "config");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 27);
  await writeFile(join(r, "Virtual Hard Disks/disk.vhdx"), bytes);
  const files = await hashHyperVExport(r);
  expect(files).toHaveLength(2);
  expect(files.find((f) => f.path.endsWith("vhdx"))).toMatchObject({
    size: String(bytes.length),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  bytes[0] = 99;
  await writeFile(join(r, "Virtual Hard Disks/disk.vhdx"), bytes);
  const changed = await hashHyperVExport(r);
  expect(changed.find((f) => f.path.endsWith("vhdx"))?.sha256).not.toBe(
    files.find((f) => f.path.endsWith("vhdx"))?.sha256,
  );
});
it("does not follow links out of an export or report malformed registry as a template", async () => {
  const r = await root();
  await writeFile(join(r, "foreign"), "unrelated");
  await mkdir(join(r, "bundle"));
  await symlink(join(r, "foreign"), join(r, "bundle/disk.vhdx"));
  await expect(hashHyperVExport(join(r, "bundle"))).rejects.toThrow("links");
  const registry = join(r, "registry");
  await mkdir(registry);
  await writeFile(join(registry, "bad.json"), "{}");
  expect(
    await new HyperVTemplateRegistry(
      registry,
      "00000000-0000-4000-8000-000000000001",
    ).facts(),
  ).toEqual([]);
});
