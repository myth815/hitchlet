import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CleanupProofHttpQuerySchema } from "@hitchlet/contracts";
import type { Principal } from "./auth.js";
import { AuthFailure } from "./auth.js";
import type { TicketCleanupProofReader } from "../application/ticket-cleanup-proof.js";
import { ApplicationError } from "../application/errors.js";

/** An ordinary GET query; existing authentication and own-ticket scope.
 * No recoverable-write journal, idempotency command or new role/grant. */
export function registerCleanupProofRoute(
  app: FastifyInstance,
  identify: (request: FastifyRequest, write?: boolean) => Promise<Principal>,
  reader: TicketCleanupProofReader,
) {
  app.get<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/cleanup-proof",
    async (request, reply) => {
      const actor = await identify(request, false);
      if (!actor.scopes.includes("tickets:read"))
        throw new AuthFailure("forbidden");
      const ticket = z.string().uuid().safeParse(request.params.ticketId),
        query = CleanupProofHttpQuerySchema.safeParse(request.query);
      if (!ticket.success || !query.success)
        throw new ApplicationError("invalid_request");
      const { leaseId, generation, ...expected } = query.data;
      const proof = await reader.read(actor.consumerId, ticket.data, {
        leaseId,
        generation,
        ...(Object.keys(expected).length ? { expected } : {}),
      });
      if (!proof) throw new ApplicationError("not_found");
      reply.header("Cache-Control", "no-store");
      return proof;
    },
  );
}
