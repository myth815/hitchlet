const PROBE_COMMAND = "id -un && id -u && id -g";
const MAX_OUTPUT_BYTES = 4096;
const swallowLateError = () => {};

function discardChannel(stream) {
  if (!stream) return;
  stream.on?.("error", swallowLateError);
  stream.stderr?.on?.("error", swallowLateError);
  try {
    stream.destroy?.();
  } catch {
    // A late channel is discarded without exposing transport details.
  }
}

function positiveTimeout(value, fallback, name) {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000) {
    throw new TypeError(`${name} must be an integer from 1 through 86400000.`);
  }
  return timeout;
}

function safeProbeSummary(stdout) {
  const lines = stdout.toString("utf8").trim().split(/\r?\n/);
  if (
    lines.length !== 3 ||
    lines[0].length === 0 ||
    !/^\d+$/.test(lines[1]) ||
    !/^\d+$/.test(lines[2])
  ) {
    throw new Error("The remote read-only probe returned an invalid result.");
  }
  if (
    !Number.isSafeInteger(Number(lines[1])) ||
    !Number.isSafeInteger(Number(lines[2]))
  ) {
    throw new Error("The remote read-only probe returned an invalid result.");
  }
  return {
    probe: "complete",
    uid: Number(lines[1]),
    gid: Number(lines[2]),
  };
}

/**
 * Build the CLI adapter callback around a consumer-supplied ssh2 Client class.
 * This module deliberately has no ssh2 dependency or import.
 */
export function createSshAdapter({
  Client,
  readyTimeoutMs: readyTimeoutInput,
  commandTimeoutMs: commandTimeoutInput,
} = {}) {
  if (typeof Client !== "function")
    throw new TypeError(
      "A consumer-supplied SSH Client constructor is required.",
    );
  const readyTimeoutMs = positiveTimeout(
    readyTimeoutInput,
    10_000,
    "readyTimeoutMs",
  );
  const commandTimeoutMs = positiveTimeout(
    commandTimeoutInput,
    10_000,
    "commandTimeoutMs",
  );

  return async function sshAccessAdapter({
    grant,
    verifyServerHostKey,
    confirmedExpiresAt,
  } = {}) {
    const auth = grant?.authentication;
    const access = grant?.access;
    if (
      access?.protocol !== "ssh" ||
      auth?.kind !== "ephemeral_private_key" ||
      typeof auth.privateKey !== "string" ||
      !auth.privateKey ||
      typeof access.host !== "string" ||
      access.host.length === 0 ||
      !Number.isInteger(access.port) ||
      access.port < 1 ||
      access.port > 65535 ||
      typeof access.username !== "string" ||
      access.username.length === 0 ||
      typeof verifyServerHostKey !== "function"
    ) {
      throw new Error(
        "The SSH adapter requires an SSH endpoint and ephemeral private-key grant.",
      );
    }

    const confirmedDeadline = Date.parse(confirmedExpiresAt ?? "");
    const grantDeadline = Date.parse(access.expiresAt ?? "");
    const deadlineAt = Math.min(confirmedDeadline, grantDeadline);
    if (
      !Number.isFinite(confirmedDeadline) ||
      !Number.isFinite(grantDeadline) ||
      deadlineAt <= Date.now()
    ) {
      throw new Error("The confirmed lease or access grant has expired.");
    }

    let client;
    try {
      client = new Client();
    } catch {
      throw new Error("The SSH adapter could not create a client.");
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let ready = false;
      let hostKeyVerified = false;
      let channel = null;
      let stdout = Buffer.alloc(0);
      let readyTimer;
      let commandTimer;

      const replaceErrorListener = (emitter, businessListener) => {
        if (!emitter) return;
        emitter.removeListener?.("error", businessListener);
        emitter.on?.("error", swallowLateError);
      };

      const closeChannel = () => {
        if (!channel) return;
        replaceErrorListener(channel, absorbChannelError);
        replaceErrorListener(channel.stderr, absorbChannelError);
        channel.removeListener("data", onStdout);
        channel.removeListener("close", onChannelClose);
        channel.removeListener("end", onChannelEnd);
        channel.stderr?.removeListener?.("data", onStderr);
        // Keep the error listeners installed so late close-time errors are absorbed.
        try {
          channel.destroy?.();
        } catch {
          // Closing is best effort; the caller receives only the fixed outcome below.
        }
      };

      const closeClient = () => {
        clearTimeout(readyTimer);
        clearTimeout(commandTimer);
        replaceErrorListener(client, absorbClientError);
        client.removeListener("ready", onReady);
        client.removeListener("close", onClientEnded);
        client.removeListener("end", onClientEnded);
        closeChannel();
        try {
          client.end();
        } catch {
          // destroy() below still runs if protocol shutdown fails.
        } finally {
          try {
            client.destroy();
          } catch {
            // The error sink remains installed during socket destruction.
          }
        }
      };

      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        closeClient();
        if (error) reject(new Error(error));
        else resolve(value);
      };

      const absorbClientError = () => {
        if (!settled) settle("The SSH connection failed.");
      };
      const absorbChannelError = () => {
        if (!settled) settle("The SSH probe channel failed.");
      };
      const onClientEnded = () => {
        if (!settled)
          settle("The SSH connection closed before the probe completed.");
      };
      const onStderr = () => {};
      const onStdout = (chunk) => {
        if (settled) return;
        if (Date.now() >= deadlineAt) {
          settle("The confirmed lease or access grant expired.");
          return;
        }
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stdout.length + bytes.length > MAX_OUTPUT_BYTES) {
          settle("The SSH probe output exceeded its fixed limit.");
          return;
        }
        stdout = Buffer.concat([stdout, bytes]);
      };
      const onChannelEnd = () => {
        // The close event carries the exit status; end alone is not success.
      };
      const onChannelClose = (code, signal) => {
        if (settled) return;
        if (Date.now() >= deadlineAt) {
          settle("The confirmed lease or access grant expired.");
          return;
        }
        if (code !== 0 || signal != null) {
          settle("The SSH read-only probe did not complete successfully.");
          return;
        }
        try {
          settle(null, safeProbeSummary(stdout));
        } catch {
          settle("The SSH read-only probe returned an invalid result.");
        }
      };
      const runProbe = () => {
        if (settled || ready) return;
        ready = true;
        clearTimeout(readyTimer);
        if (!hostKeyVerified) {
          settle("The SSH server host key was not verified.");
          return;
        }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          settle(
            "The confirmed lease or access grant expired before the probe.",
          );
          return;
        }
        commandTimer = setTimeout(
          () => settle("The SSH read-only probe timed out."),
          Math.min(commandTimeoutMs, remaining),
        );
        try {
          client.exec(PROBE_COMMAND, (error, stream) => {
            if (settled) {
              discardChannel(stream);
              return;
            }
            if (Date.now() >= deadlineAt) {
              settle("The confirmed lease or access grant expired.");
              discardChannel(stream);
              return;
            }
            if (error || !stream) {
              settle("The SSH read-only probe could not be started.");
              discardChannel(stream);
              return;
            }
            channel = stream;
            channel.on("error", absorbChannelError);
            channel.stderr?.on?.("error", absorbChannelError);
            channel.on("data", onStdout);
            channel.stderr?.on?.("data", onStderr);
            channel.on("end", onChannelEnd);
            channel.on("close", onChannelClose);
          });
        } catch {
          settle("The SSH read-only probe could not be started.");
        }
      };
      const onReady = () => runProbe();

      client.on("error", absorbClientError);
      client.on("close", onClientEnded);
      client.on("end", onClientEnded);
      client.on("ready", onReady);

      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        settle(
          "The confirmed lease or access grant expired before connecting.",
        );
        return;
      }
      const timeoutMs = Math.min(readyTimeoutMs, remaining);
      readyTimer = setTimeout(
        () => settle("The SSH connection timed out before becoming ready."),
        timeoutMs,
      );
      try {
        client.connect({
          host: access.host,
          port: access.port,
          username: access.username,
          privateKey: auth.privateKey,
          readyTimeout: timeoutMs,
          hostVerifier: (rawHostKey) => {
            try {
              if (settled || Date.now() >= deadlineAt) return false;
              if (
                !(
                  Buffer.isBuffer(rawHostKey) ||
                  rawHostKey instanceof Uint8Array
                )
              )
                return false;
              hostKeyVerified = verifyServerHostKey(rawHostKey) === true;
              return hostKeyVerified;
            } catch {
              hostKeyVerified = false;
              return false;
            }
          },
        });
      } catch {
        settle("The SSH connection could not be started.");
      }
    });
  };
}
