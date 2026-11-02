import { describe, expect, it } from "vitest";
import {
  assertTartExecutionAdaptersConfigured,
  loadConfig,
  redact,
} from "../src/config.js";
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
    expect(() => assertTartExecutionAdaptersConfigured("tart")).toThrow(
      "Tart execution remains closed: real Tart/Softnet qualification and controlled deployment have not been verified and enabled",
    );
    expect(() =>
      assertTartExecutionAdaptersConfigured("disabled"),
    ).not.toThrow();
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
