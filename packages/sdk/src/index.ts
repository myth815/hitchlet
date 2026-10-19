import {
  HealthResponseSchema,
  type HealthResponse,
} from "@hitchlet/contracts/health";
export class HitchletApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HitchletApiError";
  }
}
export class HitchletClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async health(): Promise<HealthResponse> {
    const response = await this.fetcher(new URL("/healthz", this.baseUrl));
    if (!response.ok)
      throw new HitchletApiError(
        response.status,
        `Hitchlet API returned HTTP ${response.status}`,
      );
    const parsed = HealthResponseSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new HitchletApiError(
        response.status,
        "Hitchlet API returned an invalid health response",
      );
    return parsed.data;
  }
}
