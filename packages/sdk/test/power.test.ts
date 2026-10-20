import { describe, expect, it } from "vitest";
import { HitchletClient } from "../src/index.js";
import { PowerPolicySchema } from "@hitchlet/contracts/admin";
const id = "00000000-0000-4000-8000-000000000001";
describe("power sandbox SDK", () => {
  it("does not retry an uncertain power write or silently enable real execution", async () => {
    let calls = 0;
    const client = new HitchletClient("https://controller.test", {
      fetch: async () => {
        calls++;
        throw new TypeError("lost response after commit");
      },
    });
    await expect(
      client.admin.updatePowerPolicy(
        id,
        { expectedVersion: 0, policy: PowerPolicySchema.parse({}) },
        "key",
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
  it("validates synthetic event and management response boundaries", async () => {
    let calls = 0;
    const client = new HitchletClient("https://controller.test", {
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            executionAllowed: true,
            token: "not-a-management-response",
          }),
          { status: 200 },
        );
      },
    });
    await expect(client.admin.powerConfiguration(id)).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(() =>
      client.admin.advancePowerPreview(
        id,
        id,
        {
          expectedVersion: 1,
          event: { kind: "evaluate", token: "secret" },
        } as never,
        "key",
      ),
    ).toThrow();
    expect(calls).toBe(1);
  });
});

describe("native power SDK", () => {
  it("journals native power requests and never retries an unknown shutdown response", async () => {
    let calls = 0;
    const prepared: unknown[] = [];
    const client = new HitchletClient("https://controller.test", {
      onManagementPrepared: async (r) => {
        prepared.push(r);
      },
      fetch: async () => {
        calls++;
        throw new TypeError("lost native request response");
      },
    });
    await expect(
      client.admin.startPowerExecution(id, { qualification: true }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(prepared[0]).toMatchObject({
      path: `/v1/machines/${id}/power-executions`,
      body: { qualification: true },
    });
  });
});
