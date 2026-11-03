import type { ExecutionPort, ProvisionPlan } from "./port.js";

import {
  executionEnabled,
  isExecutionMode,
  type ExecutionMode,
  type ExecutionSelection,
} from "./execution-registry.js";
export type {
  ExecutionMode,
  ExecutionSelection,
} from "./execution-registry.js";

/** Selects the adapter from the immutable node configuration frozen into a plan. */
export class ExecutionProviderDispatcher implements ExecutionPort {
  constructor(
    private readonly providers: Readonly<
      Partial<Record<ExecutionMode, ExecutionPort>>
    >,
    private readonly enabledExecutionMode?: ExecutionSelection,
  ) {}

  private provider(plan: ProvisionPlan): ExecutionPort {
    const mode = plan.runtimeConfig?.executionMode;
    if (!isExecutionMode(mode))
      throw new Error("Frozen execution mode is unavailable");
    const provider = this.providers[mode];
    if (!provider)
      throw new Error(`Frozen ${mode} execution provider is unavailable`);
    return provider;
  }

  async resolveMounts(plan: ProvisionPlan) {
    if (plan.executionPhase !== "cleanup" && plan.executionPhase !== "observe")
      this.assertProvisionEnabled(plan);
    const provider = this.provider(plan);
    if (!provider.resolveMounts)
      throw new Error("Frozen provider cannot resolve mounts");
    return provider.resolveMounts(plan);
  }

  create(plan: ProvisionPlan, journal: Parameters<ExecutionPort["create"]>[1]) {
    this.assertProvisionEnabled(plan);
    return this.provider(plan).create(plan, journal);
  }

  inspect(plan: ProvisionPlan) {
    return this.provider(plan).inspect(plan);
  }

  ready(plan: ProvisionPlan, inventory: Parameters<ExecutionPort["ready"]>[1]) {
    this.assertProvisionEnabled(plan);
    return this.provider(plan).ready(plan, inventory);
  }

  revokeStop(plan: ProvisionPlan) {
    return this.provider(plan).revokeStop(plan);
  }

  destroy(
    plan: ProvisionPlan,
    resource: Parameters<ExecutionPort["destroy"]>[1],
  ) {
    return this.provider(plan).destroy(plan, resource);
  }

  private assertProvisionEnabled(plan: ProvisionPlan): void {
    const mode = plan.runtimeConfig?.executionMode;
    if (!isExecutionMode(mode))
      throw new Error("Frozen execution mode is unavailable");
    if (!executionEnabled(this.enabledExecutionMode ?? "disabled", mode))
      throw new Error(`New ${mode} execution is disabled`);
  }
}
