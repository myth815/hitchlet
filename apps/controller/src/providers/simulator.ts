import { resourceManifest } from "../domain/resource-manifest.js";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecutionPort,
  InventoryEvidence,
  OwnedResource,
  ProvisionPlan,
  ReadyReceipt,
  Inspection,
  RuntimeBinding,
  ResourceJournal,
} from "./port.js";

export type SimulatorFault =
  | "none"
  | "create_before_first_object"
  | "create_after_first_object"
  | "create_receipt_lost"
  | "create_response_lost"
  | "delete_failure"
  | "incomplete_inventory"
  | "wrong_runtime";

/** Persistent external simulator state, independent from the SQLite control ledger. */
export class PersistentSimulator implements ExecutionPort {
  constructor(
    private readonly root: string,
    private readonly fault: SimulatorFault = "none",
  ) {}
  private allocationPath(plan: ProvisionPlan): string {
    return join(
      this.root,
      "resources",
      key(
        plan.identity.installationId,
        plan.identity.allocationId,
        String(plan.identity.generation),
      ),
    );
  }
  private journalPath(plan: ProvisionPlan): string {
    return join(
      this.root,
      "journal",
      `${key(plan.identity.installationId, plan.identity.allocationId, String(plan.identity.generation), plan.identity.operationId, plan.identity.purpose)}.json`,
    );
  }
  private async save(file: string, value: unknown): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, file);
  }
  async create(
    plan: ProvisionPlan,
    resourceJournal: ResourceJournal,
  ): Promise<readonly OwnedResource[]> {
    return withAllocationLock(plan, () =>
      this.createExclusive(plan, resourceJournal),
    );
  }
  private async createExclusive(
    plan: ProvisionPlan,
    resourceJournal: ResourceJournal,
  ): Promise<readonly OwnedResource[]> {
    const dir = this.allocationPath(plan);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const journal = await readJson(this.journalPath(plan));
    if (
      journal?.state === "fenced" &&
      Number(journal.controlVersion) >= plan.identity.controlVersion
    )
      throw new Error("simulator create intent was fenced");
    const found = await this.inspect(plan);
    if (found.presence === "unknown") throw new Error(found.reason);
    const existing = found.presence === "present" ? found.evidence.objects : [];
    await this.save(this.journalPath(plan), {
      state: "started",
      identity: plan.identity,
      contractHash: plan.resolved.contractHash,
    });
    const resources: OwnedResource[] = [];
    const definitions: {
      kind: OwnedResource["kind"];
      referenceKey?: string;
    }[] = [
      { kind: "container" },
      { kind: "network_policy" },
      { kind: "endpoint" },
      ...plan.resolved.mounts.map((mount) => ({
        kind: "storage_reference" as const,
        referenceKey: `${mount.revisionId}:${mount.target}`,
      })),
    ];
    if (
      this.fault === "create_before_first_object" &&
      !(await this.faultConsumed(plan))
    ) {
      await this.consumeFault(plan);
      throw new Error("simulator injected pre-create interruption");
    }
    for (const definition of definitions) {
      const { kind, referenceKey } = definition;
      const id = key(
        plan.identity.installationId,
        plan.identity.allocationId,
        String(plan.identity.generation),
        plan.identity.operationId,
        plan.identity.purpose,
        kind,
        referenceKey ?? "",
      );
      const already = existing.find((item) => item.id === id);
      if (already) {
        await resourceJournal.recordCreated(already);
        resources.push(already);
        continue;
      }
      const resource: OwnedResource = {
        id,
        kind,
        ownership: referenceKey ? "reference" : "owned",
        ...(referenceKey ? { referenceKey } : {}),
        identity: plan.identity,
        contractHash: plan.resolved.contractHash,
        evidence: {
          artifactDigest: plan.artifact.digest,
          resourcesHash: hash(plan.resources),
          networkHash: hash(plan.resolved.network),
          mountsHash: hash(plan.resolved.mounts),
          accessProtocol: plan.accessProtocol,
        },
      };
      await this.save(join(dir, `${id}.json`), resource);
      if (
        this.fault === "create_receipt_lost" &&
        resources.length === 0 &&
        !(await this.faultConsumed(plan))
      ) {
        await this.consumeFault(plan);
        throw new Error("simulator injected lost resource journal receipt");
      }
      await resourceJournal.recordCreated(resource);
      resources.push(resource);
      if (
        this.fault === "create_after_first_object" &&
        resources.length === 1 &&
        !(await this.faultConsumed(plan))
      ) {
        await this.consumeFault(plan);
        throw new Error("simulator injected create interruption");
      }
    }
    await this.save(this.journalPath(plan), {
      state: "complete",
      identity: plan.identity,
      contractHash: plan.resolved.contractHash,
    });
    if (
      this.fault === "create_response_lost" &&
      !(await this.faultConsumed(plan))
    ) {
      await this.consumeFault(plan);
      throw new Error("simulator injected lost create response");
    }
    return resources;
  }
  async inspect(plan: ProvisionPlan): Promise<Inspection> {
    if (this.fault === "wrong_runtime")
      return { presence: "unknown", reason: "runtime_identity_mismatch" };
    if (this.fault === "incomplete_inventory")
      return { presence: "unknown", reason: "inventory_incomplete" };
    let names: string[];
    try {
      names = await readdir(this.allocationPath(plan));
    } catch (error) {
      if (isMissing(error))
        return {
          presence: "absent",
          evidence: {
            completeness: "complete",
            runtime: plan.identity,
            identity: plan.identity,
          },
        };
      throw error;
    }
    const objects: OwnedResource[] = [];
    for (const name of names.filter(
      (item) => item.endsWith(".json") && item !== "revoked.json",
    )) {
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(this.allocationPath(plan), name), "utf8"),
        );
        if (
          !isObject(parsed) ||
          !isObject(parsed.identity) ||
          !sameOwner(parsed.identity, plan)
        )
          return { presence: "unknown", reason: "runtime_identity_mismatch" };
        if (
          typeof parsed.id !== "string" ||
          ![
            "container",
            "network_policy",
            "endpoint",
            "storage_reference",
          ].includes(String(parsed.kind)) ||
          parsed.contractHash !== plan.resolved.contractHash ||
          !isObject(parsed.evidence) ||
          parsed.evidence.artifactDigest !== plan.artifact.digest ||
          parsed.evidence.resourcesHash !== hash(plan.resources) ||
          parsed.evidence.networkHash !== hash(plan.resolved.network) ||
          parsed.evidence.mountsHash !== hash(plan.resolved.mounts) ||
          parsed.evidence.accessProtocol !== plan.accessProtocol
        )
          return { presence: "unknown", reason: "inventory_incomplete" };
        objects.push(parsed as unknown as OwnedResource);
      } catch {
        return { presence: "unknown", reason: "inventory_incomplete" };
      }
    }
    const journal = await readJson(this.journalPath(plan));
    if (journal && !validJournal(journal, plan))
      return { presence: "unknown", reason: "inventory_incomplete" };
    if (!objects.length && journal?.state === "started")
      return { presence: "unknown", reason: "inventory_incomplete" };
    if (!objects.length)
      return {
        presence: "absent",
        evidence: {
          completeness: "complete",
          runtime: plan.identity,
          identity: plan.identity,
        },
      };
    const evidence: InventoryEvidence = {
      completeness: "complete",
      runtime: plan.identity,
      identity: plan.identity,
      objects,
    };
    return { presence: "present", evidence };
  }
  async ready(
    plan: ProvisionPlan,
    inventory: InventoryEvidence,
  ): Promise<ReadyReceipt> {
    if (
      inventory.completeness !== "complete" ||
      !sameOwner(
        inventory.identity as unknown as Record<string, unknown>,
        plan,
      ) ||
      !sameRuntime(inventory.runtime, plan.identity) ||
      inventory.objects.length !== 3 + plan.resolved.mounts.length
    )
      throw new Error("simulator inventory does not satisfy the plan");
    if (
      plan.resources.isolation !== "shared_kernel" ||
      plan.resources.accelerators.length > 0
    )
      throw new Error(
        "simulator does not implement VM or accelerator contracts",
      );
    const kinds = new Set(inventory.objects.map((item) => item.kind));
    if (
      !["container", "network_policy", "endpoint"].every((kind) =>
        kinds.has(kind as OwnedResource["kind"]),
      ) ||
      inventory.objects.filter((item) => item.kind === "storage_reference")
        .length !== plan.resolved.mounts.length ||
      inventory.objects.some(
        (item) =>
          item.contractHash !== plan.resolved.contractHash ||
          item.evidence.artifactDigest !== plan.artifact.digest ||
          item.evidence.resourcesHash !== hash(plan.resources) ||
          item.evidence.networkHash !== hash(plan.resolved.network) ||
          item.evidence.mountsHash !== hash(plan.resolved.mounts) ||
          item.evidence.accessProtocol !== plan.accessProtocol,
      )
    )
      throw new Error("simulator manifest is incomplete");
    const effectiveResources = {
      limits: plan.resources.limit,
      cpuEnforcement: "hard" as const,
      memoryEnforcement: "hard" as const,
      scratchEnforcement:
        plan.resources.scratchEnforcement === "required"
          ? ("hard" as const)
          : ("best_effort" as const),
      acceleratorAssignments: [],
    };
    if (
      plan.resources.scratchEnforcement === "required" &&
      effectiveResources.scratchEnforcement !== "hard"
    )
      throw new Error("required scratch enforcement is unavailable");
    return {
      identity: plan.identity,
      artifactDigest: plan.artifact.digest,
      contractHash: plan.resolved.contractHash,
      ...resourceManifest(plan, inventory.objects),
      objectIds: inventory.objects.map((item) => item.id).sort(),
      effectiveResources,
      networkRevisionId: plan.resolved.network.revisionId,
      networkContractHash: hash(plan.resolved.network),
      mountContractHash: hash(plan.resolved.mounts),
      accessProtocol: plan.accessProtocol,
      bootstrapComplete: true,
      offlineLeaseEnforcement: "unsupported",
    };
  }
  async revokeStop(plan: ProvisionPlan): Promise<void> {
    return withAllocationLock(plan, () => this.revokeStopExclusive(plan));
  }
  private async revokeStopExclusive(plan: ProvisionPlan): Promise<void> {
    const found = await this.inspect(plan);
    if (
      found.presence === "unknown" &&
      found.reason === "runtime_identity_mismatch"
    )
      throw new Error(found.reason);
    const current = await readJson(this.journalPath(plan));
    await this.save(this.journalPath(plan), {
      state: "fenced",
      identity: plan.identity,
      contractHash: plan.resolved.contractHash,
      controlVersion: Math.max(
        plan.identity.controlVersion,
        Number(current?.controlVersion ?? 0),
      ),
    });
    if (found.presence === "present")
      await this.save(join(this.allocationPath(plan), "revoked.json"), {
        identity: plan.identity,
        controlVersion: plan.identity.controlVersion,
        revoked: true,
      });
  }
  async destroy(plan: ProvisionPlan, resource: OwnedResource): Promise<void> {
    return withAllocationLock(plan, () =>
      this.destroyExclusive(plan, resource),
    );
  }
  private async destroyExclusive(
    plan: ProvisionPlan,
    resource: OwnedResource,
  ): Promise<void> {
    if (
      !sameOwner(
        resource.identity as unknown as Record<string, unknown>,
        plan,
      ) ||
      resource.contractHash !== plan.resolved.contractHash
    )
      throw new Error("simulator object ownership mismatch");
    const found = await this.inspect(plan);
    if (found.presence === "unknown") throw new Error(found.reason);
    if (found.presence === "absent") return;
    if (resource.ownership === "owned" && this.fault === "delete_failure")
      throw new Error("simulator injected delete failure");
    if (found.evidence.objects.some((item) => item.id === resource.id))
      await rm(join(this.allocationPath(plan), `${resource.id}.json`), {
        force: false,
      });
  }
  private async faultConsumed(plan: ProvisionPlan): Promise<boolean> {
    try {
      await access(
        join(
          this.root,
          "faults",
          `${key(plan.identity.operationId, this.fault)}.json`,
        ),
      );
      return true;
    } catch {
      return false;
    }
  }
  private async consumeFault(plan: ProvisionPlan): Promise<void> {
    await this.save(
      join(
        this.root,
        "faults",
        `${key(plan.identity.operationId, this.fault)}.json`,
      ),
      { consumed: true },
    );
  }
}

const allocationLocks = new Map<string, Promise<void>>();
async function withAllocationLock<T>(
  plan: ProvisionPlan,
  action: () => Promise<T>,
): Promise<T> {
  const lock = key(
    plan.identity.installationId,
    plan.identity.allocationId,
    String(plan.identity.generation),
  );
  const previous = allocationLocks.get(lock) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  allocationLocks.set(lock, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (allocationLocks.get(lock) === tail) allocationLocks.delete(lock);
  }
}

function key(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32);
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sameOwner(
  left: Record<string, unknown>,
  plan: ProvisionPlan,
): boolean {
  const identity = plan.identity;
  return (
    left.installationId === identity.installationId &&
    left.allocationId === identity.allocationId &&
    left.generation === identity.generation &&
    left.purpose === identity.purpose &&
    left.operationId === identity.operationId &&
    left.runtimeIdentityId === identity.runtimeIdentityId &&
    left.connectionRevisionId === identity.connectionRevisionId &&
    typeof left.controlVersion === "number" &&
    left.controlVersion <= identity.controlVersion
  );
}
function sameRuntime(left: RuntimeBinding, right: RuntimeBinding): boolean {
  return (
    left.runtimeIdentityId === right.runtimeIdentityId &&
    left.connectionRevisionId === right.connectionRevisionId
  );
}
function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}
async function readJson(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isObject(value)) throw new Error("Simulator journal is invalid");
    return value;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
function validJournal(
  value: Record<string, unknown>,
  plan: ProvisionPlan,
): boolean {
  const identity = value.identity;
  return (
    (value.state === "started" ||
      value.state === "complete" ||
      value.state === "fenced") &&
    isObject(identity) &&
    sameOwner(identity, plan) &&
    value.contractHash === plan.resolved.contractHash &&
    (value.state !== "fenced" ||
      (typeof value.controlVersion === "number" &&
        value.controlVersion >= plan.identity.controlVersion))
  );
}
