import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { TartLocalDriver } from "../src/drivers/tart.js";

const roots: string[] = [];
const supportsTartHost =
  process.platform === "darwin" && process.arch === "arm64";
const inputs = {
  allocationId: "alloc-1",
  generation: 1,
  ownerId: "tenant-1",
  templateName: "linux-arm64-template",
  cpus: 4,
  memoryMiB: 4096,
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const vms = join(root, "tart-home", "vms");
    try {
      for (const name of await readdir(vms)) {
        try {
          const pid = Number(
            await readFile(join(vms, name, "run.pid"), "utf8"),
          );
          if (Number.isInteger(pid) && pid > 1) process.kill(pid, "SIGKILL");
        } catch {
          /* no supervised fake run process */
        }
      }
    } catch {
      /* home was not created */
    }
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!supportsTartHost)(
  "clones a local arm64 template once, recovers its manifest-owned VM, and proves delete absence",
  async () => {
    const root = await setupFixture();
    const first = makeDriver(root);
    const [one, concurrent] = await Promise.all([
      first.provision(inputs),
      first.provision(inputs),
    ]);
    expect(one).toEqual({
      status: "observed_with_ip",
      vmName: expectedName(),
      ipAddress: "192.0.2.10",
    });
    expect(concurrent).toEqual(one);

    const events = await readEvents(root);
    expect(events.filter((event) => event.args[0] === "clone")).toHaveLength(1);
    expect(events.filter((event) => event.args[0] === "run")).toHaveLength(1);
    expect(
      events.every((event) => event.env.TART_HOME === join(root, "tart-home")),
    ).toBe(true);
    expect(
      await makeDriver(root).provision({ ...inputs, memoryMiB: 8192 }),
    ).toMatchObject({ status: "unknown" });
    expect(events.every((event) => event.env.TART_NO_AUTO_PRUNE === "1")).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          JSON.stringify(event.args) ===
          JSON.stringify([
            "set",
            expectedName(),
            "--cpu",
            "4",
            "--memory",
            "4096",
            "--random-mac",
          ]),
      ),
    ).toBe(true);

    const close = await first.close();
    expect(close.lastObservedOwnedRunningVMs).toEqual([expectedName()]);
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "stop"),
    ).toBe(false);
    await expect(first.provision(inputs)).rejects.toThrow("tart_driver_closed");

    const resumed = makeDriver(root);
    expect(await resumed.provision(inputs)).toEqual(one);
    expect(
      (await readEvents(root)).filter((event) => event.args[0] === "clone"),
    ).toHaveLength(1);
    expect(await resumed.destroy(inputs)).toEqual({ status: "absent" });
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "delete"),
    ).toBe(true);
    expect(await resumed.destroy(inputs)).toMatchObject({ status: "unknown" });
    await resumed.close();
  },
);

it.skipIf(!supportsTartHost)(
  "does not treat a same-name VM without a durable owner manifest as owned",
  async () => {
    const root = await setupFixture();
    const vmName = expectedName();
    const foreign = join(root, "tart-home", "vms", vmName);
    await mkdir(foreign, { recursive: true });
    await writeConfig(foreign, "linux", "02:aa:bb:cc:dd:ee");
    const driver = makeDriver(root);

    expect(await driver.provision(inputs)).toEqual({
      status: "unknown",
      reason: "unmanifested_vm_name_collision",
    });
    expect(await driver.destroy(inputs)).toMatchObject({ status: "unknown" });
    expect(
      (await readEvents(root)).some((event) =>
        ["clone", "delete", "stop"].includes(event.args[0] ?? ""),
      ),
    ).toBe(false);
    await driver.close();
  },
);

it.skipIf(!supportsTartHost)(
  "close waits for an active transition, then reports the still-running VM without stopping it",
  async () => {
    const root = await setupFixture();
    const home = join(root, "tart-home");
    await writeFile(join(home, "hold-ip"), "hold");
    const driver = makeDriver(root);
    const provisioning = driver.provision(inputs);
    await waitForFile(join(home, "ip-started"));

    let closed = false;
    const closing = driver.close().then((result) => {
      closed = true;
      return result;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(closed).toBe(false);
    await writeFile(join(home, "ip-release"), "release");
    expect(await provisioning).toMatchObject({ status: "observed_with_ip" });
    expect(await closing).toEqual({
      lastObservedOwnedRunningVMs: [expectedName()],
    });
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "stop"),
    ).toBe(false);

    const cleanup = makeDriver(root);
    expect(await cleanup.destroy(inputs)).toEqual({ status: "absent" });
    await cleanup.close();
  },
);

function expectedName(): string {
  const identity = createHash("sha256")
    .update(`tenant-1\0alloc-1\0${inputs.generation}`)
    .digest("hex")
    .slice(0, 32);
  return `hitchlet-${identity}`;
}

it("rejects hosts outside the macOS arm64 Tart scope", () => {
  const driver = () => makeDriver("/tmp/hitchlet-tart-scope-test");
  if (supportsTartHost) expect(driver).not.toThrow();
  else expect(driver).toThrow("tart_host_unsupported");
});

it.skipIf(!supportsTartHost)(
  "does not recreate an interrupted clone or use its manifest with changed home identity",
  async () => {
    const root = await setupFixture();
    const initial = makeDriver(root);
    await initial.provision(inputs);
    await initial.close();
    const manifestFile = (await readdir(join(root, "manifests")))[0];
    expect(manifestFile).toBeDefined();
    const manifestPath = join(root, "manifests", manifestFile!);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const ownedManifest = JSON.stringify(manifest);
    delete manifest.identity;
    manifest.phase = "clone_intent";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const resumed = makeDriver(root);
    expect(await resumed.provision(inputs)).toEqual({
      status: "unknown",
      reason: "interrupted_clone_identity_not_recorded",
    });
    expect(
      (await readEvents(root)).filter((event) => event.args[0] === "clone"),
    ).toHaveLength(1);
    await resumed.close();

    await writeFile(manifestPath, ownedManifest);
    const alternateHome = join(root, "alternate-home");
    await mkdir(join(alternateHome, "vms"), { recursive: true, mode: 0o700 });
    const changedHome = makeDriver(root, alternateHome);
    expect(await changedHome.destroy(inputs)).toEqual({
      status: "unknown",
      reason: "tart_home_identity_changed",
    });
    expect(await readdir(join(root, "tart-home", "vms"))).toContain(
      expectedName(),
    );
    await changedHome.close();
  },
);

it.skipIf(!supportsTartHost)(
  "does not delete when stop exits successfully but Tart still reports running",
  async () => {
    const root = await setupFixture();
    const driver = makeDriver(root);
    await driver.provision(inputs);
    await writeFile(join(root, "tart-home", "keep-run-marker"), "keep");
    await writeFile(join(root, "tart-home", "ignore-stop-marker"), "ignore");

    expect(await driver.destroy(inputs)).toEqual({
      status: "unknown",
      reason: "vm_stop_not_verified",
    });
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "delete"),
    ).toBe(false);
    await driver.close();
  },
);

it.skipIf(!supportsTartHost)(
  "does not claim absence when CLI and Tart home inventories disagree",
  async () => {
    const root = await setupFixture();
    const driver = makeDriver(root);
    await driver.provision(inputs);
    await writeFile(join(root, "tart-home", "hide-owned-vm-marker"), "hide");

    expect(await driver.destroy(inputs)).toEqual({
      status: "unknown",
      reason: "inventory_incomplete",
    });
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "delete"),
    ).toBe(false);
    await driver.close();
  },
);

function makeDriver(
  root: string,
  tartHome = join(root, "tart-home"),
): TartLocalDriver {
  return new TartLocalDriver({
    tartHome,
    manifestDirectory: join(root, "manifests"),
    executable: join(root, "fake-tart"),
  });
}

async function setupFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-tart-driver-"));
  roots.push(root);
  const home = join(root, "tart-home");
  const template = join(home, "vms", inputs.templateName);
  await mkdir(template, { recursive: true });
  await chmod(home, 0o700);
  await writeConfig(template, "linux", "02:00:00:00:00:11");
  const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.TART_HOME;
const vms = path.join(home, 'vms');
const args = process.argv.slice(2);
const events = path.join(home, 'events.jsonl');
fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(events, JSON.stringify({ args, env: { TART_HOME: process.env.TART_HOME, TART_NO_AUTO_PRUNE: process.env.TART_NO_AUTO_PRUNE } }) + '\\n');
const vmPath = (name) => path.join(vms, name);
const config = (name) => path.join(vmPath(name), 'config.json');
if (args[0] === 'list') {
  const rows = fs.readdirSync(vms, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !(fs.existsSync(path.join(home, 'hide-owned-vm-marker')) && entry.name.startsWith('hitchlet-'))).map((entry) => ({
    Source: 'local', Name: entry.name, Disk: '1 GB', Size: '1 GB', Accessed: new Date().toISOString(),
    Running: fs.existsSync(path.join(vmPath(entry.name), 'run.pid')), State: fs.existsSync(path.join(vmPath(entry.name), 'run.pid')) ? 'running' : 'stopped'
  }));
  process.stdout.write(JSON.stringify(rows));
} else if (args[0] === 'clone') {
  fs.cpSync(vmPath(args[1]), vmPath(args[2]), { recursive: true, errorOnExist: true });
} else if (args[0] === 'set') {
  const value = JSON.parse(fs.readFileSync(config(args[1]), 'utf8'));
  value.macAddress = '02:00:00:00:00:22';
  value.cpuCount = Number(args[args.indexOf('--cpu') + 1]);
  value.memorySize = Number(args[args.indexOf('--memory') + 1]) * 1024 * 1024;
  fs.writeFileSync(config(args[1]), JSON.stringify(value));
} else if (args[0] === 'run') {
  fs.writeFileSync(path.join(vmPath(args[2]), 'run.pid'), String(process.pid));
  process.on('SIGINT', () => { if (!fs.existsSync(path.join(home, 'keep-run-marker'))) { try { fs.unlinkSync(path.join(vmPath(args[2]), 'run.pid')); } catch {} } process.exit(0); });
  setInterval(() => {}, 1000);
} else if (args[0] === 'ip') {
  if (fs.existsSync(path.join(home, 'hold-ip'))) {
    fs.writeFileSync(path.join(home, 'ip-started'), 'started');
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path.join(home, 'ip-release'))) Atomics.wait(waitCell, 0, 0, 10);
  }
  process.stdout.write('192.0.2.10\\n');
} else if (args[0] === 'stop') {
  const pidPath = path.join(vmPath(args[args.length - 1]), 'run.pid');
  if (fs.existsSync(pidPath) && !fs.existsSync(path.join(home, 'ignore-stop-marker'))) { try { process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 'SIGINT'); } catch {} }
} else if (args[0] === 'delete') {
  fs.rmSync(vmPath(args[1]), { recursive: true });
} else process.exit(64);
`;
  await writeFile(join(root, "fake-tart"), fakeCli, { mode: 0o700 });
  await chmod(join(root, "fake-tart"), 0o700);
  return root;
}

async function writeConfig(
  path: string,
  os: "linux" | "darwin",
  macAddress: string,
): Promise<void> {
  await writeFile(
    join(path, "config.json"),
    JSON.stringify({
      version: 1,
      os,
      arch: "arm64",
      macAddress,
      cpuCount: 2,
      memorySize: 2 * 1024 * 1024 * 1024,
    }),
  );
}

async function readEvents(
  root: string,
): Promise<Array<{ args: string[]; env: Record<string, string> }>> {
  try {
    return (await readFile(join(root, "tart-home", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error("fixture_file_timeout");
}
