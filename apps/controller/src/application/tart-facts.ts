import type { TartRuntimeFacts } from "@hitchlet/contracts/internal";

export type TartFactsForRevisionInput = Readonly<{
  installationId: string;
  runtimeIdentityId: string;
  connectionRevisionId: string;
  nodeId: string;
  config: Readonly<Record<string, unknown>>;
}>;

/** Authenticated Runtime Agent facts are provenance, not capability qualification. */
export type TartFactsForRevision = (
  input: TartFactsForRevisionInput,
) => Promise<TartRuntimeFacts>;

export function tartTemplateProofMatches(
  facts: TartRuntimeFacts,
  expected: Readonly<{
    nativeRuntimeNamespaceId: string;
    artifactRef: string;
    digest: string;
    architecture: string;
    guestOs: string;
  }>,
) {
  if (
    facts.nativeRuntimeNamespaceId !== expected.nativeRuntimeNamespaceId ||
    facts.hostOS !== "macos" ||
    facts.hostArch !== "arm64" ||
    expected.architecture !== "arm64" ||
    !["linux", "macos"].includes(expected.guestOs)
  )
    return false;
  const proof = facts.templates.find(
    (item) => item.templateRef.name === expected.artifactRef,
  );
  return (
    proof?.proofKind === "sealed_local_bundle_v1" &&
    proof.artifactDigest === expected.digest &&
    proof.templateRef.source === "local" &&
    proof.templateRef.guestArch === "arm64" &&
    proof.templateRef.guestOS ===
      (expected.guestOs === "macos" ? "darwin" : "linux")
  );
}
