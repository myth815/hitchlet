import { parentPort } from "node:worker_threads";

parentPort.postMessage({
  id: 0,
  result: { sqliteVersion: { version: "3.53.4" }, schemaVersion: 1 },
});
parentPort.on("message", () => {
  throw new Error("injected worker failure");
});
