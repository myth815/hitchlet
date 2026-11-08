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

it("atomic fixed references survive competing writers/restart; corrupt material is never replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-reference-"));
  dirs.push(dir);
  const key = join(dir, "master.key");
  await writeFile(key, Buffer.alloc(32, 3));
  const a = await LocalSecretStore.open(dir, key),
    b = await LocalSecretStore.open(dir, key),
    ref = "secret:" + "d".repeat(32);
  const [first, second] = await Promise.all([
    a.getOrCreate(ref, () => "first-private-material"),
    b.getOrCreate(ref, () => "second-private-material"),
  ]);
  expect(first).toBe(second);
  expect(
    await (
      await LocalSecretStore.open(dir, key)
    ).getOrCreate(ref, () => {
      throw Error("must not regenerate");
    }),
  ).toBe(first);
  const path = join(dir, "secrets", `${ref.slice(7)}.secret`);
  expect((await readFile(path)).includes(Buffer.from(first))).toBe(false);
  expect(await readdir(join(dir, "secrets"))).toEqual([
    `${ref.slice(7)}.secret`,
  ]);
  await writeFile(path, "corrupt");
  await expect(a.getOrCreate(ref, () => "replacement")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("corrupt");
  await writeFile(path + "." + "e".repeat(32) + ".tmp", "encrypted-orphan");
  await a.remove(ref);
  await a.remove(ref);
  expect(await readdir(join(dir, "secrets"))).toEqual([]);
});

it("removes a reserved reference even if its secret directory was never created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-reserved-"));
  dirs.push(dir);
  const key = join(dir, "master.key");
  await writeFile(key, Buffer.alloc(32, 6));
  const store = await LocalSecretStore.open(dir, key);
  const ref = "secret:" + "e".repeat(32);
  await store.remove(ref);
  await store.remove(ref);
  expect(await readdir(dir)).toEqual(["master.key"]);
});
