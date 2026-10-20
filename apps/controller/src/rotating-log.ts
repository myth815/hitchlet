import { Writable } from "node:stream";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/** Bounded local JSON logs. Pino redaction occurs before this stream receives data. */
export class RotatingLog extends Writable {
  private size = 0;
  private initialized = false;
  constructor(
    private readonly root: string,
    private readonly maximumBytes: number,
    private readonly files: number,
  ) {
    super();
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    void this.append(chunk).then(
      () => callback(),
      () => callback(new Error("Local log write failed")),
    );
  }
  private async append(chunk: Buffer) {
    const path = join(this.root, "controller.log");
    if (!this.initialized) {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      this.size = await stat(path).then(
        (s) => s.size,
        () => 0,
      );
      this.initialized = true;
    }
    if (this.size + chunk.length > this.maximumBytes) {
      for (let i = this.files - 1; i > 0; i--)
        await rename(
          join(this.root, `controller.log.${i - 1}`),
          join(this.root, `controller.log.${i}`),
        ).catch(() => undefined);
      await rename(path, join(this.root, "controller.log.0")).catch(
        () => undefined,
      );
      this.size = 0;
    }
    // A single oversized provider/log record cannot defeat the file bound.
    const bounded =
      chunk.length > this.maximumBytes
        ? Buffer.from('{"level":40,"msg":"oversized log record omitted"}\n')
        : chunk;
    await appendFile(path, bounded, { mode: 0o600 });
    this.size += bounded.length;
  }
}
