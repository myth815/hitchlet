import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import ssh2 from "ssh2";
const { Client, utils } = ssh2;
const MAX_PROBE_MS = 10_000;
const MAX_OUTPUT_BYTES = 4096;
export type SshReadinessInput = Readonly<{
  host: string;
  port: number;
  username: string;
  privateKey: string;
  hostPublicKey: string;
  hostKeyFingerprint: string;
  clientPublicKeyFingerprint: string;
  deadlineMs: number;
}>;
type SshCommandOutput = Readonly<{ stdout: string; exitCode: number | null }>;
/** Shared transport for fixed provider-owned commands. It does not accept a command from an HTTP/tenant API. */
export async function runSshReadinessCommand(
  input: SshReadinessInput,
  command: string,
  label: "Tart" | "Hyper-V",
  now = Date.now,
): Promise<SshCommandOutput> {
  const expectedHostBlob = publicKeyBlob(input.hostPublicKey, label);
  const clientKey = privateKeyBlob(input.privateKey, label);
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
      `${label} SSH readiness inputs do not match the frozen identity`,
    );

  const remainingMs = input.deadlineMs - now();
  if (remainingMs < 1)
    throw new Error(`${label} SSH readiness deadline has expired`);
  const timeoutMs = Math.min(MAX_PROBE_MS, remainingMs);
  return new Promise<SshCommandOutput>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let outputBytes = 0;
    let stdout = "";
    const done = (error?: Error, evidence?: SshCommandOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      if (error) reject(error);
      else if (evidence) resolve(evidence);
      else reject(new Error(`${label} SSH readiness did not produce evidence`));
    };
    const timeout = setTimeout(
      () => done(new Error(`${label} SSH readiness probe timed out`)),
      timeoutMs,
    );
    timeout.unref();
    client.once("close", () =>
      done(
        new Error(
          `${label} SSH connection closed before readiness was confirmed`,
        ),
      ),
    );
    client.once("ready", () => {
      client.exec(command, { pty: false }, (error, stream) => {
        if (settled) return;
        if (error) {
          done(new Error(`${label} SSH readiness command could not start`));
          return;
        }
        const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
          outputBytes += chunk.byteLength;
          if (outputBytes > MAX_OUTPUT_BYTES) {
            stream.destroy();
            done(new Error(`${label} SSH readiness output exceeded its limit`));
            return;
          }
          if (target === "stdout") stdout += chunk.toString("utf8");
        };
        stream.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
        stream.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
        stream.once("error", () =>
          done(new Error(`${label} SSH readiness command failed`)),
        );
        stream.once("close", (code: number | null) => {
          if (settled) return;
          done(undefined, { stdout, exitCode: code });
        });
      });
    });
    // Keep a single terminal error path: ssh2 may report a late handshake error during close.
    client.on("error", () =>
      done(new Error(`${label} SSH readiness connection failed`)),
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
      done(new Error(`${label} SSH readiness connection failed`));
    }
  });
}

function publicKeyBlob(value: string, label: string): Buffer {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error || parsed.isPrivateKey())
    throw new Error(`${label} SSH host public key is invalid`);
  return parsed.getPublicSSH();
}

function privateKeyBlob(value: string, label: string): Buffer {
  const parsed = utils.parseKey(value);
  if (parsed instanceof Error || !parsed.isPrivateKey())
    throw new Error(`${label} SSH client private key is invalid`);
  return parsed.getPublicSSH();
}

function fingerprint(publicKeyBlob: Buffer): string {
  return `SHA256:${createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "")}`;
}
