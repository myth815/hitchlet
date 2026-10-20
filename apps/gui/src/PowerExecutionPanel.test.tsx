// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
import { HitchletClient } from "@hitchlet/sdk";
import { PowerExecutionPanel } from "./PowerExecutionPanel.js";
type View = Awaited<ReturnType<HitchletClient["admin"]["powerExecutions"]>>;
type Execution = View["executions"][number];
const machineId = "00000000-0000-4000-8000-000000000001",
  cycleId = "00000000-0000-4000-8000-000000000002";
function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: cycleId,
    machineId,
    agentId: "00000000-0000-4000-8000-000000000003",
    version: 1,
    qualification: false,
    bindingHash: "fixture",
    guardHash: "a".repeat(64),
    executorHash: "b".repeat(64),
    phase: "idle",
    machineEpoch: 1,
    controllerEpoch: 1,
    machineVersion: 1,
    bootId: "00000000-0000-4000-8000-000000000004",
    conditionKey: "fixture",
    idleSinceMs: 1000,
    lastEvaluationAtMs: 1000,
    token: null,
    tokenExpiresAtMs: null,
    cancelRequestedAtMs: null,
    resumeWakeOnDemand: false,
    acceptedAtMs: null,
    acceptedReceiptId: null,
    observedPower: "unknown",
    onlineWolAtMs: null,
    recoveredBootId: null,
    wakeAttempts: 0,
    nextWakeAtMs: null,
    deadlineMs: null,
    reasons: [],
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}
function view(executions: Execution[]): View {
  return {
    configured: true,
    enabled: true,
    automatic: false,
    verified: true,
    reasons: [],
    executions,
  };
}
async function withAction(
  client: HitchletClient,
  action: "cancel" | "wake",
  check: (button: HTMLButtonElement, div: HTMLDivElement) => Promise<void>,
) {
  const div = document.createElement("div"),
    root = createRoot(div);
  try {
    await act(async () =>
      root.render(
        <PowerExecutionPanel
          client={client}
          machineId={machineId}
          connected
          canWrite
        />,
      ),
    );
    await act(async () => {
      const details = div.querySelector("details")!;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    const button = Array.from(div.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(
        action === "cancel" ? "取消闭环" : "请求有界 WOL",
      ),
    )!;
    expect(button.disabled).toBe(false);
    await check(button, div);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
}
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("clearly separates actual qualification from dry-run and disables writes on disconnect", async () => {
  const client = new HitchletClient("https://controller.test"),
    view = {
      configured: true,
      enabled: true,
      automatic: false,
      verified: false,
      reasons: ["Live guard remains mandatory"],
      executions: [],
    };
  vi.spyOn(client.admin, "powerExecutions").mockResolvedValue(view);
  const start = vi
      .spyOn(client.admin, "startPowerExecution")
      .mockRejectedValue(new Error("native guard blocked")),
    div = document.createElement("div"),
    root = createRoot(div);
  try {
    await act(async () =>
      root.render(
        <PowerExecutionPanel
          client={client}
          machineId="00000000-0000-4000-8000-000000000001"
          connected
          canWrite
        />,
      ),
    );
    await act(async () => {
      const d = div.querySelector("details")!;
      d.open = true;
      d.dispatchEvent(new Event("toggle"));
    });
    expect(div.textContent).toContain("执行真实电源动作");
    const button = Array.from(div.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("资格运行"),
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(start).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", {
      qualification: true,
    });
    expect(div.textContent).toContain("native guard blocked");
    await act(async () =>
      root.render(
        <PowerExecutionPanel
          client={client}
          machineId="00000000-0000-4000-8000-000000000001"
          connected={false}
          canWrite
        />,
      ),
    );
    expect(
      Array.from(div.querySelectorAll("button")).every((b) => b.disabled),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
});

it.each(["cancel", "wake"] as const)(
  "reads a fresh target cycle before one %s write and uses its latest CAS version",
  async (action) => {
    const client = new HitchletClient("https://controller.test"),
      stale = execution({ phase: action === "wake" ? "off_expected" : "idle" }),
      latest = execution({ ...stale, version: 18 }),
      fresh = view([
        execution({ id: "00000000-0000-4000-8000-000000000005", version: 99 }),
        latest,
      ]);
    let resolve!: (value: View) => void;
    const pending = new Promise<View>((r) => {
      resolve = r;
    });
    const read = vi
      .spyOn(client.admin, "powerExecutions")
      .mockResolvedValueOnce(view([stale]))
      .mockReturnValueOnce(pending)
      .mockResolvedValue(fresh);
    const command = vi
      .spyOn(client.admin, "commandPowerExecution")
      .mockResolvedValue(latest);
    await withAction(client, action, async (button) => {
      await act(async () => button.click());
      expect(read).toHaveBeenCalledTimes(2);
      expect(command).not.toHaveBeenCalled();
      expect(button.disabled).toBe(true);
      await act(async () => resolve(fresh));
      expect(command).toHaveBeenCalledExactlyOnceWith(machineId, cycleId, {
        expectedVersion: 18,
        action,
        ...(action === "wake"
          ? { provisionDeadlineMs: expect.any(Number) }
          : {}),
      });
    });
  },
);

it.each(["cancel", "wake"] as const)(
  "does not send %s when the action-time read fails",
  async (action) => {
    const client = new HitchletClient("https://controller.test");
    vi.spyOn(client.admin, "powerExecutions")
      .mockResolvedValueOnce(
        view([
          execution({ phase: action === "wake" ? "off_expected" : "idle" }),
        ]),
      )
      .mockRejectedValueOnce(new Error("fresh power read failed"));
    const command = vi.spyOn(client.admin, "commandPowerExecution");
    await withAction(client, action, async (button, div) => {
      await act(async () => button.click());
      expect(command).not.toHaveBeenCalled();
      expect(div.textContent).toContain("fresh power read failed");
    });
  },
);

it.each([
  ["cancel", "ready"],
  ["cancel", "cancelled"],
  ["cancel", "manual"],
  ["wake", "ready"],
  ["wake", "shutdown_requested"],
] as const)(
  "does not send %s after the target moves to %s",
  async (action, phase) => {
    const client = new HitchletClient("https://controller.test"),
      stale = execution({ phase: action === "wake" ? "off_expected" : "idle" });
    vi.spyOn(client.admin, "powerExecutions")
      .mockResolvedValueOnce(view([stale]))
      .mockResolvedValueOnce(view([execution({ phase, version: 19 })]));
    const command = vi.spyOn(client.admin, "commandPowerExecution");
    await withAction(client, action, async (button, div) => {
      await act(async () => button.click());
      expect(command).not.toHaveBeenCalled();
      expect(div.textContent).toContain("未发送请求");
    });
  },
);

it("does not redirect an action to another cycle when its original target disappeared", async () => {
  const client = new HitchletClient("https://controller.test");
  vi.spyOn(client.admin, "powerExecutions")
    .mockResolvedValueOnce(view([execution()]))
    .mockResolvedValueOnce(
      view([execution({ id: "00000000-0000-4000-8000-000000000005" })]),
    );
  const command = vi.spyOn(client.admin, "commandPowerExecution");
  await withAction(client, "cancel", async (button) => {
    await act(async () => button.click());
    expect(command).not.toHaveBeenCalled();
  });
});

it("leaves a conflict from the one fresh CAS write to management recovery without automatically resending", async () => {
  const client = new HitchletClient("https://controller.test");
  const read = vi
    .spyOn(client.admin, "powerExecutions")
    .mockResolvedValueOnce(view([execution()]))
    .mockResolvedValue(view([execution({ version: 18 })]));
  const command = vi
    .spyOn(client.admin, "commandPowerExecution")
    .mockRejectedValue(new Error("conflict requires management recovery"));
  await withAction(client, "cancel", async (button, div) => {
    await act(async () => button.click());
    expect(read).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledExactlyOnceWith(machineId, cycleId, {
      expectedVersion: 18,
      action: "cancel",
    });
    expect(div.textContent).toContain("conflict requires management recovery");
  });
});
