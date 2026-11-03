import { expect, it } from "vitest";
import {
  TartCapabilityAttestationSchema,
  PortainerCapabilityAttestationSchema,
} from "@hitchlet/contracts/admin";
import {
  validTartAttestedCapability,
  validAttestedCapability,
} from "../src/domain/attested-capability.js";

const id = "10000000-0000-4000-8000-000000000001";
const now = Date.now();
const scope = {
  status: "passed" as const,
  summary: "synthetic qualification",
  evidenceRef: "fixture-only",
};
const scopes = {
  resourceLimits: scope,
  sshBootstrap: scope,
  cleanupRecovery: scope,
};
const input = {
  backendKind: "tart",
  networkMode: "trusted_nat",
  expectedNamespaceId: id,
  expectedTartVersion: "2.fixture",
  templateRef: "base",
  templateDigest: `sha256:${"a".repeat(64)}`,
  guestOs: "macos",
  architecture: "arm64",
  checkedAt: new Date(now).toISOString(),
  report: { runId: id, sha256: "a".repeat(64), scopes },
};
it("qualifies NAT with resource/SSH/cleanup evidence without firewall or IPv6 claims", () => {
  expect(TartCapabilityAttestationSchema.safeParse(input).success).toBe(true);
  const { networkMode: _, ...defaultInput } = input;
  expect(TartCapabilityAttestationSchema.parse(defaultInput).networkMode).toBe(
    "trusted_nat",
  );
  expect(
    TartCapabilityAttestationSchema.safeParse({
      ...input,
      networkMode: "isolated",
    }).success,
  ).toBe(false);
  expect(PortainerCapabilityAttestationSchema.safeParse(input).success).toBe(
    false,
  );
  const capability = {
    networkMode: "trusted_nat",
    networkPolicyEnforcement: "unsupported",
    expiresAt: new Date(now + 60_000).toISOString(),
    admissionMode: "constant_online_manual_inventory",
    offline: false,
    powerEnabled: false,
    cpuHardLimit: "verified",
    memoryHardLimit: "verified",
    capabilityFingerprint: "a".repeat(64),
    connectionRevisionId: id,
    nativeNamespaceId: id,
    tartVersion: "2.fixture",
    providerVersion: "Tart/2.fixture",
    templateRef: "base",
    templateDigest: input.templateDigest,
    architecture: "arm64",
    architectures: ["arm64"],
    guestOs: ["macos"],
    capacity: { cpuMillis: 2000, memoryMiB: 2048 },
    manualReport: input.report,
  };
  expect(validTartAttestedCapability(capability, now)).toBe(true);
  expect(
    validTartAttestedCapability(
      { ...capability, networkMode: "isolated" },
      now,
    ),
  ).toBe(false);
  expect(validAttestedCapability(capability, now)).toBe(false);
  expect(
    validTartAttestedCapability(
      {
        ...capability,
        manualReport: { ...input.report, scopes: { sshBootstrap: scope } },
      },
      now,
    ),
  ).toBe(false);
});
