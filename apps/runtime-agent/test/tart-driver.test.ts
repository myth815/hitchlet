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
import { spawn, type ChildProcess } from "node:child_process";
import { TartLocalDriver } from "../src/drivers/tart.js";
import {
  canonicalTartNetworkPlan,
  type TartNetworkPlan,
} from "@hitchlet/contracts/internal";
import type { TartNetworkAdapter } from "../src/drivers/tart-network.js";
import { withCommandDeadline } from "../src/command-exec.js";
import type {
  TartAllocationIdentity,
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
    expect(b).toMatchObject({
      presence: "present",
      identity,
      network: {
        backend: "softnet",
        status: "policy_match",
        revisionId: request.network.revisionId,
        contractHash: request.network.contractHash,
      },
    });
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
    let recovered = makeDriver(root);
    expect(await recovered.inspect(identity)).toMatchObject({
      presence: "present",
      bootstrapStatus: "not_requested",
      network: { status: "unknown", reason: "network_process_untracked" },
    });
    expect(
      (await readEvents(root)).filter((e) => e.args[0] === "clone"),
    ).toHaveLength(1);
    const cleanup = {
      ...identity,
      operationId: "cleanup-1",
      controlVersion: 2,
    };
    expect(
      await recovered.revokeNetwork(cleanup, (await makeRequest(root)).network),
    ).toMatchObject({ presence: "unknown" });
    expect(
      await driver.revokeNetwork(cleanup, (await makeRequest(root)).network),
    ).toMatchObject({
      presence: "present",
      networkCleanupReceipt: { status: "removed", processExitObserved: true },
    });
    await driver.close();
    await recovered.close();
    recovered = makeDriver(root);
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
    const portBusyMarker = join(root, "tart-home", "guest-port-busy-marker");
    await writeFile(portBusyMarker, "1");
    expect(
      await driver.bootstrapApply(identity, request.bootstrap!),
    ).toMatchObject({
      presence: "present",
      bootstrapStatus: "unknown",
      bootstrapReceipt: {
        status: "unknown",
        reason: "guest_ssh_port_22_in_use",
      },
    });
    await rm(portBusyMarker, { force: true });
    const applied = await driver.bootstrapApply(identity, request.bootstrap!);
    expect(applied).toMatchObject({
      presence: "present",
      bootstrapStatus: "applied",
    });
    if (applied.presence !== "present" || !applied.bootstrapReceipt)
      throw new Error("fake_guest_receipt_missing");
    const receipt = applied.bootstrapReceipt;
    expect(receipt).toMatchObject({
      status: "applied",
      nonce: request.bootstrap!.nonce,
    });
    const execEvent = (await readEvents(root)).find(
      (event) => event.args[0] === "exec",
    );
    expect(execEvent?.args.slice(1, 7)).toEqual([
      "-i",
      expectedName(identity),
      "/usr/bin/sudo",
      "-n",
      "/opt/homebrew/bin/node",
      "-e",
    ]);
    expect(execEvent?.args[7]).toContain("runGuestBootstrap");
    expect(
      JSON.parse(
        await readFile(join(root, "tart-home", "bootstrap-input.json")),
      ),
    ).toMatchObject({ nonce: request.bootstrap!.nonce, identity });
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
    expect(await driver.revokeNetwork(cleanup, request.network)).toMatchObject({
      presence: "present",
      networkCleanupReceipt: { status: "removed" },
    });
    expect(await driver.destroy(cleanup)).toMatchObject({ presence: "absent" });
    await driver.close();
    expect(await resumed.destroy(cleanup)).toMatchObject({
      presence: "absent",
    });
    expect(
      await resumed.bootstrapApply(identity, request.bootstrap!),
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
  "seals an explicit local bundle once and stops reporting its digest after file metadata changes",
  async () => {
    const root = await setupFixture();
    const template = join(root, "tart-home", "vms", "linux-arm64-template");
    await writeFile(
      join(template, "disk.img"),
      Buffer.from("synthetic disk bytes"),
    );
    await writeFile(
      join(template, "nvram.bin"),
      Buffer.from("synthetic nvram"),
    );
    const request = await makeRequest(root);
    const driver = makeDriver(root);
    const namespaceId = "3b241101-e2bb-4255-8caf-4136c566a962";
    expect((await driver.facts(namespaceId)).templates).toEqual([]);
    const sealed = await driver.sealTemplate(request.template.name);
    expect(sealed).toMatchObject({
      templateRef: request.template,
      artifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      proofKind: "sealed_local_bundle_v1",
    });
    expect((await driver.facts(namespaceId)).templates).toEqual([sealed]);
    await writeFile(
      join(template, "disk.img"),
      Buffer.from("modified synthetic disk bytes"),
    );
    expect((await driver.facts(namespaceId)).templates).toEqual([]);
    const resealed = await driver.sealTemplate(request.template.name);
    expect(resealed.artifactDigest).not.toBe(sealed.artifactDigest);
    expect((await driver.facts(namespaceId)).templates).toEqual([resealed]);
    await driver.close();
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
    const cleanup = { ...identity, operationId: "cleanup", controlVersion: 2 };
    expect(
      await driver.revokeNetwork(cleanup, (await makeRequest(root)).network),
    ).toMatchObject({
      presence: "unknown",
      reason: "vm_stop_not_verified",
    });
    expect(await driver.destroy(cleanup)).toMatchObject({
      presence: "unknown",
      reason: "network_cleanup_not_verified",
    });
    expect(
      (await readEvents(root)).some((event) => event.args[0] === "delete"),
    ).toBe(false);
    await driver.close();

    const verifiedRoot = await setupFixture();
    const verifiedDriver = makeDriver(verifiedRoot);
    await verifiedDriver.reconcile(await makeRequest(verifiedRoot));
    const verifiedCleanup = {
      ...identity,
      operationId: "cleanup-verified",
      controlVersion: 2,
    };
    expect(
      await verifiedDriver.revokeNetwork(
        verifiedCleanup,
        (await makeRequest(verifiedRoot)).network,
      ),
    ).toMatchObject({
      presence: "present",
      networkCleanupReceipt: { status: "removed", processExitObserved: true },
    });
    const verifiedHome = join(verifiedRoot, "tart-home");
    await writeFile(join(verifiedHome, "hide-owned-vm-marker"), "hide");
    const next = makeDriver(verifiedRoot);
    expect(await next.destroy(verifiedCleanup)).toMatchObject({
      presence: "unknown",
      reason: "inventory_incomplete",
    });
    expect(
      (await readEvents(verifiedRoot)).some(
        (event) => event.args[0] === "delete",
      ),
    ).toBe(false);
    await verifiedDriver.close();
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

it("caps a short Tart CLI command at the ambient action deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-tart-deadline-"));
  roots.push(root);
  const driver = Object.create(TartLocalDriver.prototype) as Record<
    string,
    unknown
  >;
  driver.executable = process.execPath;
  driver.home = root;
  driver.env = process.env;
  const runShort = (
    driver as unknown as {
      runShort(args: readonly string[]): Promise<unknown>;
    }
  ).runShort.bind(driver);
  const startedAt = Date.now();
  await expect(
    withCommandDeadline(Date.now() + 250, () =>
      runShort(["-e", "setTimeout(() => process.stdout.write('late'), 1500)"]),
    ),
  ).rejects.toThrow("tart_cli_command_failed");
  expect(Date.now() - startedAt).toBeLessThan(1_200);
});

function makeDriver(
  root: string,
  tartHome = join(root, "tart-home"),
): TartLocalDriver {
  return new TartLocalDriver({
    tartHome,
    manifestDirectory: join(root, "manifests"),
    executable: join(root, "fake-tart"),
    networkAdapter: syntheticNetworkAdapter,
  });
}

const syntheticNetworkAdapter: TartNetworkAdapter = {
  async launch({ executable, home, env, vmName, policy }) {
    const child: ChildProcess = spawn(
      executable,
      ["run", "--no-graphics", vmName],
      { cwd: home, env, shell: false, stdio: "ignore" },
    );
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null }));
    });
    let current = {
      allow: [...policy.allow],
      block: [...policy.block],
      ruleCount: policy.allow.length + policy.block.length,
    };
    return {
      child,
      exit,
      startedAt: new Date().toISOString(),
      async getPolicy() {
        return current;
      },
      async setPolicy(allow, block) {
        current = {
          allow: [...allow],
          block: [...block],
          ruleCount: allow.length + block.length,
        };
        return current;
      },
    };
  },
};

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
    network: networkPlan(),
    ...(includeBootstrap ? { bootstrap } : {}),
  };
}

function networkPlan(): TartNetworkPlan {
  const raw = {
    grantId: "grant-1",
    revisionId: "network-revision-1",
    frozenPlatformDenyRevisionId: "frozen-deny-1",
    platformDenyRevisionId: "effective-deny-1",
    mode: "isolated_vm" as const,
    enforcement: "tart_agent" as const,
    ipv6: "disabled" as const,
    allowedEgress: [],
    allowedIngressSourceCidrs: ["0.0.0.0/0"],
    accessSourceCidrs: ["0.0.0.0/0"],
    accessPorts: [22],
    managementDenyRules: [],
  };
  return {
    ...raw,
    contractHash:
      "sha256:" +
      createHash("sha256").update(canonicalTartNetworkPlan(raw)).digest("hex"),
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
else if(args[0]==='--version')process.stdout.write('tart 2.fixture\\n');
else if(args[0]==='exec'){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(fs.existsSync(path.join(home,'guest-port-busy-marker'))){process.stderr.write('guest_ssh_port_22_in_use\\n');process.exitCode=1;return}const request=JSON.parse(input);fs.writeFileSync(path.join(home,'bootstrap-input.json'),JSON.stringify({nonce:request.nonce,identity:request.identity}));const algorithm=Buffer.from('ssh-ed25519');const key=require('node:crypto').createHash('sha256').update('synthetic-host-key').digest();const u=(n)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b};const blob=Buffer.concat([u(algorithm.length),algorithm,u(key.length),key]);const publicKey='ssh-ed25519 '+blob.toString('base64');const fingerprint='SHA256:'+require('node:crypto').createHash('sha256').update(blob).digest('base64').replace(/=+$/,'');process.stdout.write(JSON.stringify({status:'applied',identity:request.identity,nonce:request.nonce,account:request.account,clientPublicKeyFingerprint:request.clientPublicKeyFingerprint,hostPublicKey:publicKey,hostKeyFingerprint:fingerprint,networkEvidenceReference:request.networkEvidence.reference,networkEvidenceExpiresAt:request.networkEvidence.expiresAt,observedAt:new Date().toISOString()}));});}
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
