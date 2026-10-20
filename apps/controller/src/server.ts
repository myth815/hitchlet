import {
  MaintenanceService,
  admissionOpen,
} from "./application/maintenance.js";
import { runtimeClient } from "./providers/runtime-credentials.js";
import { RotatingLog } from "./rotating-log.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openStorage } from "./storage/index.js";
import {
  OperationWorker,
  AllocationCreateCalls,
} from "./application/operations.js";
import { TicketService } from "./application/tickets.js";
import { LeaseService } from "./application/leases.js";
import { PersistentSimulator } from "./providers/simulator.js";
import { LocalSecretStore } from "./storage/secret-store.js";
import { SQLiteAccessMaterialStore } from "./storage/access-material-store.js";
import { PortainerExecutionProvider } from "./providers/portainer-provider.js";
import { NodeRuntimeConfigSchema } from "./http/admin-protocol.js";
import { AdminService } from "./application/admin.js";
import { probePortainer } from "./providers/portainer-probe.js";
import { ImageCacheWorker } from "./application/image-cache.js";
import { SQLiteImageCacheStore } from "./storage/image-cache-store.js";
import { PortainerImageCacheProvider } from "./providers/portainer-cache.js";
import type { ProvisionPlan } from "./providers/port.js";
import { PortainerBackgroundLoops } from "./application/portainer-background.js";

const config = loadConfig(process.env);
const storage = await openStorage(config.DATA_DIR);
const maintenance = new MaintenanceService(
  storage,
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
await maintenance.sampleDisk();
const logStream = new RotatingLog(
  join(config.DATA_DIR, "logs"),
  config.LOG_MAX_BYTES,
  config.LOG_FILES,
);
logStream.on("error", () => {
  void maintenance.noteWriteFailure();
});
let maintenanceRunning: Promise<unknown> | undefined;
let lastRetentionAt = 0;
const maintenanceTick = () => {
  if (!maintenanceRunning)
    maintenanceRunning = (async () => {
      const health = await maintenance.sampleDisk();
      if (
        health.admission.startsWith("disk_") ||
        Date.now() - lastRetentionAt >= 300_000
      ) {
        await maintenance.maintain();
        lastRetentionAt = Date.now();
      }
    })()
      .catch(() => {
        app?.log.warn(
          "Operational maintenance failed; inspect system health before reopening admission",
        );
      })
      .finally(() => {
        maintenanceRunning = undefined;
      });
};
const maintenanceTimer = setInterval(maintenanceTick, 5_000);
maintenanceTimer.unref();
const recoveryRow = await storage.get<{ recovery_json: string | null }>(
  "SELECT recovery_json FROM system_maintenance WHERE singleton=1",
);
const controlsReady =
  !recoveryRow?.recovery_json ||
  JSON.parse(recoveryRow.recovery_json).stage === "reconciling";
const secrets = config.HITCHLET_SECRET_KEY_FILE
  ? await LocalSecretStore.open(
      config.DATA_DIR,
      config.HITCHLET_SECRET_KEY_FILE,
    )
  : undefined;
let recoveryState: "ready" | "recovering" | "unavailable" = controlsReady
  ? "ready"
  : "recovering";
let timer: NodeJS.Timeout | undefined;
let backgroundLoops: PortainerBackgroundLoops | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  // Every serving process owns a new controller epoch, including observation-only mode.
  // Opening a ledger for CLI/tests does not implicitly acquire control.
  await storage.run(
    "UPDATE installations SET controller_epoch=controller_epoch+1 WHERE singleton=1",
  );
  if (config.EXECUTION_MODE === "simulator" && controlsReady) {
    recoveryState = "recovering";
    let installation = await storage.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation)
      throw new Error(
        "Simulator is not initialized. Run `pnpm --filter @hitchlet/controller init:simulator` and restart.",
      );
    installation = await storage.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation)
      throw new Error("Simulator installation identity is unavailable");
    const worker = new OperationWorker({
      createCalls: new AllocationCreateCalls(),
      storage,
      execution: new PersistentSimulator(config.SIMULATOR_DATA_DIR!),
      installationId: installation.installation_id,
      controllerEpoch: Number(installation.controller_epoch),
    });
    const tickets = new TicketService({
      storage,
      installationId: installation.installation_id,
      controllerEpoch: Number(installation.controller_epoch),
    });
    const leases = new LeaseService(storage);
    await tickets.refreshSimulatorFixtureObservation();
    await worker.reconcileBeforeScheduling();
    await leases.reconcilePending();
    let reconciling = false;
    const tick = async () => {
      if (reconciling) return;
      reconciling = true;
      try {
        await tickets.refreshSimulatorFixtureObservation();
        await worker.reconcileBeforeScheduling();
        await leases.reconcilePending();
        for (let index = 0; index < 32; index++)
          if (!(await tickets.reserveNext())) break;
        await worker.reconcile();
      } finally {
        reconciling = false;
      }
    };
    await tick();
    recoveryState = "ready";
    timer = setInterval(() => {
      void tick().catch((error: unknown) => {
        recoveryState = "unavailable";
        app?.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Simulator reconciliation failed",
        );
      });
    }, 2_000);
    timer.unref();
  } else if (config.EXECUTION_MODE === "portainer" && controlsReady) {
    recoveryState = "recovering";
    if (!secrets)
      throw new Error("Portainer mode requires the encrypted secret store");
    let installation = await storage.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation)
      throw new Error(
        "Installation is not initialized. Initialize the control ledger before starting Portainer mode.",
      );
    installation = await storage.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation) throw new Error("Installation identity is unavailable");
    const epoch = Number(installation.controller_epoch);
    const admin = new AdminService(
      storage,
      probePortainer,
      Date.now,
      config.PORTAINER_ALLOW_LOOPBACK_HTTP,
      (versionRef) => secrets.get(versionRef),
    );
    const accessMaterials = new SQLiteAccessMaterialStore(storage, secrets);
    const execution = new PortainerExecutionProvider(
      (plan) => resolvePortainerRuntime(storage, secrets, plan, epoch),
      accessMaterials,
    );
    const imageCache = new ImageCacheWorker(
      new SQLiteImageCacheStore(storage),
      new PortainerImageCacheProvider(async (operation) => {
        if (!operation.secretVersionRef)
          throw new Error("Frozen cache connection credential is unavailable");
        return {
          endpointUrl: operation.endpointRef,
          environmentId: operation.providerEndpointId,
          apiKey: await secrets.get(operation.secretVersionRef),
          engineId: operation.nativeEngineId,
        };
      }),
      async (operation) => {
        if (!(await admissionOpen(storage))) return undefined;
        const node = await storage.get<{
          config_json: string;
          installation_id: string;
        }>(
          "SELECT n.config_json,i.installation_id FROM nodes n JOIN installations i ON i.singleton=1 WHERE n.id=? AND n.runtime_identity_id=?",
          [operation.nodeId, operation.runtimeIdentityId],
        );
        if (!node) return undefined;
        const profile = NodeRuntimeConfigSchema.parse(
          JSON.parse(node.config_json).runtimeProfile,
        );
        const facts = await runtimeClient(profile, secrets).storageFacts({
          requestId: randomUUID(),
          installationId: node.installation_id,
          runtimeIdentityId: operation.runtimeIdentityId,
          nativeEngineId: operation.nativeEngineId,
          mounts: [],
        });
        return {
          verified: true,
          evidenceId: facts.requestId,
          observedAtMs: facts.receivedAtMs,
          sampledAtMs: facts.observedAtMs,
          availableMiB: facts.imageStore.availableMiB,
          requiredMiB: operation.sizeMiB ?? config.IMAGE_PULL_BUDGET_MIB,
          lowWaterMiB: config.DISK_LOW_WATER_MIB,
        };
      },
    );
    const worker = new OperationWorker({
      createCalls: new AllocationCreateCalls(),
      storage,
      execution,
      installationId: installation.installation_id,
      controllerEpoch: epoch,
    });
    const tickets = new TicketService({
      storage,
      installationId: installation.installation_id,
      controllerEpoch: epoch,
    });
    const leases = new LeaseService(storage);
    backgroundLoops = new PortainerBackgroundLoops({
      refreshObservations: async () => {
        await admin.refreshPortainerObservations();
        const nodes = await storage.all<{
          id: string;
          runtime_identity_id: string;
          native_id: string;
          config_json: string;
        }>(
          "SELECT n.id,n.runtime_identity_id,r.native_id,n.config_json FROM nodes n JOIN runtime_identities r ON r.id=n.runtime_identity_id WHERE n.backend_kind='portainer'",
        );
        const disks: Record<string, unknown> = {};
        for (const node of nodes) {
          const observedAtMs = Date.now();
          try {
            const profile = NodeRuntimeConfigSchema.parse(
              JSON.parse(node.config_json).runtimeProfile,
            );
            const facts = await runtimeClient(profile, secrets).storageFacts({
              requestId: randomUUID(),
              installationId: installation!.installation_id,
              runtimeIdentityId: node.runtime_identity_id,
              nativeEngineId: node.native_id,
              mounts: [],
            });
            const availableMiB = facts.imageStore.availableMiB;
            const state =
              availableMiB <= config.DISK_RESERVE_MIB
                ? "full"
                : availableMiB <= config.DISK_LOW_WATER_MIB
                  ? "low"
                  : "healthy";
            disks[node.id] = {
              nodeId: node.id,
              state,
              availableMiB,
              observedAtMs: facts.receivedAtMs,
              sampledAtMs: facts.observedAtMs,
              reserveMiB: config.DISK_RESERVE_MIB,
            };
            if (state !== "healthy") {
              const candidates = await storage.all<{
                image_artifact_id: string;
              }>(
                "SELECT c.image_artifact_id FROM image_caches c JOIN image_artifacts artifact ON artifact.id=c.image_artifact_id WHERE c.node_id=? AND c.observed_state='ready' AND (c.pinned_until_ms IS NULL OR c.pinned_until_ms<=?) ORDER BY COALESCE((SELECT max(a.updated_at_ms) FROM allocations a JOIN image_artifacts used ON used.id=a.image_artifact_id WHERE a.node_id=c.node_id AND used.content_digest=artifact.content_digest),c.digest_verified_at_ms,0) LIMIT 8",
                [node.id, Date.now()],
              );
              for (const candidate of candidates)
                await admin.planCacheEviction({
                  nodeId: node.id,
                  artifactId: candidate.image_artifact_id,
                });
            }
          } catch {
            disks[node.id] = {
              nodeId: node.id,
              state: "unknown",
              availableMiB: null,
              observedAtMs,
              reserveMiB: config.DISK_RESERVE_MIB,
            };
          }
        }
        await storage.run(
          "UPDATE system_maintenance SET runtime_disks_json=? WHERE singleton=1",
          [JSON.stringify(disks)],
        );
      },
      reconcile: async () => {
        await worker.reconcileBeforeScheduling();
        await leases.reconcilePending();
        for (let index = 0; index < 32; index++)
          if (!(await tickets.reserveNext())) break;
        await worker.reconcile();
        await imageCache.reconcile();
      },
      onReconcileSuccess: () => {
        recoveryState = "ready";
      },
      onFailure: (kind, error) => {
        if (kind === "reconcile") recoveryState = "unavailable";
        app?.log.error(
          {
            kind,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          kind === "observation"
            ? "Portainer observation refresh failed"
            : "Portainer reconciliation failed",
        );
      },
    });
  }
  app = await buildApp(config, {
    storage,
    maintenance,
    logStream,
    recoveryState: () => recoveryState,
    ...(secrets ? { secrets } : {}),
  });
  app.addHook("onClose", async () => {
    clearInterval(maintenanceTimer);
    await maintenanceRunning;
    logStream.end();
    if (timer) clearInterval(timer);
    await backgroundLoops?.close();
    await storage.close();
  });
  backgroundLoops?.start();
  maintenanceTick();
} catch (error) {
  if (timer) clearInterval(timer);
  await backgroundLoops?.close();
  await storage.close().catch(() => undefined);
  throw error;
}

async function resolvePortainerRuntime(
  storage: Awaited<ReturnType<typeof openStorage>>,
  secrets: LocalSecretStore,
  plan: ProvisionPlan,
  controllerEpoch: number,
) {
  // Resource identity and network/storage meaning stay frozen. Transport keys
  // follow the current activated connection and Agent credentials on the exact
  // Node, so revoking an old key does not strand an accepted cleanup obligation.
  const row = await storage.get<
    Record<string, string | number | bigint | null>
  >(
    "SELECT r.id actual_revision_id,r.endpoint_ref,r.provider_endpoint_id,r.secret_version_ref,r.verified_runtime_identity_id,r.evidence_json,ri.native_id,n.config_json,(SELECT id FROM platform_network_deny_revisions ORDER BY revision DESC LIMIT 1) AS effective_deny_id,(SELECT management_deny_rules_json FROM platform_network_deny_revisions ORDER BY revision DESC LIMIT 1) AS effective_deny_rules FROM provider_connection_revisions r JOIN runtime_identities ri ON ri.id=r.verified_runtime_identity_id JOIN allocations a ON a.id=? AND a.runtime_identity_id=ri.id JOIN nodes n ON n.id=a.node_id AND n.runtime_identity_id=ri.id JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=ri.id WHERE r.id=pc.current_revision_id AND r.verified_runtime_identity_id=? AND ri.id=? AND n.backend_kind='portainer'",
    [
      plan.identity.allocationId,
      plan.identity.runtimeIdentityId,
      plan.identity.runtimeIdentityId,
    ],
  );
  if (
    !row ||
    typeof row.endpoint_ref !== "string" ||
    typeof row.provider_endpoint_id !== "string" ||
    typeof row.secret_version_ref !== "string" ||
    typeof row.native_id !== "string" ||
    typeof row.config_json !== "string"
  )
    throw new Error(
      "The operation's frozen Portainer connection revision or exact Node is unavailable",
    );
  const nodeConfig = plan.runtimeConfig;
  if (!nodeConfig)
    throw new Error(
      "The Portainer operation has no frozen Runtime Agent configuration",
    );
  const runtimeProfile = NodeRuntimeConfigSchema.parse({
    ...NodeRuntimeConfigSchema.parse(nodeConfig.runtimeProfile),
    runtimeAgent: NodeRuntimeConfigSchema.parse(
      JSON.parse(row.config_json).runtimeProfile,
    ).runtimeAgent,
  });
  if (
    typeof row.effective_deny_id !== "string" ||
    typeof row.effective_deny_rules !== "string"
  )
    throw new Error("Current platform management protection is unavailable");
  const effectiveProtection = NodeRuntimeConfigSchema.parse({
    ...runtimeProfile,
    managementDenyRevisionId: row.effective_deny_id,
    managementDenyRules: JSON.parse(row.effective_deny_rules),
  });
  if (plan.executionPhase !== "cleanup")
    for (const mount of plan.resolved.mounts)
      if (mount.secretVersionRef) await secrets.get(mount.secretVersionRef);
  const apiKey = await secrets.get(row.secret_version_ref);
  const agent = runtimeProfile.runtimeAgent;
  const network = runtimeClient(runtimeProfile, secrets);
  await storage.run(
    "UPDATE operations SET result_json=json_set(COALESCE(result_json,'{}'),'$.transportRevisionId',?) WHERE id=?",
    [row.actual_revision_id!, plan.identity.operationId],
  );
  return {
    endpointUrl: row.endpoint_ref,
    environmentId: row.provider_endpoint_id,
    apiKey,
    engineId: row.native_id,
    providerEvidence: JSON.parse(String(row.evidence_json)),
    agentId: agent.id,
    controllerEpoch,
    networkCidrBase: runtimeProfile.networkCidrBase,
    ingressSourceCidrs: plan.resolved.network.allowedIngressSourceCidrs,
    effectiveDenyRevisionId: effectiveProtection.managementDenyRevisionId,
    accessHost: runtimeProfile.accessHost,
    userlandProxy: runtimeProfile.userlandProxy,
    managementDenyRules: [
      ...runtimeProfile.managementDenyRules,
      ...effectiveProtection.managementDenyRules,
    ],
    runtimeNetwork: network,
    storageLowWaterMiB: config.DISK_LOW_WATER_MIB,
    storageReserveMiB: config.DISK_RESERVE_MIB,
    storageFacts: (
      request: import("@hitchlet/contracts/internal").RuntimeStorageRequest,
    ) => network.storageFacts(request),
  };
}

const close = async () => app?.close();
process.once("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});
try {
  await app!.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  if (timer) clearInterval(timer);
  await backgroundLoops?.close();
  await storage.close().catch(() => undefined);
  throw error;
}
