import { toPublicJsonSchema } from "@hitchlet/contracts";
import { z } from "zod";
import {
  hostPairingRequestSchema,
  hostPairingReceiptSchema,
  hostEnrollRequestSchema,
  hostEnrollReceiptSchema,
  hostBootRequestSchema,
  hostBootReceiptSchema,
  hostHeartbeatSchema,
  hostHeartbeatReceiptSchema,
  hostSessionViewSchema,
  hostAgentViewSchema,
  hostRevokeRequestSchema,
  hostSnapshotViewSchema,
} from "@hitchlet/contracts/internal";
import { AdminSchemas } from "./admin-protocol.js";

export function openApiDocument() {
  const converted = toPublicJsonSchema() as {
    properties: Record<string, unknown>;
    $defs?: Record<string, unknown>;
  };
  const rewriteRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteRefs);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "$ref" &&
        typeof item === "string" &&
        item.startsWith("#/$defs/")
          ? item.replace("#/$defs/", "#/components/schemas/")
          : rewriteRefs(item),
      ]),
    );
  };
  const schemas = rewriteRefs({
    ...(converted.$defs ?? {}),
    ...converted.properties,
  }) as Record<string, unknown>;
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const json = (schema: unknown) => ({ "application/json": { schema } });
  const response = (description: string, schema?: unknown) => ({
    description,
    ...(schema ? { content: json(schema) } : {}),
  });
  const errors = {
    "401": response("Authentication required", ref("ApiErrorResponse")),
    "403": response("Forbidden", ref("ApiErrorResponse")),
    "404": response("Not found", ref("ApiErrorResponse")),
    "409": response("Conflict", ref("ApiErrorResponse")),
    "412": response("Version conflict", ref("ApiErrorResponse")),
    "422": response("Invalid request", ref("ApiErrorResponse")),
    "429": response("Admission limit", ref("ApiErrorResponse")),
    "503": response("Recovery or storage unavailable", ref("ApiErrorResponse")),
  };
  const errorsExceptConflict = {
    "401": errors["401"],
    "403": errors["403"],
    "404": errors["404"],
    "412": errors["412"],
    "422": errors["422"],
    "429": errors["429"],
    "503": errors["503"],
  };
  const security = [{ bearerAuth: [] }, { sessionCookie: [] }];
  const parameter = (
    name: string,
    location: "path" | "query" | "header",
    schema: unknown,
    required = true,
  ) => ({ name, in: location, required, schema });
  const pathId = (name: string) =>
    parameter(name, "path", { type: "string", format: "uuid" });
  const ifMatch = () =>
    parameter("If-Match", "header", {
      type: "string",
      pattern: '^\\"?[1-9][0-9]*\\"?$',
    });
  const body = (name: string) => ({ required: true, content: json(ref(name)) });
  const operation = (
    summary: string,
    successCode: string,
    successSchema: string,
    extra: Record<string, unknown> = {},
  ) => ({
    summary,
    security,
    responses: {
      [successCode]: response(summary, ref(successSchema)),
      ...errors,
    },
    ...extra,
  });
  const adminOperation = (
    summary: string,
    successCode = "200",
    requestSchema: z.ZodType | undefined,
    responseSchema: z.ZodType,
    parameters: Record<string, unknown>[] = [],
  ) => ({
    summary,
    description: "Requires a full-scope administrator bearer or session.",
    security,
    ...(parameters.length ? { parameters } : {}),
    ...(requestSchema
      ? {
          requestBody: {
            required: true,
            content: json(z.toJSONSchema(requestSchema)),
          },
        }
      : {}),
    responses: {
      [successCode]: response(summary, z.toJSONSchema(responseSchema)),
      ...errors,
    },
  });
  return {
    openapi: "3.1.0",
    info: { title: "Hitchlet API", version: "1.0.0" },
    paths: {
      "/v1/agents/pairings": {
        post: adminOperation(
          "Create or replace a disabled Host single-use pairing",
          "201",
          hostPairingRequestSchema,
          hostPairingReceiptSchema,
        ),
      },
      "/v1/agents/enroll": {
        post: {
          ...adminOperation(
            "Consume a five-minute Machine-bound pairing",
            "201",
            hostEnrollRequestSchema,
            hostEnrollReceiptSchema,
          ),
          security: [],
          description:
            "Single-use pairing credential. The returned Host credential is shown once; no-store.",
        },
      },
      "/v1/agents/{agentId}/session": {
        get: {
          ...adminOperation(
            "Read current Host control and sender epochs",
            "200",
            undefined,
            hostSessionViewSchema,
            [pathId("agentId")],
          ),
          security: [{ hostCredential: [] }],
          description:
            "Host bearer only; consumer and Runtime credentials are rejected.",
        },
      },
      "/v1/agents/{agentId}/boot": {
        post: {
          ...adminOperation(
            "Fence a new Host process with session epoch CAS",
            "200",
            hostBootRequestSchema,
            hostBootReceiptSchema,
            [pathId("agentId")],
          ),
          security: [{ hostCredential: [] }],
          description:
            "Host bearer only. Historical boot IDs cannot be revived.",
        },
      },
      "/v1/agents/{agentId}/heartbeat": {
        post: {
          ...adminOperation(
            "Persist an authenticated physical Host observation",
            "200",
            hostHeartbeatSchema,
            hostHeartbeatReceiptSchema,
            [pathId("agentId")],
          ),
          security: [{ hostCredential: [] }],
          description:
            "Host bearer only; binds installation, Machine, boot, epoch, sequence and time. Duplicate receipt does not refresh observation age.",
        },
      },
      "/v1/agents/{agentId}": {
        get: adminOperation(
          "Read non-secret Host registration",
          "200",
          undefined,
          hostAgentViewSchema,
          [pathId("agentId")],
        ),
      },
      "/v1/agents/{agentId}/revoke": {
        post: {
          ...adminOperation(
            "Revoke Host credentials with session CAS and reason audit",
            "204",
            hostRevokeRequestSchema,
            z.null(),
            [pathId("agentId")],
          ),
          responses: { "204": response("Host credential revoked"), ...errors },
        },
      },
      "/v1/machines/{machineId}/snapshot": {
        get: adminOperation(
          "Read latest Host evidence; stale or revoked observations are unknown",
          "200",
          undefined,
          hostSnapshotViewSchema.nullable(),
          [pathId("machineId")],
        ),
      },
      "/v1/admin/installation": {
        get: adminOperation(
          "Read non-secret installation and platform network-deny metadata",
          "200",
          undefined,
          AdminSchemas.AdminInstallationViewSchema,
        ),
      },
      "/v1/auth/session": {
        post: {
          summary:
            "Exchange a full-scope bearer credential for a browser session",
          security: [{ bearerAuth: [] }],
          responses: {
            "201": response("Session created", ref("AuthenticatedPrincipal")),
            "401": errors["401"],
            "403": errors["403"],
            "429": errors["429"],
            "422": errors["422"],
          },
        },
        delete: {
          summary: "Revoke the current browser session",
          security: [{ sessionCookie: [] }],
          parameters: [parameter("X-CSRF-Token", "header", { type: "string" })],
          responses: {
            "204": response("Session revoked"),
            "401": errors["401"],
            "403": errors["403"],
          },
        },
      },
      "/v1/auth/me": {
        get: operation(
          "Get the authenticated principal",
          "200",
          "AuthenticatedPrincipal",
        ),
      },
      "/v1/tickets": {
        get: operation("List own tickets", "200", "TicketSummaryPage", {
          parameters: [
            parameter("cursor", "query", { type: "string" }, false),
            parameter(
              "limit",
              "query",
              { type: "integer", minimum: 1, maximum: 200 },
              false,
            ),
            parameter("phase", "query", { type: "string" }, false),
          ],
        }),
        post: operation("Acquire a ticket", "202", "AcquireReceipt", {
          parameters: [
            parameter("Idempotency-Key", "header", { type: "string" }),
          ],
          requestBody: body("AcquireRequest"),
        }),
      },
      "/v1/tickets/{ticketId}": {
        get: operation("Get own ticket", "200", "TicketView", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter("If-None-Match", "header", { type: "string" }, false),
          ],
          responses: {
            "200": response("Ticket snapshot", ref("TicketView")),
            "304": response("Ticket has not changed"),
            ...errors,
          },
        }),
      },
      "/v1/tickets/{ticketId}/release": {
        post: operation("Release a ticket", "202", "TicketView", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter("Idempotency-Key", "header", { type: "string" }),
          ],
          requestBody: body("ReleaseRequest"),
          responses: {
            "200": response("Already released", ref("TicketView")),
            "202": response("Reclaim in progress", ref("TicketView")),
            ...errors,
          },
        }),
      },
      "/v1/tickets/{ticketId}/cancel": {
        post: operation("Cancel a ticket", "202", "TicketView", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter("Idempotency-Key", "header", { type: "string" }),
          ],
          requestBody: body("CancelRequest"),
          responses: {
            "200": response("Already released", ref("TicketView")),
            "202": response(
              "Cancellation or reclaim is in progress",
              ref("TicketView"),
            ),
            ...errors,
          },
        }),
      },
      "/v1/tickets/{ticketId}/revoke": {
        post: operation("Revoke a ticket as operator", "202", "TicketView", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter("Idempotency-Key", "header", { type: "string" }),
          ],
          requestBody: body("RevokeRequest"),
          responses: {
            "200": response("Already released", ref("TicketView")),
            "202": response(
              "Revocation or reclaim is in progress",
              ref("TicketView"),
            ),
            ...errors,
          },
        }),
      },
      "/v1/tickets/{ticketId}/renew": {
        post: operation("Propose a lease renewal", "200", "RenewReceipt", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter("Idempotency-Key", "header", { type: "string" }),
          ],
          requestBody: body("RenewRequest"),
          responses: {
            "200": response("Confirmed renewal", ref("RenewReceipt")),
            "202": response("Pending renewal", ref("RenewOutcome")),
            "409": response("Rejected renewal", ref("RenewOutcome")),
            ...errorsExceptConflict,
          },
        }),
      },
      "/v1/tickets/{ticketId}/renewals/{renewalId}": {
        get: operation("Get a renewal decision", "200", "LeaseRenewalView", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter("renewalId", "path", { type: "string", format: "uuid" }),
          ],
        }),
      },
      "/v1/tickets/{ticketId}/access": {
        post: operation("Get Simulator access material", "200", "AccessGrant", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter("Idempotency-Key", "header", { type: "string" }),
          ],
          requestBody: body("AccessCommandRequest"),
        }),
      },
      "/v1/tickets/{ticketId}/events": {
        get: operation("List own ticket events", "200", "ResourceEventPage", {
          parameters: [
            parameter("ticketId", "path", { type: "string", format: "uuid" }),
            parameter(
              "after",
              "query",
              { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
              false,
            ),
            parameter(
              "limit",
              "query",
              { type: "integer", minimum: 1, maximum: 200 },
              false,
            ),
          ],
        }),
      },
      "/v1/events": {
        get: operation("List own events", "200", "ResourceEventPage", {
          parameters: [
            parameter(
              "after",
              "query",
              { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
              false,
            ),
            parameter(
              "limit",
              "query",
              { type: "integer", minimum: 1, maximum: 200 },
              false,
            ),
            parameter(
              "ticketId",
              "query",
              { type: "string", format: "uuid" },
              false,
            ),
          ],
        }),
      },
      "/v1/events/stream": {
        get: {
          summary: "Stream authorized events with resumable EventCursor",
          security,
          parameters: [
            parameter(
              "Last-Event-ID",
              "header",
              { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
              false,
            ),
            parameter(
              "after",
              "query",
              { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
              false,
            ),
            parameter(
              "ticketId",
              "query",
              { type: "string", format: "uuid" },
              false,
            ),
          ],
          responses: {
            "200": {
              description: "Server-sent ResourceEvent envelopes",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors,
          },
        },
      },
      "/v1/images": {
        get: operation("List authorized images", "200", "ImageSummaryPage", {
          parameters: [
            parameter("cursor", "query", { type: "string" }, false),
            parameter(
              "limit",
              "query",
              { type: "integer", minimum: 1, maximum: 200 },
              false,
            ),
          ],
        }),
        post: adminOperation(
          "Register a digest-pinned draft image",
          "201",
          AdminSchemas.ImageDraftSchema,
          AdminSchemas.DraftCreationReceiptSchema,
        ),
      },
      "/v1/images/{imageId}/versions": {
        post: adminOperation(
          "Register another immutable architecture/version under an existing image",
          "201",
          AdminSchemas.ImageVersionDraftSchema,
          AdminSchemas.DraftCreationReceiptSchema,
          [pathId("imageId")],
        ),
      },
      "/v1/admin/image-versions/{versionId}": {
        get: adminOperation(
          "Read an internal draft image version and artifacts",
          "200",
          undefined,
          AdminSchemas.DraftVersionViewSchema,
          [pathId("versionId")],
        ),
      },
      "/v1/admin/image-versions": {
        get: adminOperation(
          "List image version summaries across draft and publication states",
          "200",
          undefined,
          z.array(AdminSchemas.AdminImageVersionSummarySchema),
        ),
      },
      "/v1/admin/image-versions/{versionId}/validations": {
        get: adminOperation(
          "List validation history for an image version",
          "200",
          undefined,
          z.array(AdminSchemas.AdminValidationHistoryItemSchema),
          [pathId("versionId")],
        ),
      },
      "/v1/admin/images/{imageId}/aliases": {
        get: adminOperation(
          "Read current image aliases and CAS versions",
          "200",
          undefined,
          z.array(AdminSchemas.AdminImageAliasViewSchema),
          [pathId("imageId")],
        ),
      },
      "/v1/nodes/{nodeId}/image-cache/operations/{operationId}": {
        get: adminOperation(
          "Read a safe receipt for one image-cache operation",
          "200",
          undefined,
          AdminSchemas.AdminCacheOperationReceiptSchema,
          [pathId("nodeId"), pathId("operationId")],
        ),
      },
      "/v1/image-versions/{versionId}": {
        get: operation(
          "Get an authorized image version",
          "200",
          "ImageVersionView",
          {
            parameters: [
              parameter("versionId", "path", {
                type: "string",
                format: "uuid",
              }),
            ],
          },
        ),
      },
      "/v1/provider-connections": {
        get: adminOperation(
          "List Portainer connections and verified revisions",
          "200",
          undefined,
          z.array(AdminSchemas.ProviderConnectionViewSchema),
        ),
        post: adminOperation(
          "Persist and run a read-only Portainer discovery",
          "202",
          AdminSchemas.PortainerConnectionInputSchema,
          AdminSchemas.ProviderOperationReceiptSchema,
        ),
      },
      "/v1/provider-discovery/{operationId}/retry": {
        post: adminOperation(
          "Retry a persisted Portainer discovery",
          "200",
          undefined,
          AdminSchemas.ProviderOperationReceiptSchema,
          [pathId("operationId")],
        ),
      },
      "/v1/provider-discovery/{operationId}": {
        get: adminOperation(
          "Read a safe Portainer discovery operation receipt",
          "200",
          undefined,
          AdminSchemas.ProviderOperationReceiptSchema,
          [pathId("operationId")],
        ),
      },
      "/v1/provider-connections/{connectionId}/revisions": {
        post: adminOperation(
          "Probe and persist a same-Engine connection revision",
          "202",
          AdminSchemas.PortainerConnectionInputSchema,
          AdminSchemas.ProviderOperationReceiptSchema,
          [pathId("connectionId")],
        ),
      },
      "/v1/provider-connection-proposals/{operationId}/retry": {
        post: adminOperation(
          "Retry a persisted same-Engine connection revision proposal",
          "200",
          undefined,
          AdminSchemas.ProviderOperationReceiptSchema,
          [pathId("operationId")],
        ),
      },
      "/v1/provider-connection-proposals/{operationId}": {
        get: adminOperation(
          "Read a safe connection revision operation receipt",
          "200",
          undefined,
          AdminSchemas.ProviderOperationReceiptSchema,
          [pathId("operationId")],
        ),
      },
      "/v1/provider-connections/{connectionId}/activate-revision": {
        post: adminOperation(
          "CAS-activate a verified connection revision",
          "200",
          AdminSchemas.ConnectionActivationSchema,
          AdminSchemas.ConnectionActivationReceiptSchema,
          [pathId("connectionId"), ifMatch()],
        ),
      },
      "/v1/machines": {
        post: adminOperation(
          "Register a conservative manual machine budget",
          "201",
          AdminSchemas.MachineInputSchema,
          AdminSchemas.MachineReceiptSchema,
        ),
      },
      "/v1/nodes": {
        get: adminOperation(
          "List registered nodes",
          "200",
          undefined,
          z.array(AdminSchemas.NodeViewSchema),
        ),
        post: adminOperation(
          "Register a Portainer node with admission disabled",
          "201",
          AdminSchemas.NodeInputSchema,
          AdminSchemas.NodeReceiptSchema,
        ),
      },
      "/v1/nodes/{nodeId}/runtime-config": {
        put: adminOperation(
          "Register Runtime Agent and fixed network/access configuration",
          "200",
          AdminSchemas.NodeRuntimeConfigSchema,
          AdminSchemas.NodeRuntimeConfigReceiptSchema,
          [pathId("nodeId"), ifMatch()],
        ),
      },
      "/v1/nodes/{nodeId}/capability-attestations": {
        post: adminOperation(
          "Import a recent independent manual capability test report and enable constant-online admission",
          "200",
          AdminSchemas.NodeCapabilityAttestationSchema,
          AdminSchemas.NodeCapabilityAttestationReceiptSchema,
          [pathId("nodeId"), ifMatch()],
        ),
      },
      "/v1/network-profiles": {
        get: adminOperation(
          "List network profile revisions",
          "200",
          undefined,
          z.array(AdminSchemas.AdminProfileViewSchema),
        ),
        post: adminOperation(
          "Create a network profile and immutable revision",
          "201",
          AdminSchemas.NetworkProfileInputSchema,
          AdminSchemas.ProfileWriteReceiptSchema,
        ),
      },
      "/v1/storage-profiles": {
        get: adminOperation(
          "List storage profile revisions",
          "200",
          undefined,
          z.array(AdminSchemas.AdminProfileViewSchema),
        ),
        post: adminOperation(
          "Create a storage profile and immutable revision",
          "201",
          AdminSchemas.StorageProfileInputSchema,
          AdminSchemas.ProfileWriteReceiptSchema,
        ),
      },
      "/v1/network-profiles/{profileId}/revisions": {
        post: adminOperation(
          "Create and CAS-activate a network profile revision",
          "201",
          AdminSchemas.NetworkProfileRevisionSchema,
          AdminSchemas.ProfileWriteReceiptSchema,
          [pathId("profileId"), ifMatch()],
        ),
      },
      "/v1/storage-profiles/{profileId}/revisions": {
        post: adminOperation(
          "Create and CAS-activate a storage profile revision",
          "201",
          AdminSchemas.StorageProfileRevisionSchema,
          AdminSchemas.ProfileWriteReceiptSchema,
          [pathId("profileId"), ifMatch()],
        ),
      },
      "/v1/image-versions/{versionId}/artifacts": {
        post: adminOperation(
          "Register an immutable draft artifact",
          "201",
          AdminSchemas.DraftArtifactSchema,
          AdminSchemas.ArtifactReceiptSchema,
          [pathId("versionId")],
        ),
      },
      "/v1/image-versions/{versionId}/validate": {
        post: adminOperation(
          "Schedule a fixed-contract internal validation run",
          "202",
          AdminSchemas.ImageValidationRequestSchema,
          AdminSchemas.ValidationScheduleReceiptSchema,
          [pathId("versionId")],
        ),
      },
      "/v1/image-versions/{versionId}/publish": {
        post: adminOperation(
          "Publish matching, cleaned validation evidence",
          "200",
          AdminSchemas.ImagePublishRequestSchema,
          AdminSchemas.ImagePublishReceiptSchema,
          [pathId("versionId")],
        ),
      },
      "/v1/images/{imageId}/aliases/{alias}": {
        put: adminOperation(
          "Move a published image alias",
          "200",
          AdminSchemas.ImageAliasRequestSchema,
          AdminSchemas.ImageAliasReceiptSchema,
          [
            pathId("imageId"),
            parameter(
              "alias",
              "path",
              z.toJSONSchema(AdminSchemas.ImageAliasNameSchema),
            ),
          ],
        ),
      },
      "/v1/image-validations/{validationId}/cancel": {
        post: adminOperation(
          "Cancel and reclaim an internal validation",
          "200",
          undefined,
          AdminSchemas.AdminValidationViewSchema,
          [pathId("validationId")],
        ),
      },
      "/v1/image-validations/{validationId}": {
        get: adminOperation(
          "Read an internal image validation run",
          "200",
          undefined,
          AdminSchemas.AdminValidationViewSchema,
          [pathId("validationId")],
        ),
      },
      "/v1/nodes/{nodeId}/image-cache/prewarm": {
        post: adminOperation(
          "Persist an exact-artifact cache pull intent",
          "202",
          AdminSchemas.CacheArtifactSchema,
          AdminSchemas.CachePlanReceiptSchema,
          [pathId("nodeId")],
        ),
      },
      "/v1/nodes/{nodeId}/image-cache/gc": {
        post: adminOperation(
          "Persist an unreferenced cache eviction intent",
          "202",
          AdminSchemas.CacheArtifactSchema,
          AdminSchemas.CachePlanReceiptSchema,
          [pathId("nodeId")],
        ),
      },
    },
    components: {
      schemas,
      securitySchemes: {
        hostCredential: {
          type: "http",
          scheme: "bearer",
          description: "Independent physical Host credential, hch_ prefix",
        },
        bearerAuth: { type: "http", scheme: "bearer" },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "hitchlet_session",
        },
      },
    },
  };
}
