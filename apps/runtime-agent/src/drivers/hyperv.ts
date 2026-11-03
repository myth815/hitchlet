import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  vmAllocationIdentitySchema,
  vmAllocationOwnerTuple,
  vmResourceSpecSchema,
  type VmAllocationIdentity,
} from "@hitchlet/contracts/internal";
import { canonical } from "../canonical.js";
import { currentCommandDeadlineMs } from "../command-exec.js";

const sha = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const absolutePath = z
  .string()
  .min(3)
  .refine(
    (v) =>
      /^[A-Za-z]:\\/.test(v) &&
      !v.includes("\0") &&
      !v.split(/[\\/]/).includes(".."),
    "local absolute Windows path required",
  );
export const hyperVRequestSchema = z
  .object({
    identity: vmAllocationIdentitySchema,
    template: z
      .object({
        configPath: absolutePath,
        configSha256: z.string().regex(/^[a-f0-9]{64}$/),
        guestOs: z.enum(["windows", "linux"]),
        architecture: z.literal("amd64"),
        generation: z.union([z.literal(1), z.literal(2)]),
      })
      .strict(),
    resources: vmResourceSpecSchema,
    switchName: z.string().min(1).max(200),
  })
  .strict();
export type HyperVRequest = z.infer<typeof hyperVRequestSchema>;
const specSchema = hyperVRequestSchema.omit({ identity: true });
type Spec = z.infer<typeof specSchema>;
const vmSchema = z
  .object({
    id: z.string().uuid(),
    owner: z.string(),
    directory: absolutePath,
    configurationPath: absolutePath,
    diskPaths: z.array(absolutePath),
    cpus: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    dynamicMemory: z.boolean(),
    generation: z.union([z.literal(1), z.literal(2)]),
    state: z.enum(["running", "stopped", "other"]),
    switchNames: z.array(z.string()),
    dynamicMac: z.boolean(),
    ipv4: z.array(z.ipv4()),
  })
  .strict();
export type HyperVNativeVm = z.infer<typeof vmSchema>;
const observationSchema = z
  .object({
    presence: z.enum(["present", "absent", "unknown"]),
    inventoryComplete: z.boolean(),
    directoryPresent: z.boolean(),
    vm: vmSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
type Observation = z.infer<typeof observationSchema>;
const manifestSchema = z
  .object({
    version: z.literal(1),
    identity: vmAllocationIdentitySchema,
    highestControlVersion: z.number().int().positive(),
    phase: z.enum(["importing", "owned", "deleting", "released"]),
    spec: specSchema,
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
    vmId: z.string().uuid().nullable(),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
export type HyperVNativeCommand = Readonly<{
  action:
    | "facts"
    | "prepare"
    | "inspect"
    | "import"
    | "configure"
    | "start"
    | "stop"
    | "remove";
  directory: string;
  owner: string;
  specHash: string;
  vmId: string | null;
  spec?: Spec;
}>;
export type HyperVNativeRunner = (
  request: HyperVNativeCommand,
  timeoutMs: number,
) => Promise<unknown>;
export type HyperVInspection = Readonly<{
  identity: VmAllocationIdentity;
  presence: "present" | "absent" | "unknown";
  inventoryComplete: boolean;
  reason?: string;
  vm?: HyperVNativeVm;
  requestedEnvironment?: {
    guestOs: "windows" | "linux";
    architecture: "amd64";
  };
  bootstrapStatus: "not_implemented";
}>;

/** Native lifecycle kernel only: not registered as a rentable ExecutionPort. */
export class HyperVLocalDriver {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly run: HyperVNativeRunner;
  private readonly workRoot: string;
  constructor(
    private readonly options: {
      manifestDirectory: string;
      workRoot: string;
      run?: HyperVNativeRunner;
    },
  ) {
    this.workRoot = win32.normalize(absolutePath.parse(options.workRoot));
    if (this.workRoot === win32.parse(this.workRoot).root)
      throw Error("Hyper-V work root must be a dedicated directory");
    this.run = options.run ?? runHyperVNative;
  }
  async facts() {
    const value = await this.command({
      action: "facts",
      directory: this.workRoot,
      owner: "",
      specHash: "",
      vmId: null,
    });
    return z
      .object({
        available: z.boolean(),
        reason: z.string().optional(),
        hostArchitecture: z.string(),
        implementedOperations: z.array(z.string()),
      })
      .strict()
      .parse(value);
  }
  reconcile(input: unknown): Promise<HyperVInspection> {
    const request = hyperVRequestSchema.parse(input);
    return this.lock(request.identity, () => this.reconcileOwned(request));
  }
  inspect(input: unknown): Promise<HyperVInspection> {
    const identity = vmAllocationIdentitySchema.parse(input);
    return this.lock(identity, async () => {
      const m = await this.load(identity);
      const o = await this.observe(identity, m);
      return this.inspection(identity, o, m);
    });
  }
  stop(input: unknown): Promise<HyperVInspection> {
    return this.cleanup(input, false);
  }
  destroy(input: unknown): Promise<HyperVInspection> {
    return this.cleanup(input, true);
  }

  private async reconcileOwned(
    request: HyperVRequest,
  ): Promise<HyperVInspection> {
    const identity = request.identity;
    const { identity: _, ...spec } = request;
    let m = await this.load(identity);
    if (m) {
      this.fence(m, identity);
      if (m.specHash !== sha(spec))
        throw Error("Hyper-V allocation specification changed");
      if (m.phase === "released" || m.phase === "deleting")
        return this.unknown(identity, "allocation_terminating_or_released");
    }
    if (!m) {
      const before = await this.observe(identity, null);
      if (
        before.presence !== "absent" ||
        !before.inventoryComplete ||
        before.directoryPresent
      )
        return this.unknown(identity, "untracked_or_unknown_native_resource");
      try {
        z.object({ prepared: z.literal(true) })
          .strict()
          .parse(
            await this.command({
              ...this.native(identity, null, "prepare"),
              spec,
            }),
          );
      } catch {
        return this.unknown(identity, "template_or_runtime_not_prepared");
      }
      m = {
        version: 1,
        identity,
        highestControlVersion: identity.controlVersion,
        phase: "importing",
        spec,
        specHash: sha(spec),
        vmId: null,
      };
      if (await this.claim(m)) {
        try {
          await this.command(this.native(identity, m, "import"));
        } catch {
          return this.unknown(identity, "import_outcome_unknown");
        }
      } else {
        m = await this.load(identity);
        if (!m) return this.unknown(identity, "manifest_race");
        this.fence(m, identity);
        if (m.specHash !== sha(spec))
          throw Error("Hyper-V allocation specification changed");
      }
    }
    let observed = await this.observe(identity, m);
    if (observed.presence !== "present" || !observed.vm)
      return this.unknown(
        identity,
        m.phase === "importing"
          ? "import_outcome_unknown"
          : (observed.reason ?? "native_inspection_unknown"),
      );
    if (!this.owns(identity, m, observed.vm))
      return this.unknown(identity, "native_owner_mismatch");
    if (m.vmId === null) {
      m.vmId = observed.vm.id;
      m.phase = "owned";
      await this.store(m);
    }
    m.identity = identity;
    m.highestControlVersion = identity.controlVersion;
    await this.store(m);
    if (observed.vm.state === "running" && !this.matches(observed.vm, spec))
      return this.unknown(identity, "running_configuration_mismatch");
    try {
      if (observed.vm.state !== "running") {
        await this.command(this.native(identity, m, "configure"));
        observed = await this.observe(identity, m);
        if (
          observed.presence !== "present" ||
          !observed.vm ||
          !this.matches(observed.vm, spec)
        )
          return this.unknown(identity, "configuration_not_confirmed");
        await this.command(this.native(identity, m, "start"));
      }
    } catch {
      return this.unknown(identity, "native_command_outcome_unknown");
    }
    observed = await this.observe(identity, m);
    if (
      observed.presence !== "present" ||
      !observed.vm ||
      !this.matches(observed.vm, spec) ||
      observed.vm.state !== "running"
    )
      return this.unknown(identity, "start_not_confirmed");
    return this.inspection(identity, observed, m);
  }

  private cleanup(input: unknown, remove: boolean): Promise<HyperVInspection> {
    const identity = vmAllocationIdentitySchema.parse(input);
    return this.lock(identity, async () => {
      const m = await this.load(identity);
      const before = await this.observe(identity, m);
      if (!m)
        return before.presence === "absent" &&
          !before.directoryPresent &&
          before.inventoryComplete
          ? this.inspection(identity, before, null)
          : this.unknown(identity, "manifest_missing");
      this.fence(m, identity);
      if (
        m.phase === "released" &&
        before.presence === "absent" &&
        !before.directoryPresent &&
        before.inventoryComplete
      )
        return this.inspection(identity, before, m);
      if (before.presence === "present" && before.vm) {
        if (!this.owns(identity, m, before.vm))
          return this.unknown(identity, "native_owner_mismatch");
        m.vmId = before.vm.id;
      } else if (m.phase === "importing")
        return this.unknown(identity, "import_outcome_unknown");
      else if (
        !before.inventoryComplete ||
        !(
          before.presence === "absent" || before.reason === "owned_files_remain"
        )
      )
        return this.unknown(
          identity,
          before.reason ?? "native_inspection_unknown",
        );
      m.identity = identity;
      m.highestControlVersion = identity.controlVersion;
      if (remove) m.phase = "deleting";
      await this.store(m);
      try {
        await this.command(
          this.native(identity, m, remove ? "remove" : "stop"),
        );
      } catch {
        return this.unknown(identity, "cleanup_outcome_unknown");
      }
      const after = await this.observe(identity, m);
      if (remove) {
        if (
          after.presence !== "absent" ||
          after.directoryPresent ||
          !after.inventoryComplete
        )
          return this.unknown(identity, "owned_resource_or_files_remain");
        m.phase = "released";
        await this.store(m);
      } else if (after.presence === "present" && after.vm?.state !== "stopped")
        return this.unknown(identity, "stop_not_confirmed");
      return this.inspection(identity, after, m);
    });
  }
  private matches(vm: HyperVNativeVm, spec: Spec) {
    return (
      vm.cpus === spec.resources.cpus &&
      vm.memoryMiB === spec.resources.memoryMiB &&
      !vm.dynamicMemory &&
      vm.generation === spec.template.generation &&
      vm.dynamicMac &&
      vm.switchNames.length === 1 &&
      vm.switchNames[0] === spec.switchName
    );
  }
  private owns(
    identity: VmAllocationIdentity,
    m: Manifest,
    vm: HyperVNativeVm,
  ) {
    return (
      vm.owner === this.native(identity, m, "inspect").owner &&
      (m.vmId === null || vm.id === m.vmId) &&
      win32.normalize(vm.directory).toLowerCase() ===
        this.directory(identity).toLowerCase() &&
      [vm.configurationPath, ...vm.diskPaths].every((p) =>
        inside(this.directory(identity), p),
      )
    );
  }
  private inspection(
    identity: VmAllocationIdentity,
    o: Observation,
    m: Manifest | null,
  ): HyperVInspection {
    if (
      o.presence === "present" &&
      (!m || !o.vm || !this.owns(identity, m, o.vm))
    )
      return this.unknown(identity, "native_owner_mismatch");
    if (m?.phase === "importing" && o.presence === "absent")
      return this.unknown(identity, "import_outcome_unknown");
    if (o.presence === "absent" && (o.directoryPresent || !o.inventoryComplete))
      return this.unknown(identity, "absence_not_confirmed");
    return {
      identity,
      presence: o.presence,
      inventoryComplete: o.inventoryComplete,
      bootstrapStatus: "not_implemented",
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.vm ? { vm: o.vm } : {}),
      ...(m
        ? {
            requestedEnvironment: {
              guestOs: m.spec.template.guestOs,
              architecture: m.spec.template.architecture,
            },
          }
        : {}),
    };
  }
  private unknown(
    identity: VmAllocationIdentity,
    reason: string,
  ): HyperVInspection {
    return {
      identity,
      presence: "unknown",
      inventoryComplete: false,
      reason,
      bootstrapStatus: "not_implemented",
    };
  }
  private owner(identity: VmAllocationIdentity) {
    return sha(vmAllocationOwnerTuple(identity));
  }
  private directory(identity: VmAllocationIdentity) {
    return win32.join(this.workRoot, this.owner(identity));
  }
  private file(identity: VmAllocationIdentity) {
    return join(this.options.manifestDirectory, this.owner(identity) + ".json");
  }
  private native(
    identity: VmAllocationIdentity,
    m: Manifest | null,
    action: HyperVNativeCommand["action"],
  ): HyperVNativeCommand {
    return {
      action,
      directory: this.directory(identity),
      owner:
        "hitchlet/v1/" + this.owner(identity) + (m ? "/" + m.specHash : ""),
      specHash: m?.specHash ?? "",
      vmId: m?.vmId ?? null,
      ...(m ? { spec: m.spec } : {}),
    };
  }
  private async observe(
    identity: VmAllocationIdentity,
    m: Manifest | null,
  ): Promise<Observation> {
    try {
      const o = observationSchema.parse(
        await this.command(this.native(identity, m, "inspect")),
      );
      return o.inventoryComplete
        ? o
        : {
            presence: "unknown",
            inventoryComplete: false,
            directoryPresent: o.directoryPresent,
            reason: o.reason ?? "native_inventory_incomplete",
          };
    } catch {
      return {
        presence: "unknown",
        inventoryComplete: false,
        directoryPresent: false,
        reason: "native_inspection_unknown",
      };
    }
  }
  private fence(m: Manifest, i: VmAllocationIdentity) {
    if (
      canonical(vmAllocationOwnerTuple(m.identity)) !==
      canonical(vmAllocationOwnerTuple(i))
    )
      throw Error("Hyper-V allocation owner mismatch");
    if (i.controlVersion < m.highestControlVersion)
      throw Error("Hyper-V stale control version");
  }
  private async load(identity: VmAllocationIdentity): Promise<Manifest | null> {
    try {
      const m = manifestSchema.parse(
        JSON.parse(await readFile(this.file(identity), "utf8")),
      );
      if (m.specHash !== sha(m.spec))
        throw Error("Hyper-V manifest specification hash mismatch");
      if (
        canonical(vmAllocationOwnerTuple(m.identity)) !==
        canonical(vmAllocationOwnerTuple(identity))
      )
        throw Error("Hyper-V allocation owner mismatch");
      return m;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  private async claim(m: Manifest) {
    await mkdir(this.options.manifestDirectory, {
      recursive: true,
      mode: 0o700,
    });
    let file;
    try {
      file = await open(this.file(m.identity), "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    try {
      await file.writeFile(JSON.stringify(m));
      await file.sync();
    } finally {
      await file.close();
    }
    return true;
  }
  private async store(m: Manifest) {
    const path = this.file(m.identity),
      tmp = path + "." + randomUUID() + ".tmp";
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(m));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  }
  private async command(command: HyperVNativeCommand) {
    const timeout = Math.floor(
      Math.min(
        command.action === "import" ? 120000 : 15000,
        (currentCommandDeadlineMs() ?? Infinity) - Date.now(),
      ),
    );
    if (timeout <= 0) throw Error("Hyper-V command deadline reached");
    return this.run(command, timeout);
  }
  private lock<T>(
    identity: VmAllocationIdentity,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = this.owner(identity),
      prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.locks.set(key, next);
    void next
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      })
      .catch(() => {});
    return next;
  }
}
function inside(root: string, path: string) {
  const relative = win32.relative(root, path);
  return (
    relative !== "" && !relative.startsWith("..") && !win32.isAbsolute(relative)
  );
}

/** Fixed script + structured stdin. Does not request elevation or configure the host. */
export const runHyperVNative: HyperVNativeRunner = (request, timeoutMs) => {
  if (process.platform !== "win32")
    return Promise.reject(Error("Hyper-V native commands require Windows"));
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./hyperv-local.ps1", import.meta.url)),
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(Error("Hyper-V native command failed or timed out"));
          return;
        }
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, "")));
        } catch {
          reject(Error("Hyper-V native response is invalid"));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
};
