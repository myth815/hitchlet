// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App.js";
import { HitchletClient } from "@hitchlet/sdk";
import type { AuthenticatedPrincipal } from "@hitchlet/sdk";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const ids = {
  consumer: "00000000-0000-4000-8000-000000000001",
  image: "00000000-0000-4000-8000-000000000002",
  network: "00000000-0000-4000-8000-000000000003",
  machine: "00000000-0000-4000-8000-000000000004",
  node: "00000000-0000-4000-8000-000000000005",
  ticket: "00000000-0000-4000-8000-000000000006",
  lease: "00000000-0000-4000-8000-000000000007",
  artifact: "00000000-0000-4000-8000-000000000009",
};
const at = "2026-10-19T00:00:00.000Z";
const amounts = { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 };
const principal: AuthenticatedPrincipal = {
  consumerId: ids.consumer,
  role: "consumer",
  scopes: ["tickets:write"],
  source: "session",
};

function ticket(
  phase: "queued" | "ready" | "releasing" | "released" = "ready",
  claimedAt: string | null = at,
) {
  return {
    id: ids.ticket,
    consumerId: ids.consumer,
    phase,
    version: phase === "ready" ? 1 : 2,
    pinnedImageVersionId: ids.image,
    terminalReason: phase === "released" ? "consumer_release" : null,
    cleanupStatus:
      phase === "released"
        ? "complete"
        : phase === "releasing"
          ? "running"
          : "not_needed",
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    releasedAt: phase === "released" ? at : null,
    acceptedRequest: {
      image: { versionId: ids.image },
      resources: {
        request: amounts,
        limit: amounts,
        scratchEnforcement: "best_effort",
        isolation: "shared_kernel",
        accelerators: [],
      },
      networkProfileId: ids.network,
      kind: "container",
      allowedArchitectures: ["amd64"],
      allowedProviders: ["portainer"],
      locality: "local_only",
      siteIds: ["lab"],
      requiredLabels: {},
      requiredCapabilities: [],
      storage: [],
      access: { protocol: "ssh" },
      lease: {
        requestedSeconds: 900,
        maximumLifetimeSeconds: 86400,
        queueTimeoutSeconds: 1800,
        provisioningTimeoutSeconds: 1200,
        expiryPolicyId: ids.network,
        maximumTtlSeconds: 900,
      },
      labels: {},
    },
    pinnedProfileRevisions: {
      networkProfileRevisionId: ids.network,
      storageProfileRevisionIds: [],
    },
    queueDeadline: "2026-10-19T00:30:00.000Z",
    provisioningDeadline: null,
    lease:
      phase === "queued"
        ? null
        : {
            id: ids.lease,
            generation: 1,
            version: phase === "ready" ? 1 : 2,
            state: "active",
            claimBy: at,
            claimedAt,
            expiresAt: "2026-10-19T01:00:00.000Z",
            renewUntil: "2026-10-20T00:00:00.000Z",
            revokedAt: null,
          },
    placement:
      phase === "queued"
        ? null
        : {
            machineId: ids.machine,
            nodeId: ids.node,
            provider: "portainer",
            architecture: "amd64",
            imageArtifactId: ids.artifact,
          },
    health: { state: "healthy", observedAt: at, reasonCodes: [] },
    scheduling: {
      checkedAt: at,
      reasonCodes: [],
      matchingNodeCount: 1,
      nextCheckAt: null,
    },
    renewalPending: null,
    cleanupBlockedResources: [],
  };
}

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function harness(
  options: {
    initialTicket?: boolean;
    prepared?: unknown;
    authPrincipal?: AuthenticatedPrincipal;
  } = {},
) {
  const authPrincipal = options.authPrincipal ?? principal;
  let authenticated = false;
  let force401 = false;
  let currentTicket = options.initialTicket ? ticket("ready", null) : ticket();
  let releasingPolls = 0;
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    body: string | null;
    preparedAtSend?: string | null;
  }[] = [];
  if (options.prepared)
    sessionStorage.setItem(
      `${"hitchlet.prepared.v1."}${ids.consumer}`,
      JSON.stringify([options.prepared]),
    );
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const entry: {
      url: string;
      method: string;
      headers: Headers;
      body: string | null;
      preparedAtSend?: string | null;
    } = {
      url: url.pathname + url.search,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(entry);
    if (url.pathname === "/healthz")
      return response({
        status: "ok",
        stage: "D05",
        executionMode: "simulator",
        recoveryState: "ready",
      });
    if (url.pathname === "/v1/auth/me")
      return authenticated
        ? response(authPrincipal)
        : response(
            {
              error: {
                code: "unauthenticated",
                message: "Login required",
                details: {},
                retryable: false,
                requestId: "test",
              },
            },
            401,
          );
    if (url.pathname === "/v1/auth/session" && init?.method === "POST") {
      authenticated = true;
      document.cookie = "hitchlet_csrf=csrf-token; path=/";
      return response(authPrincipal, 201, {
        "X-CSRF-Token": "csrf-token",
      });
    }
    if (url.pathname === "/v1/auth/session" && init?.method === "DELETE") {
      authenticated = false;
      document.cookie = "hitchlet_csrf=; Max-Age=0; path=/";
      return response(undefined, 204);
    }
    if (!authenticated)
      return response(
        {
          error: {
            code: "unauthenticated",
            message: "Login required",
            details: {},
            retryable: false,
            requestId: "test",
          },
        },
        401,
      );
    if (force401)
      return response(
        {
          error: {
            code: "unauthenticated",
            message: "Expired",
            details: {},
            retryable: false,
            requestId: "test",
          },
        },
        401,
      );
    if (url.pathname === "/v1/images")
      return response({
        items: [
          { id: ids.image, name: "开发镜像", description: "固定测试镜像" },
        ],
        nextCursor: null,
      });
    if (url.pathname === "/v1/image-versions/" + ids.image)
      return response({
        id: ids.image,
        imageId: ids.image,
        version: "v1",
        status: "published",
        minimumResources: amounts,
        artifacts: [
          {
            id: ids.artifact,
            provider: "portainer",
            kind: "container",
            architecture: "amd64",
            guestOs: "linux",
            digest: "sha256:" + "a".repeat(64),
            accessProtocols: ["ssh"],
          },
        ],
      });
    if (url.pathname === "/v1/tickets" && init?.method !== "POST") {
      const items = options.initialTicket
        ? [
            {
              id: ids.ticket,
              consumerId: ids.consumer,
              phase: currentTicket.phase,
              version: 1,
              pinnedImageVersionId: ids.image,
              terminalReason: currentTicket.terminalReason,
              cleanupStatus: currentTicket.cleanupStatus,
              createdAt: at,
              updatedAt: at,
              readyAt: at,
              releasedAt: currentTicket.releasedAt,
            },
          ]
        : [];
      return response({ items, nextCursor: null });
    }
    if (url.pathname === "/v1/tickets" && init?.method === "POST") {
      entry.preparedAtSend = sessionStorage.getItem(
        `hitchlet.prepared.v1.${ids.consumer}`,
      );
      currentTicket = ticket("queued", null);
      return response(
        {
          ticket: currentTicket,
          idempotencyKey: headers.get("Idempotency-Key"),
        },
        202,
      );
    }
    if (
      url.pathname === `/v1/tickets/${ids.ticket}` &&
      init?.method !== "POST"
    ) {
      if (currentTicket.phase === "releasing" && releasingPolls++ > 0)
        currentTicket = ticket("released", at);
      return response(currentTicket);
    }
    if (url.pathname.endsWith("/renew") && init?.method === "POST") {
      currentTicket = ticket("ready", at);
      return response({
        renewalId: "00000000-0000-4000-8000-000000000008",
        ticketId: ids.ticket,
        generation: 1,
        leaseId: ids.lease,
        leaseVersion: 2,
        claimedAt: at,
        expiresAt: "2026-10-19T02:00:00.000Z",
        renewUntil: "2026-10-20T00:00:00.000Z",
        offlineEnforcement: "not_guaranteed",
        guardAcknowledgementId: null,
      });
    }
    if (url.pathname.endsWith("/access") && init?.method === "POST")
      return response({
        ticketId: ids.ticket,
        leaseId: ids.lease,
        leaseVersion: 2,
        generation: 1,
        access: {
          protocol: "ssh",
          host: "simulator.invalid",
          port: 2222,
          username: "guest",
          hostKeyFingerprint: null,
          expiresAt: "2026-10-19T00:10:00.000Z",
        },
        authentication: {
          kind: "ephemeral_password",
          password: "short-secret",
        },
      });
    if (url.pathname.endsWith("/release") && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toMatchObject({
        reclaimable: true,
        generation: 1,
      });
      currentTicket = ticket("releasing", at);
      return response(currentTicket);
    }
    if (url.pathname.endsWith("/cancel") && init?.method === "POST") {
      currentTicket = ticket("releasing", at);
      return response(currentTicket);
    }
    return response(
      {
        error: {
          code: "not_found",
          message: "Not found",
          details: {},
          retryable: false,
          requestId: "test",
        },
      },
      404,
    );
  });
  return {
    client: new HitchletClient("http://localhost", {
      fetch: fetcher,
      auth: { kind: "cookie", csrfToken: () => "csrf-token" },
    }),
    calls,
    fetcher,
    expire: () => {
      force401 = true;
    },
  };
}

const roots: Root[] = [];
async function mount(client: HitchletClient) {
  const element = document.createElement("div");
  const root = createRoot(element);
  roots.push(root);
  await act(async () => {
    root.render(<App client={client} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return element;
}
async function click(element: Element, text: string) {
  const button = [...element.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function enter(element: Element, label: string, value: string) {
  const input = [...element.querySelectorAll("input")].find(
    (item) =>
      item.getAttribute("placeholder") === label ||
      item.getAttribute("aria-label") === label,
  );
  if (!input) throw new Error(`Input not found: ${label}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit(element: Element, selector: string) {
  const form = element.querySelector(selector);
  if (!form) throw new Error(`Form not found: ${selector}`);
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  sessionStorage.clear();
  document.cookie = "hitchlet_csrf=; Max-Age=0; path=/";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("D05 consumer console", () => {
  it("allows ticket writers across admin/consumer roles and blocks viewers", async () => {
    const admin = harness({
      authPrincipal: { ...principal, role: "admin", scopes: ["tickets:write"] },
    });
    const adminElement = await mount(admin.client);
    await enter(adminElement, "粘贴一次性显示的 token", "token");
    await submit(adminElement, ".login-card form");
    const adminAcquire = adminElement.querySelector(
      ".acquire-form .primary-button",
    ) as HTMLButtonElement;
    expect(adminAcquire.disabled).toBe(false);
    expect(adminElement.textContent).toContain("admin · 00000000…");

    const viewer = harness({
      authPrincipal: { ...principal, role: "viewer", scopes: ["tickets:read"] },
    });
    const viewerElement = await mount(viewer.client);
    await enter(viewerElement, "粘贴一次性显示的 token", "token");
    await submit(viewerElement, ".login-card form");
    const viewerAcquire = viewerElement.querySelector(
      ".acquire-form .primary-button",
    ) as HTMLButtonElement;
    expect(viewerAcquire.disabled).toBe(true);
    expect(viewerElement.textContent).toContain("没有 Ticket 写入权限");
  });

  it("restores the cookie session, clears the entered token and redirects after a 401", async () => {
    const h = harness();
    const element = await mount(h.client);
    expect(element.textContent).toContain("登录 Hitchlet");
    await enter(element, "粘贴一次性显示的 token", "test-bearer-secret");
    await submit(element, ".login-card form");
    expect(element.textContent).toContain("consumer · 00000000…");
    expect(element.querySelector("input[type=password]")).toBeNull();
    expect(
      sessionStorage.getItem(`hitchlet.prepared.v1.${ids.consumer}`) ?? "",
    ).not.toContain("test-bearer-secret");
    const loginCall = h.calls.find(
      (item) => item.url === "/v1/auth/session" && item.method === "POST",
    );
    expect(loginCall?.headers.get("Authorization")).toBe(
      "Bearer test-bearer-secret",
    );
    expect(loginCall?.headers.get("Cookie")).toBeNull();
    const me = h.calls.find((item) => item.url === "/v1/auth/me");
    expect(me).toBeDefined();
    // An authenticated GET that later returns 401 expires the UI session without releasing tickets.
    const oldRoot = roots.pop()!;
    await act(async () => {
      oldRoot.unmount();
    });
    const refreshed = await mount(h.client);
    expect(refreshed.textContent).toContain("consumer · 00000000…");
    h.expire();
    await click(refreshed, "刷新列表");
    expect(refreshed.textContent).toContain("登录 Hitchlet");
    expect(
      h.calls.filter(
        (item) => item.url === "/v1/tickets" && item.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("saves a prepared acquire command before the first POST and submits once", async () => {
    const h = harness();
    const element = await mount(h.client);
    await enter(element, "粘贴一次性显示的 token", "token");
    await submit(element, ".login-card form");
    await enter(element, "由管理员提供的网络配置 ID", ids.network);
    await submit(element, ".acquire-form");
    const call = h.calls.find(
      (item) => item.url === "/v1/tickets" && item.method === "POST",
    );
    expect(call?.preparedAtSend).toBeTruthy();
    expect(JSON.parse(call!.preparedAtSend!)[0].command.kind).toBe("acquire");
    expect(JSON.parse(call!.body!)).toMatchObject({
      image: { imageId: ids.image, alias: "latest" },
      networkProfileId: ids.network,
      resources: { cpuMillis: 1000, memoryMiB: 2048, scratchMiB: 2048 },
    });
    expect(
      h.calls.filter(
        (item) => item.url === "/v1/tickets" && item.method === "POST",
      ),
    ).toHaveLength(1);
    expect(element.textContent).toContain("申请已受理");
  });

  it("does not evict unresolved commands or send a new request when recovery storage is full", async () => {
    const saved = Array.from({ length: 8 }, (_, index) => ({
      command: {
        schemaVersion: 1,
        kind: "release",
        idempotencyKey: `pending-${index}`,
        ticketId: ids.ticket,
        request: { reclaimable: true },
      },
      savedAt: at,
    }));
    const h = harness({ prepared: saved[0] });
    sessionStorage.setItem(
      `hitchlet.prepared.v1.${ids.consumer}`,
      JSON.stringify(saved),
    );
    const element = await mount(h.client);
    await enter(element, "粘贴一次性显示的 token", "token");
    await submit(element, ".login-card form");
    await enter(element, "由管理员提供的网络配置 ID", ids.network);
    await submit(element, ".acquire-form");
    expect(
      h.calls.some(
        (item) => item.url === "/v1/tickets" && item.method === "POST",
      ),
    ).toBe(false);
    expect(
      JSON.parse(
        sessionStorage.getItem(`hitchlet.prepared.v1.${ids.consumer}`) ?? "[]",
      ),
    ).toEqual(saved);
    expect(element.textContent).toContain("待恢复操作已达 8 条上限");
  });

  it("requires both release confirmations, exposes access briefly and waits for released", async () => {
    const h = harness({ initialTicket: true });
    const element = await mount(h.client);
    await enter(element, "粘贴一次性显示的 token", "token");
    await submit(element, ".login-card form");
    await click(element, "可接用");
    expect(element.textContent).toContain("技术健康只说明");
    await click(element, "首次接用 / Claim");
    expect(element.textContent).toContain("首次接用已确认");
    const releaseButton = [...element.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("确认归还并删除"),
    ) as HTMLButtonElement;
    expect(releaseButton.disabled).toBe(true);
    await click(element, "获取接用材料");
    expect(element.textContent).toContain("short-secret");
    expect(
      JSON.parse(
        sessionStorage.getItem(`hitchlet.prepared.v1.${ids.consumer}`) ?? "[]",
      ),
    ).toEqual([]);
    expect(
      sessionStorage.getItem(`hitchlet.prepared.v1.${ids.consumer}`),
    ).not.toContain("short-secret");
    const checks = [
      ...element.querySelectorAll("input[type=checkbox]"),
    ] as HTMLInputElement[];
    await act(async () => {
      checks.forEach((input) => input.click());
    });
    await click(element, "确认归还并删除");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(h.calls.some((item) => item.url.endsWith("/release"))).toBe(true);
    expect(
      h.calls.some(
        (item) =>
          item.url.endsWith("/release") &&
          JSON.parse(item.body ?? "{}").reclaimable === true,
      ),
    ).toBe(true);
    expect(element.textContent).toContain("服务端已确认环境释放");
    expect(element.textContent).toContain("已释放");
    expect(element.querySelector(".access-card")).toBeNull();
    expect(element.textContent).not.toContain("short-secret");
  });

  it("resumes a saved command with its exact original key and body", async () => {
    const command = {
      schemaVersion: 1,
      kind: "acquire",
      idempotencyKey: "original-idempotency-key",
      request: {
        image: { imageId: ids.image, alias: "latest" },
        resources: amounts,
        networkProfileId: ids.network,
      },
    };
    const h = harness({ prepared: { command, savedAt: at } });
    const element = await mount(h.client);
    await enter(element, "粘贴一次性显示的 token", "token");
    await submit(element, ".login-card form");
    await click(element, "恢复原操作");
    const post = h.calls.find(
      (item) => item.url === "/v1/tickets" && item.method === "POST",
    );
    expect(post?.headers.get("Idempotency-Key")).toBe(command.idempotencyKey);
    expect(JSON.parse(post!.body!)).toEqual(command.request);
    expect(sessionStorage.getItem(`hitchlet.prepared.v1.${ids.consumer}`)).toBe(
      "[]",
    );
  });

  it("keeps refreshes read-only and clears polling timers on unmount", async () => {
    const h = harness({ initialTicket: true });
    const element = await mount(h.client);
    await enter(element, "粘贴一次性显示的 token", "token");
    await submit(element, ".login-card form");
    await click(element, "刷新列表");
    expect(
      h.calls.filter(
        (item) => item.url === "/v1/tickets" && item.method === "POST",
      ),
    ).toHaveLength(0);
    const countBeforeUnmount = h.calls.length;
    vi.useFakeTimers();
    const root = roots.pop()!;
    await act(async () => {
      root.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(h.calls).toHaveLength(countBeforeUnmount);
  });

  it("logs out the session without cancelling or releasing any Ticket", async () => {
    const h = harness({ initialTicket: true });
    const element = await mount(h.client);
    await enter(element, "粘贴一次性显示的 token", "token");
    await submit(element, ".login-card form");
    await click(element, "退出");
    expect(element.textContent).toContain(
      "现有 Ticket 和租约不会因此自动取消或释放",
    );
    expect(
      h.calls.some(
        (item) => item.url === "/v1/auth/session" && item.method === "DELETE",
      ),
    ).toBe(true);
    expect(
      h.calls.some(
        (item) => item.url.endsWith("/cancel") || item.url.endsWith("/release"),
      ),
    ).toBe(false);
  });
});
