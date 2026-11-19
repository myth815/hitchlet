import { expect, it } from "vitest";
import { NetworkProfileRevisionSchema } from "../src/admin.js";
import { networkDestinationSchema } from "../src/network-destination.js";

const host = {
  cidr: "203.0.113.10/32",
  protocol: "tcp",
  ports: [8443],
  destinationScope: "host",
};

it("accepts explicit host endpoints through the ordinary profile contract", () => {
  const policy = {
    allowedEgress: [host, { ...host, cidr: "203.0.113.11/32", ports: [22] }],
    allowedIngressSourceCidrs: [],
    ipv6: "disabled",
  };
  expect(NetworkProfileRevisionSchema.parse({ policy })).toEqual({ policy });
});

it("preserves omitted scope without materializing a default or changing forwarded UDP", () => {
  const forward = { cidr: "198.51.100.0/24", protocol: "udp", ports: [53] };
  expect(networkDestinationSchema.parse(forward)).toEqual(forward);
  expect(
    networkDestinationSchema.parse({ ...forward, destinationScope: "forward" }),
  ).toEqual({ ...forward, destinationScope: "forward" });
});

it.each([
  { cidr: "0.0.0.0/0" },
  { cidr: "0.0.0.0/32" },
  { cidr: "203.0.113.0/24" },
  { cidr: "::1/128" },
  { cidr: "host.invalid/32" },
  { cidr: "203.0.113.300/32" },
  { cidr: "203.0.113.10" },
  { cidr: "*/32" },
  { protocol: "udp" },
  { ports: [] },
  { ports: "any" },
  { ports: [0] },
  { ports: [65536] },
  { ports: ["22"] },
  { destinationScope: "any" },
])("rejects non-explicit host destinations %j", (change) => {
  const rule = { ...host, ...change };
  expect(networkDestinationSchema.safeParse(rule).success).toBe(false);
  expect(
    NetworkProfileRevisionSchema.safeParse({
      policy: {
        allowedEgress: [rule],
        allowedIngressSourceCidrs: [],
        ipv6: "disabled",
      },
    }).success,
  ).toBe(false);
});

it("freezes native Docker bridge mode without changing omitted/filtered policies", () => {
  const policy = {
    dockerMode: "bridge",
    allowedEgress: [],
    allowedIngressSourceCidrs: [],
    ipv6: "disabled",
  };
  expect(NetworkProfileRevisionSchema.parse({ policy })).toEqual({ policy });
  for (const change of [
    { dockerMode: "any" },
    { allowedEgress: [host] },
    { allowedIngressSourceCidrs: ["192.0.2.0/24"] },
    { ipv6: "verified_equivalent" },
  ])
    expect(
      NetworkProfileRevisionSchema.safeParse({
        policy: { ...policy, ...change },
      }).success,
    ).toBe(false);
  for (const dockerMode of [undefined, "filtered"])
    expect(
      NetworkProfileRevisionSchema.safeParse({
        policy: {
          allowedIngressSourceCidrs: [],
          ipv6: "disabled",
          ...(dockerMode ? { dockerMode } : {}),
          allowedEgress: [host],
        },
      }).success,
    ).toBe(true);
});
