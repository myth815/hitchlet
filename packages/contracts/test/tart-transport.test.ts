import { expect, it } from "vitest";
import {
  tartRuntimeActionRequestSchema,
  tartRuntimeFactsResponseSchema,
} from "../src/tart-transport.js";

const identity = {
  installationId: "install-1",
  runtimeIdentityId: "runtime-1",
  connectionRevisionId: "rev-1",
  allocationId: "alloc-1",
  generation: 1,
  operationId: "op-1",
  controlVersion: 1,
  purpose: "tenant" as const,
};

it("binds every action to configured installation/runtime identity and validates request nonce/epoch", () => {
  const request = {
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a963",
    deadline: "2030-01-01T00:00:00.000Z",
    controllerEpoch: 2,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    action: { kind: "inspect", identity },
  };
  expect(tartRuntimeActionRequestSchema.safeParse(request).success).toBe(true);
  expect(
    tartRuntimeActionRequestSchema.safeParse({
      ...request,
      action: {
        kind: "inspect",
        identity: { ...identity, runtimeIdentityId: "foreign" },
      },
    }).success,
  ).toBe(false);
  expect(
    tartRuntimeActionRequestSchema.safeParse({ ...request, controllerEpoch: 0 })
      .success,
  ).toBe(false);
  expect(
    tartRuntimeActionRequestSchema.safeParse({ ...request, extra: true })
      .success,
  ).toBe(false);
});

it("binds bootstrap.apply to the full stored operation identity", () => {
  const request = {
    requestNonce: "3b241101-e2bb-4255-8caf-4136c566a969",
    deadline: "2030-01-01T00:00:00.000Z",
    controllerEpoch: 2,
    installationId: identity.installationId,
    runtimeIdentityId: identity.runtimeIdentityId,
    action: {
      kind: "bootstrap.apply",
      identity,
      request: {
        identity,
        nonce: "nonce-0123456789abcdef",
        account: "admin",
        clientPublicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        clientPublicKeyFingerprint:
          "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        networkEvidence: {
          reference: "network-1",
          revisionId: "net-rev",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      },
    },
  };
  expect(tartRuntimeActionRequestSchema.safeParse(request).success).toBe(true);
  expect(
    tartRuntimeActionRequestSchema.safeParse({
      ...request,
      action: {
        ...request.action,
        request: {
          ...request.action.request,
          identity: { ...identity, operationId: "old-op" },
        },
      },
    }).success,
  ).toBe(false);
});

it("exposes only bounded host facts without an implicit qualification claim", () => {
  expect(
    tartRuntimeFactsResponseSchema.safeParse({
      requestNonce: "3b241101-e2bb-4255-8caf-4136c566a963",
      installationId: "install-1",
      runtimeIdentityId: "runtime-1",
      facts: {
        nativeRuntimeNamespaceId: "3b241101-e2bb-4255-8caf-4136c566a962",
        tartVersion: "tart 2.fixture",
        hostOS: "macos",
        hostArch: "arm64",
        hostCpuCount: 8,
        hostMemoryBytes: 32 * 1024 * 1024 * 1024,
        templates: [],
      },
    }).success,
  ).toBe(true);
  expect(
    tartRuntimeFactsResponseSchema.safeParse({
      requestNonce: "3b241101-e2bb-4255-8caf-4136c566a963",
      installationId: "install-1",
      runtimeIdentityId: "runtime-1",
      facts: {
        nativeRuntimeNamespaceId: "3b241101-e2bb-4255-8caf-4136c566a962",
        tartVersion: "tart 2.fixture",
        hostOS: "macos",
        hostArch: "arm64",
        hostCpuCount: 8,
        hostMemoryBytes: 32 * 1024 * 1024 * 1024,
        templates: [],
        networkVerified: true,
      },
    }).success,
  ).toBe(false);
});
