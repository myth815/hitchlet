import type { AcquireRequest, TicketView } from "./index.js";
const request: AcquireRequest | undefined = undefined;
const response: TicketView | undefined = undefined;
void request;
void response;

// @ts-expect-error Actor is internal authorization context and must not cross the package root.
import type { Actor } from "./index.js";
// @ts-expect-error Provider execution contracts are internal.
import type { ResourceProvider } from "./index.js";
// @ts-expect-error Admission policy context belongs to the controller domain.
import type { AcquireNormalizationContext } from "./index.js";
