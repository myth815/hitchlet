import { ProfileRevocation } from "./ProfileRevocation.js";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HitchletClient, type AuthenticatedPrincipal } from "@hitchlet/sdk";
import { AuthorizedAcquire } from "./AuthorizedAcquire.js";
import { ManagementConsole } from "./ManagementConsole.js";
import { InventorySetup } from "./InventorySetup.js";
import { Observation, useManagementRead } from "./ManagementUI.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const id = "00000000-0000-4000-8000-000000000001",
  version = "00000000-0000-4000-8000-000000000002",
  network = "00000000-0000-4000-8000-000000000003";
const quota = {
  maxQueuedTickets: 10,
  maxActiveTickets: 1,
  maxLeaseTtlSeconds: 900,
  maxLifetimeSeconds: 3600,
  maxResources: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 4096 },
  defaultExpiryPolicyId: id,
};
const consumer = {
  id,
  name: "Scoped consumer",
  kind: "service",
  role: "consumer",
  status: "active",
  authorization: {
    imageIds: "all",
    nodeIds: "all",
    networkProfileIds: "all",
    storageProfileIds: [],
  },
  quota,
  version: 1,
  updatedAtMs: 1,
};
const catalog = {
  observedAtMs: 1,
  quota,
  versions: [
    {
      id: version,
      imageId: version,
      imageName: "Node workspace",
      version: "v1",
      kind: "container",
      architectures: ["arm64"],
      platforms: [
        {
          architecture: "arm64",
          artifactId: id,
          digest: `sha256:${"a".repeat(64)}`,
          minimumResources: { cpuMillis: 500, memoryMiB: 512, scratchMiB: 0 },
        },
      ],
    },
  ],
  networks: [
    {
      id: network,
      name: "Safe private network",
      revisionId: network,
      revision: 2,
    },
  ],
  nodes: [],
  storage: [],
};
const principal: AuthenticatedPrincipal = {
  consumerId: id,
  role: "admin",
  source: "session",
  scopes: [
    "tickets:read",
    "tickets:write",
    "tickets:revoke",
    "images:read",
    "events:read",
  ],
};
const roots: Root[] = [];
async function mount(node: React.ReactNode) {
  const element = document.createElement("div"),
    root = createRoot(element);
  roots.push(root);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { element, root };
}
async function click(element: Element, label: string) {
  const button = [...element.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function change(
  input: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const proto =
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("D24 structured GUI and recovery", () => {
  it("loads the M0 empty real-connection directory through SDK inventory and keeps disabled-resource registration usable", async () => {
    const reads: string[] = [],
      writes: { path: string; body: unknown }[] = [];
    const client = new HitchletClient("https://m0.test", {
      auth: { kind: "cookie", csrfToken: "csrf" },
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === "POST") {
          writes.push({ path, body: JSON.parse(String(init.body)) });
          return Response.json(
            {
              id,
              poolId: id,
              admission: "disabled",
              observedPower: "unknown",
              offline: false,
              powerEnabled: false,
              capacity: { cpuMillis: 1000, memoryMiB: 2048, scratchMiB: 4096 },
            },
            { status: 201 },
          );
        }
        reads.push(path);
        if (path === "/v1/admin/installation")
          return Response.json({
            installationId: id,
            controllerEpoch: 1,
            platformNetworkDeny: {
              revisionId: id,
              revision: 1,
              managementDenyRules: [],
              reason: "explicit simulator seed",
            },
          });
        return Response.json([]);
      },
    });
    const { element } = await mount(
      <InventorySetup
        client={client}
        principal={principal}
        disabled={false}
        action={async (_label, work) => {
          await work("m0-register");
          return true;
        }}
      />,
    );
    expect(reads).toContain("/v1/provider-connections");
    expect(element.textContent).toContain("不列为真实 Portainer");
    expect(element.textContent).not.toContain("历史观测");
    const form = [...element.querySelectorAll("form")].find((f) =>
      f.textContent?.includes("登记物理 Machine"),
    )!;
    expect(
      (form.querySelector("fieldset") as HTMLFieldSetElement).disabled,
    ).toBe(false);
    await change(form.querySelector("input")!, "M0 disabled machine");
    await submit(form);
    expect(writes).toEqual([
      {
        path: "/v1/machines",
        body: {
          name: "M0 disabled machine",
          hostOs: "linux",
          architecture: "amd64",
          capacity: { cpuMillis: 1000, memoryMiB: 2048, scratchMiB: 4096 },
        },
      },
    ]);
  });
  it("chooses authorized version/network by name, previews with SDK and submits the immutable selection", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const client = new HitchletClient("https://controller.test", {
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/catalog") return Response.json(catalog);
          calls.push({ path, body: JSON.parse(String(init?.body)) });
          return Response.json({
            observedAtMs: 2,
            capacityGuaranteed: false,
            eligibleNodeIds: [],
            reasons: ["No capacity reserved"],
          });
        },
      }),
      acquire = vi.fn();
    const { element } = await mount(
      <AuthorizedAcquire
        client={client}
        canOperate
        busy={false}
        blocked={false}
        onAcquire={acquire}
      />,
    );
    expect(element.textContent).toContain("Safe private network");
    expect(element.textContent).toContain("Node workspace / v1");
    expect(
      element.querySelector('input[placeholder="粘贴已授权的 versionId"]'),
    ).toBeNull();
    await click(element, "可行性预检");
    await submit(element.querySelector("form")!);
    expect(calls[0]!.path).toBe("/v1/catalog/preview");
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        image: { versionId: version },
        networkProfileId: network,
        resources: expect.objectContaining({
          isolation: "shared_kernel",
          scratchEnforcement: "best_effort",
        }),
      }),
    );
  });
  it("keeps viewer writes disabled while directory reads remain usable", async () => {
    const client = new HitchletClient("https://controller.test", {
        fetch: async () => Response.json(catalog),
      }),
      acquire = vi.fn();
    const { element } = await mount(
      <AuthorizedAcquire
        client={client}
        canOperate={false}
        busy={false}
        blocked={false}
        onAcquire={acquire}
      />,
    );
    expect(element.querySelector("fieldset")!.disabled).toBe(true);
    expect(element.textContent).toContain("当前身份没有 Ticket 写权限");
  });
  it("retains an unknown original body/key across refresh, permits unrelated maintenance and restores under StrictMode", async () => {
    const writes: { key: string | null; body: unknown }[] = [];
    let lose = true;
    const client = new HitchletClient("https://controller.test", {
      auth: { kind: "cookie", csrfToken: "csrf" },
      fetch: async (input, init) => {
        const url = new URL(String(input)),
          path = url.pathname;
        if (path === "/v1/admin/overview")
          return Response.json({
            observedAtMs: 1,
            phases: {},
            cleanupBlocked: 0,
            unknownOperations: 0,
            machines: [],
            initialization: {
              connections: 0,
              machines: 0,
              nodes: 0,
              publishedVersions: 0,
            },
          });
        if (path === "/v1/admin/consumers" && init?.method !== "POST")
          return Response.json([consumer]);
        if (path === "/v1/admin/policies" && init?.method !== "POST")
          return Response.json([
            { id, name: "Destroy policy", version: 1, updatedAtMs: 1 },
          ]);
        if (path === `/v1/admin/consumers/${id}`) {
          writes.push({
            key: new Headers(init?.headers).get("Idempotency-Key"),
            body: JSON.parse(String(init?.body)),
          });
          if (lose) {
            lose = false;
            throw new TypeError("lost response after server mutation");
          }
          return Response.json({ ...consumer, version: 2 });
        }
        if (path === "/v1/admin/policies")
          return Response.json({
            id,
            name: "New destroy policy",
            version: 1,
            updatedAtMs: 2,
          });
        return Response.json([]);
      },
    });
    const render = () => (
      <React.StrictMode>
        <ManagementConsole
          client={client}
          principal={principal}
          onCredentialIssued={() => {}}
        />
      </React.StrictMode>
    );
    const first = await mount(render());
    await click(first.element, "消费者与配额");
    await change(first.element.querySelector("select")!, id);
    await submit(first.element.querySelector("form")!);
    expect(first.element.textContent).toContain("结果未知");
    expect(writes).toHaveLength(1);
    const saved = JSON.parse(
      sessionStorage.getItem(`hitchlet.management.requests.${id}`)!,
    );
    expect(saved[0].idempotencyKey).toBe(writes[0]!.key);
    expect(
      JSON.parse(
        sessionStorage.getItem(`hitchlet.management.pending.${id}`)!,
      )[0].path,
    ).toBe(`PUT /v1/admin/consumers/${id}`);
    const policyForm = first.element.querySelectorAll("form")[1]!;
    await change(policyForm.querySelector("input")!, "New destroy policy");
    await submit(policyForm);
    expect(first.element.textContent).toContain("请求已由服务端确认");
    expect(
      sessionStorage.getItem(`hitchlet.management.requests.${id}`),
    ).toContain(writes[0]!.key!);
    await act(async () => first.root.unmount());
    roots.splice(roots.indexOf(first.root), 1);
    const second = await mount(render());
    await click(second.element, "按保存的原请求恢复");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(second.element.textContent).toContain("已按原方法");
    expect(sessionStorage.getItem(`hitchlet.management.requests.${id}`)).toBe(
      "[]",
    );
  });
  it("investigates a refreshed old pending command from its saved request even when 100 newer receipts omit it", async () => {
    const key = "old-unlisted",
      path = "POST /v1/admin/policies",
      calls: { path: string; method: string; body: unknown }[] = [];
    sessionStorage.setItem(
      `hitchlet.management.pending.${id}`,
      JSON.stringify([{ key, label: "Old policy", page: "consumers" }]),
    );
    sessionStorage.setItem(
      `hitchlet.management.requests.${id}`,
      JSON.stringify([
        {
          kind: "management",
          idempotencyKey: key,
          method: "POST",
          path: "/v1/admin/policies",
          body: { name: "Original policy" },
        },
      ]),
    );
    const client = new HitchletClient("https://controller.test", {
      auth: { kind: "cookie", csrfToken: "csrf" },
      fetch: async (input, init) => {
        const route = new URL(String(input)).pathname;
        calls.push({
          path: route,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (route === "/v1/admin/overview")
          return Response.json({
            observedAtMs: 1,
            phases: {},
            cleanupBlocked: 0,
            unknownOperations: 0,
            machines: [],
            initialization: {
              connections: 0,
              machines: 0,
              nodes: 0,
              publishedVersions: 0,
            },
          });
        if (route === "/v1/admin/commands")
          return Response.json(
            Array.from({ length: 100 }, (_, i) => ({
              key: `new-${i}`,
              path,
              state: "completed",
              status: 201,
              createdAtMs: 2 + i,
              reviewedAtMs: null,
            })),
          );
        if (route === "/v1/admin/commands/review")
          return Response.json({
            key,
            path,
            state: "unknown",
            status: null,
            createdAtMs: 1,
            reviewedAtMs: 200,
          });
        return Response.json([]);
      },
    });
    const { element } = await mount(
      <React.StrictMode>
        <ManagementConsole
          client={client}
          principal={principal}
          onCredentialIssued={() => {}}
        />
      </React.StrictMode>,
    );
    expect(element.textContent).toContain(path);
    await click(element, "检查原命令回执");
    expect(element.textContent).toContain("原命令仍未知");
    const prompt = vi
      .spyOn(window, "prompt")
      .mockReturnValueOnce(id)
      .mockReturnValueOnce(
        "Confirmed original durable policy with independent evidence",
      );
    await click(element, "已查实原目标");
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(
      calls.find((c) => c.path === "/v1/admin/commands/review")?.body,
    ).toEqual({
      key,
      path,
      evidenceTargetId: id,
      reason: "Confirmed original durable policy with independent evidence",
    });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(
      ["/v1/admin/commands/review"],
    );
    expect(element.textContent).toContain("原命令真实状态未被改写");
    expect(sessionStorage.getItem(`hitchlet.management.pending.${id}`)).toBe(
      "[]",
    );
    expect(sessionStorage.getItem(`hitchlet.management.requests.${id}`)).toBe(
      "[]",
    );
  });
  it("does not overlap slow snapshot reads and labels a failed refresh as history", async () => {
    vi.useFakeTimers();
    let complete: ((value: string) => void) | undefined,
      reject = false;
    const load = vi.fn(() =>
      reject
        ? Promise.reject(new Error("offline"))
        : new Promise<string>((resolve) => {
            complete = resolve;
          }),
    );
    function Probe() {
      const snapshot = useManagementRead(load);
      return (
        <>
          <Observation at={snapshot.at} error={snapshot.error} />
          <span>{snapshot.data}</span>
        </>
      );
    }
    const element = document.createElement("div"),
      root = createRoot(element);
    roots.push(root);
    await act(async () => root.render(<Probe />));
    await act(async () => vi.advanceTimersByTime(30000));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => complete!("last server state"));
    reject = true;
    await act(async () => vi.advanceTimersByTime(10000));
    expect(element.textContent).toContain("以下为历史观测");
    expect(element.textContent).toContain("last server state");
  });
});

describe("profile revocation GUI SDK chain", () => {
  it("selects historical revisions, previews without execution and sends the reviewed CAS/reason with an idempotency key", async () => {
    const old = "00000000-0000-4000-8000-000000000004",
      current = "00000000-0000-4000-8000-000000000005";
    const calls: Array<{
      path: string;
      method: string;
      body: unknown;
      key: string | null;
    }> = [];
    const impact = {
      affectedTicketIds: [id],
      affectedValidationIds: [],
      affectedInfrastructureAllocationIds: [],
      canRevoke: true,
      disabledReasons: [],
    };
    const client = new HitchletClient("https://profiles.test", {
      auth: { kind: "bearer", token: "admin-fixture" },
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({
          path,
          method: init?.method ?? "GET",
          body,
          key: new Headers(init?.headers).get("Idempotency-Key"),
        });
        const result = path.endsWith("/revisions")
          ? [
              {
                id: current,
                profileId: network,
                revision: 2,
                isCurrent: true,
                revokedAt: null,
              },
              {
                id: old,
                profileId: network,
                revision: 1,
                isCurrent: false,
                revokedAt: null,
              },
            ]
          : path.endsWith("/preview")
            ? impact
            : {
                ...impact,
                id: version,
                profileKind: "network",
                profileRevisionId: old,
                reason: "Incident review",
                createdAt: new Date().toISOString(),
                createdBy: id,
                operationId: current,
              };
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const refreshed = vi.fn();
    const { element } = await mount(
      <ProfileRevocation
        client={client}
        disabled={false}
        action={async (_label, work) => {
          await work("gui-original-revocation");
          return true;
        }}
        kind="network"
        profile={{ id: network, version: 2 }}
        onRevoked={refreshed}
      />,
    );
    const select = element.querySelector("select")!;
    expect([...select.options].map((o) => o.textContent).join(" ")).toContain(
      "历史",
    );
    await change(select, old);
    await change(element.querySelector("input")!, "Incident review");
    expect(
      [...element.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("预览吊销影响"),
      )!.disabled,
      element.innerHTML,
    ).toBe(false);
    await click(element, "预览吊销影响");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.at(-1)!.path).toBe("/v1/admin/profile-grants/revoke/preview");
    expect(element.textContent).toContain("Ticket 1");
    expect(element.textContent).toContain(old);
    await click(element, "确认永久吊销");
    expect(
      calls.find((c) => c.path === "/v1/admin/profile-grants/revoke"),
    ).toMatchObject({
      method: "POST",
      key: "gui-original-revocation",
      body: {
        profileKind: "network",
        profileRevisionId: old,
        expectedProfileVersion: 2,
        reason: "Incident review",
      },
    });
    expect(refreshed).toHaveBeenCalledOnce();
  });
});
