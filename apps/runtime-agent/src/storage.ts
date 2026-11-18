import { lstat, readFile, realpath, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import {
  runtimeStorageRequestSchema,
  runtimeStorageResultSchema,
  storageRootSchema,
  workspaceMountFactSchema,
  type RuntimeStorageRequest,
  type RuntimeStorageResult,
  type StorageRoot,
} from "@hitchlet/contracts/internal";
import { hash } from "./canonical.js";

/** Read-only host facts. Deployment roots and mount credentials are administrator
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
    private readonly workspaceMountFactsDirectory?: string,
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
      const active = selectMount(info, sourceReal);
      const submountPrefix =
        root.localSubmountPrefix === undefined
          ? null
          : resolve(rootReal, root.localSubmountPrefix);
      const usesSubmount =
        submountPrefix !== null && inside(submountPrefix, sourceReal);
      // A dynamic child does not replace the configured parent's trust anchor.
      const configured = usesSubmount ? selectMount(info, rootReal) : active;
      if (
        !configured ||
        configured.point !== root.mountPoint ||
        configured.source !== root.mountSource
      )
        throw new Error("Approved storage mount is absent or replaced");
      if (
        !active ||
        (usesSubmount &&
          (active.fs !== "ext4" ||
            active.root !== "/" ||
            active.device === configured.device ||
            !inside(submountPrefix!, active.point)))
      )
        throw new Error("Approved ext4 submount is absent or replaced");
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
      const workspaceMount = usesSubmount
        ? await this.readWorkspaceMountFact(hostMount)
        : undefined;
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
          ...(workspaceMount === undefined ? {} : { workspaceMount }),
        }),
      });
    }
    const imageRoot = await this.engine.imageStoreRoot();
    if ((await realpath(imageRoot)) !== imageRoot)
      throw new Error("Image store path is not stable");
    const imageMount = selectMount(info, imageRoot);
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

  private async readWorkspaceMountFact(
    mount: ReturnType<typeof parseMountInfo>[number],
  ) {
    const directory = this.workspaceMountFactsDirectory;
    if (!directory || (await realpath(directory)) !== directory)
      throw new Error(
        "Workspace mount facts directory is not configured or stable",
      );
    await assertProtectedAncestors(directory);
    const directoryFacts = await lstat(directory, { bigint: true });
    if (
      !directoryFacts.isDirectory() ||
      directoryFacts.uid !== 0n ||
      (directoryFacts.mode & 0o777n) !== 0o700n
    )
      throw new Error("Workspace mount facts directory is not root-owned 0700");
    // Matches the maintenance producer's raw UTF-8 mount-point filename.
    const file = join(
      directory,
      createHash("sha256").update(mount.point, "utf8").digest("hex") + ".json",
    );
    const before = await lstat(file, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== 0n ||
      (before.mode & 0o777n) !== 0o600n
    )
      throw new Error("Workspace mount fact is not a root-owned 0600 file");
    const record = workspaceMountFactSchema.parse(
      JSON.parse(await readFile(file, "utf8")),
    );
    if (
      record.mountPoint !== mount.point ||
      record.mountSource !== mount.source ||
      record.filesystem !== mount.fs ||
      record.hostMountId !== mount.id ||
      record.mountDevice !== mount.device
    )
      throw new Error(
        "Workspace mount fact does not match the current host mount",
      );
    // The backing image may live on a separate approved NFS filesystem. Read
    // metadata through the same Host bind, never image bytes or a second mount.
    const backing = await lstat(record.backingFile, { bigint: true });
    if (
      !backing.isFile() ||
      (await realpath(record.backingFile)) !== record.backingFile ||
      String(backing.dev) !== record.backingDevice ||
      String(backing.ino) !== record.backingInode
    )
      throw new Error("Workspace backing image is absent or replaced");
    const [after, backingAfter] = await Promise.all([
      lstat(file, { bigint: true }),
      lstat(record.backingFile, { bigint: true }),
    ]);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      backingAfter.dev !== backing.dev ||
      backingAfter.ino !== backing.ino
    )
      throw new Error(
        "Workspace mount fact or backing image changed during inspection",
      );
    return record;
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

function selectMount(rows: ReturnType<typeof parseMountInfo>, path: string) {
  return rows
    .filter((m) => inside(m.point, path))
    .sort((a, b) => b.point.length - a.point.length)[0];
}

function assertHostMapping(
  self: ReturnType<typeof parseMountInfo>,
  host: ReturnType<typeof parseMountInfo>,
  path: string,
) {
  const a = selectMount(self, path),
    b = selectMount(host, path);
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
