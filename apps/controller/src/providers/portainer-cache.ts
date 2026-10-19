import { dockerImageReferencePath } from "../domain/docker-image-reference.js";
import type { ClaimedImageCacheOperation } from "../storage/image-cache-store.js";
import {
  ImageCachePortError,
  type ImageCacheExecutionPort,
  type LocalImageInspection,
} from "./image-cache-port.js";

export type PortainerCacheRuntime = Readonly<{
  endpointUrl: string;
  environmentId: string;
  apiKey: string;
  engineId: string;
}>;

export type {
  ImageCacheExecutionPort,
  LocalImageInspection,
} from "./image-cache-port.js";

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ImageCachePortError("provider_error", "Invalid Docker response");
  return value as Json;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function notFound(error: unknown): boolean {
  return (
    error instanceof ImageCachePortError && error.message === "__not_found__"
  );
}

/** Portainer adapter deliberately exposes only fixed image-cache operations. */
export class PortainerImageCacheProvider implements ImageCacheExecutionPort {
  constructor(
    private readonly resolveRuntime: (
      op: ClaimedImageCacheOperation,
    ) => Promise<PortainerCacheRuntime>,
    private readonly timeoutMs = 15_000,
  ) {}

  async inspectLocal(
    op: ClaimedImageCacheOperation,
  ): Promise<LocalImageInspection> {
    const runtime = await this.runtime(op);
    await this.assertEngine(runtime, op.nativeEngineId);
    let local: Json;
    try {
      local = record(
        await this.request(
          runtime,
          "GET",
          `images/${dockerImageReferencePath(op.artifactRef)}/json`,
          undefined,
          [404],
        ),
      );
    } catch (error) {
      if (notFound(error)) return { presence: "absent" };
      throw error;
    }
    const imageId = string(local.Id);
    const repoDigests = Array.isArray(local.RepoDigests)
      ? local.RepoDigests
      : [];
    if (
      !imageId ||
      !repoDigests.includes(op.artifactRef) ||
      local.Architecture !== op.architecture ||
      local.Os !== "linux" ||
      typeof local.Size !== "number" ||
      !Number.isSafeInteger(local.Size) ||
      local.Size < 0
    )
      throw new ImageCachePortError(
        "artifact_verification_failed",
        "Local immutable image digest, platform, or size failed verification",
      );
    return {
      presence: "present",
      localRef: op.digest,
      imageId,
      sizeMiB: Math.ceil(local.Size / (1024 * 1024)),
      architecture: op.architecture,
      os: "linux",
    };
  }

  async verifyRegistryManifest(op: ClaimedImageCacheOperation): Promise<void> {
    if (!op.artifactRef.endsWith(`@${op.digest}`))
      throw new ImageCachePortError(
        "artifact_verification_failed",
        "Artifact reference is not digest-pinned",
      );
    const runtime = await this.runtime(op);
    await this.assertEngine(runtime, op.nativeEngineId);
    const value = record(
      await this.request(
        runtime,
        "GET",
        `distribution/${dockerImageReferencePath(op.artifactRef)}/json`,
      ),
    );
    const descriptor = record(value.Descriptor);
    const platforms = Array.isArray(value.Platforms) ? value.Platforms : [];
    if (
      descriptor.digest !== op.digest ||
      typeof descriptor.mediaType !== "string" ||
      !descriptor.mediaType.includes("manifest") ||
      platforms.length === 0 ||
      !platforms.some((item) => {
        const platform = record(item);
        return (
          platform.os === "linux" && platform.architecture === op.architecture
        );
      })
    )
      throw new ImageCachePortError(
        "artifact_verification_failed",
        "Registry did not prove the exact digest and Linux platform",
      );
  }

  async pullPinned(op: ClaimedImageCacheOperation): Promise<void> {
    const runtime = await this.runtime(op);
    await this.assertEngine(runtime, op.nativeEngineId);
    const url = this.url(
      runtime,
      `images/create?fromImage=${encodeURIComponent(op.artifactRef)}`,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "X-API-Key": runtime.apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      throw new ImageCachePortError(
        "engine_unavailable",
        "Pinned image pull outcome is unknown",
      );
    }
    if (!response.ok || !response.body)
      throw new ImageCachePortError(
        "provider_error",
        `Pinned image pull failed (${response.status})`,
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        throw new ImageCachePortError(
          "engine_unavailable",
          "Pinned image pull outcome is unknown",
        );
      }
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Json;
        try {
          event = record(JSON.parse(line));
        } catch {
          throw new ImageCachePortError(
            "provider_error",
            "Docker pull returned malformed progress",
          );
        }
        if (typeof event.error === "string" || event.errorDetail)
          throw new ImageCachePortError(
            "provider_error",
            "Docker rejected the pinned image pull",
          );
      }
    }
    if (pending.trim()) {
      try {
        const event = record(JSON.parse(pending));
        if (typeof event.error === "string" || event.errorDetail)
          throw new ImageCachePortError(
            "provider_error",
            "Docker rejected the pinned image pull",
          );
      } catch (error) {
        if (error instanceof ImageCachePortError) throw error;
        throw new ImageCachePortError(
          "provider_error",
          "Docker pull returned malformed progress",
        );
      }
    }
    await this.assertEngine(runtime, op.nativeEngineId);
  }

  async imageInUse(
    op: ClaimedImageCacheOperation,
    imageId: string,
  ): Promise<boolean> {
    const runtime = await this.runtime(op);
    await this.assertEngine(runtime, op.nativeEngineId);
    const value = await this.request(runtime, "GET", "containers/json?all=1");
    if (!Array.isArray(value))
      throw new ImageCachePortError(
        "provider_error",
        "Incomplete container inventory",
      );
    const containers = value.map((item) => {
      const container = record(item);
      const containerImageId = string(container.ImageID);
      if (!containerImageId)
        throw new ImageCachePortError(
          "provider_error",
          "Incomplete container inventory",
        );
      return containerImageId;
    });
    return containers.includes(imageId);
  }

  async removePinned(op: ClaimedImageCacheOperation): Promise<void> {
    const runtime = await this.runtime(op);
    await this.assertEngine(runtime, op.nativeEngineId);
    try {
      await this.request(
        runtime,
        "DELETE",
        `images/${dockerImageReferencePath(op.artifactRef)}?force=false&noprune=true`,
        undefined,
        [404],
      );
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    await this.assertEngine(runtime, op.nativeEngineId);
  }

  private async runtime(
    op: ClaimedImageCacheOperation,
  ): Promise<PortainerCacheRuntime> {
    try {
      const runtime = await this.resolveRuntime(op);
      const endpoint = new URL(runtime.endpointUrl);
      if (
        endpoint.protocol !== "https:" &&
        !(
          endpoint.protocol === "http:" &&
          ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)
        )
      )
        throw new Error();
      if (
        !runtime.apiKey ||
        runtime.environmentId !== op.providerEndpointId ||
        runtime.engineId !== op.nativeEngineId
      )
        throw new Error();
      return runtime;
    } catch {
      throw new ImageCachePortError(
        "connection_revision_unavailable",
        "Frozen Portainer revision could not be resolved",
      );
    }
  }

  private url(runtime: PortainerCacheRuntime, path: string): URL {
    return new URL(
      `/api/endpoints/${encodeURIComponent(runtime.environmentId)}/docker/${path}`,
      runtime.endpointUrl,
    );
  }

  private async assertEngine(
    runtime: PortainerCacheRuntime,
    expectedId: string,
  ): Promise<void> {
    const info = record(await this.request(runtime, "GET", "info"));
    if (info.ID !== expectedId)
      throw new ImageCachePortError(
        "runtime_identity_mismatch",
        "Portainer endpoint identity changed",
      );
  }

  private async request(
    runtime: PortainerCacheRuntime,
    method: string,
    path: string,
    body?: unknown,
    allowed: readonly number[] = [],
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.url(runtime, path), {
        method,
        headers: {
          "X-API-Key": runtime.apiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ImageCachePortError(
        "engine_unavailable",
        "Portainer image-cache request failed",
      );
    }
    if (response.status === 404 && allowed.includes(404))
      throw new ImageCachePortError("provider_error", "__not_found__");
    if (!response.ok)
      throw new ImageCachePortError(
        "provider_error",
        `Portainer Docker request failed (${response.status})`,
      );
    if (method === "DELETE" && response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new ImageCachePortError(
        "provider_error",
        "Portainer Docker response was invalid",
      );
    }
  }
}
