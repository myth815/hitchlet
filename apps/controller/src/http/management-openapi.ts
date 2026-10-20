import { z } from "zod";
import { ManagementSchemas as S } from "@hitchlet/contracts/admin";
import { TicketViewSchema } from "@hitchlet/contracts";
import {
  ManagementDenyUpdateSchema,
  AdminInstallationViewSchema,
} from "@hitchlet/contracts/admin";

/** Runtime contracts are the protocol authority; this document embeds those schemas, never hand-copied DTO fields. */
export function managementApiPaths() {
  const endpoint = (
    summary: string,
    response: z.ZodType,
    body?: z.ZodType,
    parameters: unknown[] = [],
  ) => ({
    summary,
    description:
      "Current role/scopes and consumer grants are checked on every request; cookie writes require X-CSRF-Token. Management writes use a stable Idempotency-Key, and unknown outcomes must be investigated through original receipts.",
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    parameters,
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: z.toJSONSchema(body) } },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Current authoritative view or safe receipt",
        content: { "application/json": { schema: z.toJSONSchema(response) } },
      },
      "201": {
        description: "Created",
        content: { "application/json": { schema: z.toJSONSchema(response) } },
      },
      "403": { description: "Forbidden" },
      "404": { description: "Not in current authorized scope or not found" },
      "409": { description: "Conflict or original management outcome unknown" },
      "412": { description: "CAS version conflict" },
      "422": { description: "Invalid input" },
    },
  });
  const id = (name: string) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    }),
    key = {
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 200 },
    };
  return {
    "/v1/admin/network-deny": {
      put: endpoint(
        "CAS management protection revision; live Claims forbid loosening",
        AdminInstallationViewSchema,
        ManagementDenyUpdateSchema,
        [key],
      ),
    },
    "/v1/catalog": {
      get: endpoint(
        "Safe authorized image/version, network/storage and placement directory",
        S.AuthorizedCatalogSchema,
      ),
    },
    "/v1/catalog/preview": {
      post: endpoint(
        "Read-only eligibility snapshot; never reserves capacity",
        S.FeasibilitySchema,
        S.AcquireRequestSchema,
        [key],
      ),
    },
    "/v1/admin/overview": {
      get: endpoint(
        "Actor-scoped complete counts and capacity observations",
        S.ManagementOverviewSchema,
      ),
    },
    "/v1/admin/tickets": {
      get: endpoint(
        "Paginated safe Ticket views in current management scope",
        S.ManagementTicketPageSchema,
        undefined,
        [
          "consumerId",
          "nodeId",
          "imageVersionId",
          "phase",
          "cursor",
          "limit",
        ].map((name) => ({
          name,
          in: "query",
          required: false,
          schema: { type: "string" },
        })),
      ),
    },
    "/v1/admin/tickets/{ticketId}": {
      get: endpoint(
        "Read scoped Ticket frozen contract",
        TicketViewSchema,
        undefined,
        [id("ticketId")],
      ),
    },
    "/v1/admin/tickets/{ticketId}/timeline": {
      get: endpoint(
        "Safe original operations and event timeline",
        S.ManagementTimelineSchema,
        undefined,
        [id("ticketId")],
      ),
    },
    "/v1/admin/operations": {
      get: endpoint(
        "Recent safe original operation summaries (up to 200)",
        S.ManagementOperationSchema.array(),
      ),
    },
    "/v1/admin/operations/{operationId}/retry": {
      post: endpoint(
        "CAS retry of a failed original allocation operation; unknown is inspected first",
        S.ManagementOperationSchema,
        S.OperationRetrySchema,
        [id("operationId"), key],
      ),
    },
    "/v1/nodes/{id}/admission": {
      put: endpoint(
        "Scoped CAS drain/resume; disabled Node requires trusted attestation",
        S.VersionReceiptSchema,
        S.AdmissionUpdateSchema,
        [id("id"), key],
      ),
    },
    "/v1/machines/{id}/admission": {
      put: endpoint(
        "CAS admission for fully authorized machine",
        S.VersionReceiptSchema,
        S.AdmissionUpdateSchema,
        [id("id"), key],
      ),
    },
    "/v1/admin/consumers": {
      get: endpoint(
        "Full administrator Consumer configuration",
        S.ConsumerViewSchema.array(),
      ),
      post: endpoint(
        "Create Consumer with explicit quotas and grants",
        S.ConsumerViewSchema,
        S.ConsumerInputSchema,
        [key],
      ),
    },
    "/v1/admin/consumers/{id}": {
      put: endpoint(
        "Transactional CAS edit; existing tokens never gain scopes and accepted Tickets remain frozen",
        S.ConsumerViewSchema,
        S.ConsumerUpdateSchema,
        [id("id"), key],
      ),
    },
    "/v1/admin/credentials": {
      post: endpoint(
        "One-time credential; journal contains metadata only, response cannot be replayed",
        S.IssuedCredentialSchema,
        S.IssueCredentialSchema,
        [key],
      ),
    },
    "/v1/admin/policies": {
      get: endpoint(
        "Destroy policy names and associations; TTL comes from Consumer quota",
        S.LifecyclePolicyViewSchema.array(),
      ),
      post: endpoint(
        "Create destroy-policy name",
        S.LifecyclePolicyViewSchema,
        S.LifecyclePolicyInputSchema,
        [key],
      ),
    },
    "/v1/admin/policies/{id}": {
      put: endpoint(
        "CAS edit destroy-policy name only",
        S.LifecyclePolicyViewSchema,
        S.LifecyclePolicyUpdateSchema,
        [id("id"), key],
      ),
    },
    "/v1/admin/image-versions/{id}/retire": {
      post: endpoint(
        "CAS retire publication for new requests; accepted Tickets retain the artifact",
        S.VersionReceiptSchema,
        S.ImageRetireSchema,
        [id("id"), key],
      ),
    },
    "/v1/admin/commands": {
      get: endpoint(
        "Safe metadata of the caller's original management commands, last 100",
        S.AdminCommandReceiptSchema.array(),
      ),
    },
    "/v1/admin/commands/review": {
      post: endpoint(
        "Audit human investigation; never marks an unknown backend effect successful",
        S.AdminCommandReceiptSchema,
        S.AdminCommandReviewSchema,
        [key],
      ),
    },
  };
}
