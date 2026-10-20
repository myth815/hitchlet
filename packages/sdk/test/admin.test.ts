import { describe, expect, it } from "vitest";
import { ComputeClientError, HitchletClient } from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("admin SDK commands", () => {
  it("uses the admin version, validation, alias, and cache receipt routes with shared response schemas", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new HitchletClient("https://controller.test", {
      auth: { kind: "bearer", token: "test" },
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        const body = String(input).includes("image-cache/operations/")
          ? {
              operationId: "00000000-0000-4000-8000-000000000009",
              nodeId: id,
              artifactId: "00000000-0000-4000-8000-000000000010",
              kind: "image-cache.pull",
              state: "planned",
              attemptCount: 0,
              nextCheckAtMs: 1,
              cache: null,
              diagnostic: null,
            }
          : [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await client.admin.imageVersions();
    await client.admin.validationHistory(id);
    await client.admin.imageAliases(id);
    await client.admin.cacheOperationReceipt(
      id,
      "00000000-0000-4000-8000-000000000009",
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://controller.test/v1/admin/image-versions",
      `https://controller.test/v1/admin/image-versions/${id}/validations`,
      `https://controller.test/v1/admin/images/${id}/aliases`,
      `https://controller.test/v1/nodes/${id}/image-cache/operations/00000000-0000-4000-8000-000000000009`,
    ]);
  });

  it("does not retry a publish CAS conflict", async () => {
    let calls = 0;
    const client = new HitchletClient("https://controller.test", {
      auth: { kind: "bearer", token: "test" },
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            error: {
              code: "entity_version_conflict",
              message: "changed",
              details: {},
              retryable: false,
              requestId: id,
            },
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    await expect(
      client.admin.publish(id, 2, "publish-key"),
    ).rejects.toMatchObject<Partial<ComputeClientError>>({
      code: "entity_version_conflict",
      statusCode: 409,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it("does not retry validation scheduling after an unknown network result", async () => {
    let calls = 0;
    const client = new HitchletClient("https://controller.test", {
      auth: { kind: "bearer", token: "test" },
      fetch: async () => {
        calls += 1;
        // The server may have committed before this connection failure reached the client.
        throw new TypeError("connection reset after commit");
      },
    });
    await expect(
      client.admin.scheduleValidation(
        id,
        {
          imageArtifactId: id,
          nodeId: id,
          networkProfileId: id,
          storage: [],
          resources: {
            request: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
            limit: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 0 },
            scratchEnforcement: "best_effort",
            isolation: "shared_kernel",
            accelerators: [],
          },
          deadlineSeconds: 900,
        },
        "validation-key",
      ),
    ).rejects.toMatchObject<Partial<ComputeClientError>>({
      code: "NETWORK_RESULT_UNKNOWN",
      retryable: true,
    });
    expect(calls).toBe(1);
  });
});

it("keeps system credential queries safe and never retries a lost rotation response", async () => {
  let calls = 0;
  const client = new HitchletClient("https://controller.test", {
    auth: { kind: "bearer", token: "test" },
    fetch: async (input) => {
      calls++;
      if (String(input).includes("rotate"))
        throw new TypeError("connection lost after response");
      expect(String(input)).toBe(
        "https://controller.test/v1/system/credentials?consumerId=consumer%2Fid",
      );
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    },
  });
  expect(await client.admin.credentials("consumer/id")).toEqual([]);
  await expect(
    client.admin.rotateCredential({
      consumerId: "consumer/id",
      credentialId: id,
    }),
  ).rejects.toBeDefined();
  expect(calls).toBe(2);
});
