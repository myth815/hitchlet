import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeStorageFacts, parseMountInfo } from "../src/storage.js";
import {
  runtimeStorageRequestSchema,
  type StorageRoot,
} from "@hitchlet/contracts/internal";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture(protocol: "local" | "nfs" | "smb" = "local") {
  const dir = await mkdtemp("/private/tmp/hitchlet-storage-facts-");
  dirs.push(dir);
  const root = join(dir, "approved"),
    imageRoot = join(dir, "images");
  await mkdir(join(root, "input"), { recursive: true });
  await mkdir(join(root, "output"));
  await mkdir(imageRoot);
  const identity = {
    installationId: "installation",
    runtimeIdentityId: "runtime",
    nativeEngineId: "engine",
  };
  const mountSource =
    protocol === "local"
      ? "/dev/test"
      : protocol === "nfs"
        ? "127.0.0.1:/fixture"
        : "//127.0.0.1/fixture";
  const spec: StorageRoot = {
    sourceRef: root,
    protocol,
    secretVersionRef: null,
    mountPoint: protocol === "local" ? "/" : root,
    mountSource,
  };
  const base = "1 0 1:2 / / rw - ext4 /dev/test rw\n",
    remote =
      protocol === "local"
        ? ""
        : `2 1 0:50 / ${root} rw - ${protocol === "nfs" ? "nfs4" : "cifs"} ${mountSource} rw\n`;
  let self = base + remote,
    host = self;
  const engine = {
    assertEngine: async () => "engine",
    imageStoreRoot: async () => imageRoot,
    ownedInventory: async () => [],
  };
  const worker = new RuntimeStorageFacts(
    identity,
    [spec],
    engine,
    async () => self,
    Date.now,
    async () => host,
    () => 47,
  );
  const request = () =>
    runtimeStorageRequestSchema.parse({
      ...identity,
      requestId: randomUUID(),
      mounts: [
        {
          grantId: "grant",
          revisionId: "revision",
          approvedSourceRef: root,
          authorizedSubpath: "input",
          protocol,
          secretVersionRef: null,
          target: "/workspace/persistent",
          mode: "read_only",
        },
      ],
    });
  return {
    worker,
    request,
    root,
    dir,
    imageRoot,
    spec,
    setSelf: (s: string) => {
      self = s;
    },
    setHost: (s: string) => {
      host = s;
    },
    info: base + remote,
    base,
    remote,
  };
}
describe("fixed Runtime Agent storage facts", () => {
  it("resolves an approved directory with stable inode evidence and actual statfs capacity", async () => {
    const f = await fixture(),
      first = await f.worker.inspect(f.request()),
      second = await f.worker.inspect(f.request());
    expect(first.mounts[0]?.resolvedSourceRef).toBe(join(f.root, "input"));
    expect(first.mounts[0]?.sourceValidationEvidenceId).toBe(
      second.mounts[0]?.sourceValidationEvidenceId,
    );
    expect(first.imageStore.availableMiB).toBeGreaterThan(0);
    expect(first.controllerEpoch).toBe(47);
    expect(first.inventory).toBeNull();
  });
  it.each(["nfs", "smb"] as const)(
    "requires the exact live %s mount and refuses the local fallback after unmount",
    async (protocol) => {
      const f = await fixture(protocol);
      expect((await f.worker.inspect(f.request())).mounts).toHaveLength(1);
      f.setSelf(f.base);
      await expect(f.worker.inspect(f.request())).rejects.toThrow(
        "absent or replaced",
      );
    },
  );
  it("rejects traversal, symbolic links and unauthorized secret revisions before returning facts", async () => {
    const f = await fixture();
    await symlink(join(f.root, "output"), join(f.root, "escape"));
    await expect(
      f.worker.inspect({
        ...f.request(),
        mounts: [{ ...f.request().mounts[0]!, authorizedSubpath: "escape" }],
      }),
    ).rejects.toThrow("escaped");
    await expect(
      f.worker.inspect({
        ...f.request(),
        mounts: [{ ...f.request().mounts[0]!, secretVersionRef: "different" }],
      }),
    ).rejects.toThrow("not approved");
    expect(
      runtimeStorageRequestSchema.safeParse({
        ...f.request(),
        mounts: [
          { ...f.request().mounts[0]!, authorizedSubpath: "../outside" },
        ],
      }).success,
    ).toBe(false);
  });
  it("refuses a wrong bind root even when path, ext4 type and device/source all match", async () => {
    const f = await fixture();
    f.setSelf(
      f.base + `9 1 1:2 /wrong-directory ${f.root} rw - ext4 /dev/test rw\n`,
    );
    f.spec.mountPoint = f.root;
    const worker = new RuntimeStorageFacts(
      {
        installationId: "installation",
        runtimeIdentityId: "runtime",
        nativeEngineId: "engine",
      },
      [f.spec],
      {
        assertEngine: async () => "engine",
        imageStoreRoot: async () => f.imageRoot,
      },
      async () =>
        f.base + `9 1 1:2 /wrong-directory ${f.root} rw - ext4 /dev/test rw\n`,
      Date.now,
      async () => f.base,
    );
    await expect(worker.inspect(f.request())).rejects.toThrow("daemon host");
  });
  it("accepts a legitimate DockerRootDir mount whose filesystem root differs from its mountpoint", async () => {
    const f = await fixture();
    const mounted =
      f.info + `9 1 2:3 /docker ${f.imageRoot} rw - ext4 /dev/image-store rw\n`;
    f.setSelf(mounted);
    f.setHost(mounted);
    expect((await f.worker.inspect(f.request())).imageStore.root).toBe(
      f.imageRoot,
    );
  });
  it("refuses image capacity from the agent overlay or a wrongly mapped image directory", async () => {
    const f = await fixture();
    f.setSelf(
      f.info + `9 1 2:3 /wrong ${f.imageRoot} rw - ext4 /dev/images rw\n`,
    );
    f.setHost(
      f.info + `9 1 2:3 /docker ${f.imageRoot} rw - ext4 /dev/images rw\n`,
    );
    await expect(f.worker.inspect(f.request())).rejects.toThrow("daemon host");
  });
  it("rejects overlapping/reserved targets and other runtime identities", async () => {
    const f = await fixture(),
      r = f.request();
    expect(
      runtimeStorageRequestSchema.safeParse({
        ...r,
        mounts: [
          r.mounts[0],
          {
            ...r.mounts[0]!,
            grantId: "other",
            target: "/workspace/persistent/nested",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      runtimeStorageRequestSchema.safeParse({
        ...r,
        mounts: [{ ...r.mounts[0]!, target: "/workspace" }],
      }).success,
    ).toBe(false);
    await expect(
      f.worker.inspect({ ...r, nativeEngineId: "other" }),
    ).rejects.toThrow("identity");
  });
  it("keeps host evidence stable across Agent namespace IDs and detects real host remount", async () => {
    const f = await fixture("nfs"),
      first = await f.worker.inspect(f.request());
    f.setSelf(f.info.replace(/^2 /m, "99 "));
    expect(
      (await f.worker.inspect(f.request())).mounts[0]
        ?.sourceValidationEvidenceId,
    ).toBe(first.mounts[0]?.sourceValidationEvidenceId);
    f.setHost(f.info.replace(/^2 /m, "88 "));
    expect(
      (await f.worker.inspect(f.request())).mounts[0]
        ?.sourceValidationEvidenceId,
    ).not.toBe(first.mounts[0]?.sourceValidationEvidenceId);
  });
  it("rejects tenant-writable ancestors even with no symlink", async () => {
    const f = await fixture();
    await chmod(f.root, 0o777);
    await expect(f.worker.inspect(f.request())).rejects.toThrow(
      "Tenant-writable",
    );
  });
  it("parses mount roots, device identity and escaped paths", () => {
    expect(
      parseMountInfo(
        "5 1 8:1 /bind\\040root /mount\\040point ro - ext4 /dev/sda1 ro\n",
      )[0],
    ).toMatchObject({
      device: "8:1",
      root: "/bind root",
      point: "/mount point",
    });
  });
});
