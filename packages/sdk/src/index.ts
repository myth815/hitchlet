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

export { ComputeClientError } from "./transport.js";
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
    this.http = new HttpTransport(baseUrl, options);
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
}
