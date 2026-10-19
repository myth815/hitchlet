import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import {
  canonicalRuntimeNetworkValue,
  runtimeNetworkRulesMaterial,
  type RuntimeNetworkCommand,
  type RuntimeNetworkResult,
} from "@hitchlet/contracts/internal";
import { FileJournal } from "./journal.js";
import { LocalEngine } from "./engine.js";
import type { Firewall } from "./firewall.js";

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalRuntimeNetworkValue(value)).digest("hex")}`;
export type WorkerConfig = Readonly<{
  installationId: string;
  runtimeIdentityId: string;
  agentId: string;
}>;

export class NetworkWorker {
  constructor(
    private readonly config: WorkerConfig,
    private readonly journal: FileJournal,
    private readonly engine: LocalEngine,
    private readonly firewall: Firewall,
  ) {}

  execute(command: RuntimeNetworkCommand): Promise<RuntimeNetworkResult> {
    return this.journal.serialize(() => this.run(command));
  }

  private async run(
    command: RuntimeNetworkCommand,
  ): Promise<RuntimeNetworkResult> {
    const plan = command.plan;
    if (digest(without(command, "contentHash")) !== command.contentHash)
      throw new Error("Command content hash mismatch");
    if (
      command.installationId !== this.config.installationId ||
      plan.installationId !== this.config.installationId ||
      command.runtimeIdentityId !== this.config.runtimeIdentityId ||
      plan.runtimeIdentityId !== this.config.runtimeIdentityId ||
      command.agentId !== this.config.agentId ||
      command.operationId !== plan.operationId ||
      command.allocationId !== plan.allocationId ||
      command.generation !== plan.generation ||
      command.controlVersion !== plan.controlVersion
    ) {
      throw new Error("Command identity does not match its network plan");
    }
    if (digest(runtimeNetworkRulesMaterial(plan)) !== plan.expectedRulesetHash)
      throw new Error("Expected ruleset hash mismatch");
    assertIPv4Policy(plan);
    if (command.controllerEpoch < this.journal.epoch)
      throw new Error("Stale controller epoch");
    if (command.controllerEpoch > this.journal.epoch) {
      this.journal.setEpoch(command.controllerEpoch);
      await this.journal.save();
    }
    const prior = this.journal.commandMap[command.commandId];
    if (prior) {
      if (prior.hash !== command.contentHash)
        throw new Error("Command id was replayed with different content");
      if (prior.result) return prior.result;
    }
    if (Date.parse(command.deadline) <= Date.now())
      throw new Error("Command deadline expired");
    const allocation = this.journal.allocationMap[plan.allocationId];
    if (
      allocation &&
      (plan.generation < allocation.generation ||
        (plan.generation === allocation.generation &&
          plan.controlVersion < allocation.controlVersion))
    ) {
      throw new Error("Stale allocation generation or control version");
    }
    this.journal.setCommand(command.commandId, {
      hash: command.contentHash,
    });
    await this.journal.save();
    let resultStatus: RuntimeNetworkResult["status"];
    let rulesetHash: string | null = null;
    if (command.kind === "network.ensure") {
      await this.engine.assertEngine();
      if (
        allocation &&
        allocation.generation === plan.generation &&
        allocation.state !== "active"
      )
        throw new Error("Revoked allocation generation cannot be re-enabled");
      if (
        allocation &&
        plan.generation > allocation.generation &&
        allocation.state !== "removed"
      )
        throw new Error("Previous allocation generation has not been removed");
      const local = await this.engine.inspectAllocation(plan, {
        enforceIPv6: true,
        enforceBridgeNetfilter: true,
      });
      rulesetHash = await this.firewall.apply(
        plan,
        local.bridge,
        local.gateway,
      );
      resultStatus = "installed";
      this.journal.setAllocation(plan.allocationId, {
        generation: plan.generation,
        controlVersion: plan.controlVersion,
        state: "active",
        rulesetHash,
      });
    } else if (command.kind === "network.inspect") {
      try {
        await this.engine.assertEngine();
        const local = await this.engine.inspectAllocation(plan);
        rulesetHash = await this.firewall.inspect(
          plan,
          local.bridge,
          local.gateway,
        );
        resultStatus = rulesetHash ? "present" : "unknown";
      } catch {
        resultStatus = "unknown";
      }
    } else if (command.kind === "network.revoke") {
      await this.engine.assertEngine();
      this.journal.setAllocation(plan.allocationId, {
        generation: plan.generation,
        controlVersion: Math.max(
          plan.controlVersion,
          allocation?.controlVersion ?? 0,
        ),
        state: "revoked",
        rulesetHash: plan.expectedRulesetHash,
      });
      await this.journal.save(); // Durable tombstone precedes firewall side effects and blocks late ensure after restart.
      const local = await this.engine.inspectAllocation(plan, {
        enforceIPv6: true,
        enforceBridgeNetfilter: true,
      });
      rulesetHash = await this.firewall.revoke(
        plan,
        local.bridge,
        local.gateway,
      );
      resultStatus = "revoked";
    } else {
      await this.engine.assertEngine();
      if (
        !allocation ||
        allocation.generation !== plan.generation ||
        (allocation.state !== "revoked" && allocation.state !== "removed")
      )
        throw new Error("remove requires a durable revoke tombstone");
      await this.engine.assertAllocationAbsent(plan);
      await this.firewall.remove(
        plan,
        plan.bridgeInterface,
        plan.bridgeGateway,
      );
      this.journal.setAllocation(plan.allocationId, {
        generation: plan.generation,
        controlVersion: Math.max(
          plan.controlVersion,
          allocation.controlVersion,
        ),
        state: "removed",
        rulesetHash: null,
      });
      resultStatus = "removed";
    }
    const value: RuntimeNetworkResult = {
      commandId: command.commandId,
      operationId: command.operationId,
      allocationId: command.allocationId,
      generation: command.generation,
      nativeEngineId: resultStatus === "unknown" ? null : plan.nativeEngineId,
      status: resultStatus,
      rulesetHash,
      verifiedAt: new Date().toISOString(),
    };
    if (resultStatus !== "unknown") {
      this.journal.setCommand(command.commandId, {
        hash: command.contentHash,
        result: value,
      });
      await this.journal.save();
    } else {
      this.journal.removeCommand(command.commandId);
      await this.journal.save();
    }
    return value;
  }
}

function without<T extends Record<string, unknown>, K extends string>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function assertIPv4Policy(plan: RuntimeNetworkCommand["plan"]): void {
  const values = [
    plan.networkSubnet,
    ...plan.ingressSourceCidrs,
    ...plan.egress.map((entry) => entry.cidr),
    ...plan.managementDeny.map((entry) => entry.cidr),
  ];
  for (const value of values) {
    const [address, prefix, extra] = value.split("/");
    if (
      extra !== undefined ||
      !address ||
      !isIPv4(address) ||
      (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > 32))
    ) {
      throw new Error(
        "IPv6 or malformed CIDR requires a separately verified policy backend",
      );
    }
  }
  if (!isIPv4(plan.bridgeGateway))
    throw new Error(
      "Allocation bridge gateway must be IPv4 while IPv6 is disabled",
    );
}
