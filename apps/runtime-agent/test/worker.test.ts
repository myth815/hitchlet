import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRuntimeNetworkValue,
  runtimeNetworkCommandSchema,
  runtimeNetworkRulesMaterial,
  type RuntimeNetworkCommand,
  type RuntimeNetworkPlan,
} from "@hitchlet/contracts/internal";
import { FileJournal } from "../src/journal.js";
import type { LocalEngine } from "../src/engine.js";
import type { Firewall } from "../src/firewall.js";
import { NetworkWorker } from "../src/worker.js";

const root = await mkdtemp(join(tmpdir(), "hitchlet-runtime-agent-test-"));
afterEach(async () => rm(root, { recursive: true, force: true }));

function makePlan(
  overrides: Partial<RuntimeNetworkPlan> = {},
): RuntimeNetworkPlan {
  const base = {
    installationId: "install-1",
    runtimeIdentityId: "runtime-1",
    nativeEngineId: "engine-1",
    allocationId: "allocation-1",
    generation: 1,
    operationId: "operation-1",
    controlVersion: 1,
    networkId: "network-1",
    networkName: "hl-test",
    networkSubnet: "172.30.77.0/24",
    containerIds: ["container-1"],
    bridgeInterface: "br-123456789abc",
    bridgeGateway: "172.30.77.1",
    userlandProxy: true,
    publishedPorts: [
      {
        containerId: "container-1",
        protocol: "tcp" as const,
        hostPort: 24001,
        containerPort: 22,
        hostAddress: "192.0.2.10",
      },
    ],
    grantId: "grant-1",
    networkRevisionId: "network-rev-1",
    frozenDenyRevisionId: "deny-frozen-1",
    effectiveDenyRevisionId: "deny-live-2",
    ingressSourceCidrs: ["192.0.2.0/24"],
    egress: [
      { cidr: "192.0.2.20/32", protocol: "tcp" as const, ports: [2049] },
    ],
    managementDeny: [
      { cidr: "192.0.2.30/32", protocol: "tcp" as const, ports: [443] },
    ],
  };
  const material = {
    ...base,
    ...overrides,
    expectedRulesetHash: "sha256:" + "0".repeat(64),
  };
  const expectedRulesetHash = hash(
    runtimeNetworkRulesMaterial(material as RuntimeNetworkPlan),
  );
  return { ...material, expectedRulesetHash } as RuntimeNetworkPlan;
}

function command(
  kind: RuntimeNetworkCommand["kind"],
  plan: RuntimeNetworkPlan,
  controllerEpoch = 1,
): RuntimeNetworkCommand {
  const raw = {
    kind,
    installationId: plan.installationId,
    runtimeIdentityId: plan.runtimeIdentityId,
    agentId: "agent-1",
    commandId: randomUUID(),
    operationId: plan.operationId,
    allocationId: plan.allocationId,
    generation: plan.generation,
    controlVersion: plan.controlVersion,
    controllerEpoch,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    plan,
  };
  return runtimeNetworkCommandSchema.parse({ ...raw, contentHash: hash(raw) });
}

const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalRuntimeNetworkValue(value)).digest("hex")}`;

class FakeEngine {
  calls: string[] = [];
  fail = false;
  async assertEngine() {
    this.calls.push("engine");
    if (this.fail) throw new Error("wrong engine");
    return "engine-1";
  }
  async inspectAllocation(plan: RuntimeNetworkPlan) {
    this.calls.push("inspect-allocation");
    return {
      bridge: plan.bridgeInterface,
      gateway: plan.bridgeGateway,
      subnet: plan.networkSubnet,
      containers: [],
    };
  }
  async assertAllocationAbsent() {
    this.calls.push("assert-absent");
  }
}

class FakeFirewall implements Firewall {
  calls: string[] = [];
  failApply = false;
  async apply(plan: RuntimeNetworkPlan) {
    this.calls.push(`apply:${plan.expectedRulesetHash}`);
    if (this.failApply) throw new Error("apply failed");
    return plan.expectedRulesetHash;
  }
  async inspect(plan: RuntimeNetworkPlan) {
    this.calls.push("inspect");
    return plan.expectedRulesetHash;
  }
  async revoke(plan: RuntimeNetworkPlan) {
    this.calls.push("revoke");
    return plan.expectedRulesetHash;
  }
  async remove() {
    this.calls.push("remove");
  }
}

function harness(
  path: string,
  engine = new FakeEngine(),
  firewall = new FakeFirewall(),
) {
  const journal = new FileJournal(path);
  return {
    worker: new NetworkWorker(
      {
        installationId: "install-1",
        runtimeIdentityId: "runtime-1",
        agentId: "agent-1",
      },
      journal,
      engine as unknown as LocalEngine,
      firewall,
    ),
    journal,
    engine,
    firewall,
  };
}

describe("runtime network command journal and fencing", () => {
  it("replays a durable receipt across agent restart without repeating firewall work", async () => {
    const journal = join(root, "replay.json");
    const { worker: first, firewall } = harness(journal);
    const ensure = command("network.ensure", makePlan());
    const result = await first.execute(ensure);
    expect(result.status).toBe("installed");
    const { worker: restarted } = harness(journal);
    await expect(restarted.execute(ensure)).resolves.toEqual(result);
    expect(firewall.calls).toHaveLength(1);
  });

  it("rejects same command id with changed content and stale controller epochs", async () => {
    const { worker } = harness(join(root, "fence.json"));
    const first = command("network.ensure", makePlan(), 4);
    await worker.execute(first);
    const changed = {
      ...first,
      deadline: new Date(Date.now() + 90_000).toISOString(),
    } as RuntimeNetworkCommand;
    await expect(worker.execute(changed)).rejects.toThrow(
      /content hash mismatch/,
    );
    await expect(
      worker.execute(
        command("network.inspect", makePlan({ operationId: "operation-2" }), 3),
      ),
    ).rejects.toThrow(/Stale controller epoch/);
  });

  it("persists a revoke tombstone before returning and blocks late ensure after restart", async () => {
    const journal = join(root, "tombstone.json");
    const plan = makePlan();
    const { worker: first } = harness(journal);
    expect((await first.execute(command("network.revoke", plan))).status).toBe(
      "revoked",
    );
    const { worker: restarted } = harness(journal);
    await expect(
      restarted.execute(command("network.ensure", plan)),
    ).rejects.toThrow(/cannot be re-enabled/);
  });

  it("accepts revoke for an owned network created before any container", async () => {
    const plan = makePlan({ containerIds: [], publishedPorts: [] });
    const { worker, engine, firewall } = harness(
      join(root, "partial-create.json"),
    );
    expect((await worker.execute(command("network.revoke", plan))).status).toBe(
      "revoked",
    );
    expect(engine.calls).toContain("inspect-allocation");
    expect(firewall.calls).toContain("revoke");
    expect(() => command("network.ensure", plan)).toThrow();
    expect(() => command("network.inspect", plan)).toThrow();
  });

  it("serializes a revoke racing with ensure so the revoke is final", async () => {
    const { worker, firewall } = harness(join(root, "race.json"));
    const plan = makePlan();
    const [ensure, revoke] = await Promise.all([
      worker.execute(command("network.ensure", plan)),
      worker.execute(command("network.revoke", plan)),
    ]);
    expect([ensure.status, revoke.status]).toEqual(["installed", "revoked"]);
    await expect(
      worker.execute(command("network.ensure", plan)),
    ).rejects.toThrow(/cannot be re-enabled/);
    expect(firewall.calls.at(-1)).toBe("revoke");
  });

  it("refuses an unverified or wrong local Engine before applying rules", async () => {
    const engine = new FakeEngine();
    engine.fail = true;
    const { worker, firewall } = harness(
      join(root, "wrong-engine.json"),
      engine,
      new FakeFirewall(),
    );
    await expect(
      worker.execute(command("network.ensure", makePlan())),
    ).rejects.toThrow(/wrong engine/);
    expect(firewall.calls).toEqual([]);
  });

  it("returns uncached unknown for inspect when Engine identity is unavailable", async () => {
    const path = join(root, "inspect-unknown.json");
    const engine = new FakeEngine();
    engine.fail = true;
    const { worker, journal } = harness(path, engine);
    const inspect = command("network.inspect", makePlan());
    await expect(worker.execute(inspect)).resolves.toMatchObject({
      status: "unknown",
      nativeEngineId: null,
      rulesetHash: null,
    });
    expect(journal.commandMap[inspect.commandId]).toBeUndefined();
    engine.fail = false;
    await expect(worker.execute(inspect)).resolves.toMatchObject({
      status: "present",
      nativeEngineId: "engine-1",
    });
  });

  it("rejects a completed command replay after a newer controller epoch", async () => {
    const { worker } = harness(join(root, "epoch-replay.json"));
    const original = command("network.inspect", makePlan(), 1);
    await worker.execute(original);
    await worker.execute(
      command("network.inspect", makePlan({ operationId: "epoch-2" }), 2),
    );
    await expect(worker.execute(original)).rejects.toThrow(
      /Stale controller epoch/,
    );
  });

  it("durably fences a command id before firewall side effects and resumes its exact retry", async () => {
    const { worker, firewall } = harness(join(root, "pending-command.json"));
    const original = command("network.ensure", makePlan());
    firewall.failApply = true;
    await expect(worker.execute(original)).rejects.toThrow(/apply failed/);
    const changedBase = {
      ...original,
      operationId: "changed-operation",
      plan: makePlan({ operationId: "changed-operation" }),
    };
    const { contentHash: _oldHash, ...changedWithoutHash } = changedBase;
    const changed = {
      ...changedWithoutHash,
      contentHash: hash(changedWithoutHash),
    } as RuntimeNetworkCommand;
    await expect(worker.execute(changed)).rejects.toThrow(
      /replayed with different content/,
    );
    firewall.failApply = false;
    await expect(worker.execute(original)).resolves.toMatchObject({
      status: "installed",
    });
  });

  it("removes rules only after engine-local absence confirmation", async () => {
    const path = join(root, "remove.json");
    const plan = makePlan();
    const state = harness(path);
    await state.worker.execute(command("network.ensure", plan));
    await state.worker.execute(command("network.revoke", plan));
    const removalPlan = makePlan({
      containerIds: [],
      operationId: "cleanup-op",
      controlVersion: 2,
    });
    await expect(
      state.worker.execute(command("network.remove", removalPlan)),
    ).resolves.toMatchObject({ status: "removed", rulesetHash: null });
    expect(state.engine.calls).toContain("assert-absent");
    expect(state.firewall.calls.at(-1)).toBe("remove");
  });

  it("rechecks Engine absence and firewall cleanup for a new remove after removed state", async () => {
    const path = join(root, "remove-retry.json");
    const state = harness(path);
    const plan = makePlan();
    await state.worker.execute(command("network.ensure", plan));
    await state.worker.execute(command("network.revoke", plan));
    const removalPlan = makePlan({
      containerIds: [],
      operationId: "cleanup-op-1",
      controlVersion: 2,
    });
    await state.worker.execute(command("network.remove", removalPlan));
    const retryPlan = makePlan({
      containerIds: [],
      operationId: "cleanup-op-2",
      controlVersion: 3,
    });
    await expect(
      state.worker.execute(command("network.remove", retryPlan)),
    ).resolves.toMatchObject({ status: "removed", rulesetHash: null });
    expect(
      state.engine.calls.filter((call) => call === "assert-absent"),
    ).toHaveLength(2);
    expect(
      state.firewall.calls.filter((call) => call === "remove"),
    ).toHaveLength(2);
  });
});
