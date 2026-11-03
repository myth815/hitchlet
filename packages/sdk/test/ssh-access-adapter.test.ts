import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSshAdapter } from "../examples/ssh-access-adapter.mjs";

const now = Date.parse("2026-11-02T10:00:00Z");
const rawKey = Buffer.from("synthetic public key blob; not an SSH key");
const material = "SYNTHETIC_PRIVATE_KEY_MATERIAL_NOT_A_REAL_KEY";
type Options = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  readyTimeout: number;
  hostVerifier: (key: Buffer | string) => boolean;
  hostHash?: string;
};
class Channel extends EventEmitter {
  stderr = new EventEmitter();
  destroy = vi.fn(() => this);
}
class Client extends EventEmitter {
  static instances: Client[] = [];
  config!: Options;
  callback!: (error: Error | null, stream?: Channel) => void;
  connect = vi.fn((options: Options) => {
    this.config = options;
    return this;
  });
  exec = vi.fn((_command: string, callback: Client["callback"]) => {
    this.callback = callback;
    return this;
  });
  end = vi.fn(() => this);
  destroy = vi.fn(() => this);
  constructor() {
    super();
    Client.instances.push(this);
  }
}
function context(confirmedDelta = 1000, grantDelta = 1000) {
  const fingerprint = `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}`;
  return {
    grant: {
      access: {
        protocol: "ssh",
        host: "synthetic.invalid",
        port: 2222,
        username: "workspace",
        hostKeyFingerprint: fingerprint,
        expiresAt: new Date(now + grantDelta).toISOString(),
      },
      authentication: { kind: "ephemeral_private_key", privateKey: material },
    },
    confirmedExpiresAt: new Date(now + confirmedDelta).toISOString(),
    verifyServerHostKey: vi.fn(
      (key: Buffer) =>
        `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` ===
        fingerprint,
    ),
  };
}
function start(input = context(), options = {}) {
  const adapter = createSshAdapter({
    Client,
    readyTimeoutMs: 100,
    commandTimeoutMs: 100,
    ...options,
  });
  const promise = adapter(input);
  return { promise, client: Client.instances.at(-1)! };
}
function ready(client: Client, channel = new Channel()) {
  expect(client.config.hostVerifier(rawKey)).toBe(true);
  client.emit("ready");
  client.callback(null, channel);
  return channel;
}
function expectClean(client: Client, channel?: Channel) {
  expect(client.end).toHaveBeenCalledTimes(1);
  expect(client.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  for (const event of ["ready", "close", "end"])
    expect(client.listenerCount(event)).toBe(0);
  expect(client.listenerCount("error")).toBe(1);
  expect(() => client.emit("error", new Error(material))).not.toThrow();
  if (channel) {
    expect(channel.destroy).toHaveBeenCalled();
    for (const event of ["data", "close", "end"])
      expect(channel.listenerCount(event)).toBe(0);
    expect(channel.stderr.listenerCount("data")).toBe(0);
    expect(() => channel.emit("error", new Error(material))).not.toThrow();
    expect(() =>
      channel.stderr.emit("error", new Error(material)),
    ).not.toThrow();
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  Client.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("consumer-supplied SSH reference adapter (controlled Client only)", () => {
  it("verifies the official grant and raw host key, then returns identity without requiring tenant Node", async () => {
    const input = context();
    const { promise, client } = start(input);
    expect(client.config).toMatchObject({
      host: input.grant.access.host,
      port: 2222,
      username: "workspace",
      privateKey: material,
      readyTimeout: 100,
    });
    expect(client.config).not.toHaveProperty("hostHash");
    expect(client.exec).not.toHaveBeenCalled();
    const channel = ready(client);
    expect(input.verifyServerHostKey).toHaveBeenCalledWith(rawKey);
    expect(client.exec).toHaveBeenCalledWith(
      "id -un && id -u && id -g",
      expect.any(Function),
    );
    channel.emit("data", Buffer.from("workspace\n1000\n1000\n"));
    channel.emit("end");
    channel.emit("close", 0);
    const result = await promise;
    expect(result).toEqual({
      probe: "complete",
      uid: 1000,
      gid: 1000,
    });
    expect(JSON.stringify(result)).not.toContain(material);
    expectClean(client, channel);
    expect(client.config.hostVerifier(rawKey)).toBe(false);
  });

  it.each([
    "workspace\n1000\n",
    "workspace\nnot-a-uid\n1000\n",
    "workspace\n1000\n9007199254740992\n",
    "workspace\n1000\n1000\nunexpected\n",
  ])(
    "rejects an incomplete or malformed identity response (%s)",
    async (stdout) => {
      const { promise, client } = start();
      const rejected = expect(promise).rejects.toThrow(/invalid result/);
      const channel = ready(client);
      channel.emit("data", Buffer.from(stdout));
      channel.emit("close", 0);
      await rejected;
      expectClean(client, channel);
    },
  );

  it.each(["ephemeral_password", "ssh_certificate", "client_public_key"])(
    "refuses unsupported %s authentication before constructing a client",
    async (kind) => {
      const input = context();
      input.grant.authentication.kind = kind;
      await expect(createSshAdapter({ Client })(input)).rejects.toThrow(
        /ephemeral private-key/,
      );
      expect(Client.instances).toHaveLength(0);
    },
  );
  it.each([
    [0, 1000],
    [1000, 0],
    [NaN, 1000],
  ])(
    "refuses expired/unknown confirmed or grant deadlines before connecting (%s/%s)",
    async (confirmed, grant) => {
      const input = context();
      input.confirmedExpiresAt = Number.isFinite(confirmed)
        ? new Date(now + confirmed).toISOString()
        : "unknown";
      input.grant.access.expiresAt = new Date(now + grant).toISOString();
      await expect(createSshAdapter({ Client })(input)).rejects.toThrow(
        /expired/,
      );
      expect(Client.instances).toHaveLength(0);
    },
  );
  it("checks the deadline again after client construction and never connects after it", async () => {
    class SlowConstructor extends Client {
      constructor() {
        super();
        vi.setSystemTime(now + 2);
      }
    }
    const promise = createSshAdapter({ Client: SlowConstructor })(context(1));
    await expect(promise).rejects.toThrow(/expired/);
    const client = Client.instances[0]!;
    expect(client.connect).not.toHaveBeenCalled();
    expectClean(client);
  });

  it.each(["false", "throw", "string-key"])(
    "rejects a nonverified host key (%s), without exposing callback errors",
    async (mode) => {
      const input = context();
      if (mode === "throw")
        input.verifyServerHostKey.mockImplementation(() => {
          throw new Error(material);
        });
      const { promise, client } = start(input);
      const rejected = expect(promise).rejects.not.toThrow(material);
      expect(
        client.config.hostVerifier(
          mode === "string-key"
            ? rawKey.toString("hex")
            : Buffer.from("different synthetic key"),
        ),
      ).toBe(false);
      client.emit("error", new Error(material));
      await rejected;
      expect(client.exec).not.toHaveBeenCalled();
      expectClean(client);
    },
  );
  it("refuses ready without a successful host verifier", async () => {
    const { promise, client } = start();
    const rejected = expect(promise).rejects.toThrow(/not verified/);
    client.emit("ready");
    await rejected;
    expect(client.exec).not.toHaveBeenCalled();
    expectClean(client);
  });

  it.each(["error", "end", "close"])(
    "settles a connection %s once and absorbs late close-time errors",
    async (event) => {
      const { promise, client } = start();
      const rejected = expect(promise).rejects.not.toThrow(material);
      client.end.mockImplementation(() => {
        client.emit("error", new Error(material));
        throw new Error(material);
      });
      client.emit(event, new Error(material));
      await rejected;
      client.emit("close");
      client.emit("ready");
      expect(client.exec).not.toHaveBeenCalled();
      expectClean(client);
    },
  );
  it.each(["channel", "stderr"])(
    "settles a %s error, removes business listeners and redacts raw details",
    async (source) => {
      const { promise, client } = start();
      const rejected = expect(promise).rejects.not.toThrow(material);
      const channel = ready(client);
      (source === "channel" ? channel : channel.stderr).emit(
        "error",
        new Error(material),
      );
      await rejected;
      channel.emit("close", 0);
      expectClean(client, channel);
    },
  );

  it("bounds handshake timeout and rejects a late host verifier/ready", async () => {
    const { promise, client } = start();
    const rejected = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(client.config.hostVerifier(rawKey)).toBe(false);
    client.emit("ready");
    expect(client.exec).not.toHaveBeenCalled();
    expectClean(client);
  });
  it("bounds the command and destroys a channel delivered after timeout", async () => {
    const { promise, client } = start();
    const rejected = expect(promise).rejects.toThrow(/timed out/);
    expect(client.config.hostVerifier(rawKey)).toBe(true);
    client.emit("ready");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    const late = new Channel();
    client.callback(null, late);
    expect(late.destroy).toHaveBeenCalledTimes(1);
    expect(() => late.emit("error", new Error(material))).not.toThrow();
    expectClean(client);
  });
  it.each([
    [50, 1000],
    [1000, 50],
  ])(
    "closes at the earlier confirmed/grant deadline (%s/%s)",
    async (confirmed, grant) => {
      const { promise, client } = start(context(confirmed, grant), {
        commandTimeoutMs: 1000,
      });
      const rejected = expect(promise).rejects.toThrow();
      const channel = ready(client);
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expectClean(client, channel);
    },
  );
  it("does not report success past the lease even when an event-loop delay leaves the timer unrun", async () => {
    const { promise, client } = start(context(50));
    const rejected = expect(promise).rejects.toThrow(/expired/);
    const channel = ready(client);
    channel.emit("data", Buffer.from("workspace\n1000\n1000\n"));
    vi.setSystemTime(now + 51); // Change the fake wall clock without executing timers.
    channel.emit("close", 0);
    await rejected;
    expectClean(client, channel);
  });
  it.each(["early-close", "bad-exit", "oversized-output"])(
    "rejects incomplete or invalid probe completion (%s) without returning stderr",
    async (failure) => {
      const { promise, client } = start();
      const rejected = expect(promise).rejects.not.toThrow(material);
      const channel = ready(client);
      channel.stderr.emit("data", Buffer.from(material));
      if (failure === "oversized-output")
        channel.emit("data", Buffer.alloc(4097));
      else if (failure === "bad-exit") channel.emit("close", 12);
      else channel.emit("close", null);
      await rejected;
      expectClean(client, channel);
    },
  );
});
