import { expect, it } from "vitest";
import { managementApiPaths } from "../src/http/management-openapi.js";

it("documents read-only catalog preview without a required command key", () => {
  const paths = managementApiPaths();
  const preview = paths["/v1/catalog/preview"].post;
  expect(preview.parameters).not.toContainEqual(
    expect.objectContaining({ name: "Idempotency-Key" }),
  );
  expect(paths["/v1/admin/consumers"].post.parameters).toContainEqual(
    expect.objectContaining({ name: "Idempotency-Key", required: true }),
  );
});
