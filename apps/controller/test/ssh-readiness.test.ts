import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("ssh2", () => ({ Client: vi.fn(() => fixture.client) }));
import { probeSsh } from "../src/providers/ssh-readiness.js";

class TestClient extends EventEmitter {
  end = vi.fn();
  connect = vi.fn();
  exec = vi.fn();
}
const input = {
  host: "127.0.0.1",
  port: 2222,
  username: "workspace",
  privateKey: "test-only-not-a-key",
  expectedHostKey: Buffer.from("fixture-host-key"),
};
afterEach(() => vi.useRealTimers());

describe("SSH readiness connection lifecycle", () => {
  it("rejects the first handshake error and handles errors arriving during shutdown", async () => {
    vi.useFakeTimers();
    const client = new TestClient();
    fixture.client = client;
    const first = new Error("Connection lost before handshake");
    const promise = probeSsh(input);
    const rejected = expect(promise).rejects.toBe(first);
    client.emit("error", first);
    // ssh2 may report both the socket failure and a later protocol failure.
    expect(() =>
      client.emit("error", new Error("late protocol error")),
    ).not.toThrow();
    client.emit("close");
    await rejected;
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires authenticated command success and preserves exact host-key verification", async () => {
    vi.useFakeTimers();
    const client = new TestClient();
    fixture.client = client;
    const stream = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
    });
    client.exec.mockImplementation((_command, callback) =>
      callback(null, stream),
    );
    const promise = probeSsh(input);
    const options = client.connect.mock.calls[0]![0];
    expect(options.hostVerifier(input.expectedHostKey)).toBe(true);
    expect(options.hostVerifier(Buffer.from("different-key"))).toBe(false);
    client.emit("ready");
    stream.emit("data", Buffer.from("workspace\n1000\n1000\nv24.22.2\n"));
    stream.emit("close", 0);
    await promise;
    expect(client.exec).toHaveBeenCalledWith(
      "id -un && id -u && id -g && node --version && test -w /workspace",
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [1001, 1000],
    [1000, 1001],
    [1001, 1001],
  ])("rejects a matching account name with UID/GID %i/%i", async (uid, gid) => {
    const client = new TestClient();
    fixture.client = client;
    const stream = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
    });
    client.exec.mockImplementation((_command, callback) =>
      callback(null, stream),
    );
    const rejected = expect(probeSsh(input)).rejects.toThrow(
      "Authenticated SSH bootstrap probe failed",
    );
    client.emit("ready");
    stream.emit("data", Buffer.from(`workspace\n${uid}\n${gid}\nv24.22.2\n`));
    stream.emit("close", 0);
    await rejected;
  });

  it("rejects a connection closing before readiness without leaving a timeout", async () => {
    vi.useFakeTimers();
    const client = new TestClient();
    fixture.client = client;
    const promise = probeSsh(input);
    const rejected = expect(promise).rejects.toThrow("closed before readiness");
    client.emit("close");
    await rejected;
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
