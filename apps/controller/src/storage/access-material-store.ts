import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import ssh2 from "ssh2";
import type { Storage } from "./index.js";
import { LocalSecretStore } from "./secret-store.js";

type Row = Record<string, string | number | bigint | null>;
const { utils: sshUtils } = ssh2;

/** Versioned AES secret reference for a single allocation's generated SSH key. */
export class SQLiteAccessMaterialStore {
  constructor(
    private readonly db: Storage,
    private readonly secrets: LocalSecretStore,
    private readonly now = Date.now,
  ) {}

  async getOrCreate(allocationId: string) {
    const current = await this.db.get<Row>(
      "SELECT access_secret_ref FROM allocations WHERE id=? AND purpose IN ('tenant','validation')",
      [allocationId],
    );
    if (!current) throw new Error("Access material allocation is missing");
    if (typeof current.access_secret_ref === "string") {
      const privateKey = await this.secrets.get(current.access_secret_ref);
      return material(privateKey, current.access_secret_ref);
    }
    const privatePem = encodeEd25519OpenSshKey(
      generateKeyPairSync("ed25519").privateKey,
    );
    // Validate before any secret or Allocation reference is persisted.
    const generated = material(privatePem, "pending");
    const ref = await this.secrets.put(privatePem);
    const result = await this.db.run(
      "UPDATE allocations SET access_secret_ref=?,version=version+1,updated_at_ms=? WHERE id=? AND access_secret_ref IS NULL",
      [ref, this.now(), allocationId],
    );
    if (result.changes === 1n) return { ...generated, secretRef: ref };
    const winner = await this.db.get<Row>(
      "SELECT access_secret_ref FROM allocations WHERE id=?",
      [allocationId],
    );
    if (!winner || typeof winner.access_secret_ref !== "string")
      throw new Error(
        "Access material CAS failed without a recoverable winner",
      );
    const winnerPrivateKey = await this.secrets.get(winner.access_secret_ref);
    return material(winnerPrivateKey, winner.access_secret_ref);
  }

  async read(secretRef: string) {
    return this.secrets.get(secretRef);
  }
}

/** OpenSSH envelope around Node's Ed25519 bytes; no key arithmetic is implemented here.
 * ssh2's generator strips leading zero public-key bytes, which are significant
 * for Ed25519. JWK preserves the exact 32-byte public key and private seed. */
export function encodeEd25519OpenSshKey(key: KeyObject): string {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw new Error("An Ed25519 private key is required");
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x || !jwk.d) throw new Error("Ed25519 key bytes are missing");
  const publicBytes = Buffer.from(jwk.x, "base64url"),
    seed = Buffer.from(jwk.d, "base64url");
  if (publicBytes.length !== 32 || seed.length !== 32)
    throw new Error("Ed25519 keys require 32-byte public and seed values");
  const uint32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const sshString = (value: string | Buffer) => {
    const b = typeof value === "string" ? Buffer.from(value) : value;
    return Buffer.concat([uint32(b.length), b]);
  };
  const publicBlob = Buffer.concat([
    sshString("ssh-ed25519"),
    sshString(publicBytes),
  ]);
  const check = randomBytes(4);
  const privateBlock = Buffer.concat([
    check,
    check,
    publicBlob,
    sshString(Buffer.concat([seed, publicBytes])),
    sshString("hitchlet"),
  ]);
  const padding = Buffer.from(
    Array.from({ length: 8 - (privateBlock.length % 8) }, (_, i) => i + 1),
  );
  const envelope = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(publicBlob),
    sshString(Buffer.concat([privateBlock, padding])),
  ]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${envelope
    .toString("base64")
    .match(/.{1,70}/g)!
    .join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function material(privateKey: string, secretRef: string) {
  const parsed = sshUtils.parseKey(privateKey);
  if (
    parsed instanceof Error ||
    !parsed.isPrivateKey() ||
    parsed.type !== "ssh-ed25519"
  )
    throw new Error(
      "Stored access key is not a valid OpenSSH Ed25519 private key",
    );
  // ssh2 returns the SSH wire-format blob here (uint32 length + key type +
  // fields), not the textual authorized_keys representation.
  const publicBlob = parsed.getPublicSSH();
  const typeLength = publicBlob.readUInt32BE(0);
  const type = publicBlob.subarray(4, 4 + typeLength).toString("ascii");
  const encoded = publicBlob.toString("base64");
  if (type !== "ssh-ed25519" || publicBlob.length < 4 + typeLength)
    throw new Error(
      "Generated access key has an invalid OpenSSH public encoding",
    );
  const publicKey = `${type} ${encoded} hitchlet`;
  const fingerprint = `SHA256:${createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")}`;
  return { privateKey, publicKey, fingerprint, secretRef };
}
