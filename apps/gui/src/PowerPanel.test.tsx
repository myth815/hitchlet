// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
import { HitchletClient } from "@hitchlet/sdk";
import { PowerPanel } from "./PowerPanel.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type Configuration = Awaited<
  ReturnType<HitchletClient["admin"]["powerConfiguration"]>
>;
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((r) => r.unmount());
  });
  vi.restoreAllMocks();
});
const machineId = "00000000-0000-4000-8000-000000000001";
function configuration(): Configuration {
  return {
    machineId,
    machineVersion: 2,
    machineEpoch: 1,
    version: 0,
    policy: {
      enabled: false,
      dryRun: true,
      idleSeconds: 1800,
      idleAction: "none",
      wakeOnDemand: false,
      wakeTimeoutSeconds: 300,
      maximumWakeAttempts: 3,
      expectedOffGuardSeconds: 120,
      permitForcedPhysicalPowerOff: false,
      faultRecovery: { mode: "disabled" },
    },
    capabilities: {
      sleep: "unverified",
      normalShutdown: "unverified",
      wakeFromSleep: "unverified",
      coldBoot: "unverified",
      wolWhilePossiblyOn: "unverified",
      wakeRouteRef: null,
      verificationReportIds: [],
    },
    binding: null,
    executionAllowed: false,
    executionDisabledReasons: ["D22b real power remains unavailable"],
    shutdownDisabledReasons: ["Human presence is unknown"],
    activePreviewId: null,
  };
}
async function setup() {
  const client = new HitchletClient("https://controller.test"),
    c = configuration();
  vi.spyOn(client.admin, "powerConfiguration").mockResolvedValue(c);
  vi.spyOn(client.admin, "powerPreviews").mockResolvedValue([]);
  const div = document.createElement("div"),
    root = createRoot(div);
  roots.push(root);
  const render = async (connected = true, canWrite = true) =>
    act(async () =>
      root.render(
        <PowerPanel
          client={client}
          machineId={machineId}
          machineVersion={2}
          connected={connected}
          canWrite={canWrite}
        />,
      ),
    );
  await render();
  await act(async () => {
    const details = div.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  return { client, c, div, render };
}
const button = (div: HTMLElement, text: string) =>
  Array.from(div.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  )!;
async function value(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("power sandbox management", () => {
  it("labels synthetic state, requires policy preview and invalidates it when connection changes", async () => {
    const { client, c, div, render } = await setup();
    const preview = vi
      .spyOn(client.admin, "previewPowerPolicy")
      .mockResolvedValue({ configuration: c, canSave: true });
    expect(div.textContent).toContain("均为虚拟");
    expect(div.textContent).toContain("D22b");
    expect(button(div, "保存电源策略").disabled).toBe(true);
    await act(async () => button(div, "预演电源策略").click());
    expect(preview).toHaveBeenCalledOnce();
    expect(button(div, "保存电源策略").disabled).toBe(false);
    await render(false);
    expect(div.textContent).toContain("连接中断");
    expect(button(div, "保存电源策略").closest("fieldset")!.disabled).toBe(
      true,
    );
    await render(true);
    expect(button(div, "保存电源策略").disabled).toBe(true);
  });
  it("structured binding derives identity metadata and sends only fixed secret-version references", async () => {
    const { client, c, div } = await setup();
    const update = vi
      .spyOn(client.admin, "updateSmartPlugBinding")
      .mockResolvedValue(c);
    for (const [label, text] of [
      ["精确设备 ID", "12345"],
      ["MAC 地址", "AA:BB:CC:DD:EE:FF"],
      ["管理端点引用", "endpoint:test"],
      ["固定秘密版本引用", `secret:${"a".repeat(32)}`],
    ])
      await value(div.querySelector(`input[aria-label="${label}"]`)!, text!);
    await act(async () => button(div, "保存独立插座绑定").click());
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![1]).toMatchObject({
      expectedMachineVersion: 2,
      binding: {
        machineId,
        adapter: "xiaomi_miio_lan",
        dedicatedSupply: "unverified",
        acPowerOn: "unverified",
        verificationReportIds: [],
        credentialVersionRef: `secret:${"a".repeat(32)}`,
      },
    });
    expect(div.querySelector("textarea")).toBeNull();
  });
  it("read-only viewers can inspect but cannot save or start a simulation", async () => {
    const { div, render } = await setup();
    await render(true, false);
    expect(button(div, "开始连续空闲预演").closest("fieldset")!.disabled).toBe(
      true,
    );
    expect(button(div, "刷新电源预演").disabled).toBe(false);
  });
});
