import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  open,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const SHORT_COMMAND_MS = 15_000;
const CLONE_COMMAND_MS = 120_000;
const IP_DEADLINE_MS = 90_000;
const IP_POLL_MS = 1_000;
const RUN_EXIT_MS = 5_000;
const MAX_OUTPUT = 1024 * 1024;

const inputSchema = z
  .object({
    allocationId: z.string().min(1).max(128),
    generation: z.number().int().positive().max(2_147_483_647),
    ownerId: z.string().min(1).max(128),
    templateName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    cpus: z.number().int().min(1).max(64),
    memoryMiB: z.number().int().min(512).max(1_048_576),
  })
  .strict();

const manifestSchema = z
  .object({
    version: z.literal(1),
    allocationId: z.string(),
    generation: z.number().int().positive(),
    ownerId: z.string(),
    templateName: z.string(),
    vmName: z.string(),
    phase: z.enum(["clone_intent", "owned", "deleting"]),
    cpus: z.number().int().min(1).max(64),
    memoryMiB: z.number().int().min(512).max(1_048_576),
    home: z
      .object({ path: z.string(), device: z.string(), inode: z.string() })
      .strict(),
    template: z
      .object({
        device: z.string(),
        inode: z.string(),
        configSha256: z.string().regex(/^[a-f0-9]{64}$/),
        guestOS: z.enum(["darwin", "linux"]),
        arch: z.literal("arm64"),
      })
      .strict()
      .optional(),
    identity: z
      .object({
        device: z.string(),
        inode: z.string(),
        macAddress: z.string().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i),
        guestOS: z.enum(["darwin", "linux"]),
        arch: z.literal("arm64"),
        cpus: z.number().int().positive(),
        memoryBytes: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Manifest = z.infer<typeof manifestSchema>;
type InventoryRow = {
  Source: string;
  Name: string;
  Running: boolean;
  State: string;
};
type Identity = {
  device: string;
  inode: string;
  macAddress: string;
  guestOS: "darwin" | "linux";
  arch: "arm64";
  cpus: number;
  memoryBytes: number;
};
type TemplateFacts = {
  device: string;
  inode: string;
  configSha256: string;
  guestOS: "darwin" | "linux";
  arch: "arm64";
};
type RunningChild = { child: ChildProcess; exit: Promise<void> };

export type TartDriverOptions = Readonly<{
  /** Dedicated Tart home; never point this at a user's regular Tart home. */
  tartHome: string;
  /** Durable, private directory for this driver's ownership manifests. */
  manifestDirectory: string;
  /** Absolute executable path. Production callers fix this to their installed Tart binary. */
  executable: string;
}>;

export type TartProvisionResult =
  | Readonly<{ status: "observed_with_ip"; vmName: string; ipAddress: string }>
  | Readonly<{ status: "unknown"; reason: string }>;
export type TartDeleteResult =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "unknown"; reason: string }>;

/**
 * Finite, local Tart CLI adapter for macOS arm64. This is not a controller
 * ProvisionPlan implementation and does not qualify guest networking or boot.
 * Every command uses fixed argv with shell:false and a private TART_HOME.
 */
export class TartLocalDriver {
  private readonly home: string;
  private readonly vmRoot: string;
  private readonly manifestRoot: string;
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly children = new Map<string, RunningChild>();
  private readonly ownedRunningVMs = new Set<string>();
  private readonly operations = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: TartDriverOptions) {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error("tart_host_unsupported");
    if (!options.tartHome || !options.manifestDirectory || !options.executable)
      throw new Error("tart_driver_paths_required");
    if (!options.executable.startsWith("/"))
      throw new Error("tart_executable_must_be_absolute");
    this.home = resolve(options.tartHome);
    this.vmRoot = join(this.home, "vms");
    if (
      this.home === resolve(homedir()) ||
      this.home === resolve(homedir(), ".tart") ||
      this.home.startsWith(`${resolve(homedir(), ".tart")}/`) ||
      this.home === "/"
    )
      throw new Error("tart_home_must_be_dedicated");
    this.manifestRoot = resolve(options.manifestDirectory);
    if (
      this.manifestRoot === this.home ||
      this.manifestRoot.startsWith(`${this.home}/`)
    )
      throw new Error("tart_manifest_must_be_outside_home");
    this.executable = options.executable;
    this.env = {
      ...process.env,
      TART_HOME: this.home,
      TART_NO_AUTO_PRUNE: "1",
      LC_ALL: "C",
      LANG: "C",
    };
  }

  provision(rawInput: unknown): Promise<TartProvisionResult> {
    const input = inputSchema.parse(rawInput);
    const key = this.operationKey(input);
    return this.exclusive(key, () => this.provisionOwned(input));
  }

  destroy(rawInput: unknown): Promise<TartDeleteResult> {
    const input = inputSchema.parse(rawInput);
    const key = this.operationKey(input);
    return this.exclusive(key, () => this.destroyOwned(input));
  }

  /** Stop accepting work and wait for in-flight CLI state transitions. Running
   * VMs are left intact; close never treats a run-child exit as VM absence. */
  async close(): Promise<
    Readonly<{ lastObservedOwnedRunningVMs: readonly string[] }>
  > {
    this.closed = true;
    await Promise.all([...this.operations.values()]);
    return { lastObservedOwnedRunningVMs: [...this.ownedRunningVMs] };
  }

  private operationKey(input: Input): string {
    return `${input.allocationId}:${input.generation}`;
  }

  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("tart_driver_closed");
    const previous = this.operations.get(key) ?? Promise.resolve();
    let finish!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      finish = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.operations.set(key, tail);
    await previous;
    try {
      if (this.closed) throw new Error("tart_driver_closed");
      return await work();
    } finally {
      finish();
      if (this.operations.get(key) === tail) this.operations.delete(key);
    }
  }

  private async provisionOwned(input: Input): Promise<TartProvisionResult> {
    await this.prepareDirectories();
    const vmName = this.vmName(input);
    const manifestPath = this.manifestPath(input);
    let manifest = await this.readManifest(manifestPath);
    if (manifest && !this.matchesInput(manifest, input, vmName))
      return {
        status: "unknown",
        reason: "manifest_owner_or_generation_mismatch",
      };
    if (manifest?.phase === "deleting")
      return { status: "unknown", reason: "deletion_already_in_progress" };
    if (manifest && !(await this.matchesHome(manifest)))
      return { status: "unknown", reason: "tart_home_identity_changed" };

    const newIntent = manifest === undefined;
    if (!manifest) {
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return { status: "unknown", reason: "inventory_incomplete" };
      if (inventory.names.has(vmName))
        return { status: "unknown", reason: "unmanifested_vm_name_collision" };
      if (!inventory.names.has(input.templateName))
        return { status: "unknown", reason: "local_template_not_found" };
      const template = await this.readTemplateFacts(input.templateName);
      if (!template)
        return {
          status: "unknown",
          reason: "local_template_identity_unavailable",
        };
      manifest = {
        version: 1,
        allocationId: input.allocationId,
        generation: input.generation,
        ownerId: input.ownerId,
        templateName: input.templateName,
        cpus: input.cpus,
        memoryMiB: input.memoryMiB,
        vmName,
        phase: "clone_intent",
        home: await this.homeIdentity(),
        template,
      };
      await this.writeManifest(manifestPath, manifest);
    }

    if (manifest.phase === "clone_intent") {
      if (!newIntent)
        return {
          status: "unknown",
          reason: "interrupted_clone_identity_not_recorded",
        };
      const inventory = await this.inventory();
      if (inventory.status !== "complete")
        return { status: "unknown", reason: "inventory_incomplete" };
      // A clone can finish while the process is interrupted before identity is
      // durably recorded. Name coincidence is not proof of ownership.
      if (inventory.names.has(vmName))
        return { status: "unknown", reason: "clone_identity_not_recorded" };
      if (!inventory.names.has(input.templateName))
        return { status: "unknown", reason: "local_template_not_found" };
      const currentTemplate = await this.readTemplateFacts(input.templateName);
      if (
        !manifest.template ||
        !currentTemplate ||
        !sameTemplate(manifest.template, currentTemplate)
      )
        return { status: "unknown", reason: "template_identity_changed" };
      await this.runShort(
        ["clone", input.templateName, vmName],
        CLONE_COMMAND_MS,
      );
      await this.runShort([
        "set",
        vmName,
        "--cpu",
        String(input.cpus),
        "--memory",
        String(input.memoryMiB),
        "--random-mac",
      ]);
      const identity = await this.readIdentity(vmName);
      if (
        !identity ||
        identity.guestOS !== manifest.template.guestOS ||
        identity.arch !== manifest.template.arch
      )
        return { status: "unknown", reason: "cloned_vm_identity_unavailable" };
      if (
        identity.cpus !== input.cpus ||
        identity.memoryBytes !== input.memoryMiB * 1024 * 1024
      )
        return {
          status: "unknown",
          reason: "cloned_vm_resources_do_not_match_request",
        };
      manifest = { ...manifest, phase: "owned", identity };
      await this.writeManifest(manifestPath, manifest);
    }

    if (!manifest.identity)
      return { status: "unknown", reason: "manifest_identity_missing" };
    const currentTemplate = await this.readTemplateFacts(input.templateName);
    if (
      !manifest.template ||
      !currentTemplate ||
      !sameTemplate(manifest.template, currentTemplate)
    )
      return { status: "unknown", reason: "template_identity_changed" };
    const verified = await this.verifyOwned(manifest);
    if (verified !== "present")
      return { status: "unknown", reason: `owned_vm_${verified}` };
    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      return { status: "unknown", reason: "inventory_incomplete" };
    const row = inventory.rows.find((item) => item.Name === vmName);
    if (!row || row.Source !== "local")
      return {
        status: "unknown",
        reason: "owned_vm_missing_from_cli_inventory",
      };
    if (!row.Running) await this.startRun(vmName);
    const ipAddress = await this.discoverIp(vmName);
    if (!ipAddress)
      return {
        status: "unknown",
        reason: "guest_ip_not_observed_before_deadline",
      };
    this.ownedRunningVMs.add(vmName);
    return { status: "observed_with_ip", vmName, ipAddress };
  }

  private async destroyOwned(input: Input): Promise<TartDeleteResult> {
    await this.prepareDirectories();
    const manifestPath = this.manifestPath(input);
    const manifest = await this.readManifest(manifestPath);
    if (
      !manifest ||
      !this.matchesInput(manifest, input, this.vmName(input)) ||
      !manifest.identity
    )
      return {
        status: "unknown",
        reason: "owned_manifest_or_identity_missing",
      };
    if (!(await this.matchesHome(manifest)))
      return { status: "unknown", reason: "tart_home_identity_changed" };
    const verified = await this.verifyOwned(manifest);
    if (verified === "unknown")
      return { status: "unknown", reason: "inventory_incomplete" };
    if (verified === "absent") {
      const inventory = await this.inventory();
      if (
        inventory.status !== "complete" ||
        inventory.names.has(manifest.vmName)
      )
        return { status: "unknown", reason: "absence_not_verified" };
      await rm(manifestPath, { force: true });
      this.ownedRunningVMs.delete(manifest.vmName);
      return { status: "absent" };
    }
    const inventory = await this.inventory();
    if (inventory.status !== "complete")
      return { status: "unknown", reason: "inventory_incomplete" };
    const row = inventory.rows.find((item) => item.Name === manifest.vmName);
    if (!row || row.Source !== "local")
      return {
        status: "unknown",
        reason: "owned_vm_missing_from_cli_inventory",
      };
    await this.writeManifest(manifestPath, { ...manifest, phase: "deleting" });
    if (row.Running) {
      await this.runShort(["stop", "--timeout", "5", manifest.vmName]);
    }
    if (!(await this.stopRunChild(manifest.vmName)))
      return { status: "unknown", reason: "run_process_exit_not_observed" };
    const stopped = await this.inventory();
    if (stopped.status !== "complete")
      return { status: "unknown", reason: "inventory_incomplete_after_stop" };
    const stoppedRow = stopped.rows.find(
      (item) => item.Name === manifest.vmName,
    );
    if (
      !stoppedRow ||
      stoppedRow.Source !== "local" ||
      stoppedRow.Running ||
      stoppedRow.State !== "stopped"
    )
      return { status: "unknown", reason: "vm_stop_not_verified" };
    // Recheck immutable local identity immediately before the destructive CLI call.
    if ((await this.verifyOwned(manifest)) !== "present")
      return {
        status: "unknown",
        reason: "owned_vm_identity_changed_before_delete",
      };
    await this.runShort(["delete", manifest.vmName]);
    const after = await this.inventory();
    if (after.status !== "complete" || after.names.has(manifest.vmName))
      return { status: "unknown", reason: "deletion_absence_not_verified" };
    await rm(manifestPath, { force: true });
    this.ownedRunningVMs.delete(manifest.vmName);
    return { status: "absent" };
  }

  private async prepareDirectories(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(this.manifestRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.vmRoot, { recursive: true, mode: 0o700 });
    const [homeStat, manifestStat] = await Promise.all([
      stat(this.home),
      stat(this.manifestRoot),
    ]);
    if ((homeStat.mode & 0o077) !== 0 || (manifestStat.mode & 0o077) !== 0)
      throw new Error("tart_private_directory_permissions_required");
  }

  private async homeIdentity(): Promise<{
    path: string;
    device: string;
    inode: string;
  }> {
    const directory = await stat(this.home);
    return {
      path: this.home,
      device: String(directory.dev),
      inode: String(directory.ino),
    };
  }

  private async matchesHome(manifest: Manifest): Promise<boolean> {
    const current = await this.homeIdentity();
    return (
      current.path === manifest.home.path &&
      current.device === manifest.home.device &&
      current.inode === manifest.home.inode
    );
  }

  private vmName(input: Input): string {
    const identity = createHash("sha256")
      .update(`${input.ownerId}\0${input.allocationId}\0${input.generation}`)
      .digest("hex")
      .slice(0, 32);
    return `hitchlet-${identity}`;
  }

  private manifestPath(input: Input): string {
    const key = createHash("sha256")
      .update(`${input.ownerId}\0${input.allocationId}\0${input.generation}`)
      .digest("hex");
    return join(this.manifestRoot, `${key}.json`);
  }

  private matchesInput(
    manifest: Manifest,
    input: Input,
    vmName: string,
  ): boolean {
    return (
      manifest.allocationId === input.allocationId &&
      manifest.generation === input.generation &&
      manifest.ownerId === input.ownerId &&
      manifest.templateName === input.templateName &&
      manifest.vmName === vmName &&
      manifest.cpus === input.cpus &&
      manifest.memoryMiB === input.memoryMiB
    );
  }

  private async readManifest(path: string): Promise<Manifest | undefined> {
    try {
      return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new Error("tart_manifest_unreadable");
    }
  }

  private async writeManifest(path: string, manifest: Manifest): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(tmp, path);
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  private async inventory(
    deadlineMs?: number,
  ): Promise<
    | { status: "complete"; names: Set<string>; rows: InventoryRow[] }
    | { status: "unknown" }
  > {
    try {
      const { stdout } = await this.runShort(
        ["list", "--source", "local", "--format", "json"],
        commandBudget(deadlineMs),
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return { status: "unknown" };
      const rows = parsed.map((row) => {
        if (
          typeof row !== "object" ||
          row === null ||
          typeof (row as Record<string, unknown>).Name !== "string" ||
          typeof (row as Record<string, unknown>).Source !== "string" ||
          typeof (row as Record<string, unknown>).Running !== "boolean" ||
          typeof (row as Record<string, unknown>).State !== "string"
        )
          throw new Error("inventory_shape");
        return row as InventoryRow;
      });
      if (
        rows.some((row) => row.Source !== "local") ||
        new Set(rows.map((row) => row.Name)).size !== rows.length
      )
        return { status: "unknown" };
      const diskNames = await readdir(this.vmRoot, { withFileTypes: true });
      const names = diskNames
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const cliNames = rows.map((row) => row.Name).sort();
      if (JSON.stringify(names) !== JSON.stringify(cliNames))
        return { status: "unknown" };
      return { status: "complete", names: new Set(names), rows };
    } catch {
      return { status: "unknown" };
    }
  }

  private async readIdentity(vmName: string): Promise<Identity | undefined> {
    try {
      const directory = join(this.vmRoot, vmName);
      const [directoryStat, configText] = await Promise.all([
        stat(directory),
        readFile(join(directory, "config.json"), "utf8"),
      ]);
      const config: unknown = JSON.parse(configText);
      if (
        typeof config !== "object" ||
        config === null ||
        typeof (config as Record<string, unknown>).macAddress !== "string" ||
        typeof (config as Record<string, unknown>).cpuCount !== "number" ||
        typeof (config as Record<string, unknown>).memorySize !== "number" ||
        !["darwin", "linux"].includes(
          String((config as Record<string, unknown>).os),
        ) ||
        (config as Record<string, unknown>).arch !== "arm64"
      )
        return undefined;
      const values = config as Record<string, unknown>;
      const macAddress = values.macAddress as string;
      if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(macAddress))
        return undefined;
      return {
        device: String(directoryStat.dev),
        inode: String(directoryStat.ino),
        macAddress: macAddress.toLowerCase(),
        guestOS: values.os as "darwin" | "linux",
        arch: "arm64",
        cpus: values.cpuCount as number,
        memoryBytes: values.memorySize as number,
      };
    } catch {
      return undefined;
    }
  }

  private async readTemplateFacts(
    templateName: string,
  ): Promise<TemplateFacts | undefined> {
    try {
      const path = join(this.vmRoot, templateName);
      const [directoryStat, configText] = await Promise.all([
        stat(path),
        readFile(join(path, "config.json"), "utf8"),
      ]);
      const config: unknown = JSON.parse(configText);
      if (typeof config !== "object" || config === null) return undefined;
      const values = config as Record<string, unknown>;
      if (
        !["darwin", "linux"].includes(String(values.os)) ||
        values.arch !== "arm64"
      )
        return undefined;
      return {
        device: String(directoryStat.dev),
        inode: String(directoryStat.ino),
        configSha256: createHash("sha256").update(configText).digest("hex"),
        guestOS: values.os as "darwin" | "linux",
        arch: "arm64",
      };
    } catch {
      return undefined;
    }
  }

  private async verifyOwned(
    manifest: Manifest,
  ): Promise<"present" | "absent" | "unknown"> {
    const inventory = await this.inventory();
    if (inventory.status !== "complete") return "unknown";
    const exists = inventory.names.has(manifest.vmName);
    if (!exists) return "absent";
    if (!manifest.identity) return "unknown";
    const identity = await this.readIdentity(manifest.vmName);
    if (
      !identity ||
      identity.device !== manifest.identity.device ||
      identity.inode !== manifest.identity.inode ||
      identity.macAddress !== manifest.identity.macAddress ||
      identity.guestOS !== manifest.identity.guestOS ||
      identity.arch !== manifest.identity.arch ||
      identity.cpus !== manifest.identity.cpus ||
      identity.memoryBytes !== manifest.identity.memoryBytes
    )
      return "unknown";
    return "present";
  }

  private async runShort(
    args: readonly string[],
    timeout = SHORT_COMMAND_MS,
  ): Promise<{ stdout: string; stderr: string }> {
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error("tart_command_deadline_expired");
    try {
      return await execFileAsync(this.executable, [...args], {
        cwd: this.home,
        env: this.env,
        shell: false,
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
      });
    } catch {
      throw new Error("tart_cli_command_failed");
    }
  }

  private async startRun(vmName: string): Promise<void> {
    if (this.children.has(vmName)) return;
    const child = spawn(this.executable, ["run", "--no-graphics", vmName], {
      cwd: this.home,
      env: this.env,
      shell: false,
      stdio: "ignore",
    });
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    child.once("error", () => resolveExit());
    child.once("exit", () => resolveExit());
    this.children.set(vmName, { child, exit });
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("tart_run_start_timeout")),
        5_000,
      );
      child.once("spawn", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("tart_run_start_failed"));
      });
    }).catch((error: unknown) => {
      this.children.delete(vmName);
      throw error;
    });
    void exit.then(() => {
      if (this.children.get(vmName)?.child === child)
        this.children.delete(vmName);
    });
  }

  private async discoverIp(vmName: string): Promise<string | undefined> {
    const deadline = Date.now() + IP_DEADLINE_MS;
    while (Date.now() < deadline) {
      const current = await this.inventory(deadline);
      if (current.status !== "complete" || !current.names.has(vmName))
        return undefined;
      const row = current.rows.find((item) => item.Name === vmName);
      if (row?.Running) {
        try {
          const { stdout } = await this.runShort(
            ["ip", "--wait", "0", vmName],
            commandBudget(deadline),
          );
          const address = stdout.trim();
          if (
            /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) &&
            address.split(".").every((part) => Number(part) <= 255)
          )
            return address;
        } catch {
          // IP discovery is read-only and retried within the fixed deadline.
        }
      }
      if (Date.now() < deadline)
        await new Promise((resolvePromise) =>
          setTimeout(
            resolvePromise,
            Math.min(IP_POLL_MS, deadline - Date.now()),
          ),
        );
    }
    return undefined;
  }

  private async stopRunChild(vmName: string): Promise<boolean> {
    const running = this.children.get(vmName);
    if (!running) return true;
    running.child.kill("SIGINT");
    if (await settlesWithin(running.exit, RUN_EXIT_MS)) {
      this.children.delete(vmName);
      return true;
    }
    running.child.kill("SIGKILL");
    if (await settlesWithin(running.exit, RUN_EXIT_MS)) {
      this.children.delete(vmName);
      return true;
    }
    return false;
  }
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function sameTemplate(left: TemplateFacts, right: TemplateFacts): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.configSha256 === right.configSha256 &&
    left.guestOS === right.guestOS &&
    left.arch === right.arch
  );
}

function commandBudget(deadlineMs?: number): number {
  return Math.floor(
    Math.min(
      SHORT_COMMAND_MS,
      deadlineMs === undefined ? SHORT_COMMAND_MS : deadlineMs - Date.now(),
    ),
  );
}
