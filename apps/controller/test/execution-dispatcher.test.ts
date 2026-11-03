import { describe, expect, it, vi } from "vitest";
import type { ExecutionPort, ProvisionPlan } from "../src/providers/port.js";
import { ExecutionProviderDispatcher } from "../src/providers/execution-dispatcher.js";

function plan(
  mode: "simulator" | "portainer" | "tart",
  phase?: "provision" | "cleanup",
) {
  return {
    runtimeConfig: { executionMode: mode },
    ...(phase ? { executionPhase: phase } : {}),
  } as ProvisionPlan;
}

function provider() {
  const calls = {
    resolveMounts: vi.fn(async () => []),
    create: vi.fn(async () => []),
    inspect: vi.fn(async () => ({
      presence: "unknown" as const,
      reason: "inventory_incomplete" as const,
    })),
    ready: vi.fn(async () => ({}) as never),
    revokeStop: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  return { calls, execution: calls as unknown as ExecutionPort };
}

describe("ExecutionProviderDispatcher", () => {
  it("routes by the plan's frozen backend and preserves the provider receiver", async () => {
    const docker = provider();
    const tart = provider();
    let tartProvider: ExecutionPort;
    tartProvider = {
      ...tart.calls,
      resolveMounts: async function () {
        if (this !== tartProvider) throw new Error("provider receiver lost");
        return [];
      },
    };
    const dispatcher = new ExecutionProviderDispatcher({
      portainer: docker.execution,
      tart: tartProvider,
    });

    await dispatcher.resolveMounts(plan("tart", "cleanup"));
    await dispatcher.inspect(plan("tart", "cleanup"));
    await dispatcher.inspect(plan("portainer", "cleanup"));

    expect(tart.calls.inspect).toHaveBeenCalledOnce();
    expect(docker.calls.inspect).toHaveBeenCalledOnce();
    expect(docker.calls.resolveMounts).not.toHaveBeenCalled();
  });

  it("keeps Tart cleanup available while rejecting disabled provision work", async () => {
    const docker = provider();
    const tart = provider();
    const dispatcher = new ExecutionProviderDispatcher(
      { portainer: docker.execution, tart: tart.execution },
      "portainer",
    );

    await dispatcher.inspect(plan("tart", "provision"));
    await dispatcher.destroy(plan("tart", "cleanup"), {} as never);
    await expect(
      dispatcher.resolveMounts(plan("tart", "provision")),
    ).rejects.toThrow("New tart execution is disabled");
    expect(() =>
      dispatcher.create(plan("tart", "provision"), {} as never),
    ).toThrow("New tart execution is disabled");
    expect(() =>
      dispatcher.ready(plan("tart", "provision"), {} as never),
    ).toThrow("New tart execution is disabled");

    expect(tart.calls.inspect).toHaveBeenCalledOnce();
    expect(tart.calls.destroy).toHaveBeenCalledOnce();
    expect(tart.calls.create).not.toHaveBeenCalled();
    expect(tart.calls.ready).not.toHaveBeenCalled();
  });

  it("keeps the explicitly enabled Docker backend on its existing path", async () => {
    const docker = provider();
    const dispatcher = new ExecutionProviderDispatcher(
      { portainer: docker.execution },
      "portainer",
    );

    await dispatcher.create(plan("portainer", "provision"), {});

    expect(docker.calls.create).toHaveBeenCalledOnce();
  });

  it("fails closed when the frozen backend adapter is unavailable", async () => {
    const docker = provider();
    const dispatcher = new ExecutionProviderDispatcher(
      { portainer: docker.execution },
      "portainer",
    );

    expect(() => dispatcher.inspect(plan("tart", "cleanup"))).toThrow(
      "Frozen tart execution provider is unavailable",
    );
    expect(docker.calls.inspect).not.toHaveBeenCalled();
  });
});
