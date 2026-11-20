import { expect, it } from "vitest";
import {
  failureCategory,
  requestStage,
  PortainerRequestError,
} from "../src/providers/portainer-request-error.js";

it.each([
  ["distribution/example.invalid/private@sha256:abc/json", "manifest"],
  ["images/private/json", "image_inspect"],
  ["containers/create?name=PRIVATE_NAME", "container_create"],
  ["containers/PRIVATE_ID/start", "container_start"],
  ["networks/PRIVATE_ID", "network_inspect"],
  ["containers/PRIVATE_ID/json", "container_inspect"],
])("reduces private request %s to a fixed stage", (path, stage) => {
  expect(requestStage(path)).toBe(stage);
});

it.each([
  [
    "Get https://example.invalid/private?token=PRIVATE: connection refused",
    "connection_refused",
  ],
  [
    new Error("PRIVATE", { cause: { code: "ECONNREFUSED" } }),
    "connection_refused",
  ],
  [
    new Error("PRIVATE", { cause: { code: "ENOTFOUND" } }),
    "name_resolution_failed",
  ],
  [
    new Error("PRIVATE", { cause: { code: "EAI_AGAIN" } }),
    "name_resolution_failed",
  ],
  [new Error("PRIVATE", { cause: { code: "ETIMEDOUT" } }), "timeout"],
  [Object.assign(new Error("PRIVATE"), { name: "TimeoutError" }), "timeout"],
  ["unclassified PRIVATE text", "http_error"],
])("retains a short class without copying text (%j)", (value, category) => {
  const result = failureCategory(value, "http_error");
  expect(result).toBe(category);
  expect(
    new PortainerRequestError({
      provider: "portainer",
      stage: "manifest",
      category: result,
      statusCode: 500,
    }).message,
  ).not.toContain("PRIVATE");
});

it.each(["http", "transport", "json"] as const)(
  "retains actual node probe failure kind %s without private endpoint/body",
  async (kind) => {
    const { probePortainer } = await import(
      "../src/providers/portainer-probe.js"
    );
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async () => {
      if (kind === "transport")
        throw new Error("PRIVATE_ENDPOINT", {
          cause: { code: "ECONNREFUSED" },
        });
      return new Response("PRIVATE_BODY", {
        status: kind === "http" ? 503 : 200,
      });
    });
    try {
      const error = await probePortainer({
        endpointUrl: "https://private.invalid",
        environmentId: "1",
        apiKey: "PRIVATE_KEY",
      }).catch((e) => e);
      expect(error).toBeInstanceOf(PortainerRequestError);
      expect(error.diagnostic).toMatchObject({
        stage: "node_probe",
        category:
          kind === "http"
            ? "http_error"
            : kind === "transport"
              ? "connection_refused"
              : "invalid_response",
        ...(kind === "transport"
          ? {}
          : { statusCode: kind === "http" ? 503 : 200 }),
      });
      expect(JSON.stringify(error)).not.toContain("PRIVATE");
      expect(error.message).not.toContain("private.invalid");
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["networks/PRIVATE_ID", "DELETE"],
  ["networks/create", "POST"],
  ["containers/PRIVATE_ID/json", "POST"],
])("does not label a non-GET %s request as inspect", (path, method) => {
  expect(requestStage(path, method)).toBe("docker_request");
});
