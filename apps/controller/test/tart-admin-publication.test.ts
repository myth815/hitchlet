import { describe, expect, it } from "vitest";
import { DraftArtifactSchema } from "@hitchlet/contracts/admin";

describe("Tart artifact administration contract", () => {
  it("accepts an immutable local macOS VM artifact with explicit provenance", () => {
    const artifact = {
      backendKind: "tart",
      kind: "vm",
      architecture: "arm64",
      guestOs: "macos",
      artifactRef: "sonoma-arm64",
      digest: `sha256:${"a".repeat(64)}`,
      minimumResources: { cpuMillis: 2000, memoryMiB: 4096, scratchMiB: 0 },
      requirements: {
        bootstrap: {
          mechanism: "tart-guest-bootstrap-v1",
          contractVersion: "1",
          identityReset: true,
        },
        requiredCapabilities: [],
      },
      access: {
        accessProtocols: ["ssh"],
        ports: [22],
        account: "workspace",
        allowedSourceCidrs: ["10.0.0.0/8"],
        discovery: "guest_ipv4",
        readiness: "authenticated_ssh",
      },
    };

    expect(DraftArtifactSchema.safeParse(artifact).success).toBe(true);
  });
});
