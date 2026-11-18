import { describe, expect, it } from "vitest";
import {
  runtimeStorageMountSchema,
  storageRootSchema,
  workspaceMountFactSchema,
} from "../src/runtime-storage.js";

const root = {
  sourceRef: "/approved/workspaces",
  protocol: "local",
  secretVersionRef: null,
  mountPoint: "/",
  mountSource: "/dev/fixture",
};

describe("deployment-owned ext4 submount allowance", () => {
  it("preserves fixed roots and accepts a local named subtree", () => {
    expect(storageRootSchema.parse(root)).toEqual(root);
    expect(
      storageRootSchema.parse({ ...root, localSubmountPrefix: "mounts" }),
    ).toMatchObject({ localSubmountPrefix: "mounts" });
  });

  it.each([
    "",
    ".",
    "..",
    "/mounts",
    "mounts/../other",
    "mounts//child",
    "mounts\\child",
  ])("rejects an unsafe submount prefix %j", (localSubmountPrefix) => {
    expect(
      storageRootSchema.safeParse({ ...root, localSubmountPrefix }).success,
    ).toBe(false);
  });

  it.each(["nfs", "smb"])(
    "does not relax the %s mount contract",
    (protocol) => {
      expect(
        storageRootSchema.safeParse({
          ...root,
          protocol,
          localSubmountPrefix: "mounts",
        }).success,
      ).toBe(false);
    },
  );

  it("does not let a storage request grant itself submount access or local root selection", () => {
    const mount = {
      grantId: "grant",
      revisionId: "revision",
      approvedSourceRef: root.sourceRef,
      authorizedSubpath: "mounts/borrow/project",
      protocol: "local",
      secretVersionRef: null,
      target: "/work",
      mode: "read_write",
    };
    expect(runtimeStorageMountSchema.safeParse(mount).success).toBe(true);
    expect(
      runtimeStorageMountSchema.safeParse({
        ...mount,
        localSubmountPrefix: "mounts",
      }).success,
    ).toBe(false);
    expect(
      runtimeStorageMountSchema.safeParse({ ...mount, authorizedSubpath: "." })
        .success,
    ).toBe(false);
  });
});

describe("maintenance workspace mount record", () => {
  const record = {
    version: 1,
    mountPoint: "/approved/mounts/turbocli-mount-example",
    mountSource: "/dev/loop7",
    filesystem: "ext4",
    hostMountId: "73",
    mountDevice: "7:7",
    backingFile: "/separate-nfs/workspaces/example.ext4",
    backingDevice: "55",
    backingInode: "99",
  };

  it("accepts the version 1 producer shape without turning the record into a grant", () => {
    expect(workspaceMountFactSchema.parse(record)).toEqual(record);
    expect(
      workspaceMountFactSchema.safeParse({ ...record, leaseId: "lease" })
        .success,
    ).toBe(false);
  });

  it("requires backing identity and a known producer version", () => {
    const { backingInode: _, ...incomplete } = record;
    expect(workspaceMountFactSchema.safeParse(incomplete).success).toBe(false);
    expect(
      workspaceMountFactSchema.safeParse({ ...record, version: 2 }).success,
    ).toBe(false);
  });
});
