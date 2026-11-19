import { expect, it } from "vitest";
import { ImageDraftSchema } from "../src/admin.js";
import {
  CONTAINER_GROUP_BOOTSTRAP,
  containerGroupFromRequirements,
  containerGroupSchema,
} from "../src/container-group.js";
import { runtimeStorageMountSchema } from "../src/runtime-storage.js";

const group = {
  gateway: {
    artifactRef: "example.invalid/gateway@sha256:" + "b".repeat(64),
    digest: "sha256:" + "b".repeat(64),
    resources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
    mountPaths: ["/persist/turbocli-network"],
    stateMountPath: "/var/lib/gateway",
    networkCapability: "tun",
    ipv4Forwarding: true,
  },
  links: [
    { from: "gateway", to: "workload", protocol: "tcp", ports: [3000] },
    { from: "workload", to: "gateway", protocol: "tcp", ports: [18080] },
  ],
};
const bootstrap = {
  mechanism: CONTAINER_GROUP_BOOTSTRAP,
  contractVersion: "1",
  identityReset: true,
};
const draft = {
  name: "container group fixture",
  version: "1",
  architecture: "arm64",
  artifactRef: "example.invalid/workload@sha256:" + "a".repeat(64),
  digest: "sha256:" + "a".repeat(64),
  minimumResources: { cpuMillis: 200, memoryMiB: 256, scratchMiB: 0 },
  bootstrap,
  containerGroup: group,
  access: {
    accessProtocols: [],
    ports: [],
    account: "workspace",
    allowedSourceCidrs: [],
    discovery: "none",
    readiness: "container-running",
  },
  authorizedConsumerIds: ["00000000-0000-4000-8000-000000000001"],
};

it("registers a frozen group with directed TCP links and no business readiness or inbound access", () => {
  expect(ImageDraftSchema.parse(draft).containerGroup).toEqual(group);
  expect(
    containerGroupFromRequirements({ bootstrap, containerGroup: group }),
  ).toEqual(group);
  expect(containerGroupFromRequirements({})).toBeUndefined();
});

it.each([
  { containerGroup: undefined },
  {
    bootstrap: { ...bootstrap, mechanism: "hitchlet-container-entrypoint-v1" },
  },
  { access: { ...draft.access, ports: [22] } },
  { access: { ...draft.access, readiness: "peer-online" } },
  { backend: "tart" },
])("rejects mismatched group recipe metadata %j", (change) => {
  expect(ImageDraftSchema.safeParse({ ...draft, ...change }).success).toBe(
    false,
  );
});

it.each([
  {
    links: [{ from: "workload", to: "workload", protocol: "tcp", ports: [80] }],
  },
  {
    links: [{ from: "gateway", to: "workload", protocol: "udp", ports: [80] }],
  },
  { links: [{ from: "gateway", to: "workload", protocol: "tcp", ports: [0] }] },
  { gateway: { ...group.gateway, digest: "sha256:" + "c".repeat(64) } },
  { gateway: { ...group.gateway, privileged: true } },
  { gateway: { ...group.gateway, stateMountPath: "/var/lib/.." } },
  {
    gateway: {
      ...group.gateway,
      mountPaths: ["/persist/gateway", "/persist/gateway"],
    },
  },
  { gateway: { ...group.gateway, networks: ["other"] } },
  { gateway: { ...group.gateway, networkCapability: "sys_admin" } },
])(
  "rejects unbound images, arbitrary privileges or undeclared links %j",
  (change) => {
    expect(
      containerGroupSchema.safeParse({ ...group, ...change }).success,
    ).toBe(false);
  },
);

it("uses the existing dedicated persistent reference target rules", () => {
  const mount = {
    grantId: "fixture-grant",
    revisionId: "fixture-revision",
    approvedSourceRef: "/approved",
    authorizedSubpath: "config",
    protocol: "local",
    secretVersionRef: null,
    target: "/persist/turbocli-network",
    mode: "read_only",
  };
  expect(runtimeStorageMountSchema.safeParse(mount).success).toBe(true);
  expect(
    runtimeStorageMountSchema.safeParse({ ...mount, target: "/etc/turbocli" })
      .success,
  ).toBe(false);
});
