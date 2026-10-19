import { createHash } from "node:crypto";
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
    const privatePem = sshUtils.generateKeyPairSync("ed25519").private;
    const ref = await this.secrets.put(privatePem);
    const result = await this.db.run(
      "UPDATE allocations SET access_secret_ref=?,version=version+1,updated_at_ms=? WHERE id=? AND access_secret_ref IS NULL",
      [ref, this.now(), allocationId],
    );
    if (result.changes === 1n) return material(privatePem, ref);
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
