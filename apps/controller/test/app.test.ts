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
        stage: "D00",
        simulator: "not_implemented",
      });
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
