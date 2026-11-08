import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  remainingWslPollDelayMs,
  wslObservationBootstrap,
} from "../src/host-wsl-client.js";

function bootstrap(mode: "valid" | "hash" | "machine" | "failure") {
  const collector =
    mode === "failure"
      ? 'export async function collectWslObservation(){throw Error("actual_collector_failed")}'
      : "export async function collectWslObservation(value){console.log(JSON.stringify(value))}";
  const request = {
    binding: {
      collectorPath: "/opt/hitchlet-observers/test/host-wsl-linux.js",
      distributionMachineId: "a".repeat(32),
    },
    collectorSha256:
      mode === "hash"
        ? "b".repeat(64)
        : createHash("sha256").update(collector).digest("hex"),
  };
  // Run the exact production bootstrap with deterministic read-only files/imports;
  // no local /opt directory, WSL service, fixture VM or source artifact is modified.
  const driver = `import {registerHooks} from "node:module";
const source=${JSON.stringify(collector)};
registerHooks({resolve(s,c,next){if(s==="node:fs/promises")return {url:"fixture:fs",shortCircuit:true};if(s==="file:///opt/hitchlet-observers/test/host-wsl-linux.js")return {url:"fixture:collector",shortCircuit:true};return next(s,c)},load(u,c,next){if(u==="fixture:fs")return {format:"module",shortCircuit:true,source:${JSON.stringify(`export async function readFile(p){if(p.endsWith("host-wsl-linux.js"))return Buffer.from(${JSON.stringify(collector)});if(p==="/etc/machine-id")return "${mode === "machine" ? "c".repeat(32) : "a".repeat(32)}\\n";if(p==="/proc/sys/kernel/random/boot_id")return "00000000-0000-4000-8000-000000000000\\n";throw Error("unexpected_read")}export async function readlink(p){if(p!=="/proc/1/ns/pid")throw Error("unexpected_readlink");return "pid:[123]"}`)}};if(u==="fixture:collector")return {format:"module",shortCircuit:true,source};return next(u,c)}});
await import(${JSON.stringify("data:text/javascript;base64," + Buffer.from(wslObservationBootstrap).toString("base64"))});`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", driver],
    { input: JSON.stringify(request), encoding: "utf8", timeout: 10000 },
  );
}
it("collects exact context and invokes only the artifact whose bytes were verified", () => {
  const result = bootstrap("valid");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).before).toEqual({
    distributionMachineId: "a".repeat(32),
    bootId: "00000000-0000-4000-8000-000000000000",
    pidNamespace: "pid:[123]",
  });
});
it.each(["hash", "machine", "failure"] as const)(
  "does not publish fabricated fresh facts after %s failure",
  (mode) => {
    const result = bootstrap(mode);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  },
);
it("deducts real monotonic collection time instead of adding another two-second gap", () => {
  expect(remainingWslPollDelayMs(250)).toBe(1750);
  expect(remainingWslPollDelayMs(2000)).toBe(0);
  expect(remainingWslPollDelayMs(3400)).toBe(0);
});
