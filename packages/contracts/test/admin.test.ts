import { describe, expect, it } from "vitest";
import * as consumerContracts from "../src/index.js";
import { AdminSchemas } from "../src/admin.js";

const uuid = "00000000-0000-4000-8000-000000000001";
const secretRef = `secret:${"a".repeat(32)}`;

describe("shared administrator contracts", () => {
  it("keeps the complete Node runtime and attestation schema at the admin entry", () => {
    expect(
      AdminSchemas.NodeRuntimeConfigSchema.parse({
        accessHost: "gateway.test",
        networkCidrBase: "10.20.0.0/16",
        userlandProxy: false,
        runtimeAgent: {
          id: uuid,
          baseUrl: "https://agent.test",
          tokenSecretRef: secretRef,
          caSecretRef: secretRef,
          clientCertSecretRef: secretRef,
          clientKeySecretRef: secretRef,
        },
        managementDenyRevisionId: uuid,
        managementDenyRules: [
          { cidr: "10.0.0.0/8", protocol: "tcp", ports: [22] },
        ],
      }),
    ).toMatchObject({ runtimeAgent: { id: uuid }, userlandProxy: false });
    expect(
      AdminSchemas.NodeCapabilityAttestationSchema.safeParse({
        expectedEngineId: "engine-a",
        expectedDockerVersion: "29.5.2",
        expectedPortainerVersion: "2.45.2",
        architecture: "amd64",
        checkedAt: "2026-10-20T00:00:00Z",
        report: {
          runId: uuid,
          sha256: "a".repeat(64),
          scopes: Object.fromEntries(
            [
              "resourceLimits",
              "firewallInput",
              "firewallForward",
              "ipv6",
              "sshBootstrap",
              "cleanupRecovery",
            ].map((name) => [
              name,
              {
                status: "passed",
                summary: "checked",
                evidenceRef: "report://evidence",
              },
            ]),
          ),
        },
        networkProfileRevisionIds: [uuid],
      }).success,
    ).toBe(true);
    expect(
      AdminSchemas.NodeRuntimeConfigSchema.safeParse({ unexpected: true })
        .success,
    ).toBe(false);
  });

  it("keeps publication and alias CAS schemas strict and outside the consumer barrel", () => {
    expect(
      AdminSchemas.ImagePublishRequestSchema.parse({
        expectedEntityVersion: 3,
      }),
    ).toEqual({ expectedEntityVersion: 3 });
    expect(
      AdminSchemas.ImageAliasRequestSchema.parse({
        versionId: uuid,
        expectedVersion: 0,
      }),
    ).toEqual({ versionId: uuid, expectedVersion: 0 });
    expect(
      AdminSchemas.ImagePublishRequestSchema.safeParse({
        expectedEntityVersion: 3,
        retry: true,
      }).success,
    ).toBe(false);
    expect(consumerContracts).not.toHaveProperty("NodeRuntimeConfigSchema");
    expect(consumerContracts).not.toHaveProperty("AdminSchemas");
  });
});
