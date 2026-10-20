// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
import { HitchletClient } from "@hitchlet/sdk";
import { MachinePanel } from "./MachinePanel.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type Machine = Awaited<ReturnType<HitchletClient["admin"]["machines"]>>[number];
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  vi.restoreAllMocks();
});
const amounts = (n: number) => ({ cpuMillis: n, memoryMiB: n, scratchMiB: n });
function machine(): Machine {
  return {
    machineId: "00000000-0000-4000-8000-000000000001",
    name: "Shared desktop",
    usageMode: "shared",
    admission: "enabled",
    version: 2,
    hostObservation: {
      state: "fresh",
      humanPresence: "present",
      cpuPercent: 1,
      memoryPercent: 2,
      unmanagedActivityHold: null,
      receivedAtMs: 100,
      probeStatus: "partial",
      sessionsComplete: false,
      interactiveSessionCount: 1,
    },
    capacity: amounts(1000),
    systemReserve: amounts(200),
    humanUsePolicy: {
      blockShutdownForAnyInteractiveSession: true,
      blockShutdownOnUnknownPresence: true,
      maximumObservationAgeSeconds: 30,
      admissionDuringInteraction: "within_reserved_budget",
      humanReserved: amounts(100),
      systemReserve: amounts(200),
      attendedMaximum: amounts(400),
      unattendedMaximum: amounts(800),
      cpuPressureLimitPercent: 80,
      memoryPressureLimitPercent: 80,
    },
    policySource: "configured",
    physicalUsage: amounts(0),
    workloadUsage: amounts(0),
    holds: [],
    dependencyTree: [],
    shutdownDisabledReasons: [
      "Human presence is present",
      "Unmanaged activity is unknown or held",
    ],
    canAdmitTenants: true,
    disabledReasons: [],
    nodes: [],
  };
}
async function render(current = machine(), canWrite = true) {
  const client = new HitchletClient("https://controller.test"),
    onRefresh = vi.fn(async () => {}),
    element = document.createElement("div"),
    root = createRoot(element);
  roots.push(root);
  const show = async (next = current, write = canWrite, connected = true) => {
    await act(async () => {
      root.render(
        <MachinePanel
          client={client}
          machines={[next]}
          canWrite={write}
          connected={connected}
          onRefresh={onRefresh}
        />,
      );
    });
  };
  await show();
  return { client, onRefresh, element, show };
}
function button(element: Element, text: string) {
  const found = [...element.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(text);
  return found;
}
async function click(element: Element, text: string) {
  await act(async () => {
    button(element, text).click();
  });
}
async function enter(element: Element, label: string, value: string) {
  await act(async () => {
    const field = element.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
describe("Machine policy editing", () => {
  it("previews edited budgets, saves exact version/policy once, and preserves zero values", async () => {
    const current = machine(),
      f = await render(current);
    const preview = vi
      .spyOn(f.client.admin, "previewHumanUsePolicy")
      .mockResolvedValue({
        machine: current,
        canApply: true,
        updateDisabledReasons: [],
      });
    const save = vi
      .spyOn(f.client.admin, "updateHumanUsePolicy")
      .mockResolvedValue({
        machineId: current.machineId,
        version: 3,
        policy: current.humanUsePolicy!,
      });
    await enter(f.element, "humanReserved cpuMillis", "0");
    expect(button(f.element, "保存已预演策略").disabled).toBe(true);
    await click(f.element, "预演策略影响");
    expect(preview.mock.calls[0]![1].policy.humanReserved.cpuMillis).toBe(0);
    await click(f.element, "保存已预演策略");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toMatchObject({
      expectedVersion: 2,
      policy: { humanReserved: { cpuMillis: 0 } },
    });
    expect(f.onRefresh).toHaveBeenCalledTimes(1);
  });
  it("preserves a readable budget preview across normal heartbeat refreshes and saves after reading", async () => {
    const current = machine(),
      f = await render(current);
    vi.spyOn(f.client.admin, "previewHumanUsePolicy").mockResolvedValue({
      machine: current,
      canApply: true,
      updateDisabledReasons: [],
    });
    const save = vi
      .spyOn(f.client.admin, "updateHumanUsePolicy")
      .mockResolvedValue({
        machineId: current.machineId,
        version: 3,
        policy: current.humanUsePolicy!,
      });
    await enter(f.element, "attendedMaximum cpuMillis", "123");
    await click(f.element, "预演策略影响");
    expect(button(f.element, "保存已预演策略").disabled).toBe(false);
    await f.show({
      ...current,
      hostObservation: {
        ...current.hostObservation,
        receivedAtMs: 200,
        cpuPercent: 3,
      },
    });
    expect(button(f.element, "保存已预演策略").disabled).toBe(false);
    expect(f.element.textContent).toContain("宿主观测已更新");
    expect(
      f.element.querySelector<HTMLInputElement>(
        'input[aria-label="attendedMaximum cpuMillis"]',
      )!.value,
    ).toBe("123");
    await click(f.element, "保存已预演策略");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toMatchObject({
      expectedVersion: 2,
      policy: { attendedMaximum: { cpuMillis: 123 } },
    });
  });
  it("invalidates budget previews when occupied capacity or editing permissions change", async () => {
    const current = machine(),
      f = await render(current);
    vi.spyOn(f.client.admin, "previewHumanUsePolicy").mockResolvedValue({
      machine: current,
      canApply: true,
      updateDisabledReasons: [],
    });
    await click(f.element, "预演策略影响");
    await f.show({ ...current, physicalUsage: amounts(100) });
    expect(button(f.element, "保存已预演策略").disabled).toBe(true);
    await f.show(current);
    await click(f.element, "预演策略影响");
    expect(button(f.element, "保存已预演策略").disabled).toBe(false);
    await f.show(current, false);
    expect(f.element.querySelector("fieldset")!.disabled).toBe(true);
    expect(f.element.textContent).toContain("当前权限只允许查看");
  });
  it("marks disconnected state historical and prevents saving a cached permit", async () => {
    const current = machine(),
      f = await render(current);
    await f.show(current, true, false);
    expect(f.element.textContent).toContain("控制器连接中断");
    expect(f.element.textContent).not.toContain("当前权限只允许查看");
    expect(f.element.textContent).toContain("当前未知");
    expect(f.element.querySelector("fieldset")!.disabled).toBe(true);
  });
  it("renders unavailable Host assurance without suggesting complete observations", async () => {
    const current = machine();
    current.hostObservation = {
      ...current.hostObservation,
      state: "stale",
      humanPresence: "unknown",
    };
    current.canAdmitTenants = false;
    current.nodes = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "Docker",
        version: 1,
        admission: "enabled",
        observedHealth: "healthy",
        poolId: "00000000-0000-4000-8000-000000000003",
        parentAllocationId: null,
        dependencies: [],
        admissionMode: "observed_host",
        canAdmit: false,
        disabledReasons: ["Host observation is stale"],
        available: amounts(0),
        admissionAssurance: "unavailable_host",
        limitations: [],
      },
    ];
    const f = await render(current);
    expect(f.element.textContent).toContain("宿主观测证据不可用或不足");
    expect(f.element.textContent).not.toContain("完整可信宿主观测");
  });
});
