import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
const config = loadConfig(process.env);
const app = await buildApp(config);
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
