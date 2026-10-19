import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { randomUUID } from "node:crypto";
import { openStorage } from "./storage/index.js";
import { OperationWorker } from "./application/operations.js";
import { PersistentSimulator } from "./providers/simulator.js";
const config = loadConfig(process.env);
const app = await buildApp(config);
if (config.EXECUTION_MODE === "simulator") {
  const storage = await openStorage(config.DATA_DIR);
  try {
    let installation = await storage.get<{
      installation_id: string;
      controller_epoch: bigint;
    }>(
      "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
    );
    if (!installation) {
      await storage.run(
        "INSERT INTO installations(singleton,installation_id,controller_epoch,created_at_ms) VALUES(1,?,1,?)",
        [randomUUID(), Date.now()],
      );
      installation = await storage.get<{
        installation_id: string;
        controller_epoch: bigint;
      }>(
        "SELECT installation_id,controller_epoch FROM installations WHERE singleton=1",
      );
    } else {
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
    }
    if (!installation)
      throw new Error(
        "Simulator installation identity could not be initialized",
      );
    const worker = new OperationWorker({
      storage,
      execution: new PersistentSimulator(config.SIMULATOR_DATA_DIR!),
      installationId: installation.installation_id,
      controllerEpoch: Number(installation.controller_epoch),
    });
    await worker.reconcileBeforeScheduling();
    const timer = setInterval(() => {
      void worker
        .reconcileBeforeScheduling()
        .catch(() => app.log.error("Simulator reconciliation failed"));
    }, 2_000);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
      await storage.close();
    });
  } catch (error) {
    await storage.close();
    throw error;
  }
}
const close = async () => {
  await app.close();
};
process.once("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});
await app.listen({ host: config.HOST, port: config.PORT });
