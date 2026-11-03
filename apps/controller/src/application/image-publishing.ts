import type { PortainerProbe } from "../providers/port.js";
import { ApplicationError } from "./errors.js";
import type { Storage } from "../storage/index.js";
import { SQLiteImagePublicationStore } from "../storage/image-publication-store.js";
import type { TartFactsForRevision } from "../providers/runtime-credentials.js";
import { tartTemplateProofMatches } from "./tart-facts.js";

export class ImagePublishingService {
  private readonly store: SQLiteImagePublicationStore;
  constructor(
    db: Storage,
    private readonly probe: PortainerProbe,
    now = Date.now,
    private readonly readSecret?: (versionRef: string) => Promise<string>,
    private readonly tartFactsForRevision?: TartFactsForRevision,
  ) {
    this.store = new SQLiteImagePublicationStore(db, now);
  }
  async publish(versionId: string, expectedEntityVersion: number) {
    const result = await this.store.publish(
      versionId,
      expectedEntityVersion,
      async (target) => {
        if (target.backendKind === "tart") {
          if (!this.tartFactsForRevision) return false;
          try {
            const facts = await this.tartFactsForRevision({
              installationId: target.installationId,
              runtimeIdentityId: target.runtimeIdentityId,
              connectionRevisionId: target.connectionRevisionId,
              nodeId: target.nodeId,
              config: target.config,
            });
            return tartTemplateProofMatches(facts, {
              nativeRuntimeNamespaceId: target.nativeRuntimeNamespaceId,
              artifactRef: target.artifactRef,
              digest: target.digest,
              architecture: target.architecture,
              guestOs: target.guestOs,
            });
          } catch {
            return false;
          }
        }
        // Other native backends require their own live template/runtime proof.
        // In particular, a Hyper-V draft is not a Docker Engine to probe.
        if (target.backendKind !== "portainer") return false;
        if (!this.readSecret) return false;
        try {
          const live = await this.probe({
            endpointUrl: target.endpointUrl,
            environmentId: target.environmentId,
            apiKey: await this.readSecret(target.secretVersionRef),
          });
          return (
            [
              "engineId",
              "dockerVersion",
              "portainerVersion",
              "os",
              "architecture",
              "apiVersion",
              "minimumApiVersion",
            ] as const
          ).every((key) => live[key] === target.expected[key]);
        } catch {
          return false;
        }
      },
    );
    if (!result) throw new ApplicationError("conflict");
    return result;
  }
  moveAlias(
    imageId: string,
    alias: string,
    versionId: string,
    expectedVersion: number,
  ) {
    return this.store.moveAlias(imageId, alias, versionId, expectedVersion);
  }
}
