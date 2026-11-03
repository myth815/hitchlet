import { expect, it } from "vitest";
import {
  vmAllocationIdentitySchema,
  vmAllocationOwnerTuple,
  vmResourceSpecSchema,
} from "../src/vm-runtime-identity.js";
import {
  tartAllocationIdentitySchema,
  tartAllocationOwnerTuple,
  tartResourceSpecSchema,
} from "../src/tart-runtime.js";
const identity = {
  installationId: "i",
  runtimeIdentityId: "r",
  connectionRevisionId: "c",
  allocationId: "a",
  generation: 1,
  operationId: "op",
  controlVersion: 1,
  purpose: "tenant" as const,
};
it("preserves existing Tart identity/resource wire contracts as aliases", () => {
  expect(tartAllocationIdentitySchema).toBe(vmAllocationIdentitySchema);
  expect(tartResourceSpecSchema).toBe(vmResourceSpecSchema);
  expect(tartAllocationIdentitySchema.parse(identity)).toEqual(identity);
  expect(tartAllocationOwnerTuple(identity)).toEqual(
    vmAllocationOwnerTuple(identity),
  );
});
it("keeps operation fences out of ownership but retains generation and purpose", () => {
  expect(
    vmAllocationOwnerTuple({
      ...identity,
      operationId: "next",
      controlVersion: 3,
    }),
  ).toEqual(vmAllocationOwnerTuple(identity));
  expect(vmAllocationOwnerTuple({ ...identity, generation: 2 })).not.toEqual(
    vmAllocationOwnerTuple(identity),
  );
  expect(
    vmAllocationOwnerTuple({ ...identity, purpose: "validation" }),
  ).not.toEqual(vmAllocationOwnerTuple(identity));
});
it("retains strict validation for incomplete or expanded identities", () => {
  expect(() =>
    vmAllocationIdentitySchema.parse({ ...identity, controlVersion: 0 }),
  ).toThrow();
  expect(() =>
    tartAllocationIdentitySchema.parse({ ...identity, provider: "hyperv" }),
  ).toThrow();
});
