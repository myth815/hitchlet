import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  HyperVLocalDriver,
  type HyperVNativeCommand,
  type HyperVNativeVm,
  type HyperVRequest,
} from "../src/drivers/hyperv.js";
import { withCommandDeadline } from "../src/command-exec.js";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
const identity = {
  installationId: "install-1",
  runtimeIdentityId: "runtime-1",
  connectionRevisionId: "revision-1",
  allocationId: "allocation-1",
  generation: 1,
  operationId: "create-1",
  controlVersion: 1,
  purpose: "tenant" as const,
};
const request = (guestOs: "windows" | "linux" = "windows"): HyperVRequest => ({
  identity,
  template: {
    configPath: "E:\\Templates\\image.vmcx",
    configSha256: "a".repeat(64),
    guestOs,
    architecture: "amd64",
    generation: 2,
  },
  resources: { cpus: 4, memoryMiB: 4096 },
  switchName: "Default Switch",
});
const cleanup = { ...identity, operationId: "cleanup-1", controlVersion: 2 };
class Native {
  calls: Array<{ command: HyperVNativeCommand; timeout: number }> = [];
  data = new Map<string, { vm: HyperVNativeVm | null; files: boolean }>();
  loseImportReply = false;
  importNeverObserved = false;
  leaveFiles = false;
  unavailable = false;
  incomplete = false;
  onImport: (() => Promise<void>) | undefined;
  async run(command: HyperVNativeCommand, timeout: number): Promise<unknown> {
    this.calls.push({ command: structuredClone(command), timeout });
    if (command.action === "facts")
      return {
        available: !this.unavailable,
        hostArchitecture: "AMD64",
        implementedOperations: [
          "inspect",
          "import",
          "configure",
          "start",
          "stop",
          "remove",
        ],
      };
    if (this.unavailable) throw Error("module unavailable");
    let entry = this.data.get(command.directory);
    if (command.action === "prepare") return { prepared: true };
    if (command.action === "import") {
      await this.onImport?.();
      if (this.importNeverObserved) throw Error("import outcome unknown");
      const vm: HyperVNativeVm = {
        id:
          "00000000-0000-4000-8000-" +
          String(
            this.calls.filter((c) => c.command.action === "import").length,
          ).padStart(12, "0"),
        owner: command.owner,
        directory: command.directory,
        configurationPath: win32.join(command.directory, "vm", "config"),
        diskPaths: [win32.join(command.directory, "disks", "os.vhdx")],
        cpus: 1,
        memoryMiB: 512,
        dynamicMemory: true,
        generation: command.spec!.template.generation,
        state: "stopped",
        switchNames: ["old switch"],
        dynamicMac: false,
        ipv4: [],
      };
      entry = { vm, files: true };
      this.data.set(command.directory, entry);
      if (this.loseImportReply) {
        this.loseImportReply = false;
        throw Error("reply lost after import completed");
      }
    }
    if (command.action === "configure" && entry?.vm) {
      const vm = entry.vm;
      vm.cpus = command.spec!.resources.cpus;
      vm.memoryMiB = command.spec!.resources.memoryMiB;
      vm.dynamicMemory = false;
      vm.switchNames = [command.spec!.switchName];
      vm.dynamicMac = true;
    }
    if (command.action === "start" && entry?.vm) {
      entry.vm.state = "running";
      entry.vm.ipv4 = ["192.0.2.10"];
    }
    if (command.action === "stop" && entry?.vm) entry.vm.state = "stopped";
    if (command.action === "remove" && entry) {
      entry.vm = null;
      entry.files = this.leaveFiles;
    }
    if (this.incomplete)
      return {
        presence: "unknown",
        inventoryComplete: false,
        directoryPresent: !!entry?.files,
        reason: "fixture incomplete",
      };
    if (entry?.vm)
      return {
        presence: "present",
        inventoryComplete: true,
        directoryPresent: true,
        vm: structuredClone(entry.vm),
      };
    if (entry?.files)
      return {
        presence: "unknown",
        inventoryComplete: true,
        directoryPresent: true,
        reason: "owned_files_remain",
      };
    return {
      presence: "absent",
      inventoryComplete: true,
      directoryPresent: false,
    };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-hyperv-"));
  roots.push(root);
  const native = new Native();
  const options = {
    manifestDirectory: join(root, "manifests"),
    workRoot: "E:\\ComputeNode\\Hitchlet",
    run: native.run.bind(native),
  };
  return { native, options, driver: new HyperVLocalDriver(options) };
}
function vm(native: Native) {
  return [...native.data.values()][0]!.vm!;
}
function count(native: Native, action: string) {
  return native.calls.filter((c) => c.command.action === action).length;
}

it.each(["windows", "linux"] as const)(
  "preserves independent %s/amd64 metadata and confirms native resources without claiming guest readiness",
  async (guestOs) => {
    const f = await fixture();
    const got = await f.driver.reconcile(request(guestOs));
    expect(got).toMatchObject({
      presence: "present",
      inventoryComplete: true,
      bootstrapStatus: "not_implemented",
      requestedEnvironment: { guestOs, architecture: "amd64" },
      vm: { state: "running", cpus: 4, memoryMiB: 4096, dynamicMemory: false },
    });
    expect(got).not.toHaveProperty("access");
    expect(count(f.native, "import")).toBe(1);
    const manifests = await readdir(f.options.manifestDirectory);
    expect(manifests).toHaveLength(1);
    const m = JSON.parse(
      await readFile(join(f.options.manifestDirectory, manifests[0]!), "utf8"),
    );
    expect(m.phase).toBe("owned");
    expect(m.vmId).toBe(got.vm!.id);
  },
);
it("serializes one allocation and recovers the same native ID across driver restart", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    f.driver.reconcile(request()),
    f.driver.reconcile(request()),
  ]);
  expect(a.vm!.id).toBe(b.vm!.id);
  const again = await new HyperVLocalDriver(f.options).reconcile(request());
  expect(again.vm!.id).toBe(a.vm!.id);
  expect(count(f.native, "import")).toBe(1);
  expect(count(f.native, "configure")).toBe(1);
});
it("recovers a completed import whose reply was lost without issuing another import", async () => {
  const f = await fixture();
  f.native.loseImportReply = true;
  expect(await f.driver.reconcile(request())).toMatchObject({
    presence: "unknown",
    reason: "import_outcome_unknown",
  });
  const got = await new HyperVLocalDriver(f.options).reconcile(request());
  expect(got.presence).toBe("present");
  expect(count(f.native, "import")).toBe(1);
});
it("keeps an unobserved timed-out import unknown through retry and cleanup", async () => {
  const f = await fixture();
  f.native.importNeverObserved = true;
  await f.driver.reconcile(request());
  const restarted = new HyperVLocalDriver(f.options);
  expect(await restarted.reconcile(request())).toMatchObject({
    presence: "unknown",
    reason: "import_outcome_unknown",
  });
  expect(await restarted.destroy(cleanup)).toMatchObject({
    presence: "unknown",
    reason: "import_outcome_unknown",
  });
  expect(count(f.native, "import")).toBe(1);
  expect(count(f.native, "remove")).toBe(0);
});
it("requires removal of both the exact VM and owned disk tree before returning absent", async () => {
  const f = await fixture();
  await f.driver.reconcile(request());
  f.native.leaveFiles = true;
  expect(await f.driver.destroy(cleanup)).toMatchObject({
    presence: "unknown",
    reason: "owned_resource_or_files_remain",
  });
  f.native.leaveFiles = false;
  const restarted = new HyperVLocalDriver(f.options);
  expect(await restarted.destroy(cleanup)).toMatchObject({
    presence: "absent",
    inventoryComplete: true,
  });
  const before = count(f.native, "remove");
  expect(await restarted.destroy(cleanup)).toMatchObject({
    presence: "absent",
  });
  expect(count(f.native, "remove")).toBe(before);
  await expect(restarted.reconcile(request())).rejects.toThrow(/stale control/);
  expect(count(f.native, "import")).toBe(1);
});
it.each(["owner", "id", "disk"])(
  "does not stop or delete a resource whose %s binding changed",
  async (field) => {
    const f = await fixture();
    await f.driver.reconcile(request());
    const value = vm(f.native);
    if (field === "owner") value.owner = "foreign-owner";
    else if (field === "id") value.id = "33333333-3333-4333-8333-333333333333";
    else value.diskPaths = ["E:\\OtherOwner\\file.vhdx"];
    expect(await f.driver.destroy(cleanup)).toMatchObject({
      presence: "unknown",
      reason: "native_owner_mismatch",
    });
    expect(count(f.native, "stop")).toBe(0);
    expect(count(f.native, "remove")).toBe(0);
  },
);
it("refuses a changed frozen spec and stale commands but keeps higher-version cleanup available", async () => {
  const f = await fixture();
  await f.driver.reconcile(request());
  await expect(
    f.driver.reconcile({
      ...request(),
      resources: { cpus: 8, memoryMiB: 4096 },
    }),
  ).rejects.toThrow(/specification changed/);
  expect(await f.driver.stop({ ...cleanup, controlVersion: 3 })).toMatchObject({
    presence: "present",
    vm: { state: "stopped" },
  });
  await expect(f.driver.reconcile(request())).rejects.toThrow(/stale control/);
  expect(
    await f.driver.destroy({ ...cleanup, controlVersion: 3 }),
  ).toMatchObject({ presence: "absent" });
});
it("keeps incomplete inventory and an unavailable backend from becoming creation permission", async () => {
  const f = await fixture();
  f.native.incomplete = true;
  expect((await f.driver.reconcile(request())).presence).toBe("unknown");
  expect(count(f.native, "import")).toBe(0);
  f.native.incomplete = false;
  f.native.unavailable = true;
  expect((await f.driver.reconcile(request())).presence).toBe("unknown");
  expect(count(f.native, "import")).toBe(0);
});
it("does not reconfigure a running VM whose readback differs from the frozen request", async () => {
  const f = await fixture();
  await f.driver.reconcile(request());
  vm(f.native).cpus = 2;
  expect(await f.driver.reconcile(request())).toMatchObject({
    presence: "unknown",
    reason: "running_configuration_mismatch",
  });
  expect(count(f.native, "configure")).toBe(1);
});
it("does not let a slow import delay cleanup for a different allocation", async () => {
  const f = await fixture();
  await f.driver.reconcile(request());
  let started!: () => void, finish!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  const hold = new Promise<void>((r) => (finish = r));
  f.native.onImport = async () => {
    started();
    await hold;
  };
  const other = {
    ...request(),
    identity: { ...identity, allocationId: "allocation-2" },
  };
  const pending = f.driver.reconcile(other);
  await begun;
  expect(await f.driver.destroy(cleanup)).toMatchObject({ presence: "absent" });
  finish();
  await pending;
});
it("caps native calls by the existing command deadline", async () => {
  const f = await fixture();
  await withCommandDeadline(Date.now() + 500, () =>
    f.driver.reconcile(request()),
  );
  expect(f.native.calls.every((c) => c.timeout > 0 && c.timeout <= 500)).toBe(
    true,
  );
});
it("rejects unsupported guest architecture or non-dedicated host roots before any native command", async () => {
  const f = await fixture();
  expect(() =>
    f.driver.reconcile({
      ...request(),
      template: { ...request().template, architecture: "arm64" },
    }),
  ).toThrow();
  expect(
    () => new HyperVLocalDriver({ ...f.options, workRoot: "E:\\" }),
  ).toThrow(/dedicated/);
  expect(
    () =>
      new HyperVLocalDriver({ ...f.options, workRoot: "\\\\server\\share" }),
  ).toThrow();
  expect(f.native.calls).toHaveLength(0);
});

it("keeps unreadable existing inventory unknown and never turns it into deletion permission", async () => {
  const f = await fixture();
  await f.driver.reconcile(request());
  f.native.incomplete = true;
  expect(await f.driver.destroy(cleanup)).toMatchObject({
    presence: "unknown",
    inventoryComplete: false,
  });
  expect(count(f.native, "remove")).toBe(0);
  expect(count(f.native, "stop")).toBe(0);
});
