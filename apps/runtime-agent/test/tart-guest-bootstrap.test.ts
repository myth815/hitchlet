import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const roots: string[] = [];
const clientPublicKey = makeSshKey("client");
const hostPublicKey = makeSshKey("host");

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("creates the fixed guest SSH service once and reuses the same persisted receipt for the nonce", async () => {
  const root = await makeRoot();
  const calls: Array<{ command: string; args: string[] }> = [];
  let loaded = false;
  const helper = await loadHelper();
  const deps = dependencies(
    root,
    calls,
    () => loaded,
    (next) => {
      loaded = next;
    },
  );
  const request = bootstrapRequest();

  const first = helper.runGuestBootstrap(request, deps);
  const privateKey = readFileSync(find(root, "ssh_host_ed25519_key"), "utf8");
  const second = helper.runGuestBootstrap(request, deps);
  expect(second).toEqual(first);
  expect(
    calls.filter((call) => call.command === "/usr/bin/ssh-keygen"),
  ).toHaveLength(1);
  expect(first).toMatchObject({
    status: "applied",
    nonce: request.nonce,
    account: "admin",
    hostPublicKey,
    hostKeyFingerprint: fingerprint(hostPublicKey),
  });
  const authorizedKeys = join(
    root,
    "PublicAuthorizedKeys",
    ownerHash(),
    "authorized_keys",
  );
  expect(readFileSync(authorizedKeys, "utf8")).toBe(
    `${clientPublicKey.split(" ").slice(0, 2).join(" ")}\n`,
  );
  expect(lstatSync(authorizedKeys).mode & 0o777).toBe(0o644);
  expect(lstatSync(dirname(authorizedKeys)).mode & 0o777).toBe(0o755);
  expect(lstatSync(dirname(dirname(authorizedKeys))).mode & 0o777).toBe(0o755);
  expect(readFileSync(find(root, "sshd_config"), "utf8")).toMatch(
    /PasswordAuthentication no/,
  );
  const sshdConfig = readFileSync(find(root, "sshd_config"), "utf8");
  expect(sshdConfig).toContain("Subsystem sftp internal-sftp");
  expect(sshdConfig).not.toContain("ForceCommand");
  expect(sshdConfig).toContain(`AuthorizedKeysFile ${authorizedKeys}`);
  expect(lstatSync(find(root, "ssh_host_ed25519_key")).mode & 0o777).toBe(
    0o600,
  );
  expect(
    lstatSync(dirname(find(root, "ssh_host_ed25519_key"))).mode & 0o777,
  ).toBe(0o700);
  expect(privateKey).not.toBe(JSON.stringify(first));
  expect(first).not.toHaveProperty("hostPrivateKey");
});

it("fails closed on unprepared, non-root, conflicting nonce, or occupied SSH port without replacing service files", async () => {
  const root = await makeRoot();
  const helper = await loadHelper();
  const request = bootstrapRequest();
  const calls: Array<{ command: string; args: string[] }> = [];
  const deps = dependencies(
    root,
    calls,
    () => false,
    () => {},
  );
  await expect(() =>
    helper.runGuestBootstrap(request, { ...deps, uid: 501 }),
  ).toThrow("guest_root_required");
  const portBusy = dependencies(
    root,
    calls,
    () => false,
    () => {},
    true,
  );
  await expect(() => helper.runGuestBootstrap(request, portBusy)).toThrow(
    "guest_ssh_port_22_in_use",
  );
  expect(calls.some((call) => call.command === "/usr/bin/ssh-keygen")).toBe(
    false,
  );
  const conflict = { ...request, nonce: "nonce-abcdefghijklmno2" };
  // An occupied port leaves only a matching preparing intent; a different nonce cannot take it over.
  await expect(() => helper.runGuestBootstrap(conflict, deps)).toThrow(
    "guest_allocation_already_bootstrapped",
  );
});

it("requires an explicit prepared-template marker before applying SSH changes", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "hitchlet-guest-bootstrap-unprepared-"),
  );
  roots.push(root);
  const helper = await loadHelper();
  const deps = dependencies(
    root,
    [],
    () => false,
    () => {},
  );
  await expect(() =>
    helper.runGuestBootstrap(bootstrapRequest(), deps),
  ).toThrow("guest_template_not_prepared");
});

it("initializes Linux SSH through one owned systemd unit and recovers its original receipt after a guest service restart", async () => {
  const root = await makeRoot("linux");
  const calls: Array<{ command: string; args: string[] }> = [];
  let loaded = false;
  const deps = dependencies(
    root,
    calls,
    () => loaded,
    (next) => {
      loaded = next;
    },
    false,
    "linux",
  );
  const helper = await loadHelper();
  const request = bootstrapRequest();
  const first = helper.runGuestBootstrap(request, deps);
  expect(helper.runGuestBootstrap(request, deps)).toEqual(first);
  loaded = false;
  expect(helper.runGuestBootstrap(request, deps)).toEqual(first);
  const unit = "hitchlet-sshd-" + ownerHash().slice(0, 24) + ".service";
  expect(readFileSync(join(root, "Systemd", unit), "utf8")).toContain(
    "ExecStart=/usr/sbin/sshd -D -e -f " + find(root, "sshd_config"),
  );
  expect(
    calls.filter((call) => call.command === "/usr/bin/ssh-keygen"),
  ).toHaveLength(1);
  expect(
    calls
      .filter(
        (call) =>
          call.command === "/usr/bin/systemctl" && call.args[0] === "enable",
      )
      .map((call) => call.args),
  ).toEqual([
    ["enable", "--now", unit],
    ["enable", "--now", unit],
  ]);
  expect(calls.some((call) => call.command === "/bin/launchctl")).toBe(false);
  expect(first).toMatchObject({
    status: "applied",
    account: "admin",
    nonce: request.nonce,
    hostKeyFingerprint: fingerprint(hostPublicKey),
  });
  expect(() =>
    helper.runGuestBootstrap(
      { ...request, nonce: "different-nonce-0123456789" },
      deps,
    ),
  ).toThrow("guest_allocation_already_bootstrapped");
});

it("keeps Linux bootstrap unknown when SSH is occupied or its port observation fails", async () => {
  const root = await makeRoot("linux");
  const calls: Array<{ command: string; args: string[] }> = [];
  const deps = dependencies(
    root,
    calls,
    () => false,
    () => {},
    true,
    "linux",
  );
  const helper = await loadHelper();
  expect(() => helper.runGuestBootstrap(bootstrapRequest(), deps)).toThrow(
    "guest_ssh_port_22_in_use",
  );
  expect(() =>
    helper.runGuestBootstrap(bootstrapRequest(), {
      ...deps,
      tryRun: (command: string, args: string[]) =>
        command === "/usr/bin/ss"
          ? { status: 1, stdout: "" }
          : deps.tryRun(command, args),
    }),
  ).toThrow("guest_ssh_port_check_unknown");
  expect(
    calls.some(
      (call) =>
        call.command === "/usr/bin/ssh-keygen" ||
        (call.command === "/usr/bin/systemctl" && call.args[0] === "enable"),
    ),
  ).toBe(false);
});

it("does not apply a macOS prepared marker to a Linux guest", async () => {
  const root = await makeRoot("macos");
  const calls: Array<{ command: string; args: string[] }> = [];
  const helper = await loadHelper();
  expect(() =>
    helper.runGuestBootstrap(
      bootstrapRequest(),
      dependencies(
        root,
        calls,
        () => false,
        () => {},
        false,
        "linux",
      ),
    ),
  ).toThrow("guest_template_not_prepared");
  expect(calls).toEqual([]);
});

async function loadHelper(): Promise<{
  runGuestBootstrap: (request: unknown, deps: unknown) => any;
}> {
  const source = await readFile(
    new URL("../src/drivers/tart-guest-bootstrap.cjs", import.meta.url),
    "utf8",
  );
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(source, {
    module,
    exports: module.exports,
    require,
    Buffer,
    process: {
      platform: "darwin",
      arch: "arm64",
      versions: { node: "v24.1.0" },
      getuid: () => 0,
    },
  });
  return module.exports as {
    runGuestBootstrap: (request: unknown, deps: unknown) => any;
  };
}

async function makeRoot(guestOS = "macos"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-guest-bootstrap-"));
  roots.push(root);
  await chmod(root, 0o700);
  await writeFile(
    join(root, "guest-bootstrap-prepared.json"),
    JSON.stringify({
      version: 1,
      guestOS,
      guestArch: "arm64",
      nodeMajor: 24,
      defaultSshDisabled: true,
      sshPort: 22,
    }),
    { mode: 0o600 },
  );
  return root;
}

function dependencies(
  root: string,
  calls: Array<{ command: string; args: string[] }>,
  isLoaded: () => boolean,
  setLoaded: (loaded: boolean) => void,
  portBusy = false,
  platform = "darwin",
) {
  const launchdDirectory = join(root, "Library", "LaunchDaemons");
  mkdirSync(launchdDirectory, { recursive: true, mode: 0o700 });
  const publicKeysRoot = join(root, "PublicAuthorizedKeys");
  const systemdDirectory = join(root, "Systemd");
  mkdirSync(systemdDirectory, { recursive: true, mode: 0o700 });
  const fact = (file: string) => {
    try {
      const value = lstatSync(file);
      return {
        uid: 0,
        mode: value.mode,
        isDirectory: value.isDirectory(),
        isFile: value.isFile(),
        isSymbolicLink: value.isSymbolicLink(),
      };
    } catch {
      return undefined;
    }
  };
  const writeAtomic = (file: string, content: string, mode: number) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.testtmp`;
    const fd = openSync(temp, "wx", mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  };
  const result = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "/usr/bin/id") return { status: 0, stdout: "501\n" };
    if (command === "/usr/sbin/lsof")
      return { status: portBusy ? 0 : 1, stdout: "" };
    if (command === "/usr/bin/ss")
      return { status: 0, stdout: portBusy ? "LISTEN 0 128 0.0.0.0:22\n" : "" };
    if (command === "/usr/bin/systemctl" && args[0] === "is-active")
      return { status: isLoaded() ? 0 : 3, stdout: "" };
    if (command === "/bin/launchctl" && args[0] === "print")
      return { status: isLoaded() ? 0 : 1, stdout: "" };
    return { status: 0, stdout: "" };
  };
  return {
    root,
    publicKeysRoot,
    launchdDirectory,
    platform,
    systemdDirectory,
    sshRuntimeDirectory: join(root, "sshd-run"),
    arch: "arm64",
    nodeVersion: "v24.1.0",
    uid: 0,
    now: () => new Date("2029-01-01T00:00:00.000Z"),
    exists: existsSync,
    lstat: fact,
    readText: (file: string) => readFileSync(file, "utf8"),
    mkdir: (dir: string, mode: number) =>
      mkdirSync(dir, { recursive: true, mode }),
    chmod: (file: string, mode: number) => chmodSync(file, mode),
    writeAtomic,
    tryRun: result,
    run: (command: string, args: string[]) => {
      const answer = result(command, args);
      if (command === "/usr/bin/ssh-keygen") {
        const keyPath = args[args.indexOf("-f") + 1]!;
        writeFileSync(keyPath, "SYNTHETIC_PRIVATE_KEY", { mode: 0o600 });
        writeFileSync(`${keyPath}.pub`, `${hostPublicKey} guest-test\n`, {
          mode: 0o644,
        });
      }
      if (
        (command === "/bin/launchctl" && args[0] === "bootstrap") ||
        (command === "/usr/bin/systemctl" && args[0] === "enable")
      )
        setLoaded(true);
      if (answer.status !== 0) throw new Error("mock_command_failed");
      return answer;
    },
  };
}

function bootstrapRequest() {
  return {
    identity: {
      installationId: "install",
      runtimeIdentityId: "runtime",
      connectionRevisionId: "rev",
      allocationId: "alloc",
      generation: 1,
      operationId: "op",
      controlVersion: 1,
      purpose: "tenant",
    },
    nonce: "nonce-abcdefghijklmno1",
    account: "admin",
    clientPublicKey,
    clientPublicKeyFingerprint: fingerprint(clientPublicKey),
    networkEvidence: {
      reference: "network-evidence",
      revisionId: "network-rev",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
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
function find(root: string, name: string): string {
  return join(root, "allocations", ownerHash(), name);
}
function ownerHash(): string {
  return createHash("sha256")
    .update(JSON.stringify(["install", "runtime", "rev", "alloc", 1, "tenant"]))
    .digest("hex");
}
