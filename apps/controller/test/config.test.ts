import { describe, expect, it } from "vitest";
import { loadConfig, redact } from "../src/config.js";
describe("configuration", () => {
  it("requires a data directory", () => {
    expect(() => loadConfig({})).toThrow(/DATA_DIR/);
  });
  it("rejects malformed values clearly", () => {
    expect(() =>
      loadConfig({ DATA_DIR: "/tmp/hitchlet", PORT: "nope" }),
    ).toThrow(/PORT/);
  });
  it("requires a separate persistent directory when Simulator execution is enabled", () => {
    expect(() =>
      loadConfig({ DATA_DIR: "/tmp/hitchlet", EXECUTION_MODE: "simulator" }),
    ).toThrow(/SIMULATOR_DATA_DIR/);
    expect(loadConfig({ DATA_DIR: "/tmp/hitchlet" }).EXECUTION_MODE).toBe(
      "disabled",
    );
  });
  it("requires the encrypted secret store for Portainer and Tart execution", () => {
    expect(() =>
      loadConfig({ DATA_DIR: "/tmp/hitchlet", EXECUTION_MODE: "portainer" }),
    ).toThrow(/HITCHLET_SECRET_KEY_FILE/);
    expect(() =>
      loadConfig({ DATA_DIR: "/tmp/hitchlet", EXECUTION_MODE: "tart" }),
    ).toThrow(/HITCHLET_SECRET_KEY_FILE/);
    expect(
      loadConfig({
        DATA_DIR: "/tmp/hitchlet",
        EXECUTION_MODE: "tart",
        HITCHLET_SECRET_KEY_FILE: "/tmp/hitchlet.key",
      }).EXECUTION_MODE,
    ).toBe("tart");
  });
  it("ignores unrelated process environment variables", () => {
    expect(loadConfig({ ...process.env, DATA_DIR: "/tmp/hitchlet" }).PORT).toBe(
      3000,
    );
  });
  it("redacts nested secret fields", () => {
    expect(
      redact({ apiToken: "secret", nested: { password: "x", okay: 1 } }),
    ).toEqual({
      apiToken: "[REDACTED]",
      nested: { password: "[REDACTED]", okay: 1 },
    });
  });
});

it("offers opt-in registered composition without changing disabled or single-backend defaults", () => {
  expect(loadConfig({ DATA_DIR: "/tmp/hitchlet" }).EXECUTION_MODE).toBe(
    "disabled",
  );
  expect(() =>
    loadConfig({ DATA_DIR: "/tmp/hitchlet", EXECUTION_MODE: "registered" }),
  ).toThrow(/HITCHLET_SECRET_KEY_FILE/);
  expect(
    loadConfig({
      DATA_DIR: "/tmp/hitchlet",
      EXECUTION_MODE: "registered",
      HITCHLET_SECRET_KEY_FILE: "/tmp/hitchlet.key",
    }).EXECUTION_MODE,
  ).toBe("registered");
});
