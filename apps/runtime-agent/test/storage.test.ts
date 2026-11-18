import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { RuntimeStorageFacts, parseMountInfo } from "../src/storage.js";
import {
  runtimeStorageRequestSchema,
  type StorageRoot,
} from "@hitchlet/contracts/internal";

// These synthetic Host fixtures model administrator-owned bind sources. CI may
// itself run as tenant uid 1000; keep real paths/modes/inodes while supplying the
// Host ownership separately. Production ownership checks remain unchanged.
const hostOwnership = vi.hoisted(() => ({
  roots: new Set<string>(),
  tenant: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(async (...args: Parameters<typeof actual.lstat>) => {
      const facts = await actual.lstat(...args);
      if (
        typeof args[0] === "string" &&
        [...hostOwnership.roots].some(
          (root) => args[0] === root || String(args[0]).startsWith(`${root}/`),
        )
      ) {
        Object.defineProperty(facts, "uid", {
          value:
            typeof facts.uid === "bigint"
              ? hostOwnership.tenant
                ? 1000n
                : 0n
              : hostOwnership.tenant
                ? 1000
                : 0,
        });
      }
      return facts;
    }),
  };
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
  hostOwnership.roots.clear();
  hostOwnership.tenant = false;
});
async function fixture(protocol: "local" | "nfs" | "smb" = "local") {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "hitchlet-storage-facts-")),
  );
  dirs.push(dir);
  hostOwnership.roots.add(dir);
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
  it("rejects tenant-owned ancestors even without group or world write", async () => {
    const f = await fixture();
    hostOwnership.tenant = true;
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

it("SMB root selection resolves the exact writable mount without relaxing ancestor protection", async () => {
  const f = await fixture("smb");
  await chmod(f.root, 0o777);
  const request = f.request();
  const rootRequest = {
    ...request,
    mounts: [
      {
        ...request.mounts[0]!,
        authorizedSubpath: ".",
        mode: "read_write" as const,
      },
    ],
  };
  expect(
    (await f.worker.inspect(rootRequest)).mounts[0]?.resolvedSourceRef,
  ).toBe(f.root);
  // The writable leaf may be selected; a child under the same writable parent still rejects.
  await expect(f.worker.inspect(request)).rejects.toThrow("Tenant-writable");
  f.setHost(f.base);
  await expect(f.worker.inspect(rootRequest)).rejects.toThrow("daemon host");
  f.setSelf(f.base);
  await expect(f.worker.inspect(rootRequest)).rejects.toThrow(
    "absent or replaced",
  );
});
it.each(["local", "nfs"] as const)(
  "SMB root marker does not enable %s root selection",
  async (protocol) => {
    const f = await fixture(protocol);
    const request = f.request();
    await expect(
      f.worker.inspect({
        ...request,
        mounts: [{ ...request.mounts[0]!, authorizedSubpath: "." }],
      }),
    ).rejects.toThrow("SMB root");
  },
);

async function submountFixture(enabled = true) {
  const f = await fixture();
  const borrowed = join(f.root, "mounts", "borrow"),
    project = join(borrowed, "project"),
    home = join(borrowed, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home);
  const child = `2 1 7:1 / ${borrowed} rw - ext4 /dev/loop1 rw\n`;
  let self = f.base + child,
    host = self;
  const worker = new RuntimeStorageFacts(
    {
      installationId: "installation",
      runtimeIdentityId: "runtime",
      nativeEngineId: "engine",
    },
    [{ ...f.spec, ...(enabled ? { localSubmountPrefix: "mounts" } : {}) }],
    {
      assertEngine: async () => "engine",
      imageStoreRoot: async () => f.imageRoot,
    },
    async () => self,
    Date.now,
    async () => host,
  );
  const request = () => ({
    ...f.request(),
    mounts: [
      {
        ...f.request().mounts[0]!,
        authorizedSubpath: "mounts/borrow/project",
        target: "/work",
        mode: "read_write" as const,
      },
      {
        ...f.request().mounts[0]!,
        grantId: "home-grant",
        authorizedSubpath: "mounts/borrow/home",
        target: "/persist/home",
        mode: "read_write" as const,
      },
    ],
  });
  return {
    ...f,
    worker,
    request,
    child,
    borrowed,
    project,
    home,
    setSelf: (value: string) => {
      self = value;
    },
    setHost: (value: string) => {
      host = value;
    },
  };
}

describe("approved local ext4 submounts", () => {
  it("resolves both named project and home through the existing request and evidence contract", async () => {
    const f = await submountFixture(),
      first = await f.worker.inspect(f.request());
    expect(first.mounts.map((mount) => mount.resolvedSourceRef)).toEqual([
      f.project,
      f.home,
    ]);
    expect((await f.worker.inspect(f.request())).mounts).toEqual(first.mounts);
  });

  it("keeps a fixed parent root from authorizing dynamic children by default", async () => {
    const f = await submountFixture(false);
    await expect(f.worker.inspect(f.request())).rejects.toThrow(
      "absent or replaced",
    );
  });

  it("refuses the parent-directory fallback when the required submount disappears", async () => {
    const f = await submountFixture();
    f.setSelf(f.base);
    f.setHost(f.base);
    await expect(f.worker.inspect(f.request())).rejects.toThrow(
      "ext4 submount",
    );
  });

  it("still requires the configured parent mount identity", async () => {
    const f = await submountFixture();
    f.setSelf(f.base.replace("/dev/test", "/dev/replaced") + f.child);
    await expect(f.worker.inspect(f.request())).rejects.toThrow(
      "Approved storage mount",
    );
  });

  it.each(["nfs4", "tmpfs"])(
    "does not accept a %s child as ext4",
    async (fs) => {
      const f = await submountFixture();
      f.setSelf(f.base + f.child.replace("ext4", fs));
      await expect(f.worker.inspect(f.request())).rejects.toThrow(
        "ext4 submount",
      );
    },
  );

  it("does not authorize a mounted directory outside the configured subtree", async () => {
    const f = await submountFixture();
    f.setSelf(f.base + `3 1 7:2 / ${f.root}/input rw - ext4 /dev/loop2 rw\n`);
    const original = f.request();
    await expect(
      f.worker.inspect({
        ...original,
        mounts: [{ ...original.mounts[0]!, authorizedSubpath: "input" }],
      }),
    ).rejects.toThrow("Approved storage mount");
  });

  it.each([
    ["7:1", "1:2"],
    ["7:1 / ", "7:1 /another-directory "],
  ])(
    "rejects a parent-device or directory bind alias (%s)",
    async (from, to) => {
      const f = await submountFixture();
      const aliased = f.base + f.child.replace(from, to);
      f.setSelf(aliased);
      f.setHost(aliased);
      await expect(f.worker.inspect(f.request())).rejects.toThrow(
        "ext4 submount",
      );
    },
  );

  it.each([
    ["7:1", "7:2"],
    ["/dev/loop1", "/dev/loop2"],
    ["7:1 / ", "7:1 /wrong-bind-root "],
  ])("rejects a different host mapping (%s)", async (from, to) => {
    const f = await submountFixture();
    f.setHost(f.base + f.child.replace(from, to));
    await expect(f.worker.inspect(f.request())).rejects.toThrow("daemon host");
  });

  it("retains host mount and real inode identity in the frozen evidence", async () => {
    const f = await submountFixture(),
      first = await f.worker.inspect(f.request());
    f.setSelf(f.base + f.child.replace(/^2 /, "99 "));
    expect((await f.worker.inspect(f.request())).mounts).toEqual(first.mounts);
    f.setHost(f.base + f.child.replace(/^2 /, "88 "));
    const remounted = await f.worker.inspect(f.request());
    expect(remounted.mounts[0]?.sourceValidationEvidenceId).not.toBe(
      first.mounts[0]?.sourceValidationEvidenceId,
    );
    await rename(f.project, join(f.borrowed, "old-project"));
    await mkdir(f.project);
    expect(
      (await f.worker.inspect(f.request())).mounts[0]
        ?.sourceValidationEvidenceId,
    ).not.toBe(remounted.mounts[0]?.sourceValidationEvidenceId);
  });

  it("keeps the existing tenant-writable-ancestor refusal", async () => {
    const f = await submountFixture();
    await chmod(f.borrowed, 0o777);
    await expect(f.worker.inspect(f.request())).rejects.toThrow(
      "Tenant-writable",
    );
  });
});
