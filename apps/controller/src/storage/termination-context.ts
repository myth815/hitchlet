/** Safe reference to the reserved command whose completion is committed atomically with termination. */
export interface IdempotencyCompletionRef {
  /** Authenticated principal that reserved the route-scoped key. */
  readonly consumerId: string;
  readonly routeScope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly ticketId: string;
}

/** Conditions and durable side effects for one ticket termination decision. */
export interface TerminationContext {
  /** Optional Ticket CAS condition; versions are monotonically increasing integers. */
  readonly expectedTicketVersion?: number;
  /** Optional expected lease/allocation generation; null means an unallocated queued Ticket. */
  readonly expectedGeneration?: number | null;
  /** Safe administrative audit fields; never sourced from an untrusted request principal. */
  readonly audit?: {
    readonly actorId: string;
    readonly requestId: string;
    readonly reason: string;
  };
  /** Reference to the pending idempotency reservation; request bodies are not persisted here. */
  readonly completion?: IdempotencyCompletionRef;
}
