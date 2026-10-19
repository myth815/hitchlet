import { describe, expect, it } from "vitest";
import { HealthResponseSchema } from "../src/health.js";

describe("health response contract", () => {
  it("accepts the D05 runtime health response", () => {
    expect(
      HealthResponseSchema.parse({
        status: "ok",
        stage: "D05",
        executionMode: "simulator",
        recoveryState: "ready",
      }),
    ).toEqual({
      status: "ok",
      stage: "D05",
      executionMode: "simulator",
      recoveryState: "ready",
    });
  });
  it("rejects unknown or invalid health data", () => {
    expect(
      HealthResponseSchema.safeParse({
        status: "ok",
        stage: "M0",
        simulator: "ready",
      }).success,
    ).toBe(false);
    expect(
      HealthResponseSchema.safeParse({
        status: "ok",
        stage: "D05",
        executionMode: "disabled",
        recoveryState: "unavailable",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
