import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  clients: [] as any[],
  servers: [] as any[],
  nextPort: 41000,
}));
vi.mock("ssh2", () => ({
  default: {
    Client: class extends EventEmitter {
      connect = vi.fn();
      forwardOut = vi.fn();
      destroy = vi.fn();
      constructor() {
        super();
        f.clients.push(this);
      }
    },
  },
}));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  createServer: (accept: any) => {
    const server = Object.assign(new EventEmitter(), {
      accept,
      port: ++f.nextPort,
      listen: vi.fn((_port, _host, cb) => cb()),
      close: vi.fn((cb) => cb()),
      address() {
        return { port: this.port };
      },
    });
    f.servers.push(server);
    return server;
  },
}));
import { HyperVSshRelay } from "../src/providers/hyperv-ssh-relay.js";
const fingerprint =
  "SHA256:" +
  createHash("sha256").update("host-key").digest("base64").replace(/=+$/, "");
const input = () => ({
  identity: {
    installationId: "i",
    runtimeIdentityId: "r",
    allocationId: "a",
    generation: 1,
    operationId: "create",
    controlVersion: 1,
    connectionRevisionId: "c",
    purpose: "tenant" as const,
  },
  vmId: "vm-guid",
  guestHost: "172.19.128.2",
  deadlineMs: Date.now() + 10_000,
  profile: {
    host: "192.0.2.10",
    username: "maint",
    hostKeyFingerprint: fingerprint,
    passwordSecretRef: "secret:fixture",
  },
});
const secrets = { get: vi.fn(async () => "not-a-real-password") };
async function open(manager: HyperVSshRelay, request = input()) {
  const p = manager.ensure(request);
  await Promise.resolve();
  await Promise.resolve();
  f.clients.at(-1).emit("ready");
  return p;
}
afterEach(() => {
  f.clients.length = 0;
  f.servers.length = 0;
  secrets.get.mockClear();
  vi.useRealTimers();
});
it("pins the existing maintenance host and exposes only a loopback raw SSH endpoint", async () => {
  const manager = new HyperVSshRelay(secrets);
  const endpoint = await open(manager);
  expect(endpoint).toEqual({ host: "127.0.0.1", port: f.servers[0].port });
  const cfg = f.clients[0].connect.mock.calls[0][0];
  expect(cfg).toMatchObject({
    host: "192.0.2.10",
    port: 22,
    username: "maint",
    password: "not-a-real-password",
  });
  expect(cfg.hostVerifier(Buffer.from("host-key"))).toBe(true);
  expect(cfg.hostVerifier(Buffer.from("other"))).toBe(false);
  expect(f.servers[0].listen).toHaveBeenCalledWith(
    0,
    "127.0.0.1",
    expect.any(Function),
  );
  const socket = new PassThrough();
  const stream = new PassThrough();
  f.clients[0].forwardOut.mockImplementation(
    (_a: any, _b: any, _c: any, _d: any, cb: any) => cb(null, stream),
  );
  f.servers[0].accept(socket);
  expect(f.clients[0].forwardOut).toHaveBeenCalledWith(
    "127.0.0.1",
    0,
    "172.19.128.2",
    22,
    expect.any(Function),
  );
  await manager.closeAll();
  expect(socket.destroyed).toBe(true);
  expect(stream.destroyed).toBe(true);
  expect(f.clients[0].destroy).toHaveBeenCalledOnce();
});
it("reuses one listener and reconnects only for changed VM/IP or credential binding", async () => {
  const manager = new HyperVSshRelay(secrets),
    request = input();
  const first = await open(manager, request);
  expect(await manager.ensure(request)).toEqual(first);
  expect(f.clients).toHaveLength(1);
  const changed = { ...request, guestHost: "172.19.128.3" };
  const second = await open(manager, changed);
  expect(second.port).not.toBe(first.port);
  expect(f.clients[0].destroy).toHaveBeenCalledOnce();
  const rotated = {
    ...changed,
    profile: { ...changed.profile, passwordSecretRef: "secret:rotated" },
  };
  await open(manager, rotated);
  expect(secrets.get).toHaveBeenLastCalledWith("secret:rotated");
  await manager.closeAll();
});
it("recovers transport loss without creating a VM or minting guest keys", async () => {
  const manager = new HyperVSshRelay(secrets),
    request = input();
  const first = await open(manager, request);
  f.clients[0].emit("close");
  const second = await open(manager, request);
  expect(second.port).not.toBe(first.port);
  expect(f.clients).toHaveLength(2);
  await manager.closeAll();
});
it("serializes simultaneous observation and closes exact owner despite cleanup control-version changes", async () => {
  const manager = new HyperVSshRelay(secrets),
    request = input();
  const a = manager.ensure(request),
    b = manager.ensure(request);
  await Promise.resolve();
  await Promise.resolve();
  f.clients[0].emit("ready");
  expect(await a).toEqual(await b);
  expect(f.clients).toHaveLength(1);
  await manager.close({ ...request.identity, allocationId: "foreign" });
  expect(f.clients[0].destroy).not.toHaveBeenCalled();
  await manager.close({
    ...request.identity,
    controlVersion: 2,
    operationId: "cleanup",
  });
  expect(f.clients[0].destroy).toHaveBeenCalledOnce();
  await manager.closeAll();
});
it("bounds failed opens, redacts errors, and shuts down pending sessions", async () => {
  vi.useFakeTimers();
  const manager = new HyperVSshRelay(secrets);
  const p = manager.ensure(input());
  const rejected = expect(p).rejects.toThrow("relay connection failed");
  await vi.advanceTimersByTimeAsync(10_001);
  await rejected;
  f.clients[0].emit("error", Error("secret-password"));
  expect(f.clients[0].destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const pending = manager.ensure(input());
  await Promise.resolve();
  await Promise.resolve();
  const closed = manager.closeAll();
  f.clients.at(-1).emit("ready");
  await expect(pending).rejects.toThrow("closed");
  await closed;
  await expect(manager.ensure(input())).rejects.toThrow("unavailable");
});
it("accepts existing private-key references without persisting them", async () => {
  const manager = new HyperVSshRelay(secrets),
    { passwordSecretRef: _, ...profile } = input().profile;
  await open(manager, {
    ...input(),
    profile: { ...profile, privateKeySecretRef: "secret:key" },
  } as any);
  expect(f.clients[0].connect.mock.calls[0][0]).toMatchObject({
    privateKey: "not-a-real-password",
  });
  expect(f.clients[0].connect.mock.calls[0][0]).not.toHaveProperty("password");
  await manager.closeAll();
});

it("handles a channel opening race without throwing into the local listener", async () => {
  const manager = new HyperVSshRelay(secrets);
  await open(manager);
  f.clients[0].forwardOut.mockImplementation(() => {
    throw Error("Not connected: private transport detail");
  });
  const socket = new PassThrough();
  expect(() => f.servers[0].accept(socket)).not.toThrow();
  expect(socket.destroyed).toBe(true);
  expect(f.clients[0].destroy).toHaveBeenCalledOnce();
  await manager.closeAll();
});
