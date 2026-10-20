import { describe, expect, it } from "vitest";
import * as consumer from "../src/index.js";
import {
  PowerPolicySchema,
  PowerCapabilityUpdateSchema,
  SmartPlugBindingUpdateSchema,
  PowerPreviewStartSchema,
} from "../src/admin.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("power management schemas", () => {
  it("defaults disabled sandbox policy and enforces guard, restoration and wake bounds", () => {
    const policy = PowerPolicySchema.parse({});
    expect(policy).toMatchObject({
      enabled: false,
      dryRun: true,
      idleSeconds: 1800,
      expectedOffGuardSeconds: 120,
      faultRecovery: { mode: "disabled" },
    });
    for (const change of [
      { dryRun: false },
      { permitForcedPhysicalPowerOff: true },
      { expectedOffGuardSeconds: 119 },
      { maximumWakeAttempts: 4 },
      { wakeTimeoutSeconds: 301 },
      { idleSeconds: -1 },
      {
        faultRecovery: {
          mode: "smart_plug_cycle",
          plugBindingId: id,
          authorization: "operator",
          minimumOffSeconds: 599,
          maximumCyclesPerIncident: 1,
        },
      },
    ])
      expect(
        PowerPolicySchema.safeParse({ ...policy, ...change }).success,
      ).toBe(false);
    expect(
      PowerPreviewStartSchema.safeParse({
        mode: "fault_recovery",
        expectedPolicyVersion: 1,
      }).success,
    ).toBe(false);
  });
  it("never accepts config assertions as real verification or a credential token", () => {
    const conclusions = {
      sleep: "unverified",
      normalShutdown: "unverified",
      wakeFromSleep: "unverified",
      coldBoot: "unverified",
      wolWhilePossiblyOn: "unverified",
      wakeRouteRef: null,
    };
    expect(
      PowerCapabilityUpdateSchema.safeParse({
        expectedMachineVersion: 1,
        conclusions: { ...conclusions, coldBoot: "verified" },
      }).success,
    ).toBe(false);
    const binding = {
      id,
      machineId: id,
      adapter: "xiaomi_miio_lan",
      device: {
        model: "cuco.plug.v3",
        deviceId: "123",
        macAddress: "AA:BB:CC:DD:EE:FF",
      },
      endpointRef: "endpoint:test",
      credentialVersionRef: `secret:${"a".repeat(32)}`,
      dedicatedSupply: "unverified",
      acPowerOn: "unverified",
      verificationReportIds: [],
    };
    expect(
      SmartPlugBindingUpdateSchema.safeParse({
        expectedMachineVersion: 1,
        binding,
      }).success,
    ).toBe(true);
    for (const change of [
      { token: "plaintext" },
      { credentialVersionRef: "secret:latest" },
      { dedicatedSupply: "verified" },
      { verificationReportIds: [id] },
      { device: { ...binding.device, deviceId: "000123" } },
    ])
      expect(
        SmartPlugBindingUpdateSchema.safeParse({
          expectedMachineVersion: 1,
          binding: { ...binding, ...change },
        }).success,
      ).toBe(false);
    expect(consumer).not.toHaveProperty("PowerPolicySchema");
    expect(consumer).not.toHaveProperty("PowerPreviewStateSchema");
  });
});
