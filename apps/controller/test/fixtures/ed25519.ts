import { createHash, generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { encodeEd25519OpenSshKey } from "../../src/storage/access-material-store.js";

export function createEd25519Fixture() {
  const privateKey = encodeEd25519OpenSshKey(
    generateKeyPairSync("ed25519").privateKey,
  );
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const publicBlob = parsed.getPublicSSH();
  return {
    privateKey,
    publicKey: `${parsed.type} ${publicBlob.toString("base64")}`,
    publicBlob,
    fingerprint: `SHA256:${createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "")}`,
  };
}
