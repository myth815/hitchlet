import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSecretStore } from "../src/storage/secret-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe("local versioned secret store", () => {
  it("keeps ciphertext on disk and detects tampering and a wrong master key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-secret-test-"));
    dirs.push(dir);
    const keyFile = join(dir, "master.key"),
      wrongKeyFile = join(dir, "wrong.key");
    await writeFile(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    await writeFile(wrongKeyFile, Buffer.alloc(32, 9), { mode: 0o600 });
    const store = await LocalSecretStore.open(dir, keyFile),
      secret = "portainer-api-key-never-plaintext";
    const ref = await store.put(secret),
      path = join(dir, "secrets", `${ref.slice(7)}.secret`),
      ciphertext = await readFile(path);
    expect(ciphertext.includes(Buffer.from(secret))).toBe(false);
    expect(await store.get(ref)).toBe(secret);
    await expect(
      (await LocalSecretStore.open(dir, wrongKeyFile)).get(ref),
    ).rejects.toThrow();
    ciphertext[ciphertext.length - 1] ^= 1;
    await writeFile(path, ciphertext);
    await expect(store.get(ref)).rejects.toThrow();
    expect((await readdir(join(dir, "secrets"))).length).toBe(1);
  });
});
