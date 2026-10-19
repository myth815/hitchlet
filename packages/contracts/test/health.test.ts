import { describe, expect, it } from "vitest";
import { HealthResponseSchema } from "../src/health.js";

describe("health response contract", () => {
  it("accepts the D00 health response", () => {
    expect(
      HealthResponseSchema.parse({
        status: "ok",
        stage: "D00",
        simulator: "not_implemented",
      }),
    ).toEqual({ status: "ok", stage: "D00", simulator: "not_implemented" });
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
        stage: "D00",
        simulator: "not_implemented",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
