import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import http from "node:http";
import https from "node:https";

export const STUDIO_PROFILE = "hitchlet-studio-acceptance";
export const STUDIO_CONTEXT = "colima-hitchlet-studio-acceptance";

// Read-only, bounded calls; only a refused connection means the listener is absent.
// TLS/auth/timeouts or an occupied unrelated endpoint are not permission to restart.
export function readStudioJson(url, { ca, token } = {}) {
  return new Promise((resolveResponse, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const req = transport.get(
      url,
      {
        ...(ca ? { ca } : {}),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        timeout: 3000,
      },
      (res) => {
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1048576) {
            req.destroy(new Error("Studio status response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () =>
          reject(new Error("Studio status response interrupted")),
        );
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {}
          resolveResponse({ status: res.statusCode, body });
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("Studio status request timed out")),
    );
    req.on("error", (error) =>
      error.code === "ECONNREFUSED"
        ? resolveResponse(null)
        : reject(
            new Error(
              `Studio status request failed (${error.code || "unknown"})`,
            ),
          ),
    );
  });
}

export async function inspectRetainedStudio({
  root,
  run,
  request = readStudioJson,
}) {
  const state = JSON.parse(readFileSync(resolve(root, "state.json"), "utf8"));
  const expectedEngine = state.connection?.evidence?.engineId;
  const installationId = state.installation?.installationId;
  if (!expectedEngine || !installationId)
    throw new Error("Retained Engine/installation identity is missing");
  const profiles = run("colima", ["list", "--json"])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const profile = profiles.find((item) => item.name === STUDIO_PROFILE);
  if (!profile)
    throw new Error(
      "Retained Colima profile is missing; this entry never creates a replacement VM",
    );
  let engineVerified = false;
  if (profile.status !== "Stopped") {
    const actual = run("docker", [
      "--context",
      STUDIO_CONTEXT,
      "info",
      "--format",
      "{{.ID}}",
    ]).trim();
    engineVerified = actual === expectedEngine;
    if (!engineVerified)
      throw new Error(
        "Retained Engine identity changed; do not resume against a replacement",
      );
  }
  const caFile = resolve(root, "secrets/ca.crt");
  const ca = readFileSync(caFile);
  const [plain, tls] = await Promise.all([
    request("http://127.0.0.1:33100/healthz"),
    request("https://127.0.0.1:33101/healthz", { ca }),
  ]);
  const result = {
    status: "stopped",
    ready: false,
    profile: STUDIO_PROFILE,
    context: STUDIO_CONTEXT,
    profileStatus: profile.status,
    installationId,
    expectedEngineId: expectedEngine,
    origin: "https://127.0.0.1:33101",
    httpOrigin: "http://127.0.0.1:33100",
    startupPersistence:
      "not inspected; an external user service may manage this supervisor",
    serviceVersion: "not inferred from the requesting checkout",
  };
  if (plain === null && tls === null) return result;
  if (
    !engineVerified ||
    plain?.status !== 200 ||
    tls?.status !== 200 ||
    plain.body?.status !== "ok" ||
    tls.body?.status !== "ok"
  )
    throw new Error(
      "Studio listeners are partial, unhealthy or occupied; do not start a duplicate supervisor",
    );
  const token = readFileSync(
    resolve(root, "secrets/admin-token"),
    "utf8",
  ).trim();
  const identity = await request(
    "https://127.0.0.1:33101/v1/admin/installation",
    { ca, token },
  );
  if (
    identity?.status !== 200 ||
    identity.body?.installationId !== installationId
  )
    throw new Error(
      "Running installation identity could not be confirmed; leave it untouched",
    );
  const consumerTokenFile = resolve(root, "secrets/tenant-token");
  const catalog = await request("https://127.0.0.1:33101/v1/catalog", {
    ca,
    token: readFileSync(consumerTokenFile, "utf8").trim(),
  });
  return {
    ...result,
    status: "running",
    ready:
      plain.body.recoveryState === "ready" &&
      tls.body.recoveryState === "ready",
    recoveryState: tls.body.recoveryState ?? null,
    consumer: {
      tokenFile: consumerTokenFile,
      caFile,
      catalogStatus: catalog?.status ?? null,
      ...(catalog?.status === 200 ? { catalog: catalog.body } : {}),
    },
  };
}
