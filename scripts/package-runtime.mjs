import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateBuild } from "./package-provenance.mjs";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function filesUnder(root) {
  const result = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const path = join(root, e.name);
    if (e.isDirectory()) result.push(...(await filesUnder(path)));
    else if (e.isFile()) result.push(path);
    else throw Error("Runtime bundle inputs must be regular files/directories");
  }
  return result.sort();
}
async function fileMap(root, paths) {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (p) => {
        const bytes = await readFile(p);
        return [
          relative(root, p).split(sep).join("/"),
          { bytes: bytes.length, sha256: sha(bytes) },
        ];
      }),
    ),
  );
}
async function sourceMap() {
  const paths = [
    ...(await filesUnder(join(REPO, "apps/runtime-agent/src"))),
    ...(await filesUnder(join(REPO, "packages/contracts/src"))),
    ...[
      "apps/runtime-agent/package.json",
      "apps/runtime-agent/tsconfig.json",
      "apps/runtime-agent/scripts/copy-host-assets.mjs",
      "packages/contracts/package.json",
      "packages/contracts/tsconfig.json",
      "package.json",
      "tsconfig.base.json",
      "pnpm-lock.yaml",
    ].map((p) => join(REPO, p)),
  ];
  return fileMap(REPO, paths.sort());
}
function packageMetadata(pkg) {
  const { devDependencies: _, scripts: __, ...metadata } = pkg;
  return metadata;
}
/** Offline directory assembly only: no install lifecycle, deployment, credentials or remote calls. */
export async function packageRuntime(outputDirectory) {
  const output = resolve(outputDirectory);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Exclusive: never merge into or overwrite an existing destination.
  const runtime = join(REPO, "apps/runtime-agent"),
    contracts = join(REPO, "packages/contracts");
  const runtimePkg = JSON.parse(
    await readFile(join(runtime, "package.json"), "utf8"),
  );
  const contractsPkg = JSON.parse(
    await readFile(join(contracts, "package.json"), "utf8"),
  );
  validateBuild("@hitchlet/contracts");
  const inputs = await sourceMap();
  execFileSync(
    process.execPath,
    [
      join(REPO, "node_modules/typescript/bin/tsc"),
      "-p",
      join(runtime, "tsconfig.json"),
    ],
    { cwd: runtime, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [join(runtime, "scripts/copy-host-assets.mjs")],
    { cwd: runtime, stdio: "pipe" },
  );
  if (JSON.stringify(inputs) !== JSON.stringify(await sourceMap()))
    throw Error(
      "Runtime source changed during packaging; candidate is incomplete",
    );
  const require = createRequire(join(runtime, "package.json"));
  const zodRoot = dirname(require.resolve("zod/package.json"));
  const zodPkg = JSON.parse(
    await readFile(join(zodRoot, "package.json"), "utf8"),
  );
  if (
    zodPkg.version !== runtimePkg.dependencies.zod ||
    zodPkg.version !== contractsPkg.dependencies.zod
  )
    throw Error("Installed Zod does not match the paired package versions");
  const contractsTarget = join(output, "node_modules/@hitchlet/contracts");
  await mkdir(contractsTarget, { recursive: true });
  await cp(join(runtime, "dist"), join(output, "dist"), {
    recursive: true,
    dereference: true,
  });
  await cp(join(contracts, "dist"), join(contractsTarget, "dist"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(
    join(contractsTarget, "package.json"),
    JSON.stringify(packageMetadata(contractsPkg), null, 2) + "\n",
  );
  await cp(zodRoot, join(output, "node_modules/zod"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(
    join(output, "package.json"),
    JSON.stringify(
      {
        ...packageMetadata(runtimePkg),
        dependencies: {
          "@hitchlet/contracts": contractsPkg.version,
          zod: zodPkg.version,
        },
        bundledDependencies: ["@hitchlet/contracts", "zod"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(output, "README.txt"),
    "Hitchlet Runtime candidate (offline assembled)\nRequires Node.js 24 supplied separately. Dependencies are included; do not run npm/pnpm install.\nHyper-V entry: set HITCHLET_HYPERV_RUNTIME_CONFIG to the actual deployment config, then node dist/hyperv-main.js [--init].\n--init creates namespace/work/state directories only when explicitly run. No credentials or configuration are included.\nThis package is not a Windows/VM qualification receipt. No installation, network setup, template or guest bootstrap is performed by packaging.\n",
  );
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO,
      encoding: "utf8",
    }).trim().length > 0;
  const outputs = await fileMap(output, await filesUnder(output));
  const manifest = {
    formatVersion: 1,
    role: "hitchlet-runtime-candidate",
    sourceRevision: revision,
    workingTreeDirty: dirty,
    buildNode: process.version,
    entry: "dist/hyperv-main.js",
    packages: {
      [runtimePkg.name]: runtimePkg.version,
      [contractsPkg.name]: contractsPkg.version,
      zod: zodPkg.version,
    },
    nodeBinaryIncluded: false,
    windowsExecuted: false,
    configOrCredentialsIncluded: false,
    inputs,
    files: outputs,
  };
  await writeFile(
    join(output, "bundle-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return {
    outputDirectory: output,
    sourceRevision: revision,
    workingTreeDirty: dirty,
    fileCount: Object.keys(outputs).length,
    totalBytes: Object.values(outputs).reduce((n, f) => n + f.bytes, 0),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3) {
    process.stderr.write(
      "Usage: node scripts/package-runtime.mjs NEW_OUTPUT_DIRECTORY\n",
    );
    process.exitCode = 1;
  } else
    packageRuntime(process.argv[2])
      .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
      .catch((error) => {
        process.stderr.write(
          `Runtime package assembly failed: ${error.message}\n`,
        );
        process.exitCode = 1;
      });
}
