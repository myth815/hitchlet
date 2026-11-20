// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputeClientError,
  HitchletClient,
  type AuthenticatedPrincipal,
} from "@hitchlet/sdk";
import { AdminPanel } from "./AdminPanel.js";
import { ManagementConsole } from "./ManagementConsole.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const imageId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const artifactId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const principal: AuthenticatedPrincipal = {
  consumerId: "00000000-0000-4000-8000-000000000005",
  role: "admin",
  scopes: [
    "tickets:read",
    "tickets:write",
    "tickets:revoke",
    "images:read",
    "events:read",
  ],
  source: "session",
};
const roots: Root[] = [];

function successfulFixture() {
  const client = new HitchletClient("https://controller.test", {
    fetch: async () => Response.json([]),
  });
  vi.spyOn(client.admin, "imageVersions").mockResolvedValue([
    {
      id: versionId,
      imageId,
      imageName: "Linux runtime",
      description: "fixture",
      version: "v1",
      status: "validating",
      entityVersion: 7,
      createdAtMs: 1,
      updatedAtMs: 2,
      publishedAtMs: null,
      artifacts: [
        {
          id: artifactId,
          architecture: "amd64",
          digest: `sha256:${"a".repeat(64)}`,
          minimumResources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
        },
      ],
    },
  ]);
  vi.spyOn(client.admin, "machines").mockResolvedValue([]);
  vi.spyOn(client.admin, "nodes").mockResolvedValue([]);
  vi.spyOn(client.admin, "networkProfiles").mockResolvedValue([]);
  vi.spyOn(client.admin, "draftVersion").mockResolvedValue({
    version: {
      id: versionId,
      imageId,
      imageName: "Linux runtime",
      description: "fixture",
      version: "v1",
      status: "validating",
      entityVersion: 7,
      manifest: {},
      createdAtMs: 1,
      updatedAtMs: 2,
    },
    artifacts: [
      {
        id: artifactId,
        provider: "portainer",
        kind: "container",
        architecture: "amd64",
        guestOs: "linux",
        artifactRef: `registry.test/image@sha256:${"a".repeat(64)}`,
        digest: `sha256:${"a".repeat(64)}`,
        minimumResources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
        requirements: {
          bootstrap: {
            mechanism: "cloud-init",
            contractVersion: "1",
            identityReset: true,
          },
          requiredCapabilities: [],
        },
        access: {
          accessProtocols: ["ssh"],
          ports: [22],
          account: "worker",
          allowedSourceCidrs: [],
          discovery: "test",
          readiness: "test",
        },
      },
    ],
  });
  vi.spyOn(client.admin, "validationHistory").mockResolvedValue([
    {
      id: runId,
      imageArtifactId: artifactId,
      nodeId: "00000000-0000-4000-8000-000000000006",
      state: "succeeded",
      testOutcome: "passed",
      cleanupStatus: "complete",
      reportId: runId,
      deadlineMs: 9999,
      finishedAtMs: 2,
      version: 3,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
  ]);
  const publish = vi.spyOn(client.admin, "publish");
  return { client, publish };
}

async function mountPanel(client: HitchletClient, selectExistingRun = true) {
  const element = document.createElement("div");
  const root = createRoot(element);
  roots.push(root);
  await act(async () => {
    root.render(<AdminPanel client={client} principal={principal} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (selectExistingRun) {
    const runPicker = [...element.querySelectorAll("select")].find((select) =>
      select.textContent?.includes(runId.slice(0, 8)),
    );
    await act(async () => {
      if (!runPicker)
        throw new Error("Validation run selector was not rendered");
      runPicker.value = runId;
      runPicker.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  return element;
}

async function clickPublish(element: Element) {
  const button = [...element.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("按当前entityVersion发布"),
  );
  if (!button) throw new Error("Publish control was not rendered");
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  const { act: reactAct } = await import("react");
  await reactAct(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

describe("administrator validation workflow", () => {
  it("keeps publish disabled when a passed test still has blocked cleanup", async () => {
    const client = new HitchletClient("https://controller.test");
    vi.spyOn(client.admin, "imageVersions").mockResolvedValue([
      {
        id: versionId,
        imageId,
        imageName: "Linux runtime",
        description: "fixture",
        version: "v1",
        status: "validating",
        entityVersion: 7,
        createdAtMs: 1,
        updatedAtMs: 2,
        publishedAtMs: null,
        artifacts: [
          {
            id: artifactId,
            architecture: "amd64",
            digest: `sha256:${"a".repeat(64)}`,
            minimumResources: {
              cpuMillis: 1000,
              memoryMiB: 1024,
              scratchMiB: 0,
            },
          },
        ],
      },
    ]);
    vi.spyOn(client.admin, "machines").mockResolvedValue([]);
    vi.spyOn(client.admin, "nodes").mockResolvedValue([]);
    vi.spyOn(client.admin, "networkProfiles").mockResolvedValue([]);
    vi.spyOn(client.admin, "draftVersion").mockResolvedValue({
      version: {
        id: versionId,
        imageId,
        imageName: "Linux runtime",
        description: "fixture",
        version: "v1",
        status: "validating",
        entityVersion: 7,
        manifest: {},
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      artifacts: [
        {
          id: artifactId,
          provider: "portainer",
          kind: "container",
          architecture: "amd64",
          guestOs: "linux",
          artifactRef: `registry.test/image@sha256:${"a".repeat(64)}`,
          digest: `sha256:${"a".repeat(64)}`,
          minimumResources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
          requirements: {
            bootstrap: {
              mechanism: "cloud-init",
              contractVersion: "1",
              identityReset: true,
            },
            requiredCapabilities: [],
          },
          access: {
            accessProtocols: ["ssh"],
            ports: [22],
            account: "worker",
            allowedSourceCidrs: [],
            discovery: "test",
            readiness: "test",
          },
        },
      ],
    });
    vi.spyOn(client.admin, "validationHistory").mockResolvedValue([
      {
        id: runId,
        imageArtifactId: artifactId,
        nodeId: "00000000-0000-4000-8000-000000000006",
        state: "releasing",
        testOutcome: "passed",
        cleanupStatus: "blocked",
        reportId: runId,
        deadlineMs: 9999,
        finishedAtMs: null,
        version: 2,
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ]);
    const element = document.createElement("div");
    const root = createRoot(element);
    roots.push(root);
    await act(async () => {
      root.render(<AdminPanel client={client} principal={principal} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const runPicker = [...element.querySelectorAll("select")].find((select) =>
      select.textContent?.includes(runId.slice(0, 8)),
    );
    await act(async () => {
      if (!runPicker)
        throw new Error("Validation run selector was not rendered");
      runPicker.value = runId;
      runPicker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const publish = [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("按当前entityVersion发布"),
    );
    expect(element.textContent).toContain("test passed");
    expect(element.textContent).toContain("cleanup blocked");
    expect(publish?.disabled).toBe(true);
  });

  it("publishes only the selected cleaned run with the current entity version", async () => {
    const { client, publish } = successfulFixture();
    publish.mockResolvedValue({
      versionId,
      status: "published",
      entityVersion: 8,
    });
    const element = await mountPanel(client);
    await clickPublish(element);
    expect(publish).toHaveBeenCalledWith(
      versionId,
      7,
      expect.any(String),
      expect.any(Function),
    );
    expect(element.textContent).toContain("已发布 version");
  });

  it("refreshes version state and surfaces a publish CAS conflict without retrying", async () => {
    const { ComputeClientError } = await import("@hitchlet/sdk");
    const { client, publish } = successfulFixture();
    publish.mockRejectedValue(
      new ComputeClientError({
        code: "STORAGE_CAS_FAILED",
        message: "entity changed",
        statusCode: 412,
      }),
    );
    const element = await mountPanel(client);
    await clickPublish(element);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(client.admin.imageVersions).toHaveBeenCalledTimes(2);
    expect(element.textContent).toContain("entity changed");
  });

  it("requires a succeeded validation run before enabling publish", async () => {
    const { client, publish } = successfulFixture();
    vi.spyOn(client.admin, "validationHistory").mockResolvedValue([
      {
        id: runId,
        imageArtifactId: artifactId,
        nodeId: "00000000-0000-4000-8000-000000000006",
        state: "failed",
        testOutcome: "passed",
        cleanupStatus: "complete",
        reportId: runId,
        deadlineMs: 9999,
        finishedAtMs: 2,
        version: 3,
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    ]);
    const element = await mountPanel(client);
    const button = [...element.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("按当前entityVersion发布"),
    );
    expect(button?.disabled).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it("starts polling a selected queued receipt after its delayed history arrives", async () => {
    const { client } = successfulFixture();
    const nodeId = "00000000-0000-4000-8000-000000000006";
    const profileId = "00000000-0000-4000-8000-000000000007";
    vi.spyOn(client.admin, "imageVersions")
      .mockResolvedValueOnce([
        {
          id: versionId,
          imageId,
          imageName: "Linux runtime",
          description: "fixture",
          version: "v1",
          status: "draft",
          entityVersion: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
          publishedAtMs: null,
          artifacts: [
            {
              id: artifactId,
              architecture: "amd64",
              digest: `sha256:${"a".repeat(64)}`,
              minimumResources: {
                cpuMillis: 1000,
                memoryMiB: 1024,
                scratchMiB: 0,
              },
            },
          ],
        },
      ])
      .mockResolvedValue([
        {
          id: versionId,
          imageId,
          imageName: "Linux runtime",
          description: "fixture",
          version: "v1",
          status: "validating",
          entityVersion: 2,
          createdAtMs: 1,
          updatedAtMs: 2,
          publishedAtMs: null,
          artifacts: [
            {
              id: artifactId,
              architecture: "amd64",
              digest: `sha256:${"a".repeat(64)}`,
              minimumResources: {
                cpuMillis: 1000,
                memoryMiB: 1024,
                scratchMiB: 0,
              },
            },
          ],
        },
      ]);
    vi.spyOn(client.admin, "nodes").mockResolvedValue([
      {
        id: nodeId,
        machineId: "00000000-0000-4000-8000-000000000008",
        name: "node-a",
        backendKind: "portainer",
        providerConnectionId: "00000000-0000-4000-8000-000000000009",
        runtimeIdentityId: "00000000-0000-4000-8000-000000000010",
        poolId: "00000000-0000-4000-8000-000000000011",
        admission: "enabled",
        observedHealth: "healthy",
        capabilities: {
          verified: true,
          expiresAt: null,
          architectures: ["amd64"],
          guestOs: ["linux"],
          resourceKinds: ["container"],
          supportedAccess: ["ssh"],
        },
        observedAtMs: 3,
        version: 2,
      },
    ]);
    vi.spyOn(client.admin, "networkProfiles").mockResolvedValue([
      {
        id: profileId,
        name: "restricted",
        kind: "network",
        status: "active",
        currentRevisionId: "00000000-0000-4000-8000-000000000012",
        version: 1,
        revision: 1,
        protocol: null,
        config: {
          allowedEgress: [],
          allowedIngressSourceCidrs: [],
          ipv6: "disabled",
        },
        secretVersionRef: null,
        createdAtMs: 1,
      },
    ]);
    let historyCalls = 0;
    let releaseDelayedHistory!: () => void;
    const delayedHistory = new Promise<void>((resolve) => {
      releaseDelayedHistory = resolve;
    });
    const history = vi
      .spyOn(client.admin, "validationHistory")
      .mockImplementation(async () => {
        historyCalls += 1;
        if (historyCalls === 1) return [];
        if (historyCalls <= 3) {
          await delayedHistory;
          return [
            {
              id: runId,
              imageArtifactId: artifactId,
              nodeId,
              state: "queued",
              testOutcome: "pending",
              cleanupStatus: "pending",
              reportId: null,
              deadlineMs: 9999,
              finishedAtMs: null,
              version: historyCalls,
              createdAtMs: 3,
              updatedAtMs: historyCalls,
            },
          ];
        }
        const cleaned = historyCalls >= 4;
        return [
          {
            id: runId,
            imageArtifactId: artifactId,
            nodeId,
            state: cleaned ? "succeeded" : "running",
            testOutcome: cleaned ? "passed" : "pending",
            cleanupStatus: cleaned ? "complete" : "running",
            reportId: cleaned ? runId : null,
            deadlineMs: 9999,
            finishedAtMs: cleaned ? 5 : null,
            version: historyCalls,
            createdAtMs: 3,
            updatedAtMs: historyCalls,
          },
        ];
      });
    const schedule = vi
      .spyOn(client.admin, "scheduleValidation")
      .mockResolvedValue({
        validationId: runId,
        allocationId: null,
        operationId: null,
        state: "queued",
        scheduler: "queued",
        blockReason: null,
        testOutcome: "pending",
        cleanupStatus: "pending",
        deadlineMs: 9999,
      });
    const element = await mountPanel(client, false);
    const scheduleButton = [...element.querySelectorAll("button")].find(
      (item) => item.textContent?.includes("安排验证"),
    );
    expect(scheduleButton?.disabled).toBe(false);
    await act(async () => {
      scheduleButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(schedule).toHaveBeenCalledWith(
      versionId,
      expect.objectContaining({
        imageArtifactId: artifactId,
        nodeId,
        networkProfileId: profileId,
        resources: expect.objectContaining({
          request: { cpuMillis: 1000, memoryMiB: 2048, scratchMiB: 2048 },
          scratchEnforcement: "best_effort",
        }),
      }),
      expect.any(String),
      expect.any(Function),
    );
    expect(element.textContent).toContain(runId);
    expect(element.textContent).toContain("持续读取这次原始 run 的结果");
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    releaseDelayedHistory();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const runPicker = [...element.querySelectorAll("select")].find((select) =>
      select.textContent?.includes(runId.slice(0, 8)),
    );
    expect(runPicker?.value).toBe(runId);
    expect(element.textContent).toContain("succeeded");
    expect(element.textContent).toContain("cleanup complete");
    expect(history).toHaveBeenCalledTimes(4);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("refreshes validation history after an unknown result without resubmitting", async () => {
    const { ComputeClientError } = await import("@hitchlet/sdk");
    const { client } = successfulFixture();
    const nodeId = "00000000-0000-4000-8000-000000000006";
    const profileId = "00000000-0000-4000-8000-000000000007";
    vi.spyOn(client.admin, "imageVersions").mockResolvedValue([
      {
        id: versionId,
        imageId,
        imageName: "Linux runtime",
        description: "fixture",
        version: "v1",
        status: "draft",
        entityVersion: 2,
        createdAtMs: 1,
        updatedAtMs: 2,
        publishedAtMs: null,
        artifacts: [
          {
            id: artifactId,
            architecture: "amd64",
            digest: `sha256:${"a".repeat(64)}`,
            minimumResources: {
              cpuMillis: 1000,
              memoryMiB: 1024,
              scratchMiB: 0,
            },
          },
        ],
      },
    ]);
    vi.spyOn(client.admin, "nodes").mockResolvedValue([
      {
        id: nodeId,
        machineId: "00000000-0000-4000-8000-000000000008",
        name: "node-a",
        backendKind: "portainer",
        providerConnectionId: "00000000-0000-4000-8000-000000000009",
        runtimeIdentityId: "00000000-0000-4000-8000-000000000010",
        poolId: "00000000-0000-4000-8000-000000000011",
        admission: "enabled",
        observedHealth: "healthy",
        capabilities: {
          verified: true,
          expiresAt: null,
          architectures: ["amd64"],
          guestOs: ["linux"],
          resourceKinds: ["container"],
          supportedAccess: ["ssh"],
        },
        observedAtMs: 3,
        version: 2,
      },
    ]);
    vi.spyOn(client.admin, "networkProfiles").mockResolvedValue([
      {
        id: profileId,
        name: "restricted",
        kind: "network",
        status: "active",
        currentRevisionId: "00000000-0000-4000-8000-000000000012",
        version: 1,
        revision: 1,
        protocol: null,
        config: {
          allowedEgress: [],
          allowedIngressSourceCidrs: [],
          ipv6: "disabled",
        },
        secretVersionRef: null,
        createdAtMs: 1,
      },
    ]);
    const history = vi
      .spyOn(client.admin, "validationHistory")
      .mockResolvedValue([]);
    const schedule = vi
      .spyOn(client.admin, "scheduleValidation")
      .mockRejectedValue(
        new ComputeClientError({
          code: "NETWORK_RESULT_UNKNOWN",
          message: "unknown result",
          retryable: true,
        }),
      );
    const element = await mountPanel(client, false);
    const button = [...element.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("安排验证"),
    );
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(2);
    expect(element.textContent).toContain(
      "验证请求结果未知，已刷新validationHistory",
    );
    expect(element.textContent).toContain("不会自动重发或新建验证");
  });
});

function maintenanceMachine(): Awaited<
  ReturnType<HitchletClient["admin"]["machines"]>
>[number] {
  const amounts = { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 1000 };
  return {
    machineId: imageId,
    name: "Synthetic shared machine",
    usageMode: "shared",
    admission: "enabled",
    version: 2,
    hostObservation: {
      state: "fresh",
      humanPresence: "present",
      cpuPercent: 1,
      memoryPercent: 1,
      memoryPressurePercent: 1,
      memoryPressureSource: "linux_memavailable",
      unmanagedActivityHold: null,
      receivedAtMs: 100,
      probeStatus: "partial",
      sessionsComplete: false,
      interactiveSessionCount: 1,
    },
    capacity: amounts,
    systemReserve: amounts,
    humanUsePolicy: {
      blockShutdownForAnyInteractiveSession: true,
      blockShutdownOnUnknownPresence: true,
      maximumObservationAgeSeconds: 30,
      admissionDuringInteraction: "within_reserved_budget",
      humanReserved: amounts,
      systemReserve: amounts,
      attendedMaximum: amounts,
      unattendedMaximum: amounts,
      cpuPressureLimitPercent: 80,
      memoryPressureLimitPercent: 80,
    },
    policySource: "configured",
    physicalUsage: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
    workloadUsage: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
    holds: [],
    dependencyTree: [],
    shutdownDisabledReasons: [],
    canAdmitTenants: true,
    disabledReasons: [],
    nodes: [],
  };
}
async function maintenanceFixture(connected = true) {
  const { client, publish } = successfulFixture(),
    machine = maintenanceMachine();
  // This test exercises real Console -> AdminPanel -> MachinePanel DOM behavior;
  // SDK method doubles supply synthetic snapshots. Request recovery itself has
  // separate real SDK/HTTP tests in Management.test.tsx.
  vi.spyOn(client, "withManagementPreparation").mockReturnValue(client);
  vi.spyOn(client.admin.management, "overview").mockRejectedValue(
    new ComputeClientError({
      code: "storage_unavailable",
      message: "overview 503",
      statusCode: 503,
      requestId: principal.consumerId,
      retryable: true,
    }),
  );
  vi.mocked(client.admin.machines).mockResolvedValue([machine]);
  const preview = vi
    .spyOn(client.admin, "previewHumanUsePolicy")
    .mockResolvedValue({ machine, canApply: true, updateDisabledReasons: [] });
  const save = vi
    .spyOn(client.admin, "updateHumanUsePolicy")
    .mockResolvedValue({
      machineId: machine.machineId,
      version: 3,
      policy: machine.humanUsePolicy!,
    });
  publish.mockResolvedValue({
    versionId,
    status: "published",
    entityVersion: 8,
  });
  const element = document.createElement("div"),
    root = createRoot(element);
  roots.push(root);
  await act(async () => {
    root.render(
      <ManagementConsole
        client={client}
        principal={principal}
        connected={connected}
        onCredentialIssued={() => {}}
      />,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  await maintenanceClick(element, "验证、机器与系统维护");
  return { client, publish, preview, save, element, machine };
}
function maintenanceButton(element: Element, label: string) {
  const b = [...element.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!b) throw new Error(`Missing ${label}`);
  return b;
}
async function maintenanceClick(element: Element, label: string) {
  await act(async () => {
    maintenanceButton(element, label).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function selectMaintenanceRun(element: Element) {
  const select = [...element.querySelectorAll("select")].find((s) =>
    s.textContent?.includes(runId.slice(0, 8)),
  )!;
  await act(async () => {
    select.value = runId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("permits machine policy and image publish when overview alone is 503 and target reads succeed", async () => {
  const f = await maintenanceFixture();
  expect(f.element.textContent).toContain("overview 503");
  await selectMaintenanceRun(f.element);
  expect(maintenanceButton(f.element, "按当前entityVersion发布").disabled).toBe(
    false,
  );
  await maintenanceClick(f.element, "预演策略影响");
  await maintenanceClick(f.element, "保存已预演策略");
  expect(f.preview).toHaveBeenCalledTimes(1);
  expect(f.save).toHaveBeenCalledWith(
    f.machine.machineId,
    { expectedVersion: 2, policy: f.machine.humanUsePolicy },
    expect.any(String),
    expect.any(Function),
  );
  await clickPublish(f.element);
  expect(f.publish).toHaveBeenCalledWith(
    versionId,
    7,
    expect.any(String),
    expect.any(Function),
  );
});

it("retains the actual disconnected state despite successful cached target snapshots", async () => {
  const f = await maintenanceFixture(false);
  await selectMaintenanceRun(f.element);
  expect(f.element.textContent).toContain("控制器连接中断");
  expect(maintenanceButton(f.element, "按当前entityVersion发布").disabled).toBe(
    true,
  );
  await maintenanceClick(f.element, "预演策略影响");
  await clickPublish(f.element);
  expect(f.preview).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

it("stops cached machine writes on its own read failure and resumes after its own successful refresh", async () => {
  const f = await maintenanceFixture();
  await selectMaintenanceRun(f.element);
  await maintenanceClick(f.element, "预演策略影响");
  expect(maintenanceButton(f.element, "保存已预演策略").disabled).toBe(false);
  vi.mocked(f.client.admin.machines).mockRejectedValue(
    new Error("machine read unavailable"),
  );
  await maintenanceClick(f.element, "刷新机器观测与依赖");
  expect(f.element.textContent).toContain("以下为历史依赖数据");
  await maintenanceClick(f.element, "保存已预演策略");
  expect(f.save).not.toHaveBeenCalled();
  // The unrelated image still has its own successful snapshots.
  expect(maintenanceButton(f.element, "按当前entityVersion发布").disabled).toBe(
    false,
  );
  vi.mocked(f.client.admin.machines).mockResolvedValue([f.machine]);
  await maintenanceClick(f.element, "刷新机器观测与依赖");
  await maintenanceClick(f.element, "预演策略影响");
  await maintenanceClick(f.element, "保存已预演策略");
  expect(f.save).toHaveBeenCalledTimes(1);
});

it("does not publish cached image success after its own list read fails, and recovers by reading its target again", async () => {
  const f = await maintenanceFixture();
  await selectMaintenanceRun(f.element);
  expect(maintenanceButton(f.element, "按当前entityVersion发布").disabled).toBe(
    false,
  );
  const versions = await f.client.admin.imageVersions();
  vi.mocked(f.client.admin.imageVersions).mockRejectedValue(
    new Error("image read unavailable"),
  );
  await maintenanceClick(f.element, "刷新管理数据");
  expect(f.element.textContent).toContain("image read unavailable");
  await clickPublish(f.element);
  expect(f.publish).not.toHaveBeenCalled();
  vi.mocked(f.client.admin.imageVersions).mockResolvedValue(versions);
  await maintenanceClick(f.element, "刷新管理数据");
  await selectMaintenanceRun(f.element);
  await clickPublish(f.element);
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it("does not reuse a passed run or artifact when the newly selected target history fails", async () => {
  const f = await maintenanceFixture();
  await selectMaintenanceRun(f.element);
  const versions = await f.client.admin.imageVersions();
  const history = await f.client.admin.validationHistory(versionId);
  vi.mocked(f.client.admin.validationHistory).mockRejectedValue(
    new Error("target history unavailable"),
  );
  vi.mocked(f.client.admin.imageVersions).mockResolvedValue(
    versions.map((v) => ({ ...v, entityVersion: 8 })),
  );
  await maintenanceClick(f.element, "刷新管理数据");
  expect(f.element.textContent).toContain("target history unavailable");
  expect(maintenanceButton(f.element, "按当前entityVersion发布").disabled).toBe(
    true,
  );
  await clickPublish(f.element);
  expect(f.publish).not.toHaveBeenCalled();
  vi.mocked(f.client.admin.validationHistory).mockResolvedValue(history);
  await maintenanceClick(f.element, "刷新管理数据");
  await selectMaintenanceRun(f.element);
  expect(maintenanceButton(f.element, "按当前entityVersion发布").disabled).toBe(
    false,
  );
  await clickPublish(f.element);
  expect(f.publish).toHaveBeenCalledWith(
    versionId,
    8,
    expect.any(String),
    expect.any(Function),
  );
});

it("refreshes the selected published alias normally instead of leaving it unloaded on same-version refresh", async () => {
  const f = await maintenanceFixture();
  const versions = await f.client.admin.imageVersions();
  vi.mocked(f.client.admin.imageVersions).mockResolvedValue(
    versions.map((v) => ({ ...v, status: "published" })),
  );
  const aliases = vi
    .spyOn(f.client.admin, "imageAliases")
    .mockResolvedValue([]);
  await maintenanceClick(f.element, "刷新管理数据");
  expect(maintenanceButton(f.element, "确认更新别名到所选版本").disabled).toBe(
    false,
  );
  expect(aliases).toHaveBeenCalledTimes(1);
  await maintenanceClick(f.element, "刷新管理数据");
  expect(maintenanceButton(f.element, "确认更新别名到所选版本").disabled).toBe(
    false,
  );
  expect(aliases).toHaveBeenCalledTimes(2);
});
