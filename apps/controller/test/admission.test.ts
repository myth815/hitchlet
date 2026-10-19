import { describe, expect, it } from "vitest";
import {
  normalizeAcquireRequest,
  type AcquireNormalizationContext,
} from "../src/domain/admission.js";
import type { AcquireRequest } from "@hitchlet/contracts";

const id = "00000000-0000-4000-8000-000000000001";
const request: AcquireRequest = {
  image: { versionId: id },
  networkProfileId: id,
  resources: { cpuMillis: 1000, memoryMiB: 512, scratchMiB: 0 },
};
const context: AcquireNormalizationContext = {
  resolvedImageVersionId: id,
  authorizedArchitectures: ["amd64", "arm64"],
  authorizedProviders: ["portainer"],
  authorizedSiteIds: [id],
  authorizedMachineIds: [id],
  authorizedNodeIds: [id],
  resourceMaximums: { cpuMillis: 4000, memoryMiB: 4096, scratchMiB: 8192 },
  maximumTtlSeconds: 3600,
  maximumLifetimeSeconds: 7200,
  queueTimeoutSeconds: 600,
  provisioningTimeoutSeconds: 300,
  defaultExpiryPolicyId: id,
};

describe("pure admission normalization", () => {
  it("freezes defaults and accepted policy across later configuration changes", () => {
    const accepted = normalizeAcquireRequest(request, context);
    expect(accepted.kind).toBe("container");
    expect(accepted.resources.isolation).toBe("shared_kernel");
    expect(accepted.resources.scratchEnforcement).toBe("best_effort");
    expect(accepted.lease).toEqual({
      requestedSeconds: 900,
      maximumLifetimeSeconds: 7200,
      queueTimeoutSeconds: 600,
      provisioningTimeoutSeconds: 300,
      expiryPolicyId: id,
      maximumTtlSeconds: 3600,
    });
    const changed = {
      ...context,
      maximumTtlSeconds: 120,
      defaultExpiryPolicyId: "00000000-0000-4000-8000-000000000002",
    };
    expect(accepted.lease.maximumTtlSeconds).toBe(3600);
    expect(
      normalizeAcquireRequest(request, changed).lease.maximumTtlSeconds,
    ).toBe(120);
  });

  it("rejects policy overruns and never widens authorized scopes", () => {
    const narrowed = normalizeAcquireRequest(
      {
        ...request,
        allowedNodeIds: [id, "00000000-0000-4000-8000-000000000002"],
      },
      context,
    );
    expect(narrowed.allowedNodeIds).toEqual([id]);
    expect(() =>
      normalizeAcquireRequest(
        {
          ...request,
          allowedNodeIds: ["00000000-0000-4000-8000-000000000002"],
        },
        context,
      ),
    ).toThrow(RangeError);
    expect(() =>
      normalizeAcquireRequest(request, { ...context, authorizedNodeIds: [] }),
    ).toThrow(RangeError);
    expect(() =>
      normalizeAcquireRequest(
        { ...request, resources: { ...request.resources, cpuMillis: 5000 } },
        context,
      ),
    ).toThrow(RangeError);
    expect(() =>
      normalizeAcquireRequest(
        { ...request, lease: { requestedSeconds: 3601 } },
        context,
      ),
    ).toThrow(RangeError);
    expect(() =>
      normalizeAcquireRequest(
        { ...request, lease: { maximumLifetimeSeconds: 7201 } },
        context,
      ),
    ).toThrow(RangeError);
  });

  it("copies nested caller data into the accepted snapshot", () => {
    const features = ["avx2"];
    const labels = { purpose: "build" };
    const storage = [
      {
        storageProfileId: id,
        authorizedSubpath: "work",
        mountPath: "/work",
        mode: "read_write" as const,
      },
    ];
    const accepted = normalizeAcquireRequest(
      {
        ...request,
        resources: {
          ...request.resources,
          accelerators: [{ api: "cuda", requiredFeatures: features }],
        },
        labels,
        storage,
      },
      context,
    );
    features.push("mutated");
    labels.purpose = "changed";
    storage[0]!.authorizedSubpath = "changed";
    expect(accepted.resources.accelerators[0]?.requiredFeatures).toEqual([
      "avx2",
    ]);
    expect(accepted.labels).toEqual({ purpose: "build" });
    expect(accepted.storage[0]?.authorizedSubpath).toBe("work");
  });
});
