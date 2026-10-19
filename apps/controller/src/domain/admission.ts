import type {
  Architecture,
  AcceptedAcquireRequest,
  AcquireRequest,
  ProviderKind,
  ResourceContract,
  ResourceKind,
} from "@hitchlet/contracts";

export interface AcquireNormalizationContext {
  /** Alias resolution and published-version authorization happen before normalization. */
  readonly resolvedImageVersionId: string;
  /** Exhaustive authorized candidate sets; an empty set means no eligible candidates. */
  readonly authorizedArchitectures: readonly Architecture[];
  readonly authorizedProviders: readonly ProviderKind[];
  readonly authorizedSiteIds: readonly string[];
  readonly authorizedMachineIds: readonly string[];
  readonly authorizedNodeIds: readonly string[];
  readonly resourceMaximums: {
    readonly cpuMillis: number;
    readonly memoryMiB: number;
    readonly scratchMiB: number;
  };
  readonly maximumTtlSeconds: number;
  readonly maximumLifetimeSeconds: number;
  readonly queueTimeoutSeconds: number;
  readonly provisioningTimeoutSeconds: number;
  readonly defaultExpiryPolicyId: string;
}

/** Pure normalization after schema validation and authorization lookup; does not resolve aliases. */
export function normalizeAcquireRequest(
  request: AcquireRequest,
  ctx: AcquireNormalizationContext,
): AcceptedAcquireRequest {
  const kind: ResourceKind = request.kind ?? "container";
  const architectures = intersection(
    request.allowedArchitectures ?? ctx.authorizedArchitectures,
    ctx.authorizedArchitectures,
  );
  const providers = intersection(
    request.allowedProviders ?? ctx.authorizedProviders,
    ctx.authorizedProviders,
  );
  const sites = request.siteIds?.length
    ? intersection(request.siteIds, ctx.authorizedSiteIds)
    : [...ctx.authorizedSiteIds];
  const machines = request.allowedMachineIds
    ? intersection(request.allowedMachineIds, ctx.authorizedMachineIds)
    : [...ctx.authorizedMachineIds];
  const nodes = request.allowedNodeIds
    ? intersection(request.allowedNodeIds, ctx.authorizedNodeIds)
    : [...ctx.authorizedNodeIds];
  if (
    !architectures.length ||
    !providers.length ||
    !sites.length ||
    !machines.length ||
    !nodes.length
  )
    throw new RangeError(
      "Requested placement scope has no authorized candidates",
    );
  const source = request.resources;
  for (const key of ["cpuMillis", "memoryMiB", "scratchMiB"] as const) {
    if (source[key] > ctx.resourceMaximums[key])
      throw new RangeError(`${key} exceeds the authorized maximum`);
  }
  const lease = request.lease;
  const bounded = (
    explicit: number | undefined,
    fallback: number,
    maximum: number,
    field: string,
  ): number => {
    if (explicit !== undefined && explicit > maximum)
      throw new RangeError(`${field} exceeds the authorized maximum`);
    return Math.min(explicit ?? fallback, maximum);
  };
  const maximumLifetimeSeconds = bounded(
    lease?.maximumLifetimeSeconds,
    86400,
    ctx.maximumLifetimeSeconds,
    "maximumLifetimeSeconds",
  );
  const maximumTtlSeconds = Math.min(
    ctx.maximumTtlSeconds,
    maximumLifetimeSeconds,
  );
  const resources: ResourceContract = {
    request: {
      cpuMillis: source.cpuMillis,
      memoryMiB: source.memoryMiB,
      scratchMiB: source.scratchMiB,
    },
    limit: {
      cpuMillis: source.cpuMillis,
      memoryMiB: source.memoryMiB,
      scratchMiB: source.scratchMiB,
    },
    scratchEnforcement: source.scratchEnforcement ?? "best_effort",
    isolation:
      source.isolation ??
      (kind === "container" ? "shared_kernel" : "virtual_machine"),
    accelerators: (source.accelerators ?? []).map((item) => ({
      ...item,
      requiredFeatures: [...item.requiredFeatures],
    })),
  };
  const acceptedLease = {
    maximumLifetimeSeconds,
    requestedSeconds: bounded(
      lease?.requestedSeconds,
      900,
      maximumTtlSeconds,
      "requestedSeconds",
    ),
    queueTimeoutSeconds: bounded(
      lease?.queueTimeoutSeconds,
      1800,
      ctx.queueTimeoutSeconds,
      "queueTimeoutSeconds",
    ),
    provisioningTimeoutSeconds: bounded(
      lease?.provisioningTimeoutSeconds,
      1200,
      ctx.provisioningTimeoutSeconds,
      "provisioningTimeoutSeconds",
    ),
    expiryPolicyId: lease?.expiryPolicyId ?? ctx.defaultExpiryPolicyId,
    maximumTtlSeconds,
  };
  return {
    image: { versionId: ctx.resolvedImageVersionId },
    resources,
    networkProfileId: request.networkProfileId,
    kind,
    allowedArchitectures: nonEmpty(architectures),
    allowedProviders: nonEmpty(providers),
    locality: request.locality ?? "local_only",
    siteIds: sites,
    allowedMachineIds: nonEmpty(machines),
    allowedNodeIds: nonEmpty(nodes),
    requiredLabels: { ...(request.requiredLabels ?? {}) },
    requiredCapabilities: [...(request.requiredCapabilities ?? [])],
    storage: (request.storage ?? []).map((item) => ({ ...item })),
    access:
      request.access === undefined
        ? { protocol: "ssh" }
        : { ...request.access },
    lease: acceptedLease,
    labels: { ...(request.labels ?? {}) },
    ...(request.clientRef === undefined
      ? {}
      : { clientRef: request.clientRef }),
  };
}

function nonEmpty<T>(items: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = items;
  if (first === undefined)
    throw new RangeError("Authorized candidate set is empty");
  return [first, ...rest];
}

function intersection<T>(requested: readonly T[], allowed: readonly T[]): T[] {
  const permitted = new Set(allowed);
  return [...new Set(requested.filter((value) => permitted.has(value)))];
}
