import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  SQLiteAccessMaterialStore,
  encodeEd25519OpenSshKey,
} from "../src/storage/access-material-store.js";
import type { Storage } from "../src/storage/index.js";
import { LocalSecretStore } from "../src/storage/secret-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("allocation SSH access material", () => {
  it("preserves a leading zero in the public key and produces a usable signing key", () => {
    // Synthetic deterministic test seed, never used by a deployed allocation.
    const seed = Buffer.alloc(32);
    seed.writeUInt32BE(135);
    const key = createPrivateKey({
      format: "der",
      type: "pkcs8",
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
      ]),
    });
    const publicKey = createPublicKey(key);
    const expected = Buffer.from(
      publicKey.export({ format: "jwk" }).x!,
      "base64url",
    );
    expect(expected[0]).toBe(0);
    const parsed = ssh2.utils.parseKey(encodeEd25519OpenSshKey(key));
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.getPublicSSH().subarray(-32)).toEqual(expected);
    const message = Buffer.from("hitchlet fixed-key regression");
    expect(
      verify(
        null,
        message,
        publicKey,
        sign(null, message, parsed.getPrivatePEM()),
      ),
    ).toBe(true);
  });
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
