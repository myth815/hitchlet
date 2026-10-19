import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const pnpm = isWindows ? "pnpm.cmd" : "pnpm";
let server;
let stopping = false;
let compiled = false;
let restartAfterExit = false;

function startServer() {
  if (stopping) return;
  server = spawn(process.execPath, ["dist/server.js"], { stdio: "inherit" });
  server.once("exit", (code, signal) => {
    server = undefined;
    if (!stopping && code !== 0 && signal === null)
      process.stderr.write(`Controller exited (${code ?? "unknown"}).\n`);
    if (!stopping && restartAfterExit) {
      restartAfterExit = false;
      startServer();
    }
  });
  process.stdout.write("Controller started from dist/server.js.\n");
}

const compiler = spawn(
  pnpm,
  ["exec", "tsc", "--watch", "--preserveWatchOutput", "-p", "tsconfig.json"],
  { stdio: ["inherit", "pipe", "inherit"] },
);
compiler.stdout.setEncoding("utf8");
compiler.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (chunk.includes("Found 0 errors. Watching for file changes.")) {
    if (!compiled) {
      compiled = true;
      startServer();
    } else {
      process.stdout.write("Controller build completed; restarting.\n");
      if (server) {
        restartAfterExit = true;
        server.kill("SIGTERM");
      } else {
        startServer();
      }
    }
  }
});

async function shutdown(signal = "SIGINT") {
  if (stopping) return;
  stopping = true;
  compiler.kill(signal);
  if (server) {
    await new Promise((resolvePromise) => {
      server.once("exit", resolvePromise);
      server.kill(signal);
    });
  }
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
