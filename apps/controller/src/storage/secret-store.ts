import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Small encrypted, version-addressed local secret store. The master key is injected from a protected file. */
export class LocalSecretStore {
  private constructor(
    private readonly root: string,
    private readonly key: Buffer,
  ) {}
  static async open(
    root: string,
    masterKeyFile: string,
  ): Promise<LocalSecretStore> {
    const key = await readFile(masterKeyFile);
    if (key.length !== 32)
      throw new Error(
        "HITCHLET_SECRET_KEY_FILE must contain exactly 32 raw key bytes",
      );
    return new LocalSecretStore(resolve(root, "secrets"), key);
  }
  async put(value: string): Promise<string> {
    if (!value || value.length > 16_384 || value.includes("\0"))
      throw new RangeError("Invalid secret value");
    const id = randomBytes(16).toString("hex");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = resolve(this.root, `${id}.secret`);
    await writeFile(
      path,
      Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
      { mode: 0o600, flag: "wx" },
    );
    await chmod(path, 0o600);
    return `secret:${id}`;
  }
  async get(ref: string): Promise<string> {
    if (!/^secret:[a-f0-9]{32}$/.test(ref))
      throw new RangeError("Invalid secret version reference");
    const bytes = await readFile(resolve(this.root, `${ref.slice(7)}.secret`));
    if (bytes.length < 29) throw new Error("Stored secret is corrupt");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
}
