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
