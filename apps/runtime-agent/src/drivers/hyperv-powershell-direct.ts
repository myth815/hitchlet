import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import {
  hyperVGuestBootstrapRequestSchema,
  hyperVGuestBootstrapObservationSchema,
  type HyperVGuestBootstrapRequest,
} from "@hitchlet/contracts/internal";
import {
  hyperVPublicKeyFingerprint,
  type HyperVGuestBootstrapPort,
} from "./hyperv-guest.js";

export type HyperVGuestCommand = Readonly<{
  mode: "inspect" | "apply";
  request: HyperVGuestBootstrapRequest;
  credentialFile: string;
  budgetMs: number;
}>;
export type HyperVGuestRunner = (
  command: HyperVGuestCommand,
) => Promise<unknown>;

/** Windows PowerShell Direct uses an existing host-protected guest PSCredential.
 * Neither password nor host maintenance identity is copied into the request. */
export function createPowerShellDirectBootstrap(options: {
  credentialFile: string;
  run?: HyperVGuestRunner;
  now?: () => number;
}): HyperVGuestBootstrapPort {
  if (!isAbsolute(options.credentialFile))
    throw Error("Absolute guest credential reference required");
  const now = options.now ?? Date.now;
  const run = options.run ?? runPowerShellDirectGuest;
  async function action(
    mode: "inspect" | "apply",
    raw: HyperVGuestBootstrapRequest,
    deadlineMs: number,
  ) {
    const request = hyperVGuestBootstrapRequestSchema.parse(raw);
    if (request.guestOs !== "windows" || request.architecture !== "amd64")
      throw Error("PowerShell Direct bootstrap supports Windows amd64 only");
    if (
      hyperVPublicKeyFingerprint(request.clientPublicKey) !==
      request.clientPublicKeyFingerprint
    )
      throw Error("Guest bootstrap client key mismatch");
    const budgetMs = Math.min(30_000, Math.floor(deadlineMs - now()));
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1)
      throw Error("Guest bootstrap deadline expired");
    const result = hyperVGuestBootstrapObservationSchema.parse(
      await run({
        mode,
        request,
        credentialFile: options.credentialFile,
        budgetMs,
      }),
    );
    if (now() >= deadlineMs) throw Error("Guest bootstrap deadline expired");
    if (result.status === "applied") {
      const { clientPublicKey: _, ...expected } = request;
      for (const [key, value] of Object.entries(expected)) {
        if (
          JSON.stringify(result[key as keyof typeof result]) !==
          JSON.stringify(value)
        )
          throw Error("Guest bootstrap receipt identity mismatch");
      }
      if (
        hyperVPublicKeyFingerprint(result.hostPublicKey) !==
        result.hostKeyFingerprint
      )
        throw Error("Guest bootstrap host key mismatch");
    }
    return result;
  }
  return {
    inspect: (request, deadline) => action("inspect", request, deadline),
    apply: (request, deadline) => action("apply", request, deadline),
  };
}

/** Fixed asset, bounded output and process lifetime. Native errors are deliberately
 * not returned: PowerShell may include protected credential paths in diagnostics. */
export const runPowerShellDirectGuest: HyperVGuestRunner = (command) => {
  const file = fileURLToPath(
    new URL("./hyperv-powershell-direct.ps1", import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", file],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = Buffer.alloc(0),
      settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(
      () => finish(Error("Guest bootstrap outcome unknown: timeout")),
      command.budgetMs,
    );
    child.on("error", () =>
      finish(Error("Guest bootstrap channel unavailable")),
    );
    child.stdin.on("error", () =>
      finish(Error("Guest bootstrap channel unavailable")),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 65536) {
        finish(Error("Guest bootstrap output limit"));
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      if (code !== 0) {
        finish(Error("Guest bootstrap channel failed"));
        return;
      }
      try {
        finish(
          undefined,
          JSON.parse(output.toString("utf8").replace(/^\uFEFF/, "")),
        );
      } catch {
        finish(Error("Guest bootstrap response invalid"));
      }
    });
    child.stdin.end(JSON.stringify(command));
  });
};
