import { createHash } from "node:crypto";
import { createServer, isIPv4, type Socket } from "node:net";
import ssh2 from "ssh2";
import type { HyperVSshEndpointPort } from "./hyperv-provider.js";
import type { VmAllocationIdentity } from "@hitchlet/contracts/internal";

type Request = Parameters<HyperVSshEndpointPort["ensure"]>[0];
type Session = {
  binding: string;
  endpoint: { host: string; port: number };
  live: boolean;
  close(): void;
};
/** Controller-owned, loopback-only transport. It forwards raw SSH to one exact
 * guest:22, so guest authentication and host-key verification remain end to end.
 * No command, remote listener, firewall rule or credential file is created. */
export class HyperVSshRelay implements HyperVSshEndpointPort {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Promise<Session>>();
  private closed = false;
  constructor(
    private readonly secrets: { get(ref: string): Promise<string> },
    private readonly now = Date.now,
  ) {}
  async ensure(input: Request): Promise<Session["endpoint"]> {
    if (
      this.closed ||
      !isIPv4(input.guestHost) ||
      !input.vmId ||
      input.deadlineMs <= this.now()
    )
      throw Error("Hyper-V SSH relay target or deadline is unavailable");
    const key = ownerKey(input.identity);
    // Serialize concurrent readiness/observation for one allocation; never bind two listeners.
    const pending = this.pending.get(key);
    if (pending) {
      await pending;
      return this.ensure(input);
    }
    const binding = JSON.stringify([
      input.vmId,
      input.guestHost,
      input.profile,
    ]);
    const existing = this.sessions.get(key);
    if (existing?.live && existing.binding === binding)
      return existing.endpoint;
    existing?.close();
    this.sessions.delete(key);
    const opening = this.open(input, binding);
    this.pending.set(key, opening);
    try {
      const session = await opening;
      if (this.closed) {
        session.close();
        throw Error("Hyper-V SSH relay is closed");
      }
      this.sessions.set(key, session);
      return session.endpoint;
    } finally {
      this.pending.delete(key);
    }
  }
  async close(identity: VmAllocationIdentity) {
    const key = ownerKey(identity);
    // A cleanup racing an opening must await it, then remove that exact listener.
    await this.pending.get(key)?.catch(() => undefined);
    this.sessions.get(key)?.close();
    this.sessions.delete(key);
  }
  async closeAll() {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
  private async open(input: Request, binding: string): Promise<Session> {
    const p = input.profile;
    const auth = p.privateKeySecretRef
      ? { privateKey: await this.secrets.get(p.privateKeySecretRef) }
      : p.passwordSecretRef
        ? { password: await this.secrets.get(p.passwordSecretRef) }
        : undefined;
    const remaining = input.deadlineMs - this.now();
    if (!auth || remaining < 1 || this.closed)
      throw Error(
        "Hyper-V SSH relay authentication or deadline is unavailable",
      );
    return new Promise<Session>((resolve, reject) => {
      const client = new ssh2.Client();
      const sockets = new Set<Socket>();
      const channels = new Set<import("ssh2").ClientChannel>();
      let settled = false;
      let disposed = false;
      const session: Session = {
        binding,
        endpoint: { host: "127.0.0.1", port: 0 },
        live: false,
        close: () => {
          if (disposed) return;
          disposed = true;
          session.live = false;
          clearTimeout(timer);
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          for (const channel of channels) channel.destroy();
          channels.clear();
          // close() is safe before listen completes; Node reports ERR_SERVER_NOT_RUNNING to the callback.
          server.close(() => undefined);
          client.destroy();
        },
      };
      const fail = () => {
        session.close();
        if (!settled) {
          settled = true;
          reject(Error("Hyper-V SSH relay connection failed"));
        }
      };
      const server = createServer((socket) => {
        if (!session.live) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
        try {
          client.forwardOut(
            "127.0.0.1",
            0,
            input.guestHost,
            22,
            (error, stream) => {
              if (error || disposed || socket.destroyed) {
                stream?.destroy();
                socket.destroy();
                return;
              }
              channels.add(stream);
              stream.once("close", () => channels.delete(stream));
              stream.on("error", () => {
                stream.destroy();
                socket.destroy();
              });
              stream.once("close", () => socket.destroy());
              socket.once("close", () => stream.destroy());
              socket.pipe(stream).pipe(socket);
            },
          );
        } catch {
          socket.destroy();
          fail();
        }
      });
      server.on("error", fail);
      const timer = setTimeout(fail, Math.min(10_000, remaining));
      timer.unref();
      client.on("error", fail);
      client.once("close", fail);
      client.once("ready", () => {
        if (disposed) return;
        server.listen(0, "127.0.0.1", () => {
          if (disposed) {
            server.close(() => undefined);
            return;
          }
          const address = server.address();
          if (!address || typeof address === "string") {
            fail();
            return;
          }
          clearTimeout(timer);
          session.endpoint.port = address.port;
          session.live = true;
          settled = true;
          resolve(session);
        });
      });
      try {
        client.connect({
          host: p.host,
          port: p.port ?? 22,
          username: p.username,
          ...auth,
          hostVerifier: (key: Buffer) =>
            "SHA256:" +
              createHash("sha256")
                .update(key)
                .digest("base64")
                .replace(/=+$/, "") ===
            p.hostKeyFingerprint,
          readyTimeout: Math.min(8_000, remaining),
          keepaliveInterval: 10_000,
          keepaliveCountMax: 3,
        });
      } catch {
        fail();
      }
    });
  }
}
function ownerKey(identity: VmAllocationIdentity) {
  return JSON.stringify([
    identity.installationId,
    identity.runtimeIdentityId,
    identity.allocationId,
    identity.generation,
  ]);
}
