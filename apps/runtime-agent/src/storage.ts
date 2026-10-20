import { lstat, readFile, realpath, statfs } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  runtimeStorageRequestSchema,
  runtimeStorageResultSchema,
  storageRootSchema,
  type RuntimeStorageRequest,
  type RuntimeStorageResult,
  type StorageRoot,
} from "@hitchlet/contracts/internal";
import { hash } from "./canonical.js";

/** Read-only fixed facts. Deployment roots and mount credentials are administrator
 * controlled; requests cannot mount/unmount, create directories, or run commands. */
export class RuntimeStorageFacts {
  private readonly roots: StorageRoot[];
  constructor(
    private readonly identity: {
      installationId: string;
      runtimeIdentityId: string;
      nativeEngineId: string;
    },
    roots: readonly StorageRoot[],
    private readonly engine: {
      assertEngine(): Promise<string>;
      imageStoreRoot(): Promise<string>;
      ownedInventory?(
        installationId: string,
      ): Promise<NonNullable<RuntimeStorageResult["inventory"]>>;
    },
    private readonly mountInfo = () => readFile("/proc/self/mountinfo", "utf8"),
    private readonly now = Date.now,
    private readonly hostMountInfo = () =>
      readFile("/proc/1/mountinfo", "utf8"),
    private readonly controllerEpoch = () => 0,
  ) {
    this.roots = roots.map((r) => storageRootSchema.parse(r));
  }
  async inspect(input: RuntimeStorageRequest): Promise<RuntimeStorageResult> {
    const request = runtimeStorageRequestSchema.parse(input);
    if (
      request.installationId !== this.identity.installationId ||
      request.runtimeIdentityId !== this.identity.runtimeIdentityId ||
      request.nativeEngineId !== this.identity.nativeEngineId
    )
      throw new Error("Storage identity mismatch");
    if ((await this.engine.assertEngine()) !== request.nativeEngineId)
      throw new Error("Engine changed");
    const info = parseMountInfo(await this.mountInfo());
    const hostInfo = parseMountInfo(await this.hostMountInfo());
    const mounts = [];
    for (const mount of request.mounts) {
      const root = this.roots.find(
        (r) =>
          r.sourceRef === mount.approvedSourceRef &&
          r.protocol === mount.protocol &&
          r.secretVersionRef === mount.secretVersionRef,
      );
      if (!root)
        throw new Error(
          "Storage root/revision secret is not approved on this runtime",
        );
      const source = resolve(root.sourceRef, mount.authorizedSubpath);
      const rootReal = await realpath(root.sourceRef),
        sourceReal = await realpath(source);
      if (
        rootReal !== root.sourceRef ||
        sourceReal !== source ||
        !inside(rootReal, sourceReal) ||
        !inside(root.mountPoint, rootReal)
      )
        throw new Error("Storage path escaped approved root");
      // Refuse symlinks even when they point back inside the root: bind source
      // resolution is deterministic. Deployment must also protect all ancestor
      // directories from tenant rename/write; lstat does not eliminate TOCTOU.
      let cursor = root.sourceRef;
      for (const part of mount.authorizedSubpath.split("/")) {
        cursor = join(cursor, part);
        const facts = await lstat(cursor);
        if (facts.isSymbolicLink() || !facts.isDirectory())
          throw new Error("Storage source is not a stable directory");
      }
      const active = info
        .filter((m) => inside(m.point, source))
        .sort((a, b) => b.point.length - a.point.length)[0];
      if (
        !active ||
        active.point !== root.mountPoint ||
        active.source !== root.mountSource
      )
        throw new Error("Approved storage mount is absent or replaced");
      if (
        root.protocol === "nfs"
          ? !["nfs", "nfs4"].includes(active.fs)
          : root.protocol === "smb"
            ? active.fs !== "cifs"
            : [
                "nfs",
                "nfs4",
                "cifs",
                "overlay",
                "proc",
                "sysfs",
                "tmpfs",
              ].includes(active.fs)
      )
        throw new Error("Storage filesystem protocol mismatch");
      await assertProtectedAncestors(sourceReal);
      const hostMount = assertHostMapping(info, hostInfo, sourceReal);
      const facts = await lstat(sourceReal, { bigint: true });
      mounts.push({
        grantId: mount.grantId,
        resolvedSourceRef: sourceReal,
        sourceValidationEvidenceId: hash({
          grantId: mount.grantId,
          revisionId: mount.revisionId,
          root,
          source: sourceReal,
          dev: String(facts.dev),
          ino: String(facts.ino),
          hostMount: {
            id: hostMount.id,
            device: hostMount.device,
            root: hostMount.root,
            point: hostMount.point,
            source: hostMount.source,
            fs: hostMount.fs,
          },
        }),
      });
    }
    const imageRoot = await this.engine.imageStoreRoot();
    if ((await realpath(imageRoot)) !== imageRoot)
      throw new Error("Image store path is not stable");
    const imageMount = info
      .filter((m) => inside(m.point, imageRoot))
      .sort((a, b) => b.point.length - a.point.length)[0];
    if (!imageMount || ["overlay", "tmpfs"].includes(imageMount.fs))
      throw new Error(
        "Host Docker image store filesystem is not visible to Agent",
      );
    assertHostMapping(info, hostInfo, imageRoot);
    const capacity = await statfs(imageRoot);
    if (request.inventory && !this.engine.ownedInventory)
      throw new Error("Runtime inventory unsupported");
    return runtimeStorageResultSchema.parse({
      ...this.identity,
      requestId: request.requestId,
      observedAtMs: this.now(),
      controllerEpoch: this.controllerEpoch(),
      inventory: request.inventory
        ? await this.engine.ownedInventory!(request.installationId)
        : null,
      imageStore: {
        root: imageRoot,
        availableMiB: Math.floor(
          (Number(capacity.bavail) * Number(capacity.bsize)) / 1048576,
        ),
      },
      mounts,
    });
  }
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!rel.startsWith("../") && rel !== ".." && !rel.startsWith("/"))
  );
}
export function parseMountInfo(text: string) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split(" - ");
      if (!left || !right) throw new Error("Invalid mountinfo");
      const fields = left.split(" "),
        tail = right.split(" ");
      const decode = (s: string) =>
        s.replace(/\\(040|011|012|134)/g, (_, v: string) =>
          String.fromCharCode(parseInt(v, 8)),
        );
      if (!fields[0] || !fields[4] || !tail[0] || !tail[1])
        throw new Error("Invalid mountinfo");
      return {
        id: fields[0],
        device: fields[2]!,
        root: decode(fields[3]!),
        point: decode(fields[4]),
        fs: tail[0],
        source: decode(tail[1]),
      };
    });
}

function assertHostMapping(
  self: ReturnType<typeof parseMountInfo>,
  host: ReturnType<typeof parseMountInfo>,
  path: string,
) {
  const select = (rows: typeof self) =>
    rows
      .filter((m) => inside(m.point, path))
      .sort((a, b) => b.point.length - a.point.length)[0];
  const a = select(self),
    b = select(host);
  if (
    !a ||
    !b ||
    a.device !== b.device ||
    a.fs !== b.fs ||
    a.source !== b.source ||
    resolve(a.root, relative(a.point, path)) !==
      resolve(b.root, relative(b.point, path))
  )
    throw new Error("Agent path does not map to the daemon host directory");
  return b;
}

/** The shipped node-ssh recipe runs tenant sessions as uid/gid 1000. A bind
 * source's ancestor must not let that tenant rename its next path component.
 * Group-write (including an ACL write mask) is conservatively rejected.
 * Administrator/root changes remain a deployment trust boundary. */
async function assertProtectedAncestors(source: string) {
  const parts = source.split("/").filter(Boolean);
  let parent = "/";
  for (const part of parts) {
    const child = join(parent, part),
      [directory, next] = await Promise.all([
        lstat(parent, { bigint: true }),
        lstat(child, { bigint: true }),
      ]);
    if (
      directory.isSymbolicLink() ||
      next.isSymbolicLink() ||
      !directory.isDirectory()
    )
      throw new Error("Unstable storage ancestor");
    const mode = Number(directory.mode),
      tenantCanWrite =
        !!(mode & 2) ||
        (directory.uid === 1000n && !!(mode & 128)) ||
        !!(mode & 16);
    const stickyProtected =
      !!(mode & 512) && directory.uid !== 1000n && next.uid !== 1000n;
    if (tenantCanWrite && !stickyProtected)
      throw new Error("Tenant-writable storage ancestor is not approved");
    parent = child;
  }
}
