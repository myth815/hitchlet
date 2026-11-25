import { expect, it } from "vitest";
import { PortainerCapabilityAttestationSchema } from "@hitchlet/contracts/admin";
import {
  PORTAINER_FILTERED_SCOPES,
  validAttestedCapability,
} from "../src/domain/attested-capability.js";

const now = Date.now(),
  id = "10000000-0000-4000-8000-000000000001";
const scope = {
  status: "passed",
  summary: "synthetic resource enforcement",
  evidenceRef: "fixture:limits",
};
const input = {
  expectedEngineId: "fixture-engine",
  expectedDockerVersion: "29.0.0",
  expectedPortainerVersion: "2.45.2",
  architecture: "amd64",
  checkedAt: new Date(now).toISOString(),
  report: {
    runId: id,
    sha256: "a".repeat(64),
    scopes: { resourceLimits: scope },
  },
  networkProfileRevisionIds: [id],
};
const capability = {
  expiresAt: new Date(now + 60000).toISOString(),
  admissionMode: "constant_online_manual_inventory",
  offline: false,
  powerEnabled: false,
  connectionRevisionId: id,
  cpuHardLimit: "verified",
  memoryHardLimit: "verified",
  networkPolicyEnforcement: "unsupported",
  supportedAccess: [],
  capabilityFingerprint: "b".repeat(64),
  providerVersion: "Portainer/2.45.2; Docker/29.0.0",
  architectures: ["amd64"],
  guestOs: ["linux"],
  manualReport: input.report,
};

it("accepts resource-only evidence without fabricating optional scopes or filtered/SSH qualification", () => {
  expect(PortainerCapabilityAttestationSchema.parse(input).report).toEqual(
    input.report,
  );
  expect(validAttestedCapability(capability, now)).toBe(true);
  expect(
    validAttestedCapability(
      { ...capability, networkPolicyEnforcement: "verified" },
      now,
    ),
  ).toBe(false);
  expect(
    validAttestedCapability({ ...capability, supportedAccess: ["ssh"] }, now),
  ).toBe(false);
  const report = {
    ...input.report,
    scopes: Object.fromEntries(
      PORTAINER_FILTERED_SCOPES.map((name) => [name, scope]),
    ),
  };
  expect(
    validAttestedCapability(
      {
        ...capability,
        networkPolicyEnforcement: "verified",
        supportedAccess: ["ssh"],
        manualReport: report,
      },
      now,
    ),
  ).toBe(true);
});

it.each([
  {},
  { resourceLimits: { ...scope, status: "failed" } },
  { resourceLimits: { ...scope, status: "not_run" } },
  { resourceLimits: { ...scope, evidenceRef: "" } },
  { resourceLimits: scope, imaginaryProbe: scope },
])("rejects missing, failed or invented resource evidence %j", (scopes) => {
  expect(
    PortainerCapabilityAttestationSchema.safeParse({
      ...input,
      report: { ...input.report, scopes },
    }).success,
  ).toBe(false);
});

it.each([
  { cpuHardLimit: "unverified" },
  { memoryHardLimit: "unsupported" },
  { manualReport: { ...input.report, scopes: {} } },
  { offline: true },
])("retains required base health evidence %j", (change) => {
  expect(validAttestedCapability({ ...capability, ...change }, now)).toBe(
    false,
  );
});

it.each([
  ["a historical expiresAt", new Date(0).toISOString()],
  ["an unparsable expiresAt", "not-a-date"],
  ["an absent expiresAt", undefined],
  ["a future expiresAt", new Date(now + 600000).toISOString()],
])(
  "keeps a Docker qualification valid for %s without treating it as a health fact",
  (_label, expiresAt) => {
    const candidate: Record<string, unknown> = { ...capability, expiresAt };
    expect(validAttestedCapability(candidate, now)).toBe(true);
    expect(validAttestedCapability({ ...candidate, offline: true }, now)).toBe(
      false,
    );
    expect(
      validAttestedCapability(
        { ...candidate, cpuHardLimit: "unverified" },
        now,
      ),
    ).toBe(false);
  },
);
