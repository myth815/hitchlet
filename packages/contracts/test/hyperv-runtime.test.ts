import { expect, it } from "vitest";
import {
  hyperVInspectionSchema,
  hyperVGuestBootstrapRequestSchema,
  hyperVRequestSchema,
  hyperVRuntimeActionRequestSchema,
} from "../src/hyperv-runtime.js";
const identity = {
  installationId: "i",
  runtimeIdentityId: "r",
  connectionRevisionId: "c",
  allocationId: "a",
  generation: 1,
  operationId: "o",
  controlVersion: 1,
  purpose: "tenant",
};
it("keeps guest OS independent from x64 host/backend metadata", () => {
  const base = {
    identity,
    template: {
      configPath: "E:\\Templates\\base.vmcx",
      configSha256: "a".repeat(64),
      guestOs: "linux",
      architecture: "amd64",
      generation: 2,
    },
    resources: { cpus: 4, memoryMiB: 4096 },
    switchName: "Existing Switch",
  };
  expect(hyperVRequestSchema.parse(base).template.guestOs).toBe("linux");
  expect(
    hyperVRequestSchema.parse({
      ...base,
      template: { ...base.template, guestOs: "windows" },
    }).template.guestOs,
  ).toBe("windows");
  expect(
    hyperVRequestSchema.safeParse({
      ...base,
      template: { ...base.template, architecture: "arm64" },
    }).success,
  ).toBe(false);
});
it("rejects mismatched runtime envelopes and arbitrary native actions", () => {
  const request = {
    requestNonce: "11111111-1111-4111-8111-111111111111",
    installationId: "i",
    runtimeIdentityId: "r",
    controllerEpoch: 1,
    deadline: "2030-01-01T00:00:00Z",
    action: { kind: "inspect", identity },
  };
  expect(hyperVRuntimeActionRequestSchema.safeParse(request).success).toBe(
    true,
  );
  expect(
    hyperVRuntimeActionRequestSchema.safeParse({
      ...request,
      runtimeIdentityId: "other",
    }).success,
  ).toBe(false);
  expect(
    hyperVRuntimeActionRequestSchema.safeParse({
      ...request,
      action: { kind: "import", identity },
    }).success,
  ).toBe(false);
});
it("requires observed native identity for present and complete inventory for absent", () => {
  const base = {
    identity,
    presence: "unknown",
    inventoryComplete: false,
    bootstrapStatus: "not_implemented",
  };
  expect(hyperVInspectionSchema.safeParse(base).success).toBe(true);
  expect(
    hyperVInspectionSchema.safeParse({ ...base, presence: "present" }).success,
  ).toBe(false);
  expect(
    hyperVInspectionSchema.safeParse({ ...base, presence: "absent" }).success,
  ).toBe(false);
  expect(
    hyperVInspectionSchema.safeParse({
      ...base,
      presence: "absent",
      inventoryComplete: true,
    }).success,
  ).toBe(true);
});

it("bootstrap accepts only public material and the same runtime envelope", () => {
  const key = "ssh-ed25519 " + "A".repeat(68);
  const bootstrap = {
    identity,
    vmId: "11111111-1111-4111-8111-111111111111",
    nonce: "bootstrap-0123456789",
    account: "workspace",
    guestOs: "windows",
    architecture: "amd64",
    clientPublicKey: key,
    clientPublicKeyFingerprint: "SHA256:" + "A".repeat(43),
  };
  expect(hyperVGuestBootstrapRequestSchema.safeParse(bootstrap).success).toBe(
    true,
  );
  expect(
    hyperVGuestBootstrapRequestSchema.safeParse({
      ...bootstrap,
      privateKey: "secret",
    }).success,
  ).toBe(false);
  expect(
    hyperVRuntimeActionRequestSchema.safeParse({
      requestNonce: "11111111-1111-4111-8111-111111111111",
      installationId: "i",
      runtimeIdentityId: "foreign",
      controllerEpoch: 1,
      deadline: "2030-01-01T00:00:00Z",
      action: { kind: "bootstrap.apply", request: bootstrap },
    }).success,
  ).toBe(false);
});
