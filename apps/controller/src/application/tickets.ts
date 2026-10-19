import { createHash, randomUUID } from "node:crypto";
import {
  AcquireRequestSchema,
  AcceptedAcquireRequestSchema,
  type AcceptedAcquireRequest,
  type AcquireRequest,
  type TerminalReason,
} from "@hitchlet/contracts";
import { normalizeAcquireRequest } from "../domain/admission.js";
import {
  leaseDeadline,
  terminalReasonFor,
  type TicketPhase,
} from "../domain/ticket.js";
import { StorageError, type Storage } from "../storage/index.js";
import { SQLiteTicketStore } from "../storage/ticket-store.js";

type Row = Record<string, string | number | bigint | null>;
export interface TicketServiceOptions {
  readonly storage: Storage;
  readonly now?: () => number;
  readonly id?: () => string;
  readonly queueTimeoutSeconds?: number;
  readonly provisioningTimeoutSeconds?: number;
}
export interface AcquireResult {
  readonly ticketId: string;
  readonly phase: "queued";
  readonly replayed: boolean;
}

/** SQLite-backed admission, deterministic v1 reservation, and one-time contract binding. */
export class TicketService {
  private readonly now: () => number;
  private readonly store: SQLiteTicketStore;
  private readonly id: () => string;
  constructor(private readonly options: TicketServiceOptions) {
    this.now = options.now ?? Date.now;
    this.store = new SQLiteTicketStore(options.storage);
    this.id = options.id ?? randomUUID;
  }

  async acquire(
    consumerId: string,
    key: string,
    input: unknown,
  ): Promise<AcquireResult> {
    if (!key || key.length > 200)
      throw new RangeError("Invalid idempotency key");
    const parsed = AcquireRequestSchema.parse(input);
    const request = parsed as unknown as AcquireRequest;
    if ((request.resources.accelerators?.length ?? 0) > 0)
      throw new Error("Accelerator requests are not supported");
    const canonical = stable(request);
    const hash = digest(canonical);
    const existing = await this.store.idempotency(consumerId, key);
    if (existing) return this.replay(existing, hash);

    const consumer = await this.store.consumer(consumerId);
    if (!consumer || consumer.status !== "active")
      throw new Error("Consumer is not active");
    const auth = object(
      parseJson(consumer.authorization_json, "consumer authorization"),
    );
    const quota = object(parseJson(consumer.quota_json, "consumer quota"));
    const maxResources = object(quota.maxResources);
    for (const key of ["cpuMillis", "memoryMiB", "scratchMiB"] as const)
      positiveInteger(maxResources[key], `maxResources.${key}`);
    const image = request.image;
    let versionId: string;
    if ("versionId" in image) versionId = image.versionId;
    else {
      if (!permits(auth.imageIds, image.imageId))
        throw new Error("Image is not authorized");
      const alias = await this.store.imageAlias(image.imageId, image.alias);
      if (!alias) throw new Error("Image alias is not published");
      versionId = String(alias.image_version_id);
    }
    const imageRow = await this.store.imageVersion(versionId);
    if (
      !imageRow ||
      imageRow.status !== "published" ||
      imageRow.image_status !== "active" ||
      !permits(auth.imageIds, imageRow.image_id) ||
      (imageRow.owner_consumer_id && imageRow.owner_consumer_id !== consumerId)
    )
      throw new Error("Image version is unavailable or unauthorized");
    const networkId = request.networkProfileId;
    if (!permits(auth.networkProfileIds, networkId))
      throw new Error("Network profile is not authorized");
    const network = await this.store.networkRevision(networkId);
    if (!network?.id) throw new Error("Network profile is unavailable");
    const storageRows: {
      profileId: string;
      revisionId: string;
      path: string;
      mount: string;
      mode: string;
      root: string;
      protocol: string;
      secretRef: string | null;
    }[] = [];
    for (const item of request.storage ?? []) {
      if (!permits(auth.storageProfileIds, item.storageProfileId))
        throw new Error("Storage profile is not authorized");
      const p = await this.store.storageRevision(item.storageProfileId);
      if (!p?.current_revision_id || typeof p.config_json !== "string")
        throw new Error("Storage profile is unavailable");
      const config = object(
        parseJson(p.config_json, "storage revision config"),
      );
      const root = typeof config.sourceRef === "string" ? config.sourceRef : "";
      const allowedModes = stringList(config.allowedModes);
      const allowedSubpaths = stringList(config.allowedSubpaths);
      if (
        !root ||
        !allowedModes.includes(item.mode) ||
        !safeSubpath(item.authorizedSubpath) ||
        !allowedSubpaths.some(
          (prefix) =>
            item.authorizedSubpath === prefix ||
            item.authorizedSubpath.startsWith(`${prefix.replace(/\/$/, "")}/`),
        )
      )
        throw new Error(
          "Storage request exceeds the frozen profile authorization",
        );
      storageRows.push({
        profileId: item.storageProfileId,
        revisionId: String(p.current_revision_id),
        path: item.authorizedSubpath,
        mount: item.mountPath,
        mode: item.mode,
        root,
        protocol: String(p.kind),
        secretRef:
          typeof p.secret_version_ref === "string"
            ? p.secret_version_ref
            : null,
      });
    }
    const maxQueued = nonNegativeInteger(
      quota.maxQueuedTickets,
      "maxQueuedTickets",
    );
    const consumerVersion = positiveInteger(
      Number(consumer.version),
      "consumer.version",
    );
    const maxTtl = positiveInteger(
      quota.maxLeaseTtlSeconds,
      "maxLeaseTtlSeconds",
    );
    const nodeScope =
      auth.nodeIds === "all" ? undefined : list(auth.nodeIds, []);
    if (nodeScope && !nodeScope.length)
      throw new Error("Consumer has no authorized nodes");
    const directory = await this.store.authorizedDirectory(
      versionId,
      nodeScope,
    );
    const authorizedNodes = [...new Set(directory.map((r) => String(r.id)))];
    const authorizedMachines = [
      ...new Set(directory.map((r) => String(r.machine_id))),
    ];
    const authorizedSites = [
      ...new Set(directory.map((r) => String(r.site_id))),
    ];
    const authorizedProviders = [
      ...new Set(directory.map((r) => String(r.backend_kind))),
    ];
    const authorizedArchitectures = [
      ...new Set(directory.map((r) => String(r.architecture))),
    ];
    if (!authorizedNodes.length)
      throw new Error("No authorized node can run this image version");
    const explicitPolicy =
      request.lease?.expiryPolicyId ??
      (typeof quota.defaultExpiryPolicyId === "string"
        ? quota.defaultExpiryPolicyId
        : undefined);
    const lifecycle = await this.store.lifecyclePolicy(explicitPolicy);
    if (!lifecycle || typeof lifecycle.id !== "string")
      throw new Error("No lifecycle expiry policy is configured");
    const now = this.now();
    const accepted = normalizeAcquireRequest(request, {
      resolvedImageVersionId: versionId,
      authorizedArchitectures: authorizedArchitectures as ("amd64" | "arm64")[],
      authorizedProviders: authorizedProviders as (
        | "portainer"
        | "hyperv"
        | "tart"
      )[],
      authorizedSiteIds: authorizedSites,
      authorizedMachineIds: authorizedMachines,
      authorizedNodeIds: authorizedNodes,
      resourceMaximums: {
        cpuMillis: Number(maxResources.cpuMillis),
        memoryMiB: Number(maxResources.memoryMiB),
        scratchMiB: Number(maxResources.scratchMiB),
      },
      maximumTtlSeconds: maxTtl,
      maximumLifetimeSeconds: positiveInteger(
        quota.maxLifetimeSeconds,
        "maxLifetimeSeconds",
      ),
      queueTimeoutSeconds: this.options.queueTimeoutSeconds ?? 1800,
      provisioningTimeoutSeconds:
        this.options.provisioningTimeoutSeconds ?? 1200,
      defaultExpiryPolicyId: String(lifecycle.id),
    });
    const contract = AcceptedAcquireRequestSchema.parse({
      ...accepted,
      storage: request.storage ?? [],
    });
    const deny = await this.store.networkDenyBaseline();
    if (!deny?.id)
      throw new Error("No platform network deny baseline is configured");
    const networkPolicy = object(
      parseJson(network.policy_json, "network policy"),
    );
    const allowedEgress = parseDestinations(networkPolicy.allowedEgress);
    const allowedIngressSourceCidrs = stringListRequired(
      networkPolicy.allowedIngressSourceCidrs,
      "network allowed ingress source CIDRs",
    );
    if (
      networkPolicy.ipv6 !== "disabled" &&
      networkPolicy.ipv6 !== "verified_equivalent"
    )
      throw new Error("Invalid network IPv6 policy");
    const frozen = {
      selectionHash: digest(
        stable({
          accepted: contract,
          networkProfileRevisionId: network.id,
          storage: storageRows.map((s) => s.revisionId),
        }),
      ),
      acceptedAt: new Date(now).toISOString(),
      storage: storageRows.map((s) => ({
        grantId: this.id(),
        grantRevision: 1,
        storageProfileRevisionId: s.revisionId,
        protocol: s.protocol,
        authorizedSubpath: s.path,
        mountPath: s.mount,
        mode: s.mode,
        approvedSourceRef: s.root,
        secretVersionRef: s.secretRef,
      })),
      network: {
        grantId: this.id(),
        networkProfileRevisionId: String(network.id),
        platformDenyRevisionId: String(deny.id),
        mode: "isolated_bridge",
        allowedEgress,
        allowedIngressSourceCidrs,
        managementDenyRules: parseDenyRules(deny.management_deny_rules_json),
        ipv6: networkPolicy.ipv6,
        enforcement: "docker_iptables",
        verificationRequired: true,
      },
    };
    const ticketId = this.id();
    try {
      await this.store.createQueuedTicket({
        ticketId,
        consumerId,
        versionId,
        networkRevisionId: String(network.id),
        networkProfileId: request.networkProfileId,
        denyRevisionId: String(deny.id),
        acceptedJson: stable(contract),
        requestHash: hash,
        frozenJson: stable(frozen),
        cpuMillis: contract.resources.request.cpuMillis,
        memoryMiB: contract.resources.request.memoryMiB,
        scratchMiB: contract.resources.request.scratchMiB,
        clientRef: contract.clientRef ?? null,
        now,
        queueDeadline: now + contract.lease.queueTimeoutSeconds * 1000,
        quotaJson: String(consumer.quota_json),
        consumerVersion,
        maxQueued,
        storageRows,
        storageGrantIds: storageRows.map(() => this.id()),
        key,
      });
      return { ticketId, phase: "queued", replayed: false };
    } catch (error) {
      const won = await this.store.idempotency(consumerId, key);
      if (won) return this.replay(won, hash);
      throw error;
    }
  }

  async reserveNext(): Promise<{
    ticketId: string;
    allocationId: string;
    nodeId: string;
  } | null> {
    const now = this.now();
    const tickets = await this.store.queuedTickets(now);
    for (const ticket of tickets) {
      const contract = AcceptedAcquireRequestSchema.parse(
        parseJson(ticket.request_json, "accepted request"),
      );
      const frozen = object(
        parseJson(ticket.accepted_contract_json, "frozen profile selection"),
      );
      const allowedNodes = contract.allowedNodeIds ?? [];
      const allowedMachines = contract.allowedMachineIds ?? [];
      const allowedArchitectures = contract.allowedArchitectures ?? [];
      const consumerId = String(ticket.consumer_id);
      const imageVersion = String(ticket.image_version_id);
      const candidates = await this.store.eligibleCandidates({
        imageVersion,
        providers: contract.allowedProviders,
        siteIds: contract.siteIds,
        nodeIds: allowedNodes,
        machineIds: allowedMachines,
        kind: contract.kind,
        architectures: allowedArchitectures,
      });
      for (const candidate of candidates) {
        const caps = object(
          parseJson(candidate.capabilities_json, "node capabilities"),
        );
        const labels = object(
          parseJson(candidate.machine_labels, "machine labels"),
        );
        if (
          !contract.requiredLabels ||
          Object.entries(contract.requiredLabels).some(
            ([k, v]) => labels[k] !== v,
          )
        )
          continue;
        if (
          !stringList(caps.resourceKinds).includes(contract.kind) ||
          !stringList(caps.architectures).includes(
            String(candidate.architecture),
          ) ||
          !stringList(caps.guestOs).includes(String(candidate.guest_os))
        )
          continue;
        const capabilityExpiry =
          typeof caps.expiresAt === "string"
            ? Date.parse(caps.expiresAt)
            : Number.NaN;
        if (!Number.isFinite(capabilityExpiry) || capabilityExpiry <= now)
          continue;
        if (
          caps.cpuHardLimit !== "verified" ||
          caps.memoryHardLimit !== "verified" ||
          caps.networkPolicyEnforcement !== "verified"
        )
          continue;
        if (
          contract.resources.scratchEnforcement === "required" &&
          caps.scratchHardLimit !== "verified"
        )
          continue;
        if (
          Number(candidate.minimum_cpu_millis) >
            contract.resources.request.cpuMillis ||
          Number(candidate.minimum_memory_mib) >
            contract.resources.request.memoryMiB ||
          Number(candidate.minimum_scratch_mib) >
            contract.resources.request.scratchMiB
        )
          continue;
        const artifactRequirements = object(
          parseJson(candidate.requirements_json, "artifact requirements"),
        );
        if (
          stringListOptional(
            artifactRequirements.requiredCapabilities,
            "artifact required capabilities",
          ).some((name) => caps[name] !== "verified")
        )
          continue;
        const accessRecipe = object(
          parseJson(candidate.access_recipe_json, "artifact access recipe"),
        );
        if (
          !stringListRequired(
            accessRecipe.accessProtocols,
            "artifact protocols",
          ).includes(contract.access.protocol)
        )
          continue;
        if (
          !stringListRequired(
            caps.supportedAccess,
            "node access protocols",
          ).includes(contract.access.protocol)
        )
          continue;
        if (
          contract.requiredCapabilities.some((cap) => caps[cap] !== "verified")
        )
          continue;
        if (
          !stringList(caps.verifiedNetworkProfileRevisionIds).includes(
            String(ticket.network_profile_revision_id),
          )
        )
          continue;
        if (candidate.observed_power !== "on" && !canSafelyWake(candidate, now))
          continue;
        const frozenStorage = Array.isArray(frozen.storage)
          ? frozen.storage.map((item) => object(item))
          : [];
        if (
          frozenStorage.some(
            (item) =>
              !stringList(caps.verifiedStorageProfileRevisionIds).includes(
                String(item.storageProfileRevisionId),
              ),
          )
        )
          continue;
        if (Number(candidate.observed_at_ms ?? 0) + 120_000 < now) continue;
        const poolId = String(candidate.pool_id);
        const poolVersion = candidate.pool_version;
        const allocId = this.id();
        const claimId = this.id();
        const generation = 1;
        const quotaRow = await this.store.consumerQuota(consumerId);
        if (
          typeof quotaRow?.quota_json !== "string" ||
          quotaRow.status !== "active"
        )
          continue;
        const quota = object(parseJson(quotaRow.quota_json, "consumer quota"));
        const limits = object(quota.maxResources);
        const maxActive = nonNegativeInteger(
          quota.maxActiveTickets,
          "maxActiveTickets",
        );
        const resourceLimits = {
          cpuMillis: positiveInteger(
            limits.cpuMillis,
            "maxResources.cpuMillis",
          ),
          memoryMiB: positiveInteger(
            limits.memoryMiB,
            "maxResources.memoryMiB",
          ),
          scratchMiB: positiveInteger(
            limits.scratchMiB,
            "maxResources.scratchMiB",
          ),
        };
        try {
          await this.store.reserve({
            allocationId: allocId,
            claimId,
            leaseId: this.id(),
            ticketId: String(ticket.id),
            consumerId,
            consumerVersion: Number(quotaRow.version),
            quotaJson: quotaRow.quota_json,
            nodeId: String(candidate.node_id),
            nodeVersion: Number(candidate.node_version),
            machineId: String(candidate.machine_id),
            machineVersion: Number(candidate.machine_version),
            runtimeIdentityId: String(candidate.runtime_identity_id),
            artifactId: String(candidate.artifact_id),
            poolId,
            poolVersion: Number(poolVersion),
            ticketVersion: Number(ticket.version),
            generation,
            resourceContractJson: stable(contract.resources),
            requested: contract.resources.request,
            consumerLimits: { maxActiveTickets: maxActive, ...resourceLimits },
            now,
            deadline: leaseDeadline(
              now,
              contract.lease.provisioningTimeoutSeconds,
            ),
          });
          return {
            ticketId: String(ticket.id),
            allocationId: allocId,
            nodeId: String(candidate.node_id),
          };
        } catch (error) {
          if (
            !(error instanceof StorageError) ||
            error.code !== "STORAGE_CAS_FAILED"
          )
            throw error;
        }
      }
      await this.store.setSchedulingReason(
        String(ticket.id),
        Number(ticket.version),
        now,
      );
    }
    return null;
  }

  async bindProvisionContract(input: {
    allocationId: string;
    ticketVersion: number;
    nodeVersion: number;
    generation: number;
    controlVersion: number;
    contractId: string;
    selectionHash: string;
  }): Promise<void> {
    const now = this.now();
    await this.store.bind({ ...input, now });
  }

  async cancel(
    ticketId: string,
    consumerId: string,
    reason: TerminalReason = "consumer_cancel",
  ): Promise<void> {
    if (!reason.trim())
      throw new RangeError("Cancellation reason must not be empty");
    const now = this.now();
    const ticket = await this.store.cancelTarget(ticketId, consumerId);
    if (!ticket) throw new Error("Ticket is unavailable");
    const phase = String(ticket.phase) as TicketPhase;
    const terminal = terminalReasonFor(phase, reason);
    if (terminal.phase === "released") {
      await this.store.cancelQueued({
        ticketId,
        consumerId,
        version: Number(ticket.version),
        now,
        reason,
      });
      return;
    }
    await this.store.cancelAllocated({
      ticketId,
      consumerId,
      phase,
      version: Number(ticket.version),
      now,
      reason,
    });
  }

  private replay(row: Row, hash: string): AcquireResult {
    if (row.request_hash !== hash)
      throw new Error("Idempotency key was reused with a different request");
    if (typeof row.ticket_id !== "string")
      throw new Error("Idempotent response is incomplete");
    return { ticketId: row.ticket_id, phase: "queued", replayed: true };
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Value is not JSON serializable");
  return result;
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function parseDestinations(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error("Invalid network allowed egress list");
  return value.map((entry) => {
    const rule = object(entry);
    if (
      typeof rule.cidr !== "string" ||
      !rule.cidr ||
      (rule.protocol !== "tcp" && rule.protocol !== "udp") ||
      !Array.isArray(rule.ports) ||
      rule.ports.length === 0 ||
      !rule.ports.every(
        (port) =>
          typeof port === "number" &&
          Number.isInteger(port) &&
          port >= 1 &&
          port <= 65535,
      )
    )
      throw new Error("Invalid network destination");
    return rule;
  });
}
function parseDenyRules(value: unknown): unknown[] {
  const parsed = parseJson(value, "management deny rules");
  if (!Array.isArray(parsed)) throw new Error("Invalid management deny rules");
  return parsed.map((entry) => {
    const rule = object(entry);
    if (
      typeof rule.cidr !== "string" ||
      !rule.cidr ||
      !["any", "tcp", "udp"].includes(String(rule.protocol))
    )
      throw new Error("Invalid management deny rule");
    if (
      rule.protocol === "any"
        ? rule.ports !== "any"
        : rule.ports !== "any" &&
          (!Array.isArray(rule.ports) ||
            rule.ports.length === 0 ||
            !rule.ports.every(
              (port) =>
                typeof port === "number" &&
                Number.isInteger(port) &&
                port >= 1 &&
                port <= 65535,
            ))
    )
      throw new Error("Invalid management deny rule ports");
    return rule;
  });
}
function stringListRequired(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
function stringListOptional(value: unknown, label: string): string[] {
  return value === undefined ? [] : stringListRequired(value, label);
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : [];
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid consumer quota ${label}`);
  return value;
}
function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid consumer quota ${label}`);
  return value;
}
function permits(scope: unknown, id: unknown): boolean {
  return scope === "all" || (Array.isArray(scope) && scope.includes(id));
}
function list<T extends string>(scope: unknown, fallback: readonly T[]): T[] {
  return Array.isArray(scope) ? (scope as T[]) : [...fallback];
}
function safeSubpath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split(/[\\/]/).some((p) => p === ".." || p === ".")
  );
}

function canSafelyWake(candidate: Row, now: number): boolean {
  const machineUpdatedAt = safeInteger(candidate.machine_updated_at_ms);
  if (
    candidate.desired_power === "off" ||
    machineUpdatedAt === undefined ||
    machineUpdatedAt + 120_000 <= now
  )
    return false;
  if (
    typeof candidate.machine_capabilities !== "string" ||
    typeof candidate.power_policy_json !== "string"
  )
    return false;
  const capabilities = object(
    parseJson(candidate.machine_capabilities, "machine power capabilities"),
  );
  const policy = object(
    parseJson(candidate.power_policy_json, "machine power policy"),
  );
  if (
    policy.enabled !== true ||
    policy.dryRun !== false ||
    policy.wakeOnDemand !== true ||
    policy.permitForcedPhysicalPowerOff !== false ||
    typeof policy.maximumWakeAttempts !== "number" ||
    !Number.isSafeInteger(policy.maximumWakeAttempts) ||
    (safeInteger(candidate.wake_attempt_count) ?? policy.maximumWakeAttempts) >=
      policy.maximumWakeAttempts ||
    typeof capabilities.wakeRouteRef !== "string" ||
    !capabilities.wakeRouteRef ||
    !stringList(capabilities.verificationReportIds).length
  )
    return false;
  if (candidate.observed_power === "sleeping")
    return capabilities.wakeFromSleep === "verified";
  if (
    candidate.observed_power !== "off" &&
    candidate.observed_power !== "unknown"
  )
    return false;
  if (
    capabilities.coldBoot !== "verified" ||
    candidate.power_lifecycle === "off_confirmed"
  )
    return (
      capabilities.coldBoot === "verified" &&
      candidate.power_lifecycle === "off_confirmed" &&
      candidate.observed_power === "off" &&
      typeof candidate.out_of_band_evidence_id === "string" &&
      candidate.out_of_band_evidence_id.length > 0
    );
  return (
    candidate.observed_power === "unknown" &&
    candidate.power_lifecycle === "off_expected" &&
    capabilities.wolWhilePossiblyOn === "verified" &&
    safeInteger(candidate.shutdown_evidence) === 1 &&
    typeof candidate.power_cycle_id === "string" &&
    typeof candidate.power_transition_id === "string" &&
    typeof candidate.shutdown_operation_id === "string" &&
    typeof candidate.accepted_shutdown_receipt_id === "string" &&
    safeInteger(candidate.shutdown_accepted_at_ms) !== undefined &&
    (safeInteger(candidate.wake_not_before_ms) ?? Number.POSITIVE_INFINITY) <=
      now &&
    (safeInteger(candidate.power_transition_deadline_ms) ?? 0) > now
  );
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === "bigint")
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : undefined;
  return undefined;
}
