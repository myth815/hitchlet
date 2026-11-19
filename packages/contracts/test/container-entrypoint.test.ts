import { describe, expect, it } from "vitest";
import { AccessRequestSchema } from "../src/schemas.js";
import { ImageDraftSchema } from "../src/admin.js";
import { supportsContainerEntrypoint } from "../src/container-entrypoint.js";

const bootstrap = {
  mechanism: "hitchlet-container-entrypoint-v1",
  contractVersion: "1",
  identityReset: true,
};
const access = {
  accessProtocols: [],
  ports: [],
  account: "workspace",
  allowedSourceCidrs: [],
  discovery: "none",
  readiness: "container-running",
};
const draft = {
  name: "entrypoint fixture",
  version: "1",
  architecture: "arm64",
  artifactRef: "example.invalid/worker@sha256:" + "a".repeat(64),
  digest: "sha256:" + "a".repeat(64),
  minimumResources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
  bootstrap,
  access,
  authorizedConsumerIds: ["00000000-0000-4000-8000-000000000001"],
};
describe("fixed entrypoint resource delivery", () => {
  it("accepts explicit no-access and matching recipe metadata", () => {
    expect(AccessRequestSchema.parse({ protocol: "none" })).toEqual({
      protocol: "none",
    });
    expect(ImageDraftSchema.parse(draft).access).toEqual(access);
    expect(supportsContainerEntrypoint({ bootstrap }, access)).toBe(true);
  });
  it("does not accept interactive keys on no-access requests", () => {
    expect(
      AccessRequestSchema.safeParse({
        protocol: "none",
        clientPublicKey: "x".repeat(40),
      }).success,
    ).toBe(false);
    expect(
      AccessRequestSchema.safeParse({
        protocol: "ssh",
        clientPublicKey: "x".repeat(40),
      }).success,
    ).toBe(true);
  });
  it.each([
    { bootstrap: { ...bootstrap, mechanism: "hitchlet-node-ssh-v1" } },
    { access: { ...access, ports: [22] } },
    { access: { ...access, accessProtocols: ["ssh"] } },
    { access: { ...access, readiness: "external-session-online" } },
  ])("rejects a mismatched no-access recipe %j", (change) => {
    expect(ImageDraftSchema.safeParse({ ...draft, ...change }).success).toBe(
      false,
    );
  });
});
