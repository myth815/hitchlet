// Keep the native supervisor (and its usernet responsibility) alive across releases.
import { spawn } from "node:child_process";
export function studioChildren({ onFailure, timeoutMs = 15000 }) {
  const children = new Set();
  let stopping = false;
  return {
    start(file, options) {
      if (stopping) throw new Error("Studio children are stopping");
      const child = spawn(process.execPath, [file], options);
      children.add(child);
      child.once("error", (error) => {
        if (!stopping) onFailure(error);
      });
      child.once("exit", (code, signal) => {
        children.delete(child);
        if (!stopping)
          onFailure(new Error(`Studio child exited (${code ?? signal})`));
      });
      return child;
    },
    async stop() {
      stopping = true;
      try {
        await Promise.all(
          [...children].map(
            (child) =>
              new Promise((resolve, reject) => {
                if (child.exitCode !== null || child.signalCode !== null) {
                  resolve();
                  return;
                }
                const timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Studio child did not stop; no replacement started",
                      ),
                    ),
                  timeoutMs,
                );
                const done = () => {
                  clearTimeout(timer);
                  resolve();
                };
                child.once("exit", done);
                child.kill("SIGTERM");
              }),
          ),
        );
      } finally {
        stopping = false;
      }
    },
  };
}
