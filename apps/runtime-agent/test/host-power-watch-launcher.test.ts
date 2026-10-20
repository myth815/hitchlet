import { describe, expect, it } from "vitest";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { superviseNativeWatch } from "../src/host-power-watch-launcher.js";

function fixture() {
  const child = new ChildProcess(),
    stdout = new PassThrough(),
    output = new PassThrough();
  Object.defineProperty(child, "pid", { value: 2222 });
  Object.defineProperty(child, "stdout", { value: stdout });
  let written = "";
  output.on("data", (chunk) => {
    written += String(chunk);
  });
  const ready = {
    event: "ready",
    launcherPid: 1111,
    launcherStartedTicks: "638000000000000001",
    watchPid: 2222,
    watchStartedTicks: "638000000000000002",
  };
  return {
    child,
    stdout,
    output,
    ready,
    get written() {
      return written;
    },
  };
}
describe("fixed independent watch launcher protocol", () => {
  it("does not report launcher startup as ready and waits for its actual child identity", async () => {
    const f = fixture();
    const result = superviseNativeWatch(f.child, 1111, f.output);
    expect(f.written).toBe("");
    const line = JSON.stringify(f.ready);
    f.stdout.write(line.slice(0, 30));
    expect(f.written).toBe("");
    f.stdout.write(line.slice(30) + "\n");
    expect(JSON.parse(f.written)).toEqual(f.ready);
    f.child.emit("exit", 0, null);
    await expect(result).resolves.toBe(0);
  });
  it("keeps supervising the PS helper after the original parent's output pipe is gone", async () => {
    const f = fixture();
    let completed = false;
    const result = superviseNativeWatch(f.child, 1111, f.output).then(
      (code) => {
        completed = true;
        return code;
      },
    );
    f.stdout.write(JSON.stringify(f.ready) + "\n");
    f.output.destroy(
      Object.assign(new Error("parent gone"), { code: "EPIPE" }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.stdout.write('{"event":"aborting"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    f.child.emit("exit", 0, null);
    await expect(result).resolves.toBe(0);
  });
  it.each(["launcher", "watch", "unknown", "oversize"])(
    "never trusts %s protocol but leaves the active helper supervising until it exits",
    async (kind) => {
      const f = fixture(),
        result = superviseNativeWatch(f.child, 1111, f.output);
      const message =
        kind === "launcher"
          ? { ...f.ready, launcherPid: 9999 }
          : kind === "watch"
            ? { ...f.ready, watchPid: 9999 }
            : { event: "ready", command: "arbitrary" };
      f.stdout.write(
        kind === "oversize" ? "x".repeat(513) : JSON.stringify(message) + "\n",
      );
      expect(JSON.parse(f.written)).toEqual({ event: "failed" });
      f.child.emit("exit", 0, null);
      await expect(result).resolves.toBe(1);
    },
  );
  it("rejects early child exit without any real ready receipt", async () => {
    const f = fixture(),
      result = superviseNativeWatch(f.child, 1111, f.output);
    f.child.emit("exit", 0, null);
    await expect(result).resolves.toBe(1);
    expect(JSON.parse(f.written)).toEqual({ event: "failed" });
  });
});
