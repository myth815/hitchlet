import { HealthResponseSchema } from "@hitchlet/contracts/health";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { redact } from "./config.js";
export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ["req.headers.*"],
        censor: "[REDACTED]",
      },
    },
  });
  app.get("/healthz", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      stage: "D00",
      simulator: "not_implemented",
    }),
  );
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
        return reply.code(404).send({ error: "Not Found" });
      const index = path.join(path.resolve(config.GUI_DIR), "index.html");
      if (existsSync(index))
        return reply.type("text/html").sendFile("index.html");
      return reply.code(404).send({ error: "Not Found" });
    });
  }
  app.addHook("onRequest", async (request) => {
    request.log.debug(redact({ headers: request.headers }));
  });
  return app;
}
