import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("ssh2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ssh2")>();
  const actualDefault = (actual as { default?: { utils?: unknown } }).default;
  const MockClient = vi.fn(() => fixture.client);
  return {
    ...actual,
    utils: actualDefault?.utils,
    Client: MockClient,
    default: { ...actual, ...actualDefault, Client: MockClient },
  };
});
import { utils as sshUtils } from "ssh2";
import { probeTartSsh } from "../src/providers/tart-ssh-readiness.js";

class TestClient extends EventEmitter {
  end = vi.fn();
  connect = vi.fn();
  exec = vi.fn();
}

afterEach(() => vi.useRealTimers());

it("loads the compiled provider through Node's native ESM loader", () => {
  const moduleUrl = pathToFileURL(
    resolve("dist/providers/tart-ssh-readiness.js"),
  ).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
});

it("submits only the fixed SSH/22 host-key-checked command and verifies guest facts", async () => {
  vi.useFakeTimers();
  const keys = keyPair();
  const client = new TestClient();
  const stream = commandStream();
  fixture.client = client;
  client.exec.mockImplementation((_command, _options, callback) =>
    callback(null, stream),
  );

  const promise = probeTartSsh(input(keys));
  const connection = client.connect.mock.calls[0]![0];
  expect(connection).toMatchObject({
    host: "127.0.0.1",
    port: 22,
    username: "guest",
  });
  expect(connection.hostVerifier(keys.hostBlob)).toBe(true);
  expect(connection.hostVerifier(Buffer.from("different-host-key"))).toBe(
    false,
  );
  client.emit("ready");
  expect(client.exec).toHaveBeenCalledWith(
    "id -un && uname -s && uname -m && test -w /tmp && printf 'hitchlet-scratch-writable\\n'",
    { pty: false },
    expect.any(Function),
  );
  stream.emit(
    "data",
    Buffer.from("guest\nLinux\naarch64\nhitchlet-scratch-writable\n"),
  );
  stream.emit("close", 0);
  await expect(promise).resolves.toMatchObject({
    authenticated: true,
    username: "guest",
    guestOS: "linux",
    architecture: "arm64",
    scratchWritable: true,
  });
  expect(client.end).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects mismatched guest facts and host-key verification", async () => {
  const keys = keyPair();
  const client = new TestClient();
  const stream = commandStream();
  fixture.client = client;
  client.exec.mockImplementation((_command, _options, callback) =>
    callback(null, stream),
  );
  const guestMismatch = probeTartSsh(input(keys));
  client.emit("ready");
  stream.emit(
    "data",
    Buffer.from("guest\nLinux\nx86_64\nhitchlet-scratch-writable\n"),
  );
  stream.emit("close", 0);
  await expect(guestMismatch).rejects.toThrow(
    "Tart SSH guest facts or scratch check did not match",
  );

  const hostMismatch = new TestClient();
  fixture.client = hostMismatch;
  const otherHost = sshUtils.generateKeyPairSync("ed25519");
  const rejected = expect(
    probeTartSsh({
      ...input(keys),
      hostPublicKey: otherHost.public,
      hostKeyFingerprint: fingerprint(otherHost.public),
    }),
  ).rejects.toThrow("Tart SSH readiness connection failed");
  const connection = hostMismatch.connect.mock.calls[0]![0];
  expect(connection.hostVerifier(keys.hostBlob)).toBe(false);
  hostMismatch.emit("error", new Error("synthetic host key mismatch"));
  await rejected;
});

it("rejects before connection when the frozen deadline has expired", async () => {
  const keys = keyPair();
  const client = new TestClient();
  fixture.client = client;
  await expect(probeTartSsh(input(keys, 1_000), () => 1_001)).rejects.toThrow(
    "Tart SSH readiness deadline has expired",
  );
  expect(client.connect).not.toHaveBeenCalled();
});

function commandStream() {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    destroy: vi.fn(),
  });
}

function input(
  keys: ReturnType<typeof keyPair>,
  deadlineMs = Date.now() + 10_000,
) {
  return {
    host: "127.0.0.1",
    port: 22,
    username: "guest",
    privateKey: keys.client.private,
    hostPublicKey: keys.host.public,
    hostKeyFingerprint: keys.hostFingerprint,
    clientPublicKeyFingerprint: keys.clientFingerprint,
    guestOS: "linux" as const,
    architecture: "arm64" as const,
    deadlineMs,
  };
}

function keyPair() {
  const host = sshUtils.generateKeyPairSync("ed25519");
  const client = sshUtils.generateKeyPairSync("ed25519");
  const publicBlob = (value: string) => {
    const parsed = sshUtils.parseKey(value);
    if (parsed instanceof Error) throw parsed;
    return Buffer.from(parsed.getPublicSSH());
  };
  return {
    host,
    client,
    hostBlob: publicBlob(host.public),
    hostFingerprint: fingerprint(host.public),
    clientFingerprint: fingerprint(client.public),
  };
}

function fingerprint(value: string): string {
  const parsed = sshUtils.parseKey(value);
  if (parsed instanceof Error) throw parsed;
  return `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}
