import type { ClaimedImageCacheOperation } from "../storage/image-cache-store.js";

export type LocalImageInspection =
  | Readonly<{ presence: "absent" }>
  | Readonly<{
      presence: "present";
      localRef: string;
      imageId: string;
      sizeMiB: number;
      architecture: string;
      os: string;
    }>;

/** Narrow fixed-action port for the cache worker; it has no generic command payload. */
export interface ImageCacheExecutionPort {
  inspectLocal(op: ClaimedImageCacheOperation): Promise<LocalImageInspection>;
  verifyRegistryManifest(op: ClaimedImageCacheOperation): Promise<void>;
  pullPinned(op: ClaimedImageCacheOperation): Promise<void>;
  imageInUse(op: ClaimedImageCacheOperation, imageId: string): Promise<boolean>;
  removePinned(op: ClaimedImageCacheOperation): Promise<void>;
}

export class ImageCachePortError extends Error {
  constructor(
    readonly code:
      | "runtime_identity_mismatch"
      | "connection_revision_unavailable"
      | "artifact_verification_failed"
      | "engine_unavailable"
      | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "ImageCachePortError";
  }
}
