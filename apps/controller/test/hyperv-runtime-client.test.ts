import { expect, it } from "vitest";
import {
  hyperVRuntimeActionRequestSchema,
  hyperVRuntimeFactsRequestSchema,
  type VmAllocationIdentity,
  type HyperVInspection,
} from "@hitchlet/contracts/internal";
import { HyperVRuntimeHttpClient } from "../src/providers/hyperv-runtime-client.js";
import type { RuntimeAgentJsonTransport } from "../src/providers/runtime-network-client.js";

const identity: VmAllocationIdentity = {
  installationId: "install",
  runtimeIdentityId: "runtime",
  connectionRevisionId: "revision",
  allocationId: "allocation",
  generation: 1,
  operationId: "operation",
  controlVersion: 2,
  purpose: "validation",
};
const inspection: HyperVInspection = {
  identity,
  presence: "unknown",
  inventoryComplete: false,
  bootstrapStatus: "not_implemented",
  reason: "import_outcome_unknown",
};
const facts = {
  nativeRuntimeNamespaceId: "11111111-1111-4111-8111-111111111111",
  available: false,
  hostArchitecture: "AMD64",
  implementedOperations: [],
};
function fixture(rewrite: (response: any) => unknown = (v) => v) {
  const calls: { path: string; request: any; timeout: number | undefined }[] =
    [];
  const transport: RuntimeAgentJsonTransport = {
    async exchangeJson(path, raw, timeout) {
      const request = path.endsWith("/actions")
        ? hyperVRuntimeActionRequestSchema.parse(raw)
        : hyperVRuntimeFactsRequestSchema.parse(raw);
      calls.push({ path, request, timeout });
      const { requestNonce, installationId, runtimeIdentityId } = request;
      return rewrite({
        requestNonce,
        installationId,
        runtimeIdentityId,
        ...(path.endsWith("/actions") ? { result: inspection } : { facts }),
      });
    },
  };
  const client = new HyperVRuntimeHttpClient({
    transport,
    installationId: "install",
    runtimeIdentityId: "runtime",
    controllerEpoch: 7,
    deadlineMs: 301_000,
    now: () => 1_000,
  });
  return { client, calls };
}
it("keeps native lifecycle internal and returns unready/unknown honestly with bounded deadlines", async () => {
  const { client, calls } = fixture();
  expect(await client.inspect(identity)).toEqual(inspection);
  await client.stop(identity);
  await client.destroy(identity);
  await client.reconcile({
    identity,
    template: {
      configPath: "E:\\Templates\\base.vmcx",
      configSha256: "a".repeat(64),
      guestOs: "windows",
      architecture: "amd64",
      generation: 2,
    },
    resources: { cpus: 4, memoryMiB: 4096 },
    switchName: "Existing Switch",
  });
  expect(await client.facts()).toEqual({ ...facts, templates: [] });
  expect(calls.map((c) => c.path)).toEqual([
    ...Array(4).fill("/v1/hyperv/actions"),
    "/v1/hyperv/facts",
  ]);
  expect(calls[0]?.request.controllerEpoch).toBe(7);
  expect(Date.parse(calls[0]?.request.deadline)).toBe(241_000);
  expect(calls[0]?.timeout).toBe(240_000);
  expect(calls[4]?.timeout).toBe(30_000);
});
it.each(["requestNonce", "installationId", "runtimeIdentityId"] as const)(
  "rejects foreign/replayed %s responses",
  async (key) => {
    const { client } = fixture((r) => ({
      ...r,
      [key]:
        key === "requestNonce"
          ? "22222222-2222-4222-8222-222222222222"
          : "foreign",
    }));
    await expect(client.inspect(identity)).rejects.toThrow("identity mismatch");
    await expect(client.facts()).rejects.toThrow("identity mismatch");
  },
);
it.each([
  "generation",
  "operationId",
  "controlVersion",
  "connectionRevisionId",
  "allocationId",
  "purpose",
] as const)(
  "rejects result from a different allocation command: %s",
  async (key) => {
    const changed = {
      ...identity,
      [key]:
        typeof identity[key] === "number"
          ? 3
          : key === "purpose"
            ? "tenant"
            : "foreign",
    };
    const { client } = fixture((r) => ({
      ...r,
      result: { ...inspection, identity: changed },
    }));
    await expect(client.destroy(identity)).rejects.toThrow(
      "does not match the action",
    );
  },
);
it("rejects foreign outgoing identity and expired actions before transport", async () => {
  const { client, calls } = fixture();
  await expect(
    client.inspect({ ...identity, runtimeIdentityId: "foreign" }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
  const expired = new HyperVRuntimeHttpClient({
    transport: {
      exchangeJson: async () => {
        throw Error("should not send");
      },
    },
    installationId: "install",
    runtimeIdentityId: "runtime",
    controllerEpoch: 1,
    deadlineMs: 1,
    now: () => 2,
  });
  await expect(expired.destroy(identity)).rejects.toThrow(
    "deadline has expired",
  );
});
it("does not accept false absence or fabricated guest readiness", async () => {
  for (const result of [
    { ...inspection, presence: "absent", inventoryComplete: false },
    { ...inspection, bootstrapStatus: "applied" },
  ]) {
    const { client } = fixture((r) => ({ ...r, result }));
    await expect(client.inspect(identity)).rejects.toThrow();
  }
});
