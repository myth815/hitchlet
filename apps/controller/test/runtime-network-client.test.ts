import { describe, expect, it } from "vitest";
import {
  assertRuntimeNetworkResponse,
  buildRuntimeNetworkCommand,
  buildRuntimeNetworkPlan,
} from "../src/providers/runtime-network-client.js";

const plan = buildRuntimeNetworkPlan({
  installationId: "install",
  runtimeIdentityId: "runtime",
  nativeEngineId: "engine",
  allocationId: "allocation",
  generation: 1,
  operationId: "operation",
  controlVersion: 1,
  networkId: "network",
  networkName: "hl-allocation",
  networkSubnet: "172.30.77.0/24",
  containerIds: ["container"],
  bridgeInterface: "br-0123456789ab",
  bridgeGateway: "172.30.77.1",
  userlandProxy: true,
  publishedPorts: [
    {
      containerId: "container",
      protocol: "tcp",
      hostPort: 24001,
      containerPort: 22,
      hostAddress: "192.0.2.10",
    },
  ],
  grantId: "grant",
  networkRevisionId: "network-revision",
  frozenDenyRevisionId: "deny-frozen",
  effectiveDenyRevisionId: "deny-effective",
  ingressSourceCidrs: ["192.0.2.0/24"],
  egress: [{ cidr: "192.0.2.20/32", protocol: "tcp", ports: [2049] }],
  managementDeny: [],
});

const ensure = buildRuntimeNetworkCommand({
  kind: "network.ensure",
  installationId: plan.installationId,
  runtimeIdentityId: plan.runtimeIdentityId,
  agentId: "agent",
  commandId: "command",
  operationId: plan.operationId,
  allocationId: plan.allocationId,
  generation: plan.generation,
  controlVersion: plan.controlVersion,
  controllerEpoch: 1,
  deadline: new Date(Date.now() + 60_000).toISOString(),
  plan,
});

describe("Runtime Network Agent response binding", () => {
  it("accepts only evidence for the requested command and exact ruleset", () => {
    const result = {
      commandId: ensure.commandId,
      operationId: ensure.operationId,
      allocationId: ensure.allocationId,
      generation: ensure.generation,
      nativeEngineId: plan.nativeEngineId,
      status: "installed" as const,
      rulesetHash: plan.expectedRulesetHash,
      verifiedAt: new Date().toISOString(),
    };
    expect(() => assertRuntimeNetworkResponse(ensure, result)).not.toThrow();
    expect(() =>
      assertRuntimeNetworkResponse(ensure, { ...result, commandId: "other" }),
    ).toThrow(/does not match the command/);
    expect(() =>
      assertRuntimeNetworkResponse(ensure, {
        ...result,
        rulesetHash: "sha256:" + "0".repeat(64),
      }),
    ).toThrow(/ruleset hash mismatch/);
  });
});
