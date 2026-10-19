// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { StatusPage } from "./StatusPage.js";
import { HitchletClient } from "@hitchlet/sdk";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
async function mount(client?: HitchletClient) {
  const element = document.createElement("div");
  const root = createRoot(element);
  roots.push(root);
  await act(async () => {
    root.render(<StatusPage {...(client ? { client } : {})} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return element;
}
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  vi.restoreAllMocks();
});
describe("status page", () => {
  it("shows D00 status, simulator limitation, and API errors", async () => {
    const client = new HitchletClient(
      "http://localhost",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const element = await mount(client);
    expect(element.textContent).toContain("Simulator 尚未实现");
    expect(element.textContent).toContain("当前阶段：D00 基础工程");
    expect(element.textContent).toContain(
      "连接失败：Hitchlet API returned HTTP 503",
    );
  });
  it("uses a stable default client and renders successful health once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          stage: "D00",
          simulator: "not_implemented",
        }),
        { status: 200 },
      ),
    );
    const element = await mount();
    expect(element.textContent).toContain("健康：ok · D00");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
