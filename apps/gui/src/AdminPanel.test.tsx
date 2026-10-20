// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HitchletClient, type AuthenticatedPrincipal } from "@hitchlet/sdk";
import { AdminPanel } from "./AdminPanel.js";

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
