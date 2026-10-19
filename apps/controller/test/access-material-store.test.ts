import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { SQLiteAccessMaterialStore } from "../src/storage/access-material-store.js";
import type { Storage } from "../src/storage/index.js";
import { LocalSecretStore } from "../src/storage/secret-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("allocation SSH access material", () => {
  it("stores an OpenSSH Ed25519 key and returns a parseable authorized_keys line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-access-key-"));
    dirs.push(dir);
    const keyFile = join(dir, "master.key");
    await writeFile(keyFile, Buffer.alloc(32, 41), { mode: 0o600 });
    const secrets = await LocalSecretStore.open(dir, keyFile);
    let ref: string | null = null;
    const database = {
      get: async () => ({ access_secret_ref: ref }),
      run: async (_sql: string, args: readonly unknown[]) => {
        ref = String(args[0]);
        return { changes: 1n };
      },
    } as unknown as Storage;
    const store = new SQLiteAccessMaterialStore(database, secrets);

    const first = await store.getOrCreate("allocation-1");
    const second = await store.getOrCreate("allocation-1");
    const parsedPublic = ssh2.utils.parseKey(first.publicKey);
    const parsedPrivate = ssh2.utils.parseKey(second.privateKey);

    expect(first.secretRef).toMatch(/^secret:[a-f0-9]{32}$/);
    expect(second.secretRef).toBe(first.secretRef);
    expect(first.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(parsedPublic).not.toBeInstanceOf(Error);
    expect(parsedPrivate).not.toBeInstanceOf(Error);
    expect(first.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* hitchlet$/);
    expect(first.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(await secrets.get(first.secretRef)).toBe(first.privateKey);
  });
});
