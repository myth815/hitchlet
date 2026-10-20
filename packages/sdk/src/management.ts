import {
  ManagementSchemas as S,
  type ConsumerInput,
  type ConsumerUpdate,
  type ManagementTicketQuery,
  type OperationRetry,
  type AdmissionUpdate,
  type AdminCommandReview,
} from "@hitchlet/contracts/admin";
import {
  TicketViewSchema,
  RevokeRequestSchema,
  type RevokeRequest,
} from "@hitchlet/contracts";
import { queryString, type HttpTransport } from "./transport.js";
const path = encodeURIComponent;
/** Actor-scoped management queries. Operator visibility is checked again by the controller for every write. */
export class ManagementCommands {
  constructor(private readonly http: HttpTransport) {}
  overview() {
    return this.http.request("/v1/admin/overview", "GET", undefined, (v) =>
      S.ManagementOverviewSchema.parse(v),
    );
  }
  tickets(query: ManagementTicketQuery = {}) {
    const q = S.ManagementTicketQuerySchema.parse(query);
    return this.http.request(
      `/v1/admin/tickets${queryString(q)}`,
      "GET",
      undefined,
      (v) => S.ManagementTicketPageSchema.parse(v),
    );
  }
  ticket(id: string) {
    return this.http.request(
      `/v1/admin/tickets/${path(id)}`,
      "GET",
      undefined,
      (v) => TicketViewSchema.parse(v),
    );
  }
  timeline(id: string) {
    return this.http.request(
      `/v1/admin/tickets/${path(id)}/timeline`,
      "GET",
      undefined,
      (v) => S.ManagementTimelineSchema.parse(v),
    );
  }
  operations() {
    return this.http.request("/v1/admin/operations", "GET", undefined, (v) =>
      S.ManagementOperationSchema.array().parse(v),
    );
  }
  retryOperation(id: string, body: OperationRetry, key: string) {
    return this.http.request(
      `/v1/admin/operations/${path(id)}/retry`,
      "POST",
      S.OperationRetrySchema.parse(body),
      (v) => S.ManagementOperationSchema.parse(v),
      { key, retry: false },
    );
  }
  revoke(id: string, body: RevokeRequest, key: string) {
    return this.http.request(
      `/v1/tickets/${path(id)}/revoke`,
      "POST",
      RevokeRequestSchema.parse(body),
      (v) => TicketViewSchema.parse(v),
      { key, retry: false },
    );
  }
  admission(
    kind: "nodes" | "machines",
    id: string,
    body: AdmissionUpdate,
    key: string,
  ) {
    return this.http.request(
      `/v1/${kind}/${path(id)}/admission`,
      "PUT",
      S.AdmissionUpdateSchema.parse(body),
      (v) => S.VersionReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  consumers() {
    return this.http.request("/v1/admin/consumers", "GET", undefined, (v) =>
      S.ConsumerViewSchema.array().parse(v),
    );
  }
  createConsumer(body: ConsumerInput, key: string) {
    return this.http.request(
      "/v1/admin/consumers",
      "POST",
      S.ConsumerInputSchema.parse(body),
      (v) => S.ConsumerViewSchema.parse(v),
      { key, retry: false },
    );
  }
  updateConsumer(id: string, body: ConsumerUpdate, key: string) {
    return this.http.request(
      `/v1/admin/consumers/${path(id)}`,
      "PUT",
      S.ConsumerUpdateSchema.parse(body),
      (v) => S.ConsumerViewSchema.parse(v),
      { key, retry: false },
    );
  }
  /** One-time bearer: never retried, journalled or persisted by the SDK. Read metadata before issuing a replacement after an unknown response. */
  issueCredential(consumerId: string, key: string = crypto.randomUUID()) {
    return this.http.request(
      "/v1/admin/credentials",
      "POST",
      S.IssueCredentialSchema.parse({ consumerId }),
      (v) => S.IssuedCredentialSchema.parse(v),
      { key, retry: false },
    );
  }
  policies() {
    return this.http.request("/v1/admin/policies", "GET", undefined, (v) =>
      S.LifecyclePolicyViewSchema.array().parse(v),
    );
  }
  createPolicy(name: string, key: string) {
    return this.http.request(
      "/v1/admin/policies",
      "POST",
      S.LifecyclePolicyInputSchema.parse({ name }),
      (v) => S.LifecyclePolicyViewSchema.parse(v),
      { key, retry: false },
    );
  }
  updatePolicy(id: string, name: string, expectedVersion: number, key: string) {
    return this.http.request(
      `/v1/admin/policies/${path(id)}`,
      "PUT",
      S.LifecyclePolicyUpdateSchema.parse({ name, expectedVersion }),
      (v) => S.LifecyclePolicyViewSchema.parse(v),
      { key, retry: false },
    );
  }
  retire(
    id: string,
    expectedEntityVersion: number,
    reason: string,
    key: string,
  ) {
    return this.http.request(
      `/v1/admin/image-versions/${path(id)}/retire`,
      "POST",
      S.ImageRetireSchema.parse({ expectedEntityVersion, reason }),
      (v) => S.VersionReceiptSchema.parse(v),
      { key, retry: false },
    );
  }
  commandReceipts() {
    return this.http.request("/v1/admin/commands", "GET", undefined, (v) =>
      S.AdminCommandReceiptSchema.array().parse(v),
    );
  }
  /** Records investigation, never turns an unknown operation into success or releases its Claim. */
  reviewCommand(body: AdminCommandReview) {
    return this.http.request(
      "/v1/admin/commands/review",
      "POST",
      S.AdminCommandReviewSchema.parse(body),
      (v) => S.AdminCommandReceiptSchema.parse(v),
      { key: crypto.randomUUID(), retry: false },
    );
  }
}
