import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGE_DIRS = {
  "@hitchlet/contracts": "packages/contracts",
  "@hitchlet/sdk": "packages/sdk",
};
export const PROVENANCE_FILE = ".hitchlet-build.json";

const hash = (contents) => createHash("sha256").update(contents).digest("hex");

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

function fileHashes(paths, root) {
  return Object.fromEntries(
    paths.map((path) => [
      relative(root, path).split(sep).join("/"),
      hash(readFileSync(path)),
    ]),
  );
}

export function manifestFingerprint(manifest) {
  return hash(JSON.stringify(manifest));
}

export function inputHashes(packageName, repoRoot = REPO_ROOT) {
  const packageRoot = resolve(repoRoot, PACKAGE_DIRS[packageName]);
  const sources = filesUnder(resolve(packageRoot, "src"));
  const fixedInputs = [
    resolve(packageRoot, "package.json"),
    resolve(packageRoot, "tsconfig.json"),
    resolve(repoRoot, "package.json"),
    resolve(repoRoot, "pnpm-lock.yaml"),
    resolve(repoRoot, "tsconfig.base.json"),
  ];
  return fileHashes([...sources, ...fixedInputs].sort(), repoRoot);
}

export function outputHashes(packageName, repoRoot = REPO_ROOT) {
  const packageRoot = resolve(repoRoot, PACKAGE_DIRS[packageName]);
  const dist = resolve(packageRoot, "dist");
  const outputs = filesUnder(dist).filter(
    (path) => relative(dist, path).split(sep).join("/") !== PROVENANCE_FILE,
  );
  if (outputs.length === 0) throw new Error(`${packageName} dist is empty`);
  return fileHashes(outputs, packageRoot);
}

function readPackage(packageName, repoRoot = REPO_ROOT) {
  const packageRoot = resolve(repoRoot, PACKAGE_DIRS[packageName]);
  return JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
}

export function readBuildManifest(packageName, repoRoot = REPO_ROOT) {
  const packageRoot = resolve(repoRoot, PACKAGE_DIRS[packageName]);
  return JSON.parse(
    readFileSync(resolve(packageRoot, "dist", PROVENANCE_FILE), "utf8"),
  );
}

export function validateBuild(packageName, repoRoot = REPO_ROOT) {
  if (!PACKAGE_DIRS[packageName])
    throw new Error(`Unknown package: ${packageName}`);
  const pkg = readPackage(packageName, repoRoot);
  const manifest = readBuildManifest(packageName, repoRoot);
  if (manifest.packageName !== packageName || manifest.version !== pkg.version)
    throw new Error(
      `${packageName} build manifest does not match package metadata`,
    );
  if (
    JSON.stringify(manifest.inputs) !==
    JSON.stringify(inputHashes(packageName, repoRoot))
  )
    throw new Error(
      `${packageName} build is stale: source or build inputs changed`,
    );
  if (
    JSON.stringify(manifest.outputs) !==
    JSON.stringify(outputHashes(packageName, repoRoot))
  )
    throw new Error(`${packageName} build is stale: emitted files changed`);
  if (packageName === "@hitchlet/sdk") {
    const contracts = validateBuild("@hitchlet/contracts", repoRoot);
    if (manifest.contractsFingerprint !== manifestFingerprint(contracts))
      throw new Error(
        "SDK build is stale: it was not built against these contracts",
      );
  }
  return manifest;
}

export function writeBuildManifest(packageName, repoRoot = REPO_ROOT) {
  if (!PACKAGE_DIRS[packageName])
    throw new Error(`Unknown package: ${packageName}`);
  const pkg = readPackage(packageName, repoRoot);
  const manifest = {
    packageName,
    version: pkg.version,
    inputs: inputHashes(packageName, repoRoot),
    outputs: outputHashes(packageName, repoRoot),
    ...(packageName === "@hitchlet/sdk"
      ? {
          contractsFingerprint: manifestFingerprint(
            validateBuild("@hitchlet/contracts", repoRoot),
          ),
        }
      : {}),
    gitRevision: process.env.HITCHLET_BUILD_REVISION ?? null,
  };
  const path = resolve(
    repoRoot,
    PACKAGE_DIRS[packageName],
    "dist",
    PROVENANCE_FILE,
  );
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  return manifest;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [packageName] = process.argv.slice(2);
  if (!packageName || !PACKAGE_DIRS[packageName]) {
    console.error(`Usage: node scripts/package-provenance.mjs <package-name>`);
    process.exitCode = 2;
  } else {
    try {
      const manifest = writeBuildManifest(packageName);
      console.log(`${packageName}@${manifest.version} provenance recorded`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
