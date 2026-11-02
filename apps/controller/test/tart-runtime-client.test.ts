import { expect, it } from "vitest";
import type {
  TartAllocationIdentity,
  TartRuntimeActionRequest,
} from "@hitchlet/contracts/internal";
import type { RuntimeAgentJsonTransport } from "../src/providers/runtime-network-client.js";
import { TartRuntimeHttpClient } from "../src/providers/tart-runtime-client.js";

const identity: TartAllocationIdentity = {
  installationId: "install-tart-client",
  runtimeIdentityId: "runtime-tart-client",
  connectionRevisionId: "revision-tart-client",
  allocationId: "allocation-tart-client",
  generation: 1,
  operationId: "operation-tart-client",
  controlVersion: 1,
  purpose: "validation",
};

it("binds Tart actions and facts to the configured identity and nonce", async () => {
  const seen: TartRuntimeActionRequest[] = [];
  const seenTimeouts: number[] = [];
  const transport: RuntimeAgentJsonTransport = {
    async exchangeJson(path, payload, timeoutMs) {
      if (timeoutMs) seenTimeouts.push(timeoutMs);
      if (path === "/v1/tart/actions") {
        const request = payload as TartRuntimeActionRequest;
        seen.push(request);
        const actionIdentity =
          request.action.kind === "reconcile"
            ? request.action.request.identity
            : request.action.identity;
        return {
          requestNonce: request.requestNonce,
          installationId: request.installationId,
          runtimeIdentityId: request.runtimeIdentityId,
          result: {
            presence: "absent",
            identity: actionIdentity,
            inventoryCompleteness: "complete",
          },
        };
      }
      return {
        requestNonce: (payload as { requestNonce: string }).requestNonce,
        installationId: identity.installationId,
        runtimeIdentityId: identity.runtimeIdentityId,
        facts: {
          nativeRuntimeNamespaceId: "11111111-1111-4111-8111-111111111111",
          tartVersion: "2.41.1",
          hostOS: "macos",
          hostArch: "arm64",
          hostCpuCount: 8,
          hostMemoryBytes: 16 * 1024 * 1024 * 1024,
          templates: [],
        },
      };
    },
  };
  const client = new TartRuntimeHttpClient({
    transport,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    controllerEpoch: 7,
    deadlineMs: Date.now() + 60_000,
  });

  await expect(client.inspect(identity)).resolves.toMatchObject({
    presence: "absent",
    inventoryCompleteness: "complete",
  });
  await expect(client.facts()).resolves.toMatchObject({
    hostOS: "macos",
    hostArch: "arm64",
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    controllerEpoch: 7,
    deadline: expect.any(String),
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    action: { kind: "inspect", identity },
  });
  expect(seen[0]?.requestNonce).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(seenTimeouts[0]).toBeLessThanOrEqual(60_000);
  expect(seenTimeouts[0]).toBeGreaterThan(0);
});

it("rejects action identity mismatches before transport and response identity mismatches after it", async () => {
  let calls = 0;
  const transport: RuntimeAgentJsonTransport = {
    async exchangeJson(_path, payload) {
      calls += 1;
      const request = payload as TartRuntimeActionRequest;
      return {
        requestNonce: request.requestNonce,
        installationId: request.installationId,
        runtimeIdentityId: request.runtimeIdentityId,
        result: {
          presence: "absent",
          identity: { ...identity, allocationId: "another-allocation" },
          inventoryCompleteness: "complete",
        },
      };
    },
  };
  const client = new TartRuntimeHttpClient({
    transport,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    controllerEpoch: 7,
    deadlineMs: Date.now() + 60_000,
  });

  await expect(
    client.inspect({ ...identity, runtimeIdentityId: "another-runtime" }),
  ).rejects.toThrow(
    "Tart action identity does not match the configured runtime",
  );
  expect(calls).toBe(0);
  await expect(client.inspect(identity)).rejects.toThrow(
    "Tart Runtime Agent result does not match the action",
  );
});

it("does not send an action after the frozen operation deadline", async () => {
  let calls = 0;
  const client = new TartRuntimeHttpClient({
    transport: {
      async exchangeJson() {
        calls += 1;
        throw new Error("transport should not be called");
      },
    },
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    controllerEpoch: 7,
    deadlineMs: 1_000,
    now: () => 1_001,
  });
  await expect(client.inspect(identity)).rejects.toThrow(
    "Tart Runtime Agent action deadline has expired",
  );
  expect(calls).toBe(0);
});
