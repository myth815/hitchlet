import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ManagementSchemas as S,
  ManagementDenyUpdateSchema,
  AdminInstallationViewSchema,
} from "@hitchlet/contracts/admin";
import { TicketViewSchema } from "@hitchlet/contracts";
import type { Principal } from "./auth.js";
import { AuthFailure } from "./auth.js";
import { ManagementService } from "../application/management.js";
import { AdminCommandJournal } from "../application/admin-command-journal.js";
import type { Storage } from "../storage/index.js";
import { ApplicationError } from "../application/errors.js";
import { z } from "zod";

/** Narrow HTTP adapters; all projection, scope and persistence work belongs to the management use cases. */
export function registerManagementRoutes(
  app: FastifyInstance,
  db: Storage,
  identify: (request: FastifyRequest, write?: boolean) => Promise<Principal>,
  requireAdmin: (
    request: FastifyRequest,
    write?: boolean,
  ) => Promise<Principal>,
) {
  const service = new ManagementService(db),
    journal = new AdminCommandJournal(db);
  const input = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApplicationError("invalid_request");
    return parsed.data;
  };
  const param = (r: FastifyRequest, key: string) =>
    input(z.string().uuid(), (r.params as Record<string, unknown>)[key]);
  const manager = async (r: FastifyRequest, write = false) => {
    const actor = await identify(r, write);
    if (
      !["admin", "operator", "viewer"].includes(actor.role) ||
      !actor.scopes.includes(write ? "tickets:revoke" : "tickets:read") ||
      (write && actor.role === "viewer")
    )
      throw new AuthFailure("forbidden");
    return actor;
  };
  app.put("/v1/admin/network-deny", async (r, reply) => {
    const actor = await requireAdmin(r, true);
    reply.header("Cache-Control", "no-store");
    return AdminInstallationViewSchema.parse(
      await service.updateNetworkDeny(
        input(ManagementDenyUpdateSchema, r.body),
        actor.consumerId,
        r.id,
      ),
    );
  });
  app.get("/v1/catalog", async (r, reply) => {
    const actor = await identify(r);
    if (!actor.scopes.includes("images:read"))
      throw new AuthFailure("forbidden");
    reply.header("Cache-Control", "no-store");
    return S.AuthorizedCatalogSchema.parse(
      await service.catalog(actor.consumerId),
    );
  });
  app.post("/v1/catalog/preview", async (r, reply) => {
    const actor = await identify(r, true);
    if (!actor.scopes.includes("tickets:write") || actor.role === "viewer")
      throw new AuthFailure("forbidden");
    reply.header("Cache-Control", "no-store");
    return S.FeasibilitySchema.parse(
      await service.feasibility(
        actor.consumerId,
        input(S.AcquireRequestSchema, r.body),
      ),
    );
  });
  app.get("/v1/admin/commands", async (r, reply) => {
    const actor = await manager(r);
    reply.header("Cache-Control", "no-store");
    return S.AdminCommandReceiptSchema.array().parse(
      await journal.receipts(actor.consumerId),
    );
  });
  app.post("/v1/admin/commands/review", async (r, reply) => {
    const actor = await manager(r, true);
    reply.header("Cache-Control", "no-store");
    return S.AdminCommandReceiptSchema.parse(
      await journal.review(
        actor.consumerId,
        input(S.AdminCommandReviewSchema, r.body),
        r.id,
      ),
    );
  });
  app.get("/v1/admin/overview", async (r, reply) => {
    const actor = await manager(r);
    reply.header("Cache-Control", "no-store");
    return service.overview(actor);
  });
  app.get("/v1/admin/tickets", async (r, reply) => {
    const actor = await manager(r);
    reply.header("Cache-Control", "no-store");
    return service.ticketsPage(
      actor,
      input(S.ManagementTicketQuerySchema, r.query),
    );
  });
  app.get("/v1/admin/tickets/:ticketId", async (r, reply) => {
    const actor = await manager(r);
    reply.header("Cache-Control", "no-store");
    return TicketViewSchema.parse(
      await service.ticket(actor, param(r, "ticketId")),
    );
  });
  app.get("/v1/admin/tickets/:ticketId/timeline", async (r, reply) => {
    const actor = await manager(r);
    reply.header("Cache-Control", "no-store");
    return S.ManagementTimelineSchema.parse(
      await service.timeline(actor, param(r, "ticketId")),
    );
  });
  app.get("/v1/admin/operations", async (r, reply) => {
    const actor = await manager(r);
    reply.header("Cache-Control", "no-store");
    return S.ManagementOperationSchema.array().parse(
      await service.operations(actor),
    );
  });
  app.post("/v1/admin/operations/:operationId/retry", async (r, reply) => {
    const actor = await manager(r, true);
    reply.header("Cache-Control", "no-store");
    return S.ManagementOperationSchema.parse(
      await service.retry(
        actor,
        param(r, "operationId"),
        input(S.OperationRetrySchema, r.body),
        r.id,
      ),
    );
  });
  for (const kind of ["nodes", "machines"] as const)
    app.put(`/v1/${kind}/:id/admission`, async (r, reply) => {
      const actor = await manager(r, true);
      reply.header("Cache-Control", "no-store");
      return S.VersionReceiptSchema.parse(
        await service.admission(
          actor,
          kind,
          param(r, "id"),
          input(S.AdmissionUpdateSchema, r.body),
          r.id,
        ),
      );
    });
  app.get("/v1/admin/consumers", async (r, reply) => {
    await requireAdmin(r);
    reply.header("Cache-Control", "no-store");
    return S.ConsumerViewSchema.array().parse(await service.consumers());
  });
  app.post("/v1/admin/consumers", async (r, reply) => {
    const actor = await requireAdmin(r, true);
    reply.header("Cache-Control", "no-store");
    return reply
      .code(201)
      .send(
        await service.saveConsumer(
          input(S.ConsumerInputSchema, r.body),
          actor.consumerId,
          r.id,
        ),
      );
  });
  app.put("/v1/admin/consumers/:id", async (r, reply) => {
    const actor = await requireAdmin(r, true);
    reply.header("Cache-Control", "no-store");
    return service.saveConsumer(
      input(S.ConsumerUpdateSchema, r.body),
      actor.consumerId,
      r.id,
      param(r, "id"),
    );
  });
  app.post("/v1/admin/credentials", async (r, reply) => {
    const actor = await requireAdmin(r, true);
    const key = input(z.string().min(1).max(200), r.headers["idempotency-key"]);
    reply.header("Cache-Control", "no-store");
    return reply
      .code(201)
      .send(
        S.IssuedCredentialSchema.parse(
          await service.issueCredential(
            input(S.IssueCredentialSchema, r.body).consumerId,
            actor.consumerId,
            r.id,
            key,
          ),
        ),
      );
  });
  app.get("/v1/admin/policies", async (r, reply) => {
    await requireAdmin(r);
    reply.header("Cache-Control", "no-store");
    return S.LifecyclePolicyViewSchema.array().parse(await service.policies());
  });
  app.post("/v1/admin/policies", async (r, reply) => {
    const actor = await requireAdmin(r, true);
    reply.header("Cache-Control", "no-store");
    return S.LifecyclePolicyViewSchema.parse(
      await service.savePolicy(
        input(S.LifecyclePolicyInputSchema, r.body).name,
        actor.consumerId,
        r.id,
      ),
    );
  });
  app.put("/v1/admin/policies/:id", async (r, reply) => {
    const actor = await requireAdmin(r, true),
      body = input(S.LifecyclePolicyUpdateSchema, r.body);
    reply.header("Cache-Control", "no-store");
    return S.LifecyclePolicyViewSchema.parse(
      await service.savePolicy(
        body.name,
        actor.consumerId,
        r.id,
        param(r, "id"),
        body.expectedVersion,
      ),
    );
  });
  app.post("/v1/admin/image-versions/:id/retire", async (r, reply) => {
    const actor = await requireAdmin(r, true),
      body = input(S.ImageRetireSchema, r.body);
    reply.header("Cache-Control", "no-store");
    return S.VersionReceiptSchema.parse(
      await service.retire(
        param(r, "id"),
        body.expectedEntityVersion,
        body.reason,
        actor.consumerId,
        r.id,
      ),
    );
  });
}
