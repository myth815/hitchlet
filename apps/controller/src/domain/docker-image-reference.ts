/** Portainer's Docker proxy requires repository separators to remain literal slashes. */
export function dockerImageReferencePath(ref: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*@sha256:[a-f0-9]{64}$/.test(
      ref,
    )
  )
    throw new RangeError(
      "Docker image reference must be a pinned OCI repository digest",
    );
  return ref.split("/").map(encodeURIComponent).join("/");
}
