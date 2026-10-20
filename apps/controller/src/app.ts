import {
  MaintenanceService,
  admissionOpen,
} from "./application/maintenance.js";
import { approveRecovery } from "./application/recovery.js";
import {
  DiagnosticsSchema,
  CredentialListSchema,
  CredentialQuerySchema,
  SystemHealthSchema,
  AdmissionPauseSchema,
  BackupViewSchema,
  BackupListSchema,
  BackupCreateSchema,
  CredentialRotationSchema,
  CredentialReceiptSchema,
  RecoveryApprovalSchema,
} from "@hitchlet/contracts/admin";
import { PowerService, startPowerRecovery } from "./application/power.js";
import { PowerSchemas } from "@hitchlet/contracts/admin";
import { HealthResponseSchema } from "@hitchlet/contracts/health";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { redact } from "./config.js";
import { createHash, randomUUID } from "node:crypto";
import {
  AcquireRequestSchema,
  AcquireReceiptSchema,
  AccessCommandRequestSchema,
  CancelRequestSchema,
  ReleaseRequestSchema,
  RenewRequestSchema,
  RenewReceiptSchema,
  LeaseRenewalViewSchema,
  EventQuerySchema,
  TicketListQuerySchema,
  PageQuerySchema,
  ImageSummaryPageSchema,
  ImageVersionViewSchema,
  ApiErrorResponseSchema,
  ResourceEventPageSchema,
  ResourceEventSchema,
  RevokeRequestSchema,
  AuthenticatedPrincipalSchema,
} from "@hitchlet/contracts";
import { HostAgents } from "./application/host-agents.js";
import {
  hostPairingRequestSchema,
  hostEnrollRequestSchema,
  hostBootRequestSchema,
  hostHeartbeatSchema,
  hostRevokeRequestSchema,
} from "@hitchlet/contracts/internal";
import type { Storage } from "./storage/index.js";
import { TicketService } from "./application/tickets.js";
import { TicketQueries } from "./application/queries.js";
import { Authenticator, AuthFailure } from "./http/auth.js";
import { openApiDocument } from "./http/openapi.js";
import { TicketCommandService } from "./application/commands.js";
import { LeaseService } from "./application/leases.js";
import { AccessService } from "./application/access.js";
import { ApplicationError } from "./application/errors.js";
import { AdminService } from "./application/admin.js";
import {
  ImageAliasNameSchema,
  ImagePublishRequestSchema,
  ImagePublishReceiptSchema,
  ImageAliasRequestSchema,
  ImageAliasReceiptSchema,
  PortainerConnectionInputSchema,
  ConnectionActivationSchema,
  ConnectionActivationReceiptSchema,
  MachineInputSchema,
  NodeInputSchema,
  NodeAdmissionModeSchema,
  NodeAdmissionModeReceiptSchema,
  NodeRuntimeConfigSchema,
  NodeCapabilityAttestationSchema,
  NetworkProfileInputSchema,
  NetworkProfileRevisionSchema,
  StorageProfileInputSchema,
  StorageProfileRevisionSchema,
  ImageDraftSchema,
  ImageVersionDraftSchema,
  DraftArtifactSchema,
  ImageValidationRequestSchema,
  CacheArtifactSchema,
  ProviderConnectionViewSchema,
  NodeViewSchema,
  AdminInstallationViewSchema,
  AdminProfileViewSchema,
  AdminValidationViewSchema,
  AdminImageVersionSummarySchema,
  AdminValidationHistoryItemSchema,
  AdminImageAliasViewSchema,
  AdminCacheOperationReceiptSchema,
  ProviderOperationReceiptSchema,
  MachineReceiptSchema,
  NodeReceiptSchema,
  ProfileWriteReceiptSchema,
  DraftCreationReceiptSchema,
  DraftVersionViewSchema,
  ArtifactReceiptSchema,
  ValidationScheduleReceiptSchema,
  CachePlanReceiptSchema,
  MachineDependencyViewSchema,
  MachinePolicyUpdateSchema,
  MachinePolicyDryRunSchema,
  MachinePolicyReceiptSchema,
} from "./http/admin-protocol.js";
import type { ImageValidationRequest } from "@hitchlet/contracts/internal";
import { probePortainer } from "./providers/portainer-probe.js";
import { LocalSecretStore } from "./storage/secret-store.js";
import { StorageError } from "./storage/index.js";
import { z, ZodError, type ZodType } from "zod";

export interface AppRuntime {
  readonly storage?: Storage;
  readonly maintenance?: MaintenanceService;
  readonly logStream?: NodeJS.WritableStream;
  readonly recoveryState?: () => "ready" | "recovering" | "unavailable";
  readonly secrets?: LocalSecretStore;
}
type Row = Record<string, string | number | bigint | null>;
export async function buildApp(
  config: Config,
  runtime: AppRuntime = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      ...(runtime.logStream ? { stream: runtime.logStream } : {}),
      redact: {
        paths: ["req.headers.*"],
        censor: "[REDACTED]",
      },
    },
  });
  // Install the shared API envelope before registering routes or awaiting any
  // plugin compilation, so static-enabled and API-only apps behave identically.
  app.setErrorHandler((error, request, reply) => {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    const applicationStatus =
      error instanceof ApplicationError
        ? error.code === "not_found"
          ? 404
          : error.code === "invalid_request"
            ? 422
            : error.code === "queue_limit_exceeded"
              ? 429
              : error.code === "agent_epoch_conflict" ||
                  error.code === "generation_conflict" ||
                  error.code === "lease_version_conflict" ||
                  error.code === "ticket_version_conflict"
                ? 412
                : 409
        : undefined;
    const inputParserStatus =
      errorCode === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      errorCode === "FST_ERR_CTP_EMPTY_JSON_BODY"
        ? 400
        : errorCode === "FST_ERR_CTP_BODY_TOO_LARGE"
          ? 413
          : errorCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
            ? 415
            : undefined;
    const status =
      applicationStatus ??
      inputParserStatus ??
      (error instanceof AuthFailure
        ? error.code === "unauthenticated"
          ? 401
          : 403
        : error instanceof RangeError
          ? 422
          : errorCode === "STORAGE_MAINTENANCE" ||
              errorCode === "STORAGE_FULL" ||
              errorCode === "STORAGE_IO" ||
              errorCode === "STORAGE_READ_ONLY" ||
              errorCode === "STORAGE_BUSY"
            ? 503
            : errorCode === "STORAGE_CAS_FAILED"
              ? 412
              : errorCode === "STORAGE_CONSTRAINT"
                ? 409
                : 500);
    const code =
      error instanceof ApplicationError
        ? error.code
        : error instanceof AuthFailure
          ? error.code
          : status === 400 || status === 413 || status === 415 || status === 422
            ? "invalid_request"
            : status === 503
              ? errorCode === "STORAGE_MAINTENANCE"
                ? "admission_paused"
                : "storage_unavailable"
              : status === 412
                ? "version_conflict"
                : status === 409
                  ? "conflict"
                  : "internal_error";
    request.log.warn(
      {
        requestId: request.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
        storageCode: error instanceof StorageError ? error.code : undefined,
      },
      "request failed",
    );
    return reply.code(status).send(apiError(request.id, code, status === 503));
  });
  app.get("/healthz", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      stage: "D05",
      executionMode: config.EXECUTION_MODE,
      recoveryState: runtime.recoveryState?.() ?? "ready",
    }),
  );
  app.get("/v1/openapi.json", async () => openApiDocument());

  if (runtime.storage) {
    const maintenance =
      runtime.maintenance ??
      new MaintenanceService(
        runtime.storage,
        config.DATA_DIR,
        {
          lowWaterMiB: config.DISK_LOW_WATER_MIB,
          reserveMiB: config.DISK_RESERVE_MIB,
        },
        Date.now,
        undefined,
        {
          dailyCopies: config.BACKUP_DAILY_COPIES,
          weeklyCopies: config.BACKUP_WEEKLY_COPIES,
        },
      );
    const auth = new Authenticator(runtime.storage);
    const commands = new TicketService({ storage: runtime.storage });
    const queries = new TicketQueries(runtime.storage);
    const ticketCommands = new TicketCommandService(runtime.storage, queries);
    const leases = new LeaseService(runtime.storage);
    const access = new AccessService(
      runtime.storage,
      Date.now,
      runtime.secrets,
    );
    const admin = new AdminService(
      runtime.storage,
      probePortainer,
      Date.now,
      config.PORTAINER_ALLOW_LOOPBACK_HTTP,
      runtime.secrets
        ? (versionRef) => runtime.secrets!.get(versionRef)
        : undefined,
    );
    const requireAdmin = async (
      request: Parameters<typeof auth.authenticate>[0],
      write = false,
    ) => {
      const actor = await identify(request, write);
      const fullAdminScopes = roleScopes("admin");
      if (
        actor.role !== "admin" ||
        actor.scopes.length !== fullAdminScopes.length ||
        fullAdminScopes.some((scope) => !actor.scopes.includes(scope))
      )
        throw new AuthFailure("forbidden");
      return actor;
    };
    app.get("/v1/system/diagnostics", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return DiagnosticsSchema.parse(await maintenance.diagnostics());
    });
    app.get("/v1/system/health", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return SystemHealthSchema.parse(await maintenance.health());
    });
    app.get("/v1/system/backups", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return BackupListSchema.parse(await maintenance.backups());
    });
    app.post("/v1/system/backups", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      parseInput(BackupCreateSchema, request.body);
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key || key.length > 200)
        throw new RangeError("Idempotency-Key required");
      reply.header("Cache-Control", "no-store");
      return BackupViewSchema.parse(
        await maintenance.backup(key, actor.consumerId, request.id),
      );
    });
    app.post("/v1/system/admission/pause", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      reply.header("Cache-Control", "no-store");
      return SystemHealthSchema.parse(
        await maintenance.pause(
          parseInput(AdmissionPauseSchema, request.body).reason,
          actor.consumerId,
          request.id,
        ),
      );
    });
    app.post("/v1/system/admission/resume", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      reply.header("Cache-Control", "no-store");
      return SystemHealthSchema.parse(
        await maintenance.resume(
          parseInput(AdmissionPauseSchema, request.body).reason,
          actor.consumerId,
          request.id,
        ),
      );
    });
    app.post("/v1/system/recovery/approve", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      const body = parseInput(RecoveryApprovalSchema, request.body);
      await approveRecovery(
        runtime.storage!,
        actor.consumerId,
        request.id,
        body.reason,
      );
      reply.header("Cache-Control", "no-store");
      return SystemHealthSchema.parse(await maintenance.health());
    });
    app.get("/v1/system/credentials", async (request, reply) => {
      await requireAdmin(request);
      const query = parseInput(CredentialQuerySchema, request.query);
      reply.header("Cache-Control", "no-store");
      return CredentialListSchema.parse(
        await maintenance.credentials(query.consumerId),
      );
    });
    app.post("/v1/system/credentials/rotate", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      const body = parseInput(CredentialRotationSchema, request.body);
      reply.header("Cache-Control", "no-store");
      return CredentialReceiptSchema.parse(
        await maintenance.rotateCredential(
          body.consumerId,
          body.credentialId,
          actor.consumerId,
          request.id,
        ),
      );
    });
    const power = new PowerService(runtime.storage);
    await power.recover();
    const stopPowerRecovery = startPowerRecovery(power, () =>
      app.log.warn(
        "Power preview restoration check failed; obligation remains persisted",
      ),
    );
    app.addHook("onClose", stopPowerRecovery);
    app.get("/v1/machines/:machineId/power", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return PowerSchemas.PowerConfigurationSchema.parse(
        await power.configuration(uuidParam(request.params, "machineId")),
      );
    });
    app.post(
      "/v1/machines/:machineId/power-policy/dry-run",
      async (request, reply) => {
        await requireAdmin(request);
        reply.header("Cache-Control", "no-store");
        return PowerSchemas.PowerPolicyPreviewSchema.parse(
          await power.previewPolicy(
            uuidParam(request.params, "machineId"),
            parseInput(
              PowerSchemas.PowerConfigurationUpdateSchema,
              request.body,
            ),
          ),
        );
      },
    );
    app.put("/v1/machines/:machineId/power-policy", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      const result = await power.configure(
        uuidParam(request.params, "machineId"),
        parseInput(PowerSchemas.PowerConfigurationUpdateSchema, request.body),
        { operatorId: actor.consumerId, requestId: request.id },
      );
      reply
        .header("Cache-Control", "no-store")
        .header("ETag", `"${result.version}"`);
      return PowerSchemas.PowerConfigurationSchema.parse(result);
    });
    app.put(
      "/v1/machines/:machineId/power-capabilities",
      async (request, reply) => {
        const actor = await requireAdmin(request, true);
        reply.header("Cache-Control", "no-store");
        return PowerSchemas.PowerConfigurationSchema.parse(
          await power.capabilities(
            uuidParam(request.params, "machineId"),
            parseInput(PowerSchemas.PowerCapabilityUpdateSchema, request.body),
            { operatorId: actor.consumerId, requestId: request.id },
          ),
        );
      },
    );
    app.put(
      "/v1/machines/:machineId/smart-plug-binding",
      async (request, reply) => {
        const actor = await requireAdmin(request, true);
        reply.header("Cache-Control", "no-store");
        return PowerSchemas.PowerConfigurationSchema.parse(
          await power.bind(
            uuidParam(request.params, "machineId"),
            parseInput(PowerSchemas.SmartPlugBindingUpdateSchema, request.body),
            { operatorId: actor.consumerId, requestId: request.id },
          ),
        );
      },
    );
    app.get(
      "/v1/machines/:machineId/power-previews",
      async (request, reply) => {
        await requireAdmin(request);
        reply.header("Cache-Control", "no-store");
        return PowerSchemas.PowerPreviewStateSchema.array().parse(
          await power.list(uuidParam(request.params, "machineId")),
        );
      },
    );
    app.post(
      "/v1/machines/:machineId/power-previews",
      async (request, reply) => {
        const actor = await requireAdmin(request, true);
        reply.header("Cache-Control", "no-store").code(201);
        return PowerSchemas.PowerPreviewStateSchema.parse(
          await power.start(
            uuidParam(request.params, "machineId"),
            parseInput(PowerSchemas.PowerPreviewStartSchema, request.body),
            { operatorId: actor.consumerId, requestId: request.id },
          ),
        );
      },
    );
    app.get(
      "/v1/machines/:machineId/power-previews/:previewId",
      async (request, reply) => {
        await requireAdmin(request);
        reply.header("Cache-Control", "no-store");
        return PowerSchemas.PowerPreviewStateSchema.parse(
          await power.get(
            uuidParam(request.params, "machineId"),
            uuidParam(request.params, "previewId"),
          ),
        );
      },
    );
    app.post(
      "/v1/machines/:machineId/power-previews/:previewId/advance",
      async (request, reply) => {
        const actor = await requireAdmin(request, true);
        reply.header("Cache-Control", "no-store");
        return PowerSchemas.PowerPreviewStateSchema.parse(
          await power.advance(
            uuidParam(request.params, "machineId"),
            uuidParam(request.params, "previewId"),
            parseInput(PowerSchemas.PowerPreviewAdvanceSchema, request.body),
            { operatorId: actor.consumerId, requestId: request.id },
          ),
        );
      },
    );
    const hosts = new HostAgents(runtime.storage);
    app.post("/v1/agents/pairings", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      reply.header("Cache-Control", "no-store");
      return reply
        .code(201)
        .send(
          await hosts.pair(
            parseInput(hostPairingRequestSchema, request.body),
            actor.principalId,
            request.id,
          ),
        );
    });
    app.post("/v1/agents/enroll", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reply
        .code(201)
        .send(
          await hosts.enroll(parseInput(hostEnrollRequestSchema, request.body)),
        );
    });
    app.get("/v1/agents/:agentId/session", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return hosts.session(
        uuidParam(request.params, "agentId"),
        request.headers.authorization,
      );
    });
    app.post("/v1/agents/:agentId/boot", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return hosts.start(
        uuidParam(request.params, "agentId"),
        request.headers.authorization,
        parseInput(hostBootRequestSchema, request.body),
      );
    });
    app.post("/v1/agents/:agentId/heartbeat", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return hosts.heartbeat(
        uuidParam(request.params, "agentId"),
        request.headers.authorization,
        parseInput(hostHeartbeatSchema, request.body),
      );
    });
    app.get("/v1/agents/:agentId", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return hosts.view(uuidParam(request.params, "agentId"));
    });
    app.post("/v1/agents/:agentId/revoke", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      const input = parseInput(hostRevokeRequestSchema, request.body);
      await hosts.revoke(
        uuidParam(request.params, "agentId"),
        input.expectedSessionEpoch,
        input.reason,
        actor.principalId,
        request.id,
      );
      return reply.code(204).send();
    });
    app.get("/v1/machines/:machineId/snapshot", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return hosts.snapshot(uuidParam(request.params, "machineId"));
    });
    app.get("/v1/admin/installation", async (request, reply) => {
      await requireAdmin(request);
      const installation = await admin.getInstallation();
      if (!installation) throw new ApplicationError("not_found");
      reply.header("Cache-Control", "no-store");
      return AdminInstallationViewSchema.parse(installation);
    });
    app.get("/v1/machines", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return MachineDependencyViewSchema.array().parse(
        await admin.machineDependencies(),
      );
    });
    app.get("/v1/machines/:machineId/dry-run", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return MachineDependencyViewSchema.parse(
        await admin.machineDryRun(uuidParam(request.params, "machineId")),
      );
    });
    app.post(
      "/v1/machines/:machineId/human-use-policy/dry-run",
      async (request, reply) => {
        await requireAdmin(request);
        const body = parseInput(MachinePolicyUpdateSchema, request.body);
        reply.header("Cache-Control", "no-store");
        return MachinePolicyDryRunSchema.parse(
          await admin.machinePolicyDryRun({
            machineId: uuidParam(request.params, "machineId"),
            ...body,
          }),
        );
      },
    );
    app.put(
      "/v1/machines/:machineId/human-use-policy",
      async (request, reply) => {
        const actor = await requireAdmin(request, true);
        const body = parseInput(MachinePolicyUpdateSchema, request.body);
        const result = await admin.updateHumanUsePolicy({
          machineId: uuidParam(request.params, "machineId"),
          ...body,
          operatorId: actor.consumerId,
          requestId: request.id,
        });
        return reply
          .header("ETag", `\"${result.version}\"`)
          .send(MachinePolicyReceiptSchema.parse(result));
      },
    );
    app.put("/v1/nodes/:nodeId/admission-mode", async (request, reply) => {
      const actor = await requireAdmin(request, true),
        body = parseInput(NodeAdmissionModeSchema, request.body);
      const result = await admin.updateNodeAdmissionMode({
        ...body,
        nodeId: uuidParam(request.params, "nodeId"),
        operatorId: actor.consumerId,
        requestId: request.id,
      });
      return reply
        .header("ETag", `"${result.version}"`)
        .send(NodeAdmissionModeReceiptSchema.parse(result));
    });
    app.post("/v1/provider-connections", async (request, reply) => {
      await requireAdmin(request, true);
      const body = parseInput(PortainerConnectionInputSchema, request.body);
      const result = await admin.discover(body);
      reply.header("Cache-Control", "no-store");
      return reply.code(202).send(ProviderOperationReceiptSchema.parse(result));
    });
    app.post<{ Params: { operationId: string } }>(
      "/v1/provider-discovery/:operationId/retry",
      async (request, reply) => {
        await requireAdmin(request, true);
        const result = await admin.retryDiscovery(request.params.operationId);
        if (!result)
          return reply.code(404).send(apiError(request.id, "not_found", false));
        reply.header("Cache-Control", "no-store");
        return reply
          .code(200)
          .send(ProviderOperationReceiptSchema.parse(result));
      },
    );
    app.get<{ Params: { operationId: string } }>(
      "/v1/provider-discovery/:operationId",
      async (request, reply) => {
        await requireAdmin(request);
        const receipt = await admin.discoveryReceipt(
          request.params.operationId,
        );
        if (!receipt)
          return reply.code(404).send(apiError(request.id, "not_found", false));
        reply.header("Cache-Control", "no-store");
        return ProviderOperationReceiptSchema.parse(receipt);
      },
    );
    app.post<{ Params: { connectionId: string } }>(
      "/v1/provider-connections/:connectionId/revisions",
      async (request, reply) => {
        await requireAdmin(request, true);
        const body = parseInput(PortainerConnectionInputSchema, request.body);
        const result = await admin.proposeConnectionRevision({
          connectionId: request.params.connectionId,
          ...body,
        });
        reply.header("Cache-Control", "no-store");
        return reply
          .code(202)
          .send(ProviderOperationReceiptSchema.parse(result));
      },
    );
    app.post<{ Params: { operationId: string } }>(
      "/v1/provider-connection-proposals/:operationId/retry",
      async (request, reply) => {
        await requireAdmin(request, true);
        const result = await admin.retryConnectionRevision(
          request.params.operationId,
        );
        if (!result)
          return reply.code(404).send(apiError(request.id, "not_found", false));
        reply.header("Cache-Control", "no-store");
        return reply
          .code(200)
          .send(ProviderOperationReceiptSchema.parse(result));
      },
    );
    app.get<{ Params: { operationId: string } }>(
      "/v1/provider-connection-proposals/:operationId",
      async (request, reply) => {
        await requireAdmin(request);
        const receipt = await admin.connectionRevisionReceipt(
          request.params.operationId,
        );
        if (!receipt)
          return reply.code(404).send(apiError(request.id, "not_found", false));
        reply.header("Cache-Control", "no-store");
        return ProviderOperationReceiptSchema.parse(receipt);
      },
    );
    app.post<{ Params: { connectionId: string } }>(
      "/v1/provider-connections/:connectionId/activate-revision",
      async (request, reply) => {
        await requireAdmin(request, true);
        const expected = ifMatchVersion(request.headers["if-match"]);
        const body = parseInput(ConnectionActivationSchema, request.body);
        return reply.send(
          ConnectionActivationReceiptSchema.parse(
            await admin.activateConnectionRevision(
              request.params.connectionId,
              body.revisionId,
              expected,
            ),
          ),
        );
      },
    );
    app.post("/v1/machines", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      const body = parseInput(MachineInputSchema, request.body);
      return reply.code(201).send(
        MachineReceiptSchema.parse(
          await admin.createMachine({
            ...body,
            operatorId: actor.consumerId,
          }),
        ),
      );
    });
    app.post("/v1/nodes", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      const body = parseInput(NodeInputSchema, request.body);
      return reply
        .code(201)
        .send(
          NodeReceiptSchema.parse(
            await admin.registerNode({ ...body, operatorId: actor.consumerId }),
          ),
        );
    });
    app.get("/v1/provider-connections", async (request) => {
      await requireAdmin(request);
      return ProviderConnectionViewSchema.array().parse(
        await admin.listConnections(),
      );
    });
    app.put("/v1/nodes/:nodeId/runtime-config", async (request, reply) => {
      const actor = await requireAdmin(request, true);
      const body = parseInput(NodeRuntimeConfigSchema, request.body);
      const result = await admin.configureNodeRuntime({
        nodeId: uuidParam(request.params, "nodeId"),
        expectedVersion: ifMatchVersion(request.headers["if-match"]),
        config: body,
        operatorId: actor.consumerId,
        requestId: request.id,
      });
      return reply.code(200).header("ETag", `"${result.version}"`).send(result);
    });
    app.post(
      "/v1/nodes/:nodeId/capability-attestations",
      async (request, reply) => {
        const actor = await requireAdmin(request, true);
        const body = parseInput(NodeCapabilityAttestationSchema, request.body);
        const result = await admin.attestNodeCapabilities({
          nodeId: uuidParam(request.params, "nodeId"),
          expectedVersion: ifMatchVersion(request.headers["if-match"]),
          ...body,
          engineId: body.expectedEngineId,
          dockerVersion: body.expectedDockerVersion,
          portainerVersion: body.expectedPortainerVersion,
          operatorId: actor.consumerId,
          requestId: request.id,
        });
        return reply
          .code(200)
          .header("ETag", `"${result.version}"`)
          .send(result);
      },
    );
    app.get("/v1/nodes", async (request) => {
      await requireAdmin(request);
      return NodeViewSchema.array().parse(await admin.listNodes());
    });
    app.post("/v1/network-profiles", async (request, reply) => {
      await requireAdmin(request, true);
      const body = parseInput(NetworkProfileInputSchema, request.body);
      return reply.code(201).send(
        ProfileWriteReceiptSchema.parse(
          await admin.createProfile("network", {
            name: body.name,
            config: body.policy,
            authorizedConsumerIds: body.authorizedConsumerIds,
          }),
        ),
      );
    });
    app.post("/v1/storage-profiles", async (request, reply) => {
      await requireAdmin(request, true);
      const body = parseInput(StorageProfileInputSchema, request.body);
      return reply.code(201).send(
        ProfileWriteReceiptSchema.parse(
          await admin.createProfile("storage", {
            name: body.name,
            protocol: body.protocol,
            config: body.config,
            secretVersionRef: body.secretVersionRef,
            authorizedConsumerIds: body.authorizedConsumerIds,
          }),
        ),
      );
    });
    app.post<{ Params: { profileId: string } }>(
      "/v1/network-profiles/:profileId/revisions",
      async (request, reply) => {
        await requireAdmin(request, true);
        const expected = ifMatchVersion(request.headers["if-match"]);
        const body = parseInput(NetworkProfileRevisionSchema, request.body);
        return reply
          .code(201)
          .send(
            ProfileWriteReceiptSchema.parse(
              await admin.newProfileRevision(
                "network",
                request.params.profileId,
                expected,
                { config: body.policy },
              ),
            ),
          );
      },
    );
    app.post<{ Params: { profileId: string } }>(
      "/v1/storage-profiles/:profileId/revisions",
      async (request, reply) => {
        await requireAdmin(request, true);
        const expected = ifMatchVersion(request.headers["if-match"]);
        const body = parseInput(StorageProfileRevisionSchema, request.body);
        return reply
          .code(201)
          .send(
            ProfileWriteReceiptSchema.parse(
              await admin.newProfileRevision(
                "storage",
                request.params.profileId,
                expected,
                body,
              ),
            ),
          );
      },
    );
    app.get("/v1/network-profiles", async (request) => {
      await requireAdmin(request);
      return AdminProfileViewSchema.array().parse(
        await admin.listProfiles("network"),
      );
    });
    app.get("/v1/storage-profiles", async (request) => {
      await requireAdmin(request);
      return AdminProfileViewSchema.array().parse(
        await admin.listProfiles("storage"),
      );
    });
    app.post("/v1/images", async (request, reply) => {
      await requireAdmin(request, true);
      const body = parseInput(ImageDraftSchema, request.body);
      const { description, ...draft } = body;
      return reply.code(201).send(
        DraftCreationReceiptSchema.parse(
          await admin.createDraft({
            ...draft,
            ...(typeof description === "string" ? { description } : {}),
          }),
        ),
      );
    });
    app.post<{ Params: { imageId: string } }>(
      "/v1/images/:imageId/versions",
      async (request, reply) => {
        await requireAdmin(request, true);
        const body = parseInput(ImageVersionDraftSchema, request.body);
        return reply.code(201).send(
          DraftCreationReceiptSchema.parse(
            await admin.createVersion({
              imageId: request.params.imageId,
              ...body,
            }),
          ),
        );
      },
    );
    app.post<{ Params: { versionId: string } }>(
      "/v1/image-versions/:versionId/artifacts",
      async (request, reply) => {
        await requireAdmin(request, true);
        const body = parseInput(DraftArtifactSchema, request.body);
        return reply
          .code(201)
          .send(
            ArtifactReceiptSchema.parse(
              await admin.addDraftArtifact(request.params.versionId, body),
            ),
          );
      },
    );
    app.post<{ Params: { versionId: string } }>(
      "/v1/image-versions/:versionId/publish",
      async (request) => {
        await requireAdmin(request, true);
        const body = parseInput(ImagePublishRequestSchema, request.body);
        return ImagePublishReceiptSchema.parse(
          await admin.publishVersion(
            request.params.versionId,
            body.expectedEntityVersion,
          ),
        );
      },
    );
    app.put<{ Params: { imageId: string; alias: string } }>(
      "/v1/images/:imageId/aliases/:alias",
      async (request) => {
        await requireAdmin(request, true);
        const body = parseInput(ImageAliasRequestSchema, request.body);
        const alias = parseInput(ImageAliasNameSchema, request.params.alias);
        return ImageAliasReceiptSchema.parse(
          await admin.moveImageAlias(
            request.params.imageId,
            alias,
            body.versionId,
            body.expectedVersion,
          ),
        );
      },
    );
    app.post<{ Params: { validationId: string } }>(
      "/v1/image-validations/:validationId/cancel",
      async (request) => {
        await requireAdmin(request, true);
        if (!(await admin.getValidation(request.params.validationId)))
          throw new ApplicationError("not_found");
        await admin.cancelValidation(request.params.validationId);
        return AdminValidationViewSchema.parse(
          await admin.getValidation(request.params.validationId),
        );
      },
    );
    app.get<{ Params: { validationId: string } }>(
      "/v1/image-validations/:validationId",
      async (request) => {
        await requireAdmin(request);
        const row = await admin.getValidation(request.params.validationId);
        if (!row) throw new ApplicationError("not_found");
        return AdminValidationViewSchema.parse(row);
      },
    );
    app.post<{ Params: { versionId: string } }>(
      "/v1/image-versions/:versionId/validate",
      async (request, reply) => {
        const actor = await requireAdmin(request, true);
        const body = parseInput(ImageValidationRequestSchema, request.body);
        return reply.code(202).send(
          ValidationScheduleReceiptSchema.parse(
            await admin.scheduleValidation({
              ...(body as ImageValidationRequest),
              versionId: request.params.versionId,
              requestedBy: actor.consumerId,
            }),
          ),
        );
      },
    );
    app.post<{ Params: { nodeId: string } }>(
      "/v1/nodes/:nodeId/image-cache/prewarm",
      async (request, reply) => {
        await requireAdmin(request, true);
        const body = parseInput(CacheArtifactSchema, request.body);
        const plan = await admin.prewarmImageCache({
          nodeId: request.params.nodeId,
          artifactId: body.artifactId,
        });
        if (plan.state === "conflict") throw new ApplicationError("conflict");
        return reply.code(202).send(CachePlanReceiptSchema.parse(plan));
      },
    );
    app.post<{ Params: { nodeId: string } }>(
      "/v1/nodes/:nodeId/image-cache/gc",
      async (request, reply) => {
        await requireAdmin(request, true);
        const body = parseInput(CacheArtifactSchema, request.body);
        const plan = await admin.planCacheEviction({
          nodeId: request.params.nodeId,
          artifactId: body.artifactId,
        });
        if (plan.state === "conflict") throw new ApplicationError("conflict");
        return reply.code(202).send(CachePlanReceiptSchema.parse(plan));
      },
    );
    const eventStreams = new Set<() => void>();
    const loginFailures = new Map<string, { count: number; since: number }>();
    let closing = false;
    const closeEventStreams = () => {
      closing = true;
      for (const close of eventStreams) close();
      eventStreams.clear();
    };
    app.addHook("preClose", closeEventStreams);
    app.addHook("onClose", closeEventStreams);
    const identify = async (
      request: Parameters<typeof auth.authenticate>[0],
      write = false,
    ) => auth.authenticate(request, write);
    app.post("/v1/auth/session", async (request, reply) => {
      const ip = request.ip;
      const now = Date.now();
      const failures = loginFailures.get(ip);
      if (failures && now - failures.since < 10 * 60_000 && failures.count >= 5)
        return reply
          .code(429)
          .header("Retry-After", "600")
          .send(apiError(request.id, "login_rate_limited", true));
      let actor;
      try {
        actor = await auth.bearerPrincipal(request);
      } catch (error) {
        const active =
          failures && now - failures.since < 10 * 60_000
            ? failures
            : { count: 0, since: now };
        active.count++;
        loginFailures.set(ip, active);
        if (loginFailures.size > 1000) {
          for (const [key, value] of loginFailures)
            if (now - value.since >= 10 * 60_000) loginFailures.delete(key);
          if (loginFailures.size > 1000)
            loginFailures.delete(loginFailures.keys().next().value!);
        }
        throw error;
      }
      loginFailures.delete(ip);
      const expected = roleScopes(actor.role);
      if (
        expected.length !== actor.scopes.length ||
        expected.some((scope) => !actor.scopes.includes(scope))
      )
        throw new AuthFailure("forbidden");
      const session = await auth.createSession(
        actor.consumerId,
        actor.principalId,
      );
      const secure = config.COOKIE_SECURE ? "; Secure" : "";
      const maxAge = 8 * 60 * 60;
      reply.header("Set-Cookie", [
        `hitchlet_session=${encodeURIComponent(session.token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`,
        `hitchlet_csrf=${encodeURIComponent(session.csrfToken)}; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure}`,
      ]);
      reply
        .header("Cache-Control", "no-store")
        .header("X-CSRF-Token", session.csrfToken);
      return reply.code(201).send(
        AuthenticatedPrincipalSchema.parse({
          consumerId: actor.consumerId,
          role: actor.role,
          scopes: actor.scopes,
          source: "session",
        }),
      );
    });
    app.get("/v1/auth/me", async (request, reply) => {
      const actor = await identify(request);
      reply.header("Cache-Control", "no-store");
      return AuthenticatedPrincipalSchema.parse({
        consumerId: actor.consumerId,
        role: actor.role,
        scopes: actor.scopes,
        source: actor.source,
      });
    });
    app.delete("/v1/auth/session", async (request, reply) => {
      const actor = await identify(request, true);
      if (actor.source !== "session") throw new AuthFailure("forbidden");
      await auth.revokeSession(request);
      const secure = config.COOKIE_SECURE ? "; Secure" : "";
      reply.header("Set-Cookie", [
        `hitchlet_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
        `hitchlet_csrf=; Path=/; Max-Age=0; SameSite=Strict${secure}`,
      ]);
      return reply.code(204).send();
    });
    app.get("/v1/tickets", async (request, reply) => {
      const actor = await identify(request);
      if (actor.scopes.includes("tickets:read")) {
        const query = parseInput(
          TicketListQuerySchema,
          normalizeLimitQuery(request.query),
        );
        return queries.list(actor.consumerId, query);
      }
      return reply.code(403).send(apiError(request.id, "forbidden", false));
    });
    app.post("/v1/tickets", async (request, reply) => {
      if ((runtime.recoveryState?.() ?? "ready") !== "ready")
        return reply
          .code(503)
          .send(apiError(request.id, "recovery_in_progress", true));
      const actor = await identify(request, true);
      if (actor.role === "viewer" || !actor.scopes.includes("tickets:write"))
        return reply.code(403).send(apiError(request.id, "forbidden", false));
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key || key.length > 200)
        return reply
          .code(422)
          .send(apiError(request.id, "invalid_idempotency_key", false));
      const body = parseInput(AcquireRequestSchema, request.body);
      const result = await commands.acquire(actor.consumerId, key, body);
      const ticket = await queries.get(actor.consumerId, result.ticketId);
      if (!ticket) throw new Error("Accepted ticket is unavailable");
      return reply
        .code(202)
        .header("location", `/v1/tickets/${ticket.id}`)
        .send(AcquireReceiptSchema.parse({ ticket, idempotencyKey: key }));
    });
    app.get<{ Params: { ticketId: string } }>(
      "/v1/tickets/:ticketId",
      async (request, reply) => {
        const actor = await identify(request);
        if (!actor.scopes.includes("tickets:read"))
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        const ticket = await queries.get(
          actor.consumerId,
          request.params.ticketId,
        );
        if (!ticket)
          return reply.code(404).send(apiError(request.id, "not_found", false));
        const etag = `"${createHash("sha256").update(JSON.stringify(ticket)).digest("hex")}"`;
        reply.header("ETag", etag);
        if (request.headers["if-none-match"] === etag)
          return reply.code(304).send();
        return ticket;
      },
    );
    app.post<{ Params: { ticketId: string } }>(
      "/v1/tickets/:ticketId/release",
      async (request, reply) => {
        const actor = await identify(request, true);
        if (!actor.scopes.includes("tickets:write") || actor.role === "viewer")
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !key || key.length > 200)
          throw new RangeError("Invalid Idempotency-Key");
        const body = parseInput(ReleaseRequestSchema, request.body);
        const ticket = await ticketCommands.idempotent(
          {
            consumerId: actor.consumerId,
            ticketId: request.params.ticketId,
            scope: "tickets.release",
            key,
            body,
          },
          async (current, completion) => {
            if (!current.lease || current.lease.generation !== body.generation)
              throw new ApplicationError("generation_conflict");
            await commands.cancel(
              request.params.ticketId,
              actor.consumerId,
              "consumer_release",
              { expectedGeneration: body.generation, completion },
            );
          },
        );
        return reply.code(ticket.phase === "released" ? 200 : 202).send(ticket);
      },
    );
    app.post<{ Params: { ticketId: string } }>(
      "/v1/tickets/:ticketId/cancel",
      async (request, reply) => {
        const actor = await identify(request, true);
        if (!actor.scopes.includes("tickets:write") || actor.role === "viewer")
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !key || key.length > 200)
          throw new RangeError("Invalid Idempotency-Key");
        const body = parseInput(CancelRequestSchema, request.body ?? {});
        const ticket = await ticketCommands.idempotent(
          {
            consumerId: actor.consumerId,
            ticketId: request.params.ticketId,
            scope: "tickets.cancel",
            key,
            body,
          },
          async (_current, completion) => {
            await commands.cancel(
              request.params.ticketId,
              actor.consumerId,
              "consumer_cancel",
              { completion },
            );
          },
        );
        return reply.code(ticket.phase === "released" ? 200 : 202).send(ticket);
      },
    );
    app.post<{ Params: { ticketId: string } }>(
      "/v1/tickets/:ticketId/revoke",
      async (request, reply) => {
        const actor = await identify(request, true);
        if (
          (actor.role !== "operator" && actor.role !== "admin") ||
          !actor.scopes.includes("tickets:revoke")
        )
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !key || key.length > 200)
          throw new RangeError("Invalid Idempotency-Key");
        const body = parseInput(RevokeRequestSchema, request.body);
        await commands.authorizeRevoke(
          request.params.ticketId,
          actor.consumerId,
          actor.role === "admin",
        );
        const ticket = await ticketCommands.idempotent(
          {
            consumerId: actor.consumerId,
            anyOwner: true,
            ticketId: request.params.ticketId,
            scope: "tickets.revoke",
            key,
            body,
          },
          async (current, completion) => {
            await commands.revoke(current.id, {
              operatorId: actor.consumerId,
              admin: actor.role === "admin",
              termination: {
                expectedTicketVersion: body.expectedTicketVersion,
                expectedGeneration: body.generation,
                audit: {
                  actorId: actor.principalId,
                  requestId: request.id,
                  reason: body.reason,
                },
                completion,
              },
            });
          },
        );
        return reply.code(ticket.phase === "released" ? 200 : 202).send(ticket);
      },
    );
    app.post<{ Params: { ticketId: string } }>(
      "/v1/tickets/:ticketId/renew",
      async (request, reply) => {
        const actor = await identify(request, true);
        if (!actor.scopes.includes("tickets:write") || actor.role === "viewer")
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !key || key.length > 200)
          throw new RangeError("Invalid Idempotency-Key");
        const parsed = parseInput(RenewRequestSchema, request.body);
        const requestBody = {
          generation: parsed.generation,
          expectedLeaseVersion: parsed.expectedLeaseVersion,
          ...(parsed.requestedTtlSec !== undefined
            ? { requestedTtlSec: parsed.requestedTtlSec }
            : {}),
        };
        const result = await leases.renew(
          actor.consumerId,
          request.params.ticketId,
          key,
          requestBody,
        );
        if (result.outcome === "confirmed")
          return reply.code(200).send(RenewReceiptSchema.parse(result.receipt));
        if (result.outcome === "pending")
          return reply
            .code(202)
            .header("location", result.location)
            .send(result);
        return reply.code(409).send(result);
      },
    );
    app.get<{ Params: { ticketId: string; renewalId: string } }>(
      "/v1/tickets/:ticketId/renewals/:renewalId",
      async (request, reply) => {
        const actor = await identify(request);
        if (!actor.scopes.includes("tickets:read"))
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        const renewal = await leases.get(
          actor.consumerId,
          request.params.ticketId,
          request.params.renewalId,
        );
        return renewal
          ? LeaseRenewalViewSchema.parse(renewal)
          : reply.code(404).send(apiError(request.id, "not_found", false));
      },
    );
    app.post<{ Params: { ticketId: string } }>(
      "/v1/tickets/:ticketId/access",
      async (request, reply) => {
        const actor = await identify(request, true);
        if (!actor.scopes.includes("tickets:write") || actor.role === "viewer")
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        if (
          config.EXECUTION_MODE !== "simulator" &&
          config.EXECUTION_MODE !== "portainer"
        )
          return reply
            .code(503)
            .send(apiError(request.id, "access_unavailable", true));
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !key || key.length > 200)
          throw new RangeError("Invalid Idempotency-Key");
        const requestBody = parseInput(
          AccessCommandRequestSchema,
          request.body,
        );
        const grant = await access.get(
          actor.consumerId,
          request.params.ticketId,
          key,
          requestBody.generation,
        );
        return reply
          .code(200)
          .header("Cache-Control", "no-store")
          .header("Pragma", "no-cache")
          .send(grant);
      },
    );
    app.get("/v1/images", async (request, reply) => {
      const actor = await identify(request);
      if (!actor.scopes.includes("images:read"))
        return reply.code(403).send(apiError(request.id, "forbidden", false));
      const query = parseInput(
        PageQuerySchema,
        normalizeLimitQuery(request.query),
      );
      const cursor = decodeCursor(query.cursor);
      if (query.cursor && !cursor) throw new RangeError("Invalid page cursor");
      const limit = query.limit ?? 50;
      const rows = await queries.images(
        actor.consumerId,
        cursor?.id ?? null,
        limit + 1,
      );
      const items = rows.slice(0, limit).map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
      }));
      const nextCursor =
        rows.length > limit && items.length
          ? encodeCursor(String(items.at(-1)!.id))
          : null;
      return ImageSummaryPageSchema.parse({ items, nextCursor });
    });
    app.get<{ Params: { versionId: string } }>(
      "/v1/admin/image-versions/:versionId",
      async (request) => {
        await requireAdmin(request);
        const draft = await admin.getDraftVersion(request.params.versionId);
        if (!draft) throw new ApplicationError("not_found");
        return DraftVersionViewSchema.parse(draft);
      },
    );
    app.get("/v1/admin/image-versions", async (request, reply) => {
      await requireAdmin(request);
      reply.header("Cache-Control", "no-store");
      return z
        .array(AdminImageVersionSummarySchema)
        .parse(await admin.listImageVersions());
    });
    app.get<{ Params: { versionId: string } }>(
      "/v1/admin/image-versions/:versionId/validations",
      async (request, reply) => {
        await requireAdmin(request);
        const items = await admin.listValidationHistory(
          request.params.versionId,
        );
        if (!items) throw new ApplicationError("not_found");
        reply.header("Cache-Control", "no-store");
        return z.array(AdminValidationHistoryItemSchema).parse(items);
      },
    );
    app.get<{ Params: { imageId: string } }>(
      "/v1/admin/images/:imageId/aliases",
      async (request, reply) => {
        await requireAdmin(request);
        const items = await admin.listImageAliases(request.params.imageId);
        if (!items) throw new ApplicationError("not_found");
        reply.header("Cache-Control", "no-store");
        return z.array(AdminImageAliasViewSchema).parse(items);
      },
    );
    app.get<{ Params: { nodeId: string; operationId: string } }>(
      "/v1/nodes/:nodeId/image-cache/operations/:operationId",
      async (request, reply) => {
        await requireAdmin(request);
        const receipt = await admin.cacheOperationReceipt(
          uuidParam(request.params, "nodeId"),
          uuidParam(request.params, "operationId"),
        );
        if (!receipt) throw new ApplicationError("not_found");
        reply.header("Cache-Control", "no-store");
        return AdminCacheOperationReceiptSchema.parse(receipt);
      },
    );
    app.get<{ Params: { versionId: string } }>(
      "/v1/image-versions/:versionId",
      async (request, reply) => {
        const actor = await identify(request);
        if (!actor.scopes.includes("images:read"))
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        const result = await queries.imageVersion(
          actor.consumerId,
          request.params.versionId,
        );
        if (!result)
          return reply.code(404).send(apiError(request.id, "not_found", false));
        return ImageVersionViewSchema.parse({
          id: result.version.id,
          imageId: result.version.image_id,
          version: result.version.version,
          status: result.version.status,
          minimumResources: {
            cpuMillis: Number(result.version.minimum_cpu_millis),
            memoryMiB: Number(result.version.minimum_memory_mib),
            scratchMiB: Number(result.version.minimum_scratch_mib),
          },
          artifacts: result.artifacts.map((a) => ({
            id: a.id,
            provider: a.backend_kind,
            kind: a.environment_kind,
            architecture: a.architecture,
            guestOs: a.guest_os,
            digest: a.content_digest,
            accessProtocols: readProtocols(a.access_recipe_json),
          })),
        });
      },
    );
    app.get("/v1/events", async (request, reply) => {
      const actor = await identify(request);
      if (!actor.scopes.includes("events:read"))
        return reply.code(403).send(apiError(request.id, "forbidden", false));
      const query = parseInput(
        EventQuerySchema,
        normalizeLimitQuery(request.query),
      );
      const rows = await queries.events(
        actor.consumerId,
        BigInt(query.after ?? "0"),
        query.ticketId ?? null,
        (query.limit ?? 50) + 1,
      );
      const selected = rows.slice(0, query.limit ?? 50);
      const items = selected.map((row) => ({
        id: String(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: Number(row.aggregate_version),
        eventType: row.event_type,
        occurredAt: new Date(Number(row.occurred_at_ms)).toISOString(),
        payload: safeJson(row.payload_json),
      }));
      return ResourceEventPageSchema.parse({
        items,
        nextCursor:
          rows.length > (query.limit ?? 50) && selected.length
            ? String(selected.at(-1)!.id)
            : null,
      });
    });
    app.get("/v1/events/stream", async (request, reply) => {
      const actor = await identify(request);
      if (closing)
        return reply
          .code(503)
          .header("Connection", "close")
          .send(apiError(request.id, "service_unavailable", true));
      if (!actor.scopes.includes("events:read"))
        return reply.code(403).send(apiError(request.id, "forbidden", false));
      const query = parseInput(
        EventQuerySchema,
        normalizeLimitQuery({
          ...(request.query as Record<string, unknown>),
          after:
            request.headers["last-event-id"] ??
            (request.query as Record<string, unknown>).after,
        }),
      );
      let after = BigInt(query.after ?? "0");
      let open = true;
      let wakeWait: () => void = () => {};
      let stopWriter: () => void = () => {};
      const close = () => {
        open = false;
        wakeWait();
        stopWriter();
      };
      eventStreams.add(close);
      request.raw.socket.once("close", close);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const write = async (frame: string): Promise<boolean> => {
        if (!open || reply.raw.destroyed || reply.raw.writableEnded)
          return false;
        if (reply.raw.write(frame)) return true;
        return new Promise<boolean>((resolve) => {
          const cleanup = () => {
            reply.raw.off("drain", onDrain);
            reply.raw.off("close", onClose);
          };
          const onDrain = () => {
            cleanup();
            resolve(open && !reply.raw.destroyed);
          };
          const onClose = () => {
            cleanup();
            stopWriter = () => {};
            resolve(false);
          };
          stopWriter = onClose;
          reply.raw.once("drain", onDrain);
          reply.raw.once("close", onClose);
        });
      };
      try {
        if (!(await write("retry: 2000\n\n"))) return;
        while (open && !reply.raw.destroyed) {
          // Revalidate the original credential/session every poll. In particular,
          // logout and source credential revocation end an already-open stream.
          try {
            const current = await identify(request);
            if (
              current.consumerId !== actor.consumerId ||
              current.principalId !== actor.principalId
            )
              break;
          } catch {
            break;
          }
          const rows = await queries.events(
            actor.consumerId,
            after,
            query.ticketId ?? null,
            query.limit ?? 50,
          );
          for (const row of rows) {
            const event = ResourceEventSchema.parse({
              id: String(row.id),
              aggregateType: row.aggregate_type,
              aggregateId: row.aggregate_id,
              aggregateVersion: Number(row.aggregate_version),
              eventType: row.event_type,
              occurredAt: new Date(Number(row.occurred_at_ms)).toISOString(),
              payload: safeJson(row.payload_json),
            });
            if (
              !(await write(
                `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
              ))
            )
              break;
            after = BigInt(event.id);
          }
          if (!open || reply.raw.destroyed) break;
          if (rows.length === 0 && !(await write(": keepalive\n\n"))) break;
          if (open && !reply.raw.destroyed)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, rows.length ? 0 : 1000);
              wakeWait = done;
              function done() {
                clearTimeout(timer);
                reply.raw.off("close", onClose);
                wakeWait = () => {};
                resolve();
              }
              const onClose = () => {
                clearTimeout(timer);
                reply.raw.off("close", onClose);
                resolve();
              };
              reply.raw.once("close", onClose);
            });
        }
      } finally {
        wakeWait = () => {};
        eventStreams.delete(close);
        request.raw.socket.off("close", close);
        if (!reply.raw.destroyed) reply.raw.end();
      }
    });
    app.get<{ Params: { ticketId: string } }>(
      "/v1/tickets/:ticketId/events",
      async (request, reply) => {
        const actor = await identify(request);
        if (!actor.scopes.includes("events:read"))
          return reply.code(403).send(apiError(request.id, "forbidden", false));
        if (!(await queries.get(actor.consumerId, request.params.ticketId)))
          return reply.code(404).send(apiError(request.id, "not_found", false));
        const query = parseInput(
          EventQuerySchema,
          normalizeLimitQuery(request.query),
        );
        const rows = await queries.events(
          actor.consumerId,
          BigInt(query.after ?? "0"),
          request.params.ticketId,
          (query.limit ?? 50) + 1,
        );
        const limit = query.limit ?? 50;
        const items = rows.slice(0, limit).map((row) => ({
          id: String(row.id),
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          aggregateVersion: Number(row.aggregate_version),
          eventType: row.event_type,
          occurredAt: new Date(Number(row.occurred_at_ms)).toISOString(),
          payload: safeJson(row.payload_json),
        }));
        return ResourceEventPageSchema.parse({
          items,
          nextCursor:
            rows.length > limit && items.length
              ? String(rows[limit - 1]!.id)
              : null,
        });
      },
    );
  }
  if (existsSync(config.GUI_DIR)) {
    await app.register(fastifyStatic, {
      root: path.resolve(config.GUI_DIR),
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url.startsWith("/v1/") ||
        request.url === "/v1" ||
        request.url.startsWith("/healthz")
      )
        return reply.code(404).send(apiError(request.id, "not_found", false));
      const index = path.join(path.resolve(config.GUI_DIR), "index.html");
      if (existsSync(index))
        return reply.type("text/html").sendFile("index.html");
      return reply.code(404).send({ error: "Not Found" });
    });
  }
  if (!existsSync(config.GUI_DIR))
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url.startsWith("/v1/") ||
        request.url === "/v1" ||
        request.url.startsWith("/healthz")
      )
        return reply.code(404).send(apiError(request.id, "not_found", false));
      return reply.code(404).send(apiError(request.id, "not_found", false));
    });
  app.addHook("onRequest", async (request) => {
    request.log.debug(redact({ headers: request.headers }));
  });
  return app;
}

function apiError(requestId: string, code: string, retryable: boolean) {
  return ApiErrorResponseSchema.parse({
    error: { code, message: code, details: {}, retryable, requestId },
  });
}
function parseInput<Schema extends ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError)
      throw new ApplicationError("invalid_request");
    throw error;
  }
}
function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}
function decodeCursor(value?: string): { id: string } | null {
  if (!value) return null;
  try {
    const item: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      typeof item.id === "string"
    )
      return { id: item.id };
  } catch {
    /* malformed opaque cursors are rejected by the caller */
  }
  return null;
}
function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
function roleScopes(
  role: "viewer" | "consumer" | "operator" | "admin",
): string[] {
  if (role === "viewer") return ["tickets:read", "images:read", "events:read"];
  if (role === "operator" || role === "admin")
    return [
      "tickets:read",
      "tickets:write",
      "tickets:revoke",
      "images:read",
      "events:read",
    ];
  return ["tickets:read", "tickets:write", "images:read", "events:read"];
}
function normalizeLimitQuery(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("limit" in value)
  )
    return value;
  const query = value as Record<string, unknown>;
  if (typeof query.limit !== "string") return value;
  return {
    ...query,
    limit: /^\d+$/.test(query.limit) ? Number(query.limit) : Number.NaN,
  };
}
function readProtocols(value: unknown): ("ssh" | "rdp")[] {
  const recipe = safeJson(value);
  if (
    typeof recipe !== "object" ||
    recipe === null ||
    !("accessProtocols" in recipe) ||
    !Array.isArray(recipe.accessProtocols)
  )
    return [];
  return recipe.accessProtocols.filter(
    (item): item is "ssh" | "rdp" => item === "ssh" || item === "rdp",
  );
}
function ifMatchVersion(value: string | string[] | undefined): number {
  if (typeof value !== "string")
    throw new RangeError("If-Match entity version is required");
  const match = /^"?(\d+)"?$/.exec(value);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new RangeError("If-Match entity version is invalid");
  return version;
}
function uuidParam(value: unknown, key: string): string {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  if (
    typeof candidate !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
  )
    throw new ApplicationError("invalid_request");
  return candidate;
}
