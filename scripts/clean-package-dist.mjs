import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_DIRS, REPO_ROOT } from "./package-provenance.mjs";

const [packageName] = process.argv.slice(2);
const packageDirectory = PACKAGE_DIRS[packageName];
if (!packageDirectory) {
  console.error("Usage: node scripts/clean-package-dist.mjs <package-name>");
  process.exitCode = 2;
} else {
  const expectedCwd = resolve(REPO_ROOT, packageDirectory);
  if (resolve(process.cwd()) !== expectedCwd) {
    console.error(
      `${packageName} dist cleanup must run from ${packageDirectory}`,
    );
    process.exitCode = 1;
  } else {
    rmSync(resolve(expectedCwd, "dist"), { recursive: true, force: true });
  }
}
