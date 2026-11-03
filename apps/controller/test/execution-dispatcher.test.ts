import {
  configuredExecutionModes,
  environmentContractReason,
} from "../src/providers/execution-registry.js";
import { AcceptedAcquireRequestSchema } from "@hitchlet/contracts";
import { normalizeAcquireRequest } from "../src/domain/admission.js";
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

it("permits new work through both explicitly registered adapters without changing frozen cleanup routing", async () => {
  const docker = provider();
  const tart = provider();
  const dispatcher = new ExecutionProviderDispatcher(
    { portainer: docker.execution, tart: tart.execution },
    configuredExecutionModes("registered"),
  );
  await dispatcher.create(plan("portainer", "provision"), {});
  await dispatcher.create(plan("tart", "provision"), {});
  await dispatcher.destroy(plan("tart", "cleanup"), {} as never);
  expect(docker.calls.create).toHaveBeenCalledOnce();
  expect(tart.calls.create).toHaveBeenCalledOnce();
  expect(tart.calls.destroy).toHaveBeenCalledOnce();
});

it("registers current implementation limits without claiming a Linux Tart bootstrap", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const contract = AcceptedAcquireRequestSchema.parse(
    normalizeAcquireRequest(
      {
        image: { versionId: id },
        kind: "vm",
        networkProfileId: id,
        resources: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 0 },
      },
      {
        resolvedImageVersionId: id,
        authorizedArchitectures: ["arm64"],
        authorizedProviders: ["tart"],
        authorizedSiteIds: [id],
        authorizedMachineIds: [id],
        authorizedNodeIds: [id],
        resourceMaximums: {
          cpuMillis: 4000,
          memoryMiB: 8192,
          scratchMiB: 8192,
        },
        maximumTtlSeconds: 900,
        maximumLifetimeSeconds: 1800,
        queueTimeoutSeconds: 300,
        provisioningTimeoutSeconds: 300,
        defaultExpiryPolicyId: id,
      },
    ),
  );
  expect(environmentContractReason("tart", contract, "macos")).toBeNull();
  expect(environmentContractReason("tart", contract, "linux")).toBe(
    "guest_os_unsupported",
  );
  expect(environmentContractReason("hyperv", contract, "windows")).toBe(
    "environment_kind_unsupported",
  );
  expect(
    environmentContractReason(
      "tart",
      {
        ...contract,
        resources: {
          ...contract.resources,
          request: { ...contract.resources.request, cpuMillis: 1500 },
        },
      },
      "macos",
    ),
  ).toBe("tart_contract_unsupported");
});
