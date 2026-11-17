import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ReadyInventoryHttpQuerySchema } from "@hitchlet/contracts";
import type { Principal } from "./auth.js";
import { AuthFailure } from "./auth.js";
import type { TicketReadyInventoryReader } from "../application/ticket-ready-inventory.js";
import { ApplicationError } from "../application/errors.js";
/** Existing own-ticket authentication; a GET, never a lifecycle command. */
export function registerReadyInventoryRoute(
  app: FastifyInstance,
  identify: (request: FastifyRequest, write?: boolean) => Promise<Principal>,
  reader: TicketReadyInventoryReader,
) {
  app.get<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/ready-inventory",
    async (request, reply) => {
      const actor = await identify(request, false);
      if (!actor.scopes.includes("tickets:read"))
        throw new AuthFailure("forbidden");
      const ticket = z.string().uuid().safeParse(request.params.ticketId);
      const query = ReadyInventoryHttpQuerySchema.safeParse(request.query);
      if (!ticket.success || !query.success)
        throw new ApplicationError("invalid_request");
      const { leaseId, generation, ...expected } = query.data;
      const result = await reader.read(actor.consumerId, ticket.data, {
        leaseId,
        generation,
        ...(Object.keys(expected).length ? { expected } : {}),
      });
      if (!result) throw new ApplicationError("not_found");
      reply.header("Cache-Control", "no-store");
      return result;
    },
  );
}
