// Resume the retained, isolated Studio acceptance installation; never initializes data.
import { execFileSync } from "node:child_process";
import { readFileSync, accessSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { studioChildren } from "./studio-acceptance-children.mjs";
import { inspectRetainedStudio } from "./studio-acceptance-status.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function resume({ checkOnly = false } = {}) {
  const root = process.env.HITCHLET_STUDIO_STATE_DIR;
  if (!root)
    throw new Error(
      "Set HITCHLET_STUDIO_STATE_DIR to the retained private installation directory",
    );
  const state = JSON.parse(readFileSync(resolve(root, "state.json"), "utf8"));
  const profile = "hitchlet-studio-acceptance";
  const context = "colima-hitchlet-studio-acceptance";
  const run = (bin, args) =>
    execFileSync(bin, args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const status = await inspectRetainedStudio({ root, run });
  if (checkOnly || status.status === "running") {
    console.log(
      JSON.stringify({
        ...status,
        action: checkOnly ? "checked" : "reused",
        started: false,
      }),
    );
    if (checkOnly && !status.ready) process.exitCode = 1;
    return;
  }
  const profiles = run("colima", ["list", "--json"])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!profiles.some((item) => item.name === profile))
    throw new Error(
      "Retained Colima profile is missing; this entry never creates a replacement VM",
    );
  run("colima", [
    "-p",
    profile,
    "start",
    "--activate=false",
    "--ssh-config=false",
  ]);
  const engine = run("docker", [
    "--context",
    context,
    "info",
    "--format",
    "{{.ID}}",
  ]);
  if (engine.trim() !== state.connection.evidence.engineId)
    throw new Error(
      "Retained Engine identity changed; do not resume against a replacement",
    );
  for (const name of ["portainer", "registry", "runtime-agent"]) {
    const container = `hitchlet-studio-${name}`;
    const label = run("docker", [
      "--context",
      context,
      "inspect",
      container,
      "--format",
      '{{index .Config.Labels "io.hitchlet.studio-stack"}}',
    ]);
    if (label.trim() !== "acceptance")
      throw new Error(`Unexpected management container: ${container}`);
  }
  for (const name of ["portainer", "registry", "runtime-agent"]) {
    run("docker", ["--context", context, "start", `hitchlet-studio-${name}`]);
  }

  let stopping = false;
  let reloading = false;
  let failed = false;
  const children = studioChildren({
    onFailure: (error) => {
      failed = true;
      console.error(
        error.message + "; supervisor retained, fix release and send SIGHUP",
      );
    },
  });
  function releaseDirectory() {
    const file = process.env.HITCHLET_STUDIO_RELEASE_FILE;
    const dir = file
      ? resolve(JSON.parse(readFileSync(file, "utf8")).releaseDirectory)
      : repo;
    // Resolve the release before stopping anything; a typo cannot take down a healthy child.
    for (const entry of [
      "apps/controller/dist/server.js",
      "apps/runtime-agent/dist/host-main.js",
    ])
      accessSync(resolve(dir, entry));
    return dir;
  }
  const proxy = https.createServer(
    {
      key: readFileSync(resolve(root, "secrets/server.key")),
      cert: readFileSync(resolve(root, "secrets/server.crt")),
    },
    (req, res) => {
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: 33100,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(503);
        res.end();
      });
      req.pipe(upstream);
      req.on("aborted", () => upstream.destroy());
    },
  );
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    proxy.close();
    children
      .stop()
      .then(() => {
        process.exitCode = code;
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
  function start(file, env, dir) {
    return children.start(resolve(dir, file), {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
  }
  async function reload() {
    if (stopping || reloading) return;
    reloading = true;
    try {
      const dir = releaseDirectory();
      await children.stop();
      if (stopping) return;
      failed = false;
      start(
        "apps/controller/dist/server.js",
        {
          HOST: "127.0.0.1",
          PORT: "33100",
          DATA_DIR: resolve(root, "controller-data"),
          HITCHLET_SECRET_KEY_FILE: resolve(root, "secrets/master.key"),
          GUI_DIR: resolve(dir, "apps/gui/dist"),
          EXECUTION_MODE: "portainer",
          PORTAINER_ALLOW_LOOPBACK_HTTP: "true",
          LOG_LEVEL: "warn",
        },
        dir,
      );
      let ready = false;
      for (let attempt = 0; attempt < 50 && !stopping && !failed; attempt++) {
        try {
          const response = await fetch("http://127.0.0.1:33100/healthz", {
            signal: AbortSignal.timeout(1000),
          });
          if (
            response.ok &&
            (await response.json()).recoveryState === "ready"
          ) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready || stopping || failed)
        throw new Error(
          "Studio controller is not ready; supervisor/network parent retained",
        );
      start(
        "apps/runtime-agent/dist/host-main.js",
        {
          HITCHLET_HOST_AGENT_CONFIG: resolve(root, "secrets/host-config.json"),
        },
        dir,
      );
      console.log(
        "Studio children ready from " +
          dir +
          "; supervisor PID " +
          process.pid +
          " retained",
      );
    } catch (error) {
      console.error(error.message);
    } finally {
      reloading = false;
    }
  }
  proxy.once("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  proxy.listen(33101, "127.0.0.1", () => {
    void reload();
  });
  // Normal upgrades update the release pointer and signal only this parent.
  // Do not bootout/kickstart the parent: Lima's usernet retains its responsibility.
  process.on("SIGHUP", () => {
    void reload();
  });
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(
    "HITCHLET_STUDIO_STATE_DIR=<retained-state> node scripts/studio-acceptance-resume.mjs [--check|--resume]\n--check is read-only; --resume (default) reuses an online installation or resumes the retained one. No autostart, credentials or replacement VM are created.",
  );
} else if (
  args.length > 1 ||
  (args.length === 1 && !["--check", "--resume"].includes(args[0]))
) {
  console.error("Expected --check or --resume; use --help.");
  process.exitCode = 1;
} else {
  resume({ checkOnly: args[0] === "--check" }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
