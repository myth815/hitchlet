import { expect, it } from "vitest";
import { portainerCapabilityMatches } from "../src/domain/attested-capability.js";

const binding = {
  engineId: "synthetic-engine",
  connectionRevisionId: "synthetic-revision",
  architecture: "arm64",
  providerEvidence: { dockerVersion: "29.0", portainerVersion: "2.45" },
  capacity: { cpuMillis: 2000, memoryMiB: 2048, scratchMiB: 4096 },
};
function evidence() {
  return {
    ...binding,
    admissionMode: "constant_online_manual_inventory",
    offline: false,
    powerEnabled: false,
    cpuHardLimit: "verified",
    memoryHardLimit: "verified",
    capabilityFingerprint: "a".repeat(64),
    providerVersion: "Portainer/2.45; Docker/29.0",
    architectures: ["arm64"],
    guestOs: ["linux"],
    expiresAt: "2000-01-01T00:00:00.000Z",
    manualReport: {
      sha256: "a".repeat(64),
      scopes: { resourceLimits: { status: "passed" } },
    },
  };
}

it("uses unchanged Docker proof after its historical date without extending it", () => {
  const proof = evidence();
  const original = JSON.stringify(proof);
  expect(portainerCapabilityMatches(proof, binding)).toBe(true);
  expect(JSON.stringify(proof)).toBe(original);
});

it.each([
  ["Engine", { engineId: "other" }],
  ["connection revision", { connectionRevisionId: "other" }],
  ["architecture", { architecture: "amd64" }],
  [
    "Docker version",
    {
      providerEvidence: { ...binding.providerEvidence, dockerVersion: "30.0" },
    },
  ],
  [
    "Portainer version",
    {
      providerEvidence: {
        ...binding.providerEvidence,
        portainerVersion: "3.0",
      },
    },
  ],
  ["capacity", { capacity: { ...binding.capacity, memoryMiB: 4096 } }],
] as const)(
  "rejects changed %s even though old evidence passed",
  (_name, changed) => {
    expect(
      portainerCapabilityMatches(evidence(), { ...binding, ...changed }),
    ).toBe(false);
  },
);

it.each(["cpuHardLimit", "memoryHardLimit", "manualReport", "capacity"])(
  "rejects absent %s rather than treating time-independent as unverified admission",
  (field) => {
    const proof: Record<string, unknown> = evidence();
    delete proof[field];
    expect(portainerCapabilityMatches(proof, binding)).toBe(false);
  },
);

it("does not let a resource-only proof claim filtered or SSH capability", () => {
  expect(
    portainerCapabilityMatches(
      { ...evidence(), networkPolicyEnforcement: "verified" },
      binding,
    ),
  ).toBe(false);
  expect(
    portainerCapabilityMatches(
      { ...evidence(), supportedAccess: ["ssh"] },
      binding,
    ),
  ).toBe(false);
});
