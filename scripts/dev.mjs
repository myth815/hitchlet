import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const isWindows = process.platform === "win32";
const executable = isWindows ? "pnpm.cmd" : "pnpm";
const env = {
  ...process.env,
  DATA_DIR: process.env.DATA_DIR ?? resolve("data"),
};
for (const args of [
  ["--filter", "@hitchlet/contracts", "build"],
  ["--filter", "@hitchlet/sdk", "build"],
]) {
  const result = spawnSync(executable, args, {
    env,
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const child = spawn(
  executable,
  [
    "--parallel",
    "--filter",
    "@hitchlet/controller",
    "--filter",
    "@hitchlet/gui",
    "dev",
  ],
  { env, stdio: "inherit", shell: isWindows },
);
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
