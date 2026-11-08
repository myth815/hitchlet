/** Fixed original-owner keepalive. No commands, listeners, bearer tokens or persistent state. */
import { readFile, readlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
/** Install before asynchronous identity reads, so early parent EOF cannot strand the helper. */
export function trackKeeperParent(
  input: Readable,
  stop: (code: number) => void,
) {
  const state = { open: true };
  const close = (code: number) => {
    if (state.open) {
      state.open = false;
      stop(code);
    }
  };
  input.once("end", () => close(0));
  input.once("error", () => close(1));
  input.once("data", () => close(1));
  input.resume();
  return state;
}
async function hash(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
async function main() {
  const parent = trackKeeperParent(process.stdin, (code) => process.exit(code));
  const pid = process.pid,
    base = `/proc/${pid}`;
  const text = await readFile(base + "/stat", "utf8");
  const fields = text
    .slice(text.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  const executable = await readlink(base + "/exe");
  const before = await stat(executable);
  if (
    !before.isFile() ||
    ![0, process.getuid!()].includes(before.uid) ||
    before.mode & 0o022 ||
    before.size > 256 * 1024 * 1024
  )
    throw Error("keeper_node_unprotected");
  const nodeSha256 = await hash(executable),
    helperSha256 = await hash(fileURLToPath(import.meta.url));
  const after = await stat(executable);
  for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
    if (before[key] !== after[key]) throw Error("keeper_node_changed");
  const proof = {
    pid,
    parentPid: Number(fields[1]),
    uid: process.getuid!(),
    startTicks: fields[19],
    executable,
    pidNamespace: await readlink(base + "/ns/pid"),
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    distributionMachineId: (await readFile("/etc/machine-id", "utf8")).trim(),
    nodeSha256,
    helperSha256,
    nodeFile: {
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
    },
  };
  if (!parent.open) return;
  process.stdout.write(JSON.stringify(proof) + "\n");
  // The original private pipe is the lifetime owner. EOF exits naturally; no command protocol.
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    process.stderr.write("wsl_keeper_failed\n");
    process.exit(1);
  });
