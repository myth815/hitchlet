import { toPublicJsonSchema } from "@hitchlet/contracts";

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
  return {
    openapi: "3.1.0",
    info: { title: "Hitchlet API", version: "1.0.0" },
    paths: {
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
    },
    components: {
      schemas,
      securitySchemes: {
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
