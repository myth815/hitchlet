import { createHash } from "node:crypto";
import type { HyperVGuestBootstrapRequest } from "@hitchlet/contracts/internal";
/** Template-specific channel must bind the exact native VM and implement read-before-apply.
 * No production Windows/Linux channel is selected by this interface. */
export type HyperVGuestBootstrapPort = Readonly<{
  inspect(
    request: HyperVGuestBootstrapRequest,
    deadlineMs: number,
  ): Promise<unknown>;
  apply(
    request: HyperVGuestBootstrapRequest,
    deadlineMs: number,
  ): Promise<unknown>;
}>;
export function hyperVPublicKeyFingerprint(key: string): string {
  const encoded = key.trim().split(/ +/)[1] ?? "";
  const blob = Buffer.from(encoded, "base64");
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString("ascii") !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32 ||
    blob.toString("base64") !== encoded
  )
    throw Error("Hyper-V bootstrap public key is invalid");
  return (
    "SHA256:" +
    createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")
  );
}
