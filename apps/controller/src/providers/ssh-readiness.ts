import { Client } from "ssh2";

export async function probeSsh(input: {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  expectedHostKey: Buffer;
}) {
  await new Promise<void>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => done(new Error("SSH readiness probe timed out")),
      10_000,
    );
    timeout.unref();
    client.once("close", () =>
      done(new Error("SSH connection closed before readiness was confirmed")),
    );
    client.once("ready", () => {
      client.exec(
        "id -un && id -u && id -g && test -w /workspace",
        (error, stream) => {
          if (error) return done(error);
          stream.once("error", done);
          let stdout = "";
          let stderr = "";
          stream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          stream.once("close", (code: number | null) => {
            const lines = stdout.trim().split(/\r?\n/);
            if (
              code !== 0 ||
              lines[0] !== input.username ||
              lines[1] !== "1000" ||
              lines[2] !== "1000"
            )
              done(
                new Error(
                  `Authenticated SSH bootstrap probe failed${stderr ? ` (${stderr.slice(0, 128)})` : ""}`,
                ),
              );
            else done();
          });
        },
      );
    });
    // ssh2 can emit another protocol error while end() closes a failed handshake.
    // Keep the listener for this client lifetime; done settles the probe only once.
    client.on("error", (error) => done(error));
    client.connect({
      host: input.host,
      port: input.port,
      username: input.username,
      privateKey: input.privateKey,
      readyTimeout: 8_000,
      hostVerifier: (key: Buffer) => key.equals(input.expectedHostKey),
    });
  });
}
