export type ApplicationErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "queue_limit_exceeded"
  | "idempotency_key_reused"
  | "lease_not_renewable"
  | "profile_grant_revoked"
  | "execution_mode_unsupported"
  | "generation_conflict"
  | "lease_version_conflict"
  | "ticket_version_conflict"
  | "lease_expired"
  | "claim_deadline_expired"
  | "lease_lifetime_exhausted"
  | "renewal_deadline_expired"
  | "renewal_in_progress"
  | "lease_not_accessible";
export class ApplicationError extends Error {
  constructor(readonly code: ApplicationErrorCode) {
    super(code);
    this.name = "ApplicationError";
  }
}
export const notFound = () => new ApplicationError("not_found");
export const conflict = (code: ApplicationErrorCode = "conflict") =>
  new ApplicationError(code);
export const queueLimitExceeded = () =>
  new ApplicationError("queue_limit_exceeded");
export const preconditionFailed = (
  code:
    | "generation_conflict"
    | "lease_version_conflict"
    | "ticket_version_conflict" = "lease_version_conflict",
) => new ApplicationError(code);
