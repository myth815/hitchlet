import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  HostPowerEventSchema,
  HostPowerDirectiveSchema,
  hostSnapshotSchema,
} from "@hitchlet/contracts/internal";
/** Fixed artifact list and protocol schema; install-time expectation and per-run attestation must agree. */
export async function powerExecutorHash() {
  const hash = createHash("sha256").update("hitchlet-native-power-v1\n");
  for (const name of [
    "host-power-main.js",
    "host-power.js",
    "host-power-watchdog.js",
    "host-power-watch-launcher.js",
    "host-power-storage.js",
    "host-power-fingerprint.js",
    "host-power-windows.ps1",
    "host-service.js",
    "host-probes.js",
    "host-windows.ps1",
    "host-client.js",
  ]) {
    hash
      .update(name)
      .update("\0")
      .update(await readFile(new URL(name, import.meta.url)));
  }
  for (const schema of [
    HostPowerEventSchema,
    HostPowerDirectiveSchema,
    hostSnapshotSchema,
  ])
    hash.update(JSON.stringify(z.toJSONSchema(schema)));
  return hash.digest("hex");
}
