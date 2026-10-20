import {
  HealthResponseSchema,
  ImageSummaryPageSchema,
  ImageVersionViewSchema,
  PageQuerySchema,
} from "@hitchlet/contracts";
import type {
  ComputeClient,
  ImageSummary,
  ImageVersionView,
  Id,
  PageQuery,
  TicketClient,
} from "@hitchlet/contracts/public";
import type { HealthResponse } from "@hitchlet/contracts/health";
import {
  ComputeClientError,
  HttpTransport,
  type SdkOptions,
} from "./transport.js";
import { TicketCommands } from "./tickets.js";
import { SessionCommands } from "./session.js";
import { AdminCommands } from "./admin.js";
import { ManagementSchemas } from "@hitchlet/contracts/admin";
import { AcquireRequestSchema, type AcquireRequest } from "@hitchlet/contracts";

export { ComputeClientError } from "./transport.js";
export { AdminCommands } from "./admin.js";
export { PreparedManagementRevokeSchema } from "@hitchlet/contracts/admin";
export { PreparedManagementRequestSchema } from "@hitchlet/contracts/admin";
export type { PreparedManagementRequest } from "@hitchlet/contracts/admin";
export type {
  AuthorizedCatalog,
  ConsumerInput,
  ConsumerUpdate,
  ConsumerView,
  ManagementTicketQuery,
  AdmissionUpdate,
  OperationRetry,
  MachineInput,
  NodeRuntimeConfigInput,
  PortainerConnectionInput,
  ImageDraftInput,
  DraftArtifactInput,
  PreparedManagementRevoke,
} from "@hitchlet/contracts/admin";
export type {
  SystemHealth,
  BackupView,
  CredentialRotationRequest,
  RecoveryApproval,
  AdminImageAliasView,
  AdminImageVersionSummary,
  AdminValidationHistoryItem,
} from "@hitchlet/contracts/admin";
/** @deprecated Use ComputeClientError; retained as an alias for the original health-only SDK. */
export { ComputeClientError as HitchletApiError } from "./transport.js";
export type {
  RecoveryReference,
  SdkAuth,
  SdkOptions,
  SdkRuntime,
} from "./transport.js";
export type * from "@hitchlet/contracts/public";

function validateRequest<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new ComputeClientError({
      code: "INVALID_REQUEST",
      message: "The request does not match the public contract.",
      cause: error,
    });
  }
}

/** Consumer SDK entry point. Authentication is injected and never persisted by the SDK. */
export class HitchletClient implements ComputeClient {
  readonly admin: AdminCommands;
  readonly session: Pick<SessionCommands, "create" | "me" | "logout">;
  readonly tickets: TicketClient;
  readonly images: {
    list(query?: PageQuery): Promise<{
      readonly items: readonly ImageSummary[];
      readonly nextCursor: string | null;
    }>;
    getVersion(versionId: Id): Promise<ImageVersionView>;
  };
  private readonly http: HttpTransport;
  private readonly options: SdkOptions;

  /**
   * Construct against an API base URL. Passing a fetch function in the second position
   * preserves the original health-client constructor; pass SdkOptions for auth/runtime hooks.
   */
  constructor(
    baseUrl: string,
    optionsOrFetch: SdkOptions | typeof fetch = {},
    legacyOptions: Omit<SdkOptions, "fetch"> = {},
  ) {
    const options: SdkOptions =
      typeof optionsOrFetch === "function"
        ? { ...legacyOptions, fetch: optionsOrFetch }
        : optionsOrFetch;
    this.options = options;
    this.http = new HttpTransport(baseUrl, options);
    this.admin = new AdminCommands(this.http);
    this.session = new SessionCommands(this.http);
    this.tickets = new TicketCommands(this.http);
    this.images = {
      list: async (query = {}) => {
        const parsed = validateRequest(PageQuerySchema, query);
        const params = new URLSearchParams();
        if (parsed.cursor !== undefined) params.set("cursor", parsed.cursor);
        if (parsed.limit !== undefined)
          params.set("limit", String(parsed.limit));
        const suffix = params.size ? `?${params.toString()}` : "";
        return this.http.request(
          `/v1/images${suffix}`,
          "GET",
          undefined,
          (value) => ImageSummaryPageSchema.parse(value),
        );
      },
      getVersion: (versionId) =>
        this.http.request(
          `/v1/image-versions/${encodeURIComponent(versionId)}`,
          "GET",
          undefined,
          (value) => ImageVersionViewSchema.parse(value),
        ),
    };
  }

  /** Read the shared health contract; this does not authenticate or expose lease data. */
  async health(): Promise<HealthResponse> {
    return this.http.request("/healthz", "GET", undefined, (value) =>
      HealthResponseSchema.parse(value),
    );
  }
  /** Creates an independent client using the same transport/auth configuration and a per-workflow persistence hook. */
  withManagementPreparation(
    onManagementPrepared: NonNullable<SdkOptions["onManagementPrepared"]>,
    onManagementSettled?: NonNullable<SdkOptions["onManagementSettled"]>,
  ) {
    return new HitchletClient(this.http.baseUrl.toString(), {
      ...this.options,
      onManagementPrepared,
      ...(onManagementSettled ? { onManagementSettled } : {}),
    });
  }
  /** Safe authorized choices; no host source, secret version or backend address reaches the consumer. */
  catalog() {
    return this.http.request("/v1/catalog", "GET", undefined, (v) =>
      ManagementSchemas.AuthorizedCatalogSchema.parse(v),
    );
  }
  /** Read-only feasibility. It does not reserve capacity or change a Ticket. */
  preview(request: AcquireRequest) {
    return this.http.request(
      "/v1/catalog/preview",
      "POST",
      AcquireRequestSchema.parse(request),
      (v) => ManagementSchemas.FeasibilitySchema.parse(v),
      { key: crypto.randomUUID(), retry: false },
    );
  }
  /** Resumable event notifications; a disconnect never changes server resource state. */
  watchEvents(
    after: string,
    signal: AbortSignal,
    onEvent: (event: import("@hitchlet/contracts").ResourceEvent) => void,
    onConnected: () => void = () => {},
  ) {
    return this.http.watchEvents(after, signal, onEvent, onConnected);
  }
}
