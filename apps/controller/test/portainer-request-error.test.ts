import { expect, it } from "vitest";
import {
  assertContainerRunning,
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

it.each([
  [
    { Running: false, Status: "exited", ExitCode: 1, OOMKilled: false },
    {
      category: "process_exited",
      containerState: "exited",
      exitCode: 1,
      oomKilled: false,
    },
  ],
  [
    { Running: false, Status: "exited", ExitCode: 0 },
    { category: "process_exited", containerState: "exited", exitCode: 0 },
  ],
  [
    { Running: false, Status: "dead", ExitCode: 137, OOMKilled: true },
    {
      category: "process_exited",
      containerState: "dead",
      exitCode: 137,
      oomKilled: true,
    },
  ],
  [
    { Running: false, Status: "exited", ExitCode: 137 },
    { category: "process_exited", containerState: "exited", exitCode: 137 },
  ],
  [
    { Running: false, Status: "exited", ExitCode: "1", OOMKilled: "false" },
    { category: "process_exited", containerState: "exited" },
  ],
  [
    { Running: false, Status: "created", ExitCode: 0 },
    {
      category: "evidence_missing",
      reasonCode: "container_running_unverified",
      containerState: "created",
    },
  ],
  [
    { Running: false, Status: "PRIVATE_STATUS", ExitCode: 1 },
    {
      category: "evidence_missing",
      reasonCode: "container_running_unverified",
    },
  ],
])("records only observed bounded lifecycle facts (%j)", (state, expected) => {
  const error = (() => {
    try {
      assertContainerRunning(
        { Id: "owned", State: { ...state, Error: "PRIVATE_PROCESS_TEXT" } },
        "owned",
        "readiness",
      );
    } catch (e) {
      return e as PortainerRequestError;
    }
    throw new Error("An exited or unverified container must not become ready");
  })();
  expect(error).toBeInstanceOf(PortainerRequestError);
  expect(error.diagnostic).toEqual({
    provider: "portainer",
    stage: "readiness",
    reasonCode: "container_process_exited",
    ...expected,
  });
  expect(JSON.stringify(error)).not.toContain("PRIVATE");
});

it("checks container identity before attributing exit facts, while a running owned container remains ready", () => {
  expect(() =>
    assertContainerRunning(
      { Id: "owned", State: { Running: true } },
      "owned",
      "container_start",
    ),
  ).not.toThrow();
  try {
    assertContainerRunning(
      {
        Id: "foreign",
        State: { Running: false, Status: "exited", ExitCode: 1 },
      },
      "owned",
      "container_start",
    );
    throw new Error("Expected identity rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PortainerRequestError);
    expect((error as PortainerRequestError).diagnostic).toEqual({
      provider: "portainer",
      stage: "container_start",
      category: "configuration_mismatch",
      reasonCode: "container_identity_mismatch",
    });
  }
});
