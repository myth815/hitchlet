import type { HyperVRuntimeFacts } from "@hitchlet/contracts/internal";
export function hyperVTemplateProofMatches(
  facts: HyperVRuntimeFacts,
  expected: {
    nativeRuntimeNamespaceId: string;
    artifactRef: string;
    digest: string;
    architecture: string;
    guestOs: string;
  },
) {
  if (
    !facts.available ||
    facts.hostOS !== "windows" ||
    facts.hostArchitecture !== "AMD64" ||
    facts.nativeRuntimeNamespaceId !== expected.nativeRuntimeNamespaceId ||
    expected.architecture !== "amd64"
  )
    return false;
  const proofs = facts.templates.filter((p) => p.name === expected.artifactRef);
  return (
    proofs.length === 1 &&
    proofs[0]!.proofKind === "sealed_export_bundle_v1" &&
    proofs[0]!.artifactDigest === expected.digest &&
    proofs[0]!.template.guestOs === expected.guestOs &&
    proofs[0]!.template.architecture === "amd64"
  );
}
