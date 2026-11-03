import type { TartSshProbeEvidence } from "./tart-provider.js";
import { runSshReadinessCommand } from "./ssh-readiness-command.js";
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

/** Fixed Tart guest readback; wire/command semantics retained. */
export async function probeTartSsh(
  input: TartSshProbeInput,
  now = Date.now,
): Promise<TartSshProbeEvidence> {
  const output = await runSshReadinessCommand(input, REMOTE_CHECK, "Tart", now);
  const lines = output.stdout.replace(/\r/g, "").trimEnd().split("\n");
  const observedOS =
    lines[1] === "Darwin"
      ? "macos"
      : lines[1] === "Linux"
        ? "linux"
        : undefined;
  const observedArch =
    lines[2] === "arm64" || lines[2] === "aarch64" ? "arm64" : undefined;
  if (
    output.exitCode !== 0 ||
    lines.length !== 4 ||
    lines[0] !== input.username ||
    observedOS !== input.guestOS ||
    observedArch !== input.architecture ||
    lines[3] !== "hitchlet-scratch-writable"
  ) {
    throw new Error("Tart SSH guest facts or scratch check did not match");
  }
  return {
    authenticated: true,
    username: input.username,
    hostKeyFingerprint: input.hostKeyFingerprint,
    clientPublicKeyFingerprint: input.clientPublicKeyFingerprint,
    guestOS: observedOS,
    architecture: observedArch,
    scratchWritable: true,
  };
}
