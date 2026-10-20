// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { HitchletClient } from "@hitchlet/sdk";
import { SystemPanel } from "./SystemPanel.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
});
async function render(
  canWrite: boolean,
  onCredentialIssued?: (token: string) => void,
) {
  const client = new HitchletClient("https://controller.test");
  vi.spyOn(client.admin, "systemHealth").mockResolvedValue({
    admission: "paused",
    reason: "review",
    version: 1,
    disk: {
      availableMiB: 5000,
      lowWaterMiB: 1024,
      reserveMiB: 128,
      observedAtMs: 1,
    },
    recoveryRequired: false,
    recovery: null,
    runtimeDisks: [],
    offlineLeaseEnforcement: "unsupported",
  });
  vi.spyOn(client.admin, "backups").mockResolvedValue([]);
  vi.spyOn(client.admin, "credentials").mockResolvedValue([
    {
      credentialId: "credential",
      consumerId: "admin",
      consumerName: "Administrator",
      tokenPrefix: "safe-prefix",
      status: "active",
      createdAtMs: 1,
      expiresAtMs: null,
      lastUsedAtMs: null,
    },
  ]);
  const rotate = vi.spyOn(client.admin, "rotateCredential").mockResolvedValue({
    consumerId: "admin",
    credentialId: "00000000-0000-4000-8000-000000000001",
    token: "one-time-token".repeat(4),
  });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () =>
    root.render(
      <SystemPanel
        client={client}
        canWrite={canWrite}
        {...(onCredentialIssued ? { onCredentialIssued } : {})}
      />,
    ),
  );
  await act(async () => {
    const details = element.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  return { element, client, rotate };
}
it("renders safe operational metadata and disables every write without permission", async () => {
  const { element, rotate } = await render(false);
  expect(element.textContent).toContain("管理员暂停");
  expect(element.textContent).toContain("safe-prefix");
  expect(
    [...element.querySelectorAll("button")].every((button) => button.disabled),
  ).toBe(true);
  expect(rotate).not.toHaveBeenCalled();
});
it("delivers a rotated credential once in memory and stops writes while its old session is invalid", async () => {
  const issued = vi.fn(),
    { element, rotate } = await render(true, issued);
  await act(async () => {
    [...element.querySelectorAll("button")]
      .find((button) => button.textContent === "轮换此凭据")!
      .click();
  });
  expect(rotate).toHaveBeenCalledWith({
    consumerId: "admin",
    credentialId: "credential",
  });
  expect(issued).toHaveBeenCalledOnce();
  expect(localStorage.length).toBe(0);
  expect(
    [...element.querySelectorAll("button")].every((button) => button.disabled),
  ).toBe(true);
});
