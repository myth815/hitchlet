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
import { RuntimeNetworkHttpClient } from "./providers/runtime-network-client.js";
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
const secrets = config.HITCHLET_SECRET_KEY_FILE
  ? await LocalSecretStore.open(
      config.DATA_DIR,
      config.HITCHLET_SECRET_KEY_FILE,
    )
  : undefined;
let recoveryState: "ready" | "recovering" | "unavailable" = "ready";
let timer: NodeJS.Timeout | undefined;
let backgroundLoops: PortainerBackgroundLoops | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  if (config.EXECUTION_MODE === "simulator") {
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
    await storage.run(
      "UPDATE installations SET controller_epoch=controller_epoch+1 WHERE singleton=1 AND installation_id=?",
      [installation.installation_id],
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
  } else if (config.EXECUTION_MODE === "portainer") {
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
    await storage.run(
      "UPDATE installations SET controller_epoch=controller_epoch+1 WHERE singleton=1 AND installation_id=?",
      [installation.installation_id],
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
      // D23 supplies verified image-store capacity. Until then, an already
      // present image can be verified, but cache prewarm cannot start a pull.
      async () => undefined,
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
    recoveryState: () => recoveryState,
    ...(secrets ? { secrets } : {}),
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await backgroundLoops?.close();
    await storage.close();
  });
  backgroundLoops?.start();
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
  const row = await storage.get<
    Record<string, string | number | bigint | null>
  >(
    "SELECT r.endpoint_ref,r.provider_endpoint_id,r.secret_version_ref,r.verified_runtime_identity_id,r.evidence_json,ri.native_id,n.config_json,(SELECT id FROM platform_network_deny_revisions ORDER BY revision DESC LIMIT 1) AS effective_deny_id,(SELECT management_deny_rules_json FROM platform_network_deny_revisions ORDER BY revision DESC LIMIT 1) AS effective_deny_rules FROM provider_connection_revisions r JOIN runtime_identities ri ON ri.id=r.verified_runtime_identity_id JOIN allocations a ON a.id=? AND a.runtime_identity_id=ri.id JOIN nodes n ON n.id=a.node_id AND n.runtime_identity_id=ri.id WHERE r.id=? AND r.verified_runtime_identity_id=? AND ri.id=? AND n.backend_kind='portainer'",
    [
      plan.identity.allocationId,
      plan.identity.connectionRevisionId,
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
  const runtimeProfile = NodeRuntimeConfigSchema.parse(
    nodeConfig.runtimeProfile,
  );
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
  const apiKey = await secrets.get(row.secret_version_ref);
  const agent = runtimeProfile.runtimeAgent;
  const network = new RuntimeNetworkHttpClient({
    baseUrl: agent.baseUrl,
    loadCredentials: async () => {
      const [token, ca, cert, key] = await Promise.all([
        secrets.get(agent.tokenSecretRef),
        secrets.get(agent.caSecretRef),
        secrets.get(agent.clientCertSecretRef),
        secrets.get(agent.clientKeySecretRef),
      ]);
      return {
        token,
        ca: Buffer.from(ca),
        cert: Buffer.from(cert),
        key: Buffer.from(key),
      };
    },
  });
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
