import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  PACKAGE_DIRS,
  manifestFingerprint,
  validateBuild,
  writeBuildManifest,
} from "./package-provenance.mjs";
import {
  preparePair,
  validatePackedManifest,
  validatePair,
} from "./prepare-sdk-pair.mjs";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "hitchlet-sdk-pair-"));
  writeFileSync(resolve(root, "package.json"), '{"name":"fixture"}');
  writeFileSync(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(resolve(root, "tsconfig.base.json"), "{}\n");
  for (const [name, version, dependencies] of [
    ["@hitchlet/contracts", "0.1.0", {}],
    ["@hitchlet/sdk", "0.1.0", { "@hitchlet/contracts": "workspace:0.1.0" }],
  ]) {
    const packageRoot = resolve(root, PACKAGE_DIRS[name]);
    mkdirSync(resolve(packageRoot, "src"), { recursive: true });
    mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      resolve(packageRoot, "package.json"),
      JSON.stringify({
        name,
        version,
        private: true,
        dependencies,
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
        },
      }),
    );
    writeFileSync(resolve(packageRoot, "tsconfig.json"), "{}\n");
    writeFileSync(
      resolve(packageRoot, "src", "index.ts"),
      `export const name = '${name}';\n`,
    );
    writeFileSync(
      resolve(packageRoot, "dist", "index.js"),
      `export {}; // ${name}\n`,
    );
    writeFileSync(resolve(packageRoot, "dist", "index.d.ts"), "export {};\n");
  }
  writeBuildManifest("@hitchlet/contracts", root);
  writeBuildManifest("@hitchlet/sdk", root);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("missing provenance is not releasable", () => {
  const { root, cleanup } = fixture();
  try {
    rmSync(
      resolve(
        root,
        PACKAGE_DIRS["@hitchlet/sdk"],
        "dist",
        ".hitchlet-build.json",
      ),
    );
    assert.throws(() => validateBuild("@hitchlet/sdk", root), /ENOENT/);
  } finally {
    cleanup();
  }
});

test("changed source invalidates recorded build provenance", () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      resolve(root, PACKAGE_DIRS["@hitchlet/contracts"], "src", "index.ts"),
      "export const changed = true;\n",
    );
    assert.throws(() => validateBuild("@hitchlet/contracts", root), /stale/);
  } finally {
    cleanup();
  }
});

test("changed emitted artifact invalidates recorded build provenance", () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      resolve(root, PACKAGE_DIRS["@hitchlet/contracts"], "dist", "index.js"),
      "export const changed = true;\n",
    );
    assert.throws(
      () => validateBuild("@hitchlet/contracts", root),
      /emitted files changed/,
    );
  } finally {
    cleanup();
  }
});

test("SDK provenance is tied to the exact contracts build", () => {
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      resolve(root, PACKAGE_DIRS["@hitchlet/contracts"], "dist", "index.js"),
      "export const changed = true;\n",
    );
    writeBuildManifest("@hitchlet/contracts", root);
    assert.throws(
      () => validateBuild("@hitchlet/sdk", root),
      /not built against/,
    );
  } finally {
    cleanup();
  }
});

test("paired versions and exact workspace source dependency are required", () => {
  const { root, cleanup } = fixture();
  try {
    assert.doesNotThrow(() => validatePair(root));
    const sdkPackage = resolve(
      root,
      PACKAGE_DIRS["@hitchlet/sdk"],
      "package.json",
    );
    const pkg = JSON.parse(readFileSync(sdkPackage, "utf8"));
    pkg.dependencies["@hitchlet/contracts"] = "workspace:*";
    writeFileSync(sdkPackage, JSON.stringify(pkg));
    writeBuildManifest("@hitchlet/sdk", root);
    assert.throws(
      () => validatePair(root),
      /pin the matching workspace version/,
    );
  } finally {
    cleanup();
  }
});

test("pair provenance cannot mix supplied Git revisions", () => {
  const { root, cleanup } = fixture();
  try {
    const contractsManifest = resolve(
      root,
      PACKAGE_DIRS["@hitchlet/contracts"],
      "dist",
      ".hitchlet-build.json",
    );
    const manifest = JSON.parse(readFileSync(contractsManifest, "utf8"));
    manifest.gitRevision = "a".repeat(40);
    writeFileSync(contractsManifest, JSON.stringify(manifest));
    const sdkManifestPath = resolve(
      root,
      PACKAGE_DIRS["@hitchlet/sdk"],
      "dist",
      ".hitchlet-build.json",
    );
    const sdkManifest = JSON.parse(readFileSync(sdkManifestPath, "utf8"));
    sdkManifest.contractsFingerprint = manifestFingerprint(manifest);
    writeFileSync(sdkManifestPath, JSON.stringify(sdkManifest));
    assert.throws(() => validatePair(root), /different Git revisions/);
  } finally {
    cleanup();
  }
});

test("packed SDK must name the exact contracts version", () => {
  const expected = {
    packageName: "@hitchlet/sdk",
    version: "0.1.0",
    contractsVersion: "0.1.0",
  };
  assert.doesNotThrow(() =>
    validatePackedManifest(
      {
        name: "@hitchlet/sdk",
        version: "0.1.0",
        dependencies: { "@hitchlet/contracts": "0.1.0" },
      },
      expected,
    ),
  );
  for (const dependency of ["workspace:*", "^0.1.0", "0.2.0"]) {
    assert.throws(
      () =>
        validatePackedManifest(
          {
            name: "@hitchlet/sdk",
            version: "0.1.0",
            dependencies: { "@hitchlet/contracts": dependency },
          },
          expected,
        ),
      /workspace dependency|must depend on/,
    );
  }
});

test("pair preparation packs both fixture packages and records their hashes", () => {
  const { root, cleanup } = fixture();
  const output = resolve(root, "candidate");
  try {
    const fakePack = (packageName, destination, repoRoot) => {
      const packageRoot = resolve(repoRoot, PACKAGE_DIRS[packageName]);
      const pkg = JSON.parse(
        readFileSync(resolve(packageRoot, "package.json"), "utf8"),
      );
      const packed = {
        name: pkg.name,
        version: pkg.version,
        dependencies:
          pkg.name === "@hitchlet/sdk"
            ? { "@hitchlet/contracts": "0.1.0" }
            : {},
        exports: pkg.exports,
      };
      const packedRoot = resolve(destination, "package");
      mkdirSync(resolve(packedRoot, "dist"), { recursive: true });
      writeFileSync(
        resolve(packedRoot, "package.json"),
        JSON.stringify(packed),
      );
      for (const extension of ["js", "d.ts"])
        writeFileSync(
          resolve(packedRoot, "dist", `index.${extension}`),
          readFileSync(resolve(packageRoot, "dist", `index.${extension}`)),
        );
      const tarball = resolve(
        destination,
        `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`,
      );
      execFileSync("tar", ["-czf", tarball, "package"], { cwd: destination });
      return tarball;
    };
    const result = preparePair(output, root, fakePack);
    assert.equal(result.packages.length, 2);
    for (const pkg of result.packages) {
      assert.match(pkg.sha256, /^[a-f0-9]{64}$/);
      assert.ok(readFileSync(resolve(output, pkg.file)).length > 0);
    }
    assert.ok(readFileSync(resolve(output, "hitchlet-sdk-pair.json"), "utf8"));
  } finally {
    cleanup();
  }
});
