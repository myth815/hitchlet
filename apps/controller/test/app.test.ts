import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
let temporaryDirectory: string | undefined;
afterEach(async () => {
  if (temporaryDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});
describe("controller app", () => {
  it("serves a schema-valid healthy response when Portainer execution is enabled", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "hitchlet-portainer-health-"),
    );
    const app = await buildApp(
      loadConfig({
        DATA_DIR: temporaryDirectory,
        EXECUTION_MODE: "portainer",
        HITCHLET_SECRET_KEY_FILE: path.join(temporaryDirectory, "master.key"),
      }),
    );
    try {
      const response = await app.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        stage: "D05",
        executionMode: "portainer",
        recoveryState: "ready",
      });
    } finally {
      await app.close();
    }
  });

  it("serves health, static assets, SPA routes, and preserves API 404s", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hitchlet-"));
    await mkdir(path.join(temporaryDirectory, "assets"));
    await writeFile(
      path.join(temporaryDirectory, "index.html"),
      "<main>Hitchlet GUI</main>",
    );
    await writeFile(
      path.join(temporaryDirectory, "assets", "app.js"),
      'console.log("gui")',
    );
    const app = await buildApp(
      loadConfig({ DATA_DIR: temporaryDirectory, GUI_DIR: temporaryDirectory }),
    );
    try {
      const health = await app.inject({ url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({
        status: "ok",
        stage: "D05",
        executionMode: "disabled",
        recoveryState: "ready",
      });
      const openapi = await app.inject({ url: "/v1/openapi.json" });
      expect(openapi.statusCode).toBe(200);
      const document = openapi.json() as {
        paths: Record<string, Record<string, unknown>>;
        components: { schemas: Record<string, unknown> };
      };
      expect(Object.keys(document.paths)).toEqual(
        expect.arrayContaining([
          "/v1/auth/session",
          "/v1/auth/me",
          "/v1/events/stream",
          "/v1/tickets/{ticketId}/revoke",
          "/v1/tickets",
          "/v1/tickets/{ticketId}/release",
          "/v1/tickets/{ticketId}/cancel",
          "/v1/tickets/{ticketId}/renew",
          "/v1/tickets/{ticketId}/renewals/{renewalId}",
          "/v1/tickets/{ticketId}/access",
          "/v1/tickets/{ticketId}/events",
          "/v1/events",
          "/v1/images",
          "/v1/image-versions/{versionId}",
        ]),
      );
      const refs: string[] = [];
      const visit = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (typeof value === "object" && value !== null)
          Object.entries(value).forEach(([key, item]) => {
            if (key === "$ref" && typeof item === "string") refs.push(item);
            else visit(item);
          });
      };
      visit(document);
      for (const ref of refs) {
        expect(ref.startsWith("#/components/schemas/")).toBe(true);
        expect(
          document.components.schemas[
            ref.slice("#/components/schemas/".length)
          ],
        ).toBeDefined();
      }
      expect((await app.inject({ url: "/assets/app.js" })).body).toContain(
        "console.log",
      );
      expect((await app.inject({ url: "/tickets/1" })).body).toContain(
        "Hitchlet GUI",
      );
      const missingApi = await app.inject({ url: "/v1/tickets" });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
    }
  });
});
