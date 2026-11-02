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
import type {
  TartAllocationIdentity,
  TartGuestBootstrapReceipt,
  TartGuestBootstrapRequest,
  TartReconcileRequest,
} from "@hitchlet/contracts/internal";

const roots: string[] = [];
const supportsTartHost =
  process.platform === "darwin" && process.arch === "arm64";
const identity: TartAllocationIdentity = {
  installationId: "install-1",
  runtimeIdentityId: "runtime-1",
  connectionRevisionId: "revision-1",
  allocationId: "allocation-1",
  generation: 1,
  operationId: "operation-1",
  controlVersion: 1,
  purpose: "tenant",
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
          if (pid > 1) process.kill(pid, "SIGKILL");
        } catch {
          /* none */
        }
      }
    } catch {
      /* fixture not initialized */
    }
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!supportsTartHost)(
  "persists clone ownership before mutable configuration and recovers the same VM",
  async () => {
    const root = await setupFixture();
    const request = await makeRequest(root);
    const driver = makeDriver(root);
    const [a, b] = await Promise.all([
      driver.reconcile(request),
      driver.reconcile(request),
    ]);
    expect(a).toMatchObject({
      presence: "present",
      state: "running",
      bootstrapStatus: "not_requested",
      ipAddress: "192.0.2.10",
    });
    expect(b).toEqual(a);
    const events = await readEvents(root);
    expect(events.filter((e) => e.args[0] === "clone")).toHaveLength(1);
    const cloneIndex = events.findIndex((e) => e.args[0] === "clone");
    const setIndex = events.findIndex((e) => e.args[0] === "set");
    expect(cloneIndex).toBeGreaterThanOrEqual(0);
    expect(setIndex).toBeGreaterThan(cloneIndex);
    expect(events[setIndex]?.args).toEqual([
      "set",
      expectedName(identity),
      "--cpu",
      "4",
      "--memory",
      "4096",
    ]);
    expect(
      events.every(
        (e) =>
          e.env.TART_HOME === join(root, "tart-home") &&
          e.env.TART_NO_AUTO_PRUNE === "1",
      ),
    ).toBe(true);
    await driver.close();

    const recovered = makeDriver(root);
    expect(await recovered.inspect(identity)).toMatchObject({
      presence: "present",
      bootstrapStatus: "not_requested",
    });
    expect(
      (await readEvents(root)).filter((e) => e.args[0] === "clone"),
    ).toHaveLength(1);
    const cleanup = {
      ...identity,
      operationId: "cleanup-1",
      controlVersion: 2,
    };
    expect(await recovered.destroy(cleanup)).toMatchObject({
      presence: "absent",
      inventoryCompleteness: "complete",
    });
    expect(await recovered.destroy(cleanup)).toMatchObject({
      presence: "absent",
    });
    await recovered.close();
  },
);

it.skipIf(!supportsTartHost)(
  "persists a matching bootstrap receipt across restart and rejects a late receipt after cleanup",
  async () => {
    const root = await setupFixture();
    const request = await makeRequest(root, true);
    const driver = makeDriver(root);
    expect(await driver.reconcile(request)).toMatchObject({
      presence: "present",
      bootstrapStatus: "pending",
    });
    const unknownReceipt: TartGuestBootstrapReceipt = {
      status: "unknown",
      identity,
      nonce: request.bootstrap!.nonce,
      reason: "guest_unreachable",
      observedAt: "2028-01-01T00:00:00.000Z",
    };
    expect(
      await driver.recordBootstrapReceipt(
        identity,
        request.bootstrap!,
        unknownReceipt,
      ),
    ).toMatchObject({ presence: "present", bootstrapStatus: "unknown" });
    const receipt = await makeReceipt(request.bootstrap!);
    expect(
      await driver.recordBootstrapReceipt(
        identity,
        request.bootstrap!,
        receipt,
      ),
    ).toMatchObject({
      presence: "present",
      bootstrapStatus: "applied",
      bootstrapReceipt: receipt,
    });
    await driver.close();

    const resumed = makeDriver(root);
    expect(await resumed.inspect(identity)).toMatchObject({
      presence: "present",
      bootstrapStatus: "applied",
      bootstrapReceipt: receipt,
    });
    const cleanup = {
      ...identity,
      operationId: "cleanup-2",
      controlVersion: 2,
    };
    expect(await resumed.destroy(cleanup)).toMatchObject({
      presence: "absent",
    });
    expect(
      await resumed.recordBootstrapReceipt(
        identity,
        request.bootstrap!,
        receipt,
      ),
    ).toMatchObject({
      presence: "unknown",
      reason: "bootstrap_receipt_fence_closed",
    });
    await resumed.close();
  },
);

it.skipIf(!supportsTartHost)(
  "writes a release tombstone before create and prevents a late same-generation clone",
  async () => {
    const root = await setupFixture();
    const request = await makeRequest(root);
    const driver = makeDriver(root);
    expect(await driver.destroy(identity)).toMatchObject({
      presence: "absent",
      inventoryCompleteness: "complete",
    });
    expect(await driver.reconcile(request)).toMatchObject({
      presence: "absent",
    });
    expect(
      (await readEvents(root)).filter((event) => event.args[0] === "clone"),
    ).toHaveLength(0);
    await driver.close();
  },
);

it.skipIf(!supportsTartHost)(
  "rechecks cloned MAC independence on retries and rejects a running template",
  async () => {
    const root = await setupFixture();
    const request = await makeRequest(root);
    await writeFile(join(root, "tart-home", "preserve-clone-mac-marker"), "1");
    const driver = makeDriver(root);
    expect(await driver.reconcile(request)).toMatchObject({
      presence: "unknown",
      reason: "clone_mac_not_regenerated",
    });
    expect(await driver.reconcile(request)).toMatchObject({
      presence: "unknown",
      reason: "clone_mac_not_regenerated",
    });
    const events = await readEvents(root);
    expect(events.filter((event) => event.args[0] === "clone")).toHaveLength(1);
    expect(events.filter((event) => event.args[0] === "run")).toHaveLength(0);
    await driver.close();

    const runningRoot = await setupFixture();
    await writeFile(
      join(runningRoot, "tart-home", "template-running-marker"),
      "1",
    );
    const runningTemplateDriver = makeDriver(runningRoot);
    expect(
      await runningTemplateDriver.reconcile(await makeRequest(runningRoot)),
    ).toMatchObject({
      presence: "unknown",
      reason: "template_not_stopped",
    });
    expect(
      (await readEvents(runningRoot)).filter(
        (event) => event.args[0] === "clone",
      ),
    ).toHaveLength(0);
    await runningTemplateDriver.close();
  },
);

it.skipIf(!supportsTartHost)(
  "does not adopt same-name foreign VMs or replay an interrupted clone intent",
  async () => {
    const root = await setupFixture();
    const request = await makeRequest(root);
    const vmName = expectedName(identity);
    await mkdir(join(root, "tart-home", "vms", vmName), { recursive: true });
    await writeConfig(
      join(root, "tart-home", "vms", vmName),
      "02:aa:bb:cc:dd:ee",
    );
    const driver = makeDriver(root);
    expect(await driver.reconcile(request)).toMatchObject({
      presence: "unknown",
      reason: "unmanifested_vm_name_collision",
    });
    expect(await driver.destroy(identity)).toMatchObject({
      presence: "unknown",
    });
    expect(
      (await readEvents(root)).some((e) =>
        ["clone", "delete", "stop"].includes(e.args[0] ?? ""),
      ),
    ).toBe(false);
    await driver.close();
  },
);

it.skipIf(!supportsTartHost)(
  "keeps presence distinct from bootstrap readiness and refuses a changed operation specification",
  async () => {
    const root = await setupFixture();
    const request = await makeRequest(root, true);
    const driver = makeDriver(root);
    expect(await driver.reconcile(request)).toMatchObject({
      presence: "present",
      bootstrapStatus: "pending",
    });
    expect(
      await driver.reconcile({
        ...request,
        resources: { ...request.resources, memoryMiB: 8192 },
      }),
    ).toMatchObject({
      presence: "unknown",
      reason: "operation_resource_mismatch",
    });
    await driver.close();
  },
);

it.skipIf(!supportsTartHost)(
  "refuses clone-intent adoption and rejects a manifest bound to another Tart home",
  async () => {
    const root = await setupFixture();
    const request = await makeRequest(root);
    const first = makeDriver(root);
    await first.reconcile(request);
    await first.close();

    const manifestName = (await readdir(join(root, "manifests")))[0]!;
    const manifestPath = join(root, "manifests", manifestName);
    const original = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const brokenClone = { ...original, phase: "clone_intent" };
    delete brokenClone.instance;
    await writeFile(manifestPath, JSON.stringify(brokenClone));
    const resumed = makeDriver(root);
    expect(await resumed.reconcile(request)).toMatchObject({
      presence: "unknown",
      reason: "interrupted_clone_identity_not_recorded",
    });
    expect(
      (await readEvents(root)).filter((event) => event.args[0] === "clone"),
    ).toHaveLength(1);
    await resumed.close();

    await writeFile(manifestPath, JSON.stringify(original));
    const alternateHome = join(root, "alternate-home");
    await mkdir(join(alternateHome, "vms"), { recursive: true, mode: 0o700 });
    const otherHome = makeDriver(root, alternateHome);
    expect(
      await otherHome.destroy({
        ...identity,
        operationId: "cleanup",
        controlVersion: 2,
      }),
    ).toMatchObject({
      presence: "unknown",
      reason: "tart_home_identity_changed",
    });
    expect(await readdir(join(root, "tart-home", "vms"))).toContain(
      expectedName(identity),
    );
    await otherHome.close();
  },
);

it.skipIf(!supportsTartHost)(
  "does not delete while Tart still reports running or when CLI and disk inventory disagree",
  async () => {
    const root = await setupFixture();
    const driver = makeDriver(root);
    await driver.reconcile(await makeRequest(root));
    const home = join(root, "tart-home");
    await writeFile(join(home, "keep-run-marker"), "keep");
    await writeFile(join(home, "ignore-stop-marker"), "ignore");
    const cleanup = { ...identity, operationId: "cleanup", controlVersion: 2 };
    expect(await driver.destroy(cleanup)).toMatchObject({
      presence: "unknown",
      reason: "vm_stop_not_verified",
    });
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "delete"),
    ).toBe(false);
    await driver.close();

    const next = makeDriver(root);
    await writeFile(join(home, "hide-owned-vm-marker"), "hide");
    expect(await next.destroy(cleanup)).toMatchObject({
      presence: "unknown",
      reason: "inventory_incomplete",
    });
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "delete"),
    ).toBe(false);
    await next.close();
  },
);

it("rejects hosts outside the macOS arm64 Tart scope", () => {
  if (supportsTartHost)
    expect(() => makeDriver("/tmp/hitchlet-tart-host-test")).not.toThrow();
  else
    expect(() => makeDriver("/tmp/hitchlet-tart-host-test")).toThrow(
      "tart_host_unsupported",
    );
});

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

async function makeRequest(
  root: string,
  includeBootstrap = false,
): Promise<TartReconcileRequest> {
  const templateText = await readFile(
    join(root, "tart-home", "vms", "linux-arm64-template", "config.json"),
    "utf8",
  );
  const clientPublicKey = makeSshKey("client");
  const bootstrap: TartGuestBootstrapRequest = {
    identity,
    nonce: "nonce-0123456789abcdef",
    account: "tenant",
    clientPublicKey,
    clientPublicKeyFingerprint: fingerprint(clientPublicKey),
    networkEvidence: {
      reference: "network-evidence-1",
      revisionId: "network-revision-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
  };
  return {
    identity,
    template: {
      source: "local",
      name: "linux-arm64-template",
      guestOS: "linux",
      guestArch: "arm64",
      configSha256: createHash("sha256").update(templateText).digest("hex"),
    },
    resources: { cpus: 4, memoryMiB: 4096 },
    ...(includeBootstrap ? { bootstrap } : {}),
  };
}

async function makeReceipt(
  request: TartGuestBootstrapRequest,
): Promise<TartGuestBootstrapReceipt> {
  const hostPublicKey = makeSshKey("host");
  return {
    status: "applied",
    identity,
    nonce: request.nonce,
    account: request.account,
    clientPublicKeyFingerprint: request.clientPublicKeyFingerprint,
    hostPublicKey,
    hostKeyFingerprint: fingerprint(hostPublicKey),
    networkEvidenceReference: request.networkEvidence.reference,
    networkEvidenceExpiresAt: request.networkEvidence.expiresAt,
    observedAt: "2029-01-01T00:00:00.000Z",
  };
}

function makeSshKey(seed: string): string {
  const algorithm = Buffer.from("ssh-ed25519");
  const key = createHash("sha256").update(seed).digest();
  const blob = Buffer.concat([
    uint32(algorithm.length),
    algorithm,
    uint32(key.length),
    key,
  ]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}
function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}
function fingerprint(key: string): string {
  return `SHA256:${createHash("sha256")
    .update(Buffer.from(key.split(" ")[1]!, "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;
}
function expectedName(value: TartAllocationIdentity): string {
  const owner = JSON.stringify([
    value.installationId,
    value.runtimeIdentityId,
    value.connectionRevisionId,
    value.allocationId,
    value.generation,
    value.purpose,
  ]);
  return `hitchlet-${createHash("sha256").update(owner).digest("hex").slice(0, 32)}`;
}

async function setupFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-tart-driver-"));
  roots.push(root);
  const home = join(root, "tart-home");
  const template = join(home, "vms", "linux-arm64-template");
  await mkdir(template, { recursive: true });
  await chmod(home, 0o700);
  await writeConfig(template, "linux", "02:00:00:00:00:11");
  const fakeCli = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),home=process.env.TART_HOME,vms=path.join(home,'vms'),args=process.argv.slice(2),events=path.join(home,'events.jsonl');
const vm=(name)=>path.join(vms,name),config=(name)=>path.join(vm(name),'config.json');fs.mkdirSync(home,{recursive:true});fs.appendFileSync(events,JSON.stringify({args,env:{TART_HOME:process.env.TART_HOME,TART_NO_AUTO_PRUNE:process.env.TART_NO_AUTO_PRUNE}})+'\\n');
if(args[0]==='list'){const rows=fs.readdirSync(vms,{withFileTypes:true}).filter(e=>e.isDirectory()&&!(fs.existsSync(path.join(home,'hide-owned-vm-marker'))&&e.name.startsWith('hitchlet-'))).map(e=>{const running=fs.existsSync(path.join(vm(e.name),'run.pid'))||(e.name==='linux-arm64-template'&&fs.existsSync(path.join(home,'template-running-marker')));return {Source:'local',Name:e.name,Running:running,State:running?'running':'stopped'}});process.stdout.write(JSON.stringify(rows));}
else if(args[0]==='clone'){fs.cpSync(vm(args[1]),vm(args[2]),{recursive:true,errorOnExist:true});const c=JSON.parse(fs.readFileSync(config(args[2]),'utf8'));if(!fs.existsSync(path.join(home,'preserve-clone-mac-marker')))c.macAddress='02:00:00:00:00:22';fs.writeFileSync(config(args[2]),JSON.stringify(c));}
else if(args[0]==='set'){const c=JSON.parse(fs.readFileSync(config(args[1]),'utf8'));c.cpuCount=Number(args[args.indexOf('--cpu')+1]);c.memorySize=Number(args[args.indexOf('--memory')+1])*1024*1024;fs.writeFileSync(config(args[1]),JSON.stringify(c));}
else if(args[0]==='run'){fs.writeFileSync(path.join(vm(args[2]),'run.pid'),String(process.pid));process.on('SIGINT',()=>{if(!fs.existsSync(path.join(home,'keep-run-marker'))){try{fs.unlinkSync(path.join(vm(args[2]),'run.pid'))}catch{}}process.exit(0)});setInterval(()=>{},1000);}
else if(args[0]==='ip')process.stdout.write('192.0.2.10\\n');else if(args[0]==='stop'){const p=path.join(vm(args[args.length-1]),'run.pid');if(fs.existsSync(p)){try{process.kill(Number(fs.readFileSync(p,'utf8')),'SIGINT')}catch{}}}else if(args[0]==='delete')fs.rmSync(vm(args[1]),{recursive:true});else process.exit(64);`;
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
