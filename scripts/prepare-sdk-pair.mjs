import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_DIRS,
  REPO_ROOT,
  manifestFingerprint,
  validateBuild,
} from "./package-provenance.mjs";

const sha256 = (contents) =>
  createHash("sha256").update(contents).digest("hex");

export function validatePackedManifest(
  manifest,
  { packageName, version, contractsVersion },
) {
  if (manifest.name !== packageName || manifest.version !== version)
    throw new Error(`Packed manifest does not match ${packageName}@${version}`);
  if (packageName === "@hitchlet/sdk") {
    const dependency = manifest.dependencies?.["@hitchlet/contracts"];
    if (typeof dependency === "string" && dependency.startsWith("workspace:"))
      throw new Error("Packed SDK manifest retains a workspace dependency");
    if (dependency !== contractsVersion)
      throw new Error(
        `Packed SDK must depend on @hitchlet/contracts@${contractsVersion}; received ${String(dependency)}`,
      );
  }
}

export function validatePair(repoRoot = REPO_ROOT) {
  const contracts = validateBuild("@hitchlet/contracts", repoRoot);
  const sdk = validateBuild("@hitchlet/sdk", repoRoot);
  const contractsPkg = JSON.parse(
    readFileSync(
      resolve(repoRoot, PACKAGE_DIRS["@hitchlet/contracts"], "package.json"),
      "utf8",
    ),
  );
  const sdkPkg = JSON.parse(
    readFileSync(
      resolve(repoRoot, PACKAGE_DIRS["@hitchlet/sdk"], "package.json"),
      "utf8",
    ),
  );
  if (contracts.version !== sdk.version)
    throw new Error("Contracts and SDK versions must match exactly");
  if (contracts.gitRevision !== sdk.gitRevision)
    throw new Error(
      "Contracts and SDK were built from different Git revisions",
    );
  if (
    sdkPkg.dependencies?.["@hitchlet/contracts"] !==
    `workspace:${contracts.version}`
  )
    throw new Error(
      "SDK source dependency must pin the matching workspace version",
    );
  if (contractsPkg.private !== true || sdkPkg.private !== true)
    throw new Error(
      "Source packages must remain private; use the local tarball flow",
    );
  return { contracts, sdk, contractsPkg, sdkPkg };
}

function tarManifest(tarball) {
  return JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function tarEntries(tarball) {
  return execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split(/\r?\n/);
}

function verifyExportFiles(pkg, entries) {
  for (const target of Object.values(pkg.exports ?? {})) {
    for (const file of Object.values(target)) {
      if (!entries.includes(`package/${file.replace(/^\.\//, "")}`))
        throw new Error(`${pkg.name} tarball is missing exported file ${file}`);
    }
  }
}

function packPackage(packageName, destination, repoRoot = REPO_ROOT) {
  const cwd = resolve(repoRoot, PACKAGE_DIRS[packageName]);
  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd,
    stdio: "inherit",
  });
  const tarballs = readdirSync(destination)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => resolve(destination, name));
  if (tarballs.length !== 1)
    throw new Error(`${packageName} pack did not produce exactly one tarball`);
  return tarballs[0];
}

export function preparePair(
  outputDir,
  repoRoot = REPO_ROOT,
  pack = packPackage,
) {
  const absoluteOutput = resolve(outputDir);
  if (!isAbsolute(outputDir))
    throw new Error("Output directory must be absolute");
  if (existsSync(absoluteOutput) && readdirSync(absoluteOutput).length > 0)
    throw new Error("Output directory must be empty");
  const pair = validatePair(repoRoot);
  mkdirSync(absoluteOutput, { recursive: true });
  const workDir = resolve(absoluteOutput, ".pack-work");
  mkdirSync(workDir);
  const publishedFiles = [];
  try {
    const contractsWork = resolve(workDir, "contracts");
    const sdkWork = resolve(workDir, "sdk");
    mkdirSync(contractsWork);
    mkdirSync(sdkWork);
    const contractsTarball = pack(
      "@hitchlet/contracts",
      contractsWork,
      repoRoot,
    );
    const sdkTarball = pack("@hitchlet/sdk", sdkWork, repoRoot);
    const contractsManifest = tarManifest(contractsTarball);
    const sdkManifest = tarManifest(sdkTarball);
    validatePackedManifest(contractsManifest, {
      packageName: "@hitchlet/contracts",
      version: pair.contracts.version,
    });
    validatePackedManifest(sdkManifest, {
      packageName: "@hitchlet/sdk",
      version: pair.sdk.version,
      contractsVersion: pair.contracts.version,
    });
    verifyExportFiles(contractsManifest, tarEntries(contractsTarball));
    verifyExportFiles(sdkManifest, tarEntries(sdkTarball));

    const contractsName = basename(contractsTarball);
    const sdkName = basename(sdkTarball);
    const contractsOutput = resolve(absoluteOutput, contractsName);
    const sdkOutput = resolve(absoluteOutput, sdkName);
    renameSync(contractsTarball, contractsOutput);
    publishedFiles.push(contractsOutput);
    renameSync(sdkTarball, sdkOutput);
    publishedFiles.push(sdkOutput);
    const result = {
      format: 1,
      gitRevision: pair.contracts.gitRevision,
      packages: [
        {
          name: "@hitchlet/contracts",
          version: pair.contracts.version,
          file: contractsName,
          sha256: sha256(readFileSync(contractsOutput)),
          buildFingerprint: manifestFingerprint(pair.contracts),
        },
        {
          name: "@hitchlet/sdk",
          version: pair.sdk.version,
          file: sdkName,
          sha256: sha256(readFileSync(sdkOutput)),
          buildFingerprint: manifestFingerprint(pair.sdk),
        },
      ],
    };
    writeFileSync(
      resolve(absoluteOutput, "hitchlet-sdk-pair.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o644, flag: "wx" },
    );
    return result;
  } catch (error) {
    for (const path of publishedFiles) rmSync(path, { force: true });
    throw error;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = process.argv[2];
  if (!output) {
    console.error(
      "Usage: node scripts/prepare-sdk-pair.mjs /absolute/output/directory",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = preparePair(output);
      console.log(`Prepared matching local tarballs in ${resolve(output)}`);
      for (const pkg of result.packages)
        console.log(`${pkg.name}@${pkg.version} sha256:${pkg.sha256}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
