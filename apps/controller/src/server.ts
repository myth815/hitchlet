import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openStorage } from "./storage/index.js";
import { OperationWorker } from "./application/operations.js";
import { TicketService } from "./application/tickets.js";
import { LeaseService } from "./application/leases.js";
import { PersistentSimulator } from "./providers/simulator.js";
import { LocalSecretStore } from "./storage/secret-store.js";

const config = loadConfig(process.env);
const storage = await openStorage(config.DATA_DIR);
let recoveryState: "ready" | "recovering" | "unavailable" = "ready";
let timer: NodeJS.Timeout | undefined;
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
  }
  const secrets = config.HITCHLET_SECRET_KEY_FILE
    ? await LocalSecretStore.open(
        config.DATA_DIR,
        config.HITCHLET_SECRET_KEY_FILE,
      )
    : undefined;
  app = await buildApp(config, {
    storage,
    recoveryState: () => recoveryState,
    ...(secrets ? { secrets } : {}),
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await storage.close();
  });
} catch (error) {
  if (timer) clearInterval(timer);
  await storage.close().catch(() => undefined);
  throw error;
}

const close = async () => app?.close();
process.once("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});
await app!.listen({ host: config.HOST, port: config.PORT });
