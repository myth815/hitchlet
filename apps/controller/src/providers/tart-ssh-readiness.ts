import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import ssh2 from "ssh2";
import type { TartSshProbeEvidence } from "./tart-provider.js";

const { Client, utils } = ssh2;

const MAX_PROBE_MS = 10_000;
const MAX_OUTPUT_BYTES = 4096;
const REMOTE_CHECK =
  "id -un && uname -s && uname -m && test -w /tmp && printf 'hitchlet-scratch-writable\\n'";

export type TartSshProbeInput = Readonly<{
  host: string;
  port: number;
  username: string;
  privateKey: string;
  hostPublicKey: string;
  hostKeyFingerprint: string;
  clientPublicKeyFingerprint: string;
  guestOS: "linux" | "macos";
  architecture: "arm64";
  deadlineMs: number;
}>;

/** Production SSH port for Tart readiness; it performs one fixed, read-only guest check. */
export async function probeTartSsh(
  input: TartSshProbeInput,
  now = Date.now,
): Promise<TartSshProbeEvidence> {
  const expectedHostBlob = publicKeyBlob(input.hostPublicKey);
  const clientKey = privateKeyBlob(input.privateKey);
  const hostFingerprint = fingerprint(expectedHostBlob);
  const clientFingerprint = fingerprint(clientKey);
  if (
    !isIPv4(input.host) ||
    input.port !== 22 ||
    !input.username ||
    !Number.isSafeInteger(input.deadlineMs) ||
    hostFingerprint !== input.hostKeyFingerprint ||
    clientFingerprint !== input.clientPublicKeyFingerprint
  )
    throw new Error(
      "Tart SSH readiness inputs do not match the frozen identity",
    );

  const remainingMs = input.deadlineMs - now();
  if (remainingMs < 1)
    throw new Error("Tart SSH readiness deadline has expired");
  const timeoutMs = Math.min(MAX_PROBE_MS, remainingMs);
  return new Promise<TartSshProbeEvidence>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let outputBytes = 0;
    let stdout = "";
    const done = (error?: Error, evidence?: TartSshProbeEvidence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      if (error) reject(error);
      else if (evidence) resolve(evidence);
      else reject(new Error("Tart SSH readiness did not produce evidence"));
    };
    const timeout = setTimeout(
      () => done(new Error("Tart SSH readiness probe timed out")),
      timeoutMs,
    );
    timeout.unref();
    client.once("close", () =>
      done(
        new Error("Tart SSH connection closed before readiness was confirmed"),
      ),
    );
    client.once("ready", () => {
      client.exec(REMOTE_CHECK, { pty: false }, (error, stream) => {
        if (settled) return;
        if (error) {
          done(new Error("Tart SSH readiness command could not start"));
          return;
        }
        const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
          outputBytes += chunk.byteLength;
          if (outputBytes > MAX_OUTPUT_BYTES) {
            stream.destroy();
            done(new Error("Tart SSH readiness output exceeded its limit"));
            return;
          }
          if (target === "stdout") stdout += chunk.toString("utf8");
        };
        stream.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
        stream.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
        stream.once("error", () =>
          done(new Error("Tart SSH readiness command failed")),
        );
        stream.once("close", (code: number | null) => {
          if (settled) return;
          const lines = stdout.replace(/\r/g, "").trimEnd().split("\n");
          const observedOS =
            lines[1] === "Darwin"
              ? "macos"
              : lines[1] === "Linux"
                ? "linux"
                : undefined;
          const observedArch =
            lines[2] === "arm64" || lines[2] === "aarch64"
              ? "arm64"
              : undefined;
          if (
            code !== 0 ||
            lines.length !== 4 ||
            lines[0] !== input.username ||
            observedOS !== input.guestOS ||
            observedArch !== input.architecture ||
            lines[3] !== "hitchlet-scratch-writable"
          ) {
            done(
              new Error("Tart SSH guest facts or scratch check did not match"),
            );
            return;
          }
          done(undefined, {
            authenticated: true,
            username: input.username,
            hostKeyFingerprint: input.hostKeyFingerprint,
            clientPublicKeyFingerprint: input.clientPublicKeyFingerprint,
            guestOS: observedOS,
            architecture: observedArch,
            scratchWritable: true,
          });
        });
      });
    });
    // Keep a single terminal error path: ssh2 may report a late handshake error during close.
    client.on("error", () =>
      done(new Error("Tart SSH readiness connection failed")),
    );
    try {
      client.connect({
        host: input.host,
        port: input.port,
        username: input.username,
        privateKey: input.privateKey,
        readyTimeout: Math.min(8_000, timeoutMs),
        hostVerifier: (key: Buffer) => key.equals(expectedHostBlob),
      });
    } catch {
      done(new Error("Tart SSH readiness connection failed"));
    }
  });
}

function publicKeyBlob(value: string): Buffer {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error || parsed.isPrivateKey())
    throw new Error("Tart SSH host public key is invalid");
  return parsed.getPublicSSH();
}

function privateKeyBlob(value: string): Buffer {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error || !parsed.isPrivateKey())
    throw new Error("Tart SSH client private key is invalid");
  return parsed.getPublicSSH();
}

function fingerprint(publicKeyBlob: Buffer): string {
  return `SHA256:${createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "")}`;
}
