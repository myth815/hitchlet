import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("ssh2", async (original) => {
  const actual = await original<typeof import("ssh2")>();
  const d = actual.default;
  return { ...actual, default: { ...d, Client: vi.fn(() => fixture.client) } };
});
import ssh2 from "ssh2";
import { encodeEd25519OpenSshKey } from "../src/storage/access-material-store.js";
import { probeHyperVSsh } from "../src/providers/hyperv-ssh-readiness.js";
class TestClient extends EventEmitter {
  connect = vi.fn();
  end = vi.fn();
  exec = vi.fn();
}
afterEach(() => vi.useRealTimers());
function key() {
  const privateKey = encodeEd25519OpenSshKey(
    generateKeyPairSync("ed25519").privateKey,
  );
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const blob = parsed.getPublicSSH();
  return {
    privateKey,
    publicKey: "ssh-ed25519 " + blob.toString("base64"),
    blob,
    fingerprint:
      "SHA256:" +
      createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""),
  };
}
function setup(os: "windows" | "linux" = "windows") {
  const host = key(),
    clientKey = key(),
    client = new TestClient();
  fixture.client = client;
  const stream = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    destroy: vi.fn(),
  });
  client.exec.mockImplementation((_cmd, _opts, done) => done(null, stream));
  const input = {
    host: "127.0.0.1",
    port: 22 as const,
    username: "workspace",
    privateKey: clientKey.privateKey,
    hostPublicKey: host.publicKey,
    hostKeyFingerprint: host.fingerprint,
    clientPublicKeyFingerprint: clientKey.fingerprint,
    guestOs: os,
    architecture: "amd64" as const,
    deadlineMs: Date.now() + 10_000,
  };
  return { host, client, stream, input };
}
it("loads the compiled Hyper-V readiness port with native Node ESM", () => {
  const url = pathToFileURL(
    resolve("dist/providers/hyperv-ssh-readiness.js"),
  ).href;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
});
it.each(["windows", "linux"] as const)(
  "authenticates exact keys then reads actual %s/amd64 without Node or Python",
  async (os) => {
    const f = setup(os);
    const promise = probeHyperVSsh(f.input);
    const connection = f.client.connect.mock.calls[0]![0];
    expect(connection.hostVerifier(f.host.blob)).toBe(true);
    expect(connection.hostVerifier(Buffer.from("different"))).toBe(false);
    f.client.emit("ready");
    const command = f.client.exec.mock.calls[0]![0] as string;
    expect(f.client.exec.mock.calls[0]![1]).toEqual({ pty: false });
    if (os === "windows") {
      expect(command).toMatch(
        /^powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand /,
      );
      const source = Buffer.from(command.split(" ").at(-1)!, "base64").toString(
        "utf16le",
      );
      expect(source).toContain("Win32_OperatingSystem");
      expect(source).toContain("Win32_Processor");
      expect(source).toContain("[IO.File]::Delete($path)");
      expect(source).not.toContain(f.input.username);
      expect(source).not.toContain(f.input.privateKey);
      expect(source).not.toMatch(
        /ExecutionPolicy|Set-Net|Enable-Windows|New-LocalUser/,
      );
    } else
      expect(command).toBe(
        "id -un && uname -s && uname -m && test -w /tmp && printf 'hitchlet-scratch-writable\\n'",
      );
    f.stream.emit(
      "data",
      Buffer.from(
        os === "windows"
          ? "WORKSPACE\r\nWindows\r\namd64\r\nhitchlet-scratch-writable\r\n"
          : "workspace\nLinux\nx86_64\nhitchlet-scratch-writable\n",
      ),
    );
    f.stream.emit("close", 0);
    expect(await promise).toMatchObject({
      authenticated: true,
      username: "workspace",
      guestOs: os,
      architecture: "amd64",
      scratchWritable: true,
    });
    expect(f.client.end).toHaveBeenCalledOnce();
  },
);
it.each([
  "workspace\nLinux\naarch64\nhitchlet-scratch-writable\n",
  "other\nWindows\namd64\nhitchlet-scratch-writable\n",
  "workspace\nWindows\namd64\nno-proof\n",
])("rejects mismatched/missing guest facts", async (text) => {
  const f = setup();
  const p = probeHyperVSsh(f.input);
  f.client.emit("ready");
  f.stream.emit("data", Buffer.from(text));
  f.stream.emit("close", 0);
  await expect(p).rejects.toThrow("guest facts or scratch check did not match");
});
it("rejects expired or fingerprint-mismatched input before connecting", async () => {
  const f = setup();
  await expect(
    probeHyperVSsh({ ...f.input, deadlineMs: 1 }, () => 2),
  ).rejects.toThrow("deadline has expired");
  await expect(
    probeHyperVSsh({
      ...f.input,
      clientPublicKeyFingerprint: "SHA256:" + "A".repeat(43),
    }),
  ).rejects.toThrow("frozen identity");
  expect(f.client.connect).not.toHaveBeenCalled();
});
it("bounds a stalled handshake and consumes late errors without exposing them", async () => {
  vi.useFakeTimers();
  const f = setup();
  const p = probeHyperVSsh({ ...f.input, deadlineMs: Date.now() + 50 });
  const rejected = expect(p).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(51);
  await rejected;
  f.client.emit("error", Error("secret transport contents"));
  expect(f.client.end).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds combined stdout/stderr and rejects nonzero command completion", async () => {
  const f = setup();
  const p = probeHyperVSsh(f.input);
  f.client.emit("ready");
  f.stream.stderr.emit("data", Buffer.alloc(4097));
  await expect(p).rejects.toThrow("output exceeded");
  expect(f.stream.destroy).toHaveBeenCalledOnce();
  expect(f.client.end).toHaveBeenCalledOnce();
  const next = setup("linux");
  const failed = probeHyperVSsh(next.input);
  next.client.emit("ready");
  next.stream.emit(
    "data",
    Buffer.from("workspace\nLinux\nx86_64\nhitchlet-scratch-writable\n"),
  );
  next.stream.emit("close", 1);
  await expect(failed).rejects.toThrow("guest facts");
});

it("accepts an ephemeral relay port while retaining exact guest host-key verification", async () => {
  const f = setup();
  const p = probeHyperVSsh({ ...f.input, port: 41234 });
  expect(f.client.connect.mock.calls[0]![0].port).toBe(41234);
  expect(f.client.connect.mock.calls[0]![0].hostVerifier(f.host.blob)).toBe(
    true,
  );
  f.client.emit("ready");
  f.stream.emit(
    "data",
    Buffer.from("workspace\nWindows\namd64\nhitchlet-scratch-writable\n"),
  );
  f.stream.emit("close", 0);
  expect(await p).toMatchObject({ authenticated: true });
});
