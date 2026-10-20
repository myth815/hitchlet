import {
  HumanUsePolicySchema,
  type HumanUsePolicy,
} from "@hitchlet/contracts/admin";
import {
  classifyFreshHumanPresence,
  type HostSnapshot,
} from "@hitchlet/contracts/internal";

export type Resources = {
  cpuMillis: number;
  memoryMiB: number;
  scratchMiB: number;
};
export const resourceKeys = ["cpuMillis", "memoryMiB", "scratchMiB"] as const;
export const zeroResources = (): Resources => ({
  cpuMillis: 0,
  memoryMiB: 0,
  scratchMiB: 0,
});
export function addResources(a: Resources, b: Resources): Resources {
  return Object.fromEntries(
    resourceKeys.map((k) => [k, a[k] + b[k]]),
  ) as Resources;
}
export type PoolBudget = {
  id: string;
  parentAllocationId: string | null;
  capacity: Resources;
  reserve: Resources;
};
export type DependencyAllocation = {
  id: string;
  nodeId: string;
  purpose: string;
  desiredState: string;
  observedState: string;
  cleanupStatus: string;
};
export type DependencyClaim = {
  id: string;
  allocationId: string;
  poolId: string;
  state: string;
  resources: Resources;
};
export type AdmissionState = "enabled" | "draining" | "disabled";
export type NodeHealth = "healthy" | "degraded" | "unknown" | "lost";
export type DependencyNode = {
  id: string;
  name: string;
  poolId: string;
  admission: AdmissionState;
  observedHealth: NodeHealth;
  observedAtMs: number | null;
  manualInventory: boolean;
  capabilityExpiresAtMs: number | null;
};
export type MachineAdmissionContext = {
  machineId: string;
  source: string;
  admission: AdmissionState;
  power: string;
  policy: HumanUsePolicy | null;
  policyInvalid?: boolean;
  pools: PoolBudget[];
  allocations: DependencyAllocation[];
  claims: DependencyClaim[];
  nodes: DependencyNode[];
  holds: { id: string; kind: string; reason: string }[];
  observation: {
    snapshot: HostSnapshot;
    receivedAtMs: number;
    authenticated: boolean;
    /** Explicit persisted Agent disablement; expired epoch/boot evidence is only stale. */
    revoked: boolean;
  } | null;
};

/** The M1 exception uses the administrator's frozen static pool, never invented Host evidence. */
export function manualInventoryPolicy(root: PoolBudget): HumanUsePolicy {
  const maximum = Object.fromEntries(
    resourceKeys.map((k) => [
      k,
      Math.max(0, root.capacity[k] - root.reserve[k]),
    ]),
  ) as Resources;
  return HumanUsePolicySchema.parse({
    blockShutdownForAnyInteractiveSession: true,
    blockShutdownOnUnknownPresence: true,
    maximumObservationAgeSeconds: 30,
    admissionDuringInteraction: "within_reserved_budget",
    humanReserved: zeroResources(),
    systemReserve: root.reserve,
    unattendedMaximum: maximum,
    attendedMaximum: maximum,
    cpuPressureLimitPercent: 90,
    memoryPressureLimitPercent: 90,
  });
}

/** All admission callers and dry-runs use this pure rule; SQLite separately fences its complete input. */
export function evaluateMachineAdmission(
  context: MachineAdmissionContext,
  now: number,
  nodeId?: string,
  requested = zeroResources(),
) {
  const reasons: string[] = [];
  const roots = context.pools.filter((p) => p.parentAllocationId === null);
  const root = roots[0];
  const node = context.nodes.find((n) => n.id === nodeId);
  const manual = !!node?.manualInventory;
  const policy =
    context.policy ?? (manual && root ? manualInventoryPolicy(root) : null);
  const observation = context.observation;
  const maximumAge =
    Math.min(policy?.maximumObservationAgeSeconds ?? 30, 30) * 1000;
  const observedAt = observation
    ? Date.parse(observation.snapshot.observedAt)
    : NaN;
  const fresh =
    !!observation?.authenticated &&
    observedAt <= observation.receivedAtMs &&
    observation.receivedAtMs <= now &&
    now - observation.receivedAtMs <= maximumAge &&
    now - observedAt <= maximumAge;
  const humanPresence =
    fresh && observation
      ? classifyFreshHumanPresence(
          observation.snapshot,
          observation.receivedAtMs,
          now,
          maximumAge,
        )
      : "unknown";
  const snapshot = fresh ? observation?.snapshot : undefined;
  const cpuPercent = snapshot?.resources?.cpuPercent ?? null;
  const memoryPercent = snapshot?.resources
    ? (snapshot.resources.memoryUsedBytes /
        snapshot.resources.memoryTotalBytes) *
      100
    : null;
  const boundedPartial =
    !manual &&
    fresh &&
    !!snapshot &&
    snapshot.probeStatus === "partial" &&
    humanPresence !== "unknown" &&
    policy?.admissionDuringInteraction === "within_reserved_budget" &&
    snapshot.resources !== null &&
    snapshot.unmanagedActivityHold !== true;
  const limitations = manual
    ? [
        "Constant-online manual inventory trial: frozen conservative budget; shared-host use is not verified",
      ]
    : boundedPartial
      ? [
          snapshot?.unmanagedActivityHold === null
            ? "Unmanaged activity remains unknown; only the attended physical envelope is available"
            : "Host observation is partial; only the attended physical envelope is available",
          "Partial Host evidence never authorizes automatic power",
        ]
      : [];
  if (context.holds.some((h) => h.kind === "unmanaged_work"))
    limitations.push(
      "External unmanaged inventory Hold remains; approved physical budget must include its workload and the Hold prevents power actions",
    );
  const admissionAssurance = manual
    ? ("manual_inventory_trial" as const)
    : boundedPartial
      ? ("bounded_partial_host" as const)
      : fresh && snapshot?.probeStatus === "complete"
        ? ("complete_host" as const)
        : ("unavailable_host" as const);
  const hostObservation = {
    state: !observation
      ? ("missing" as const)
      : observation.revoked
        ? ("revoked" as const)
        : fresh
          ? ("fresh" as const)
          : ("stale" as const),
    humanPresence: humanPresence as "present" | "absent" | "unknown",
    cpuPercent,
    memoryPercent,
    unmanagedActivityHold: snapshot?.unmanagedActivityHold ?? null,
    receivedAtMs: observation?.receivedAtMs ?? null,
    probeStatus: snapshot?.probeStatus ?? null,
    sessionsComplete: snapshot?.sessionsComplete ?? null,
    interactiveSessionCount: snapshot?.sessions.length ?? null,
  };
  if (context.source !== "local") reasons.push("Machine source is not local");
  if (context.admission !== "enabled")
    reasons.push(`Machine admission is ${context.admission}`);
  if (context.power !== "on") reasons.push(`Machine power is ${context.power}`);
  if (roots.length !== 1)
    reasons.push("Machine must have exactly one physical root pool");
  if (!policy || context.policyInvalid)
    reasons.push("Human-use policy is missing or invalid");
  if (nodeId && !node) reasons.push("Node is not owned by this Machine");
  if (node && node.admission !== "enabled")
    reasons.push(`Node admission is ${node.admission}`);
  if (node && node.observedHealth !== "healthy")
    reasons.push(`Node health is ${node.observedHealth}`);
  if (
    node &&
    (node.observedAtMs === null ||
      node.observedAtMs > now ||
      now - node.observedAtMs >= 120_000)
  )
    reasons.push("Node observation is stale or unknown");
  if (
    node &&
    (node.capabilityExpiresAtMs === null ||
      !Number.isFinite(node.capabilityExpiresAtMs) ||
      node.capabilityExpiresAtMs <= now)
  )
    reasons.push("Node capabilities are expired or unverified");
  // A current, positive Host safety signal always vetoes even the static trial path.
  if (snapshot?.probeStatus === "failed") reasons.push("Host probe failed");
  if (snapshot?.unmanagedActivityHold === true)
    reasons.push("Unmanaged activity is held");
  if (!manual) {
    if (!fresh) reasons.push(`Host observation is ${hostObservation.state}`);
    if (snapshot?.probeStatus !== "complete" && !boundedPartial)
      reasons.push("Host workload observation is incomplete");
    if (humanPresence === "unknown") reasons.push("Human presence is unknown");
    if (snapshot?.unmanagedActivityHold !== false && !boundedPartial)
      reasons.push("Unmanaged activity is unknown or held");
  }
  if (policy) {
    if (
      humanPresence === "present" &&
      policy.admissionDuringInteraction === "block_new"
    )
      reasons.push("Interactive session blocks new allocations");
    // Unknown human use in a static trial always receives the attended (smaller) ceiling.
    if (
      manual &&
      policy.admissionDuringInteraction !== "within_reserved_budget"
    )
      reasons.push(
        "Manual inventory trial requires an explicit attended budget",
      );
    if (
      (!manual || cpuPercent !== null) &&
      (cpuPercent === null || cpuPercent >= policy.cpuPressureLimitPercent)
    )
      reasons.push("CPU pressure is unknown or above policy");
    if (
      (!manual || memoryPercent !== null) &&
      (memoryPercent === null ||
        memoryPercent >= policy.memoryPressureLimitPercent)
    )
      reasons.push("Memory pressure is unknown or above policy");
    for (const p of context.pools)
      for (const k of resourceKeys) {
        if (
          !Number.isSafeInteger(p.capacity[k]) ||
          !Number.isSafeInteger(p.reserve[k]) ||
          p.reserve[k] > p.capacity[k]
        )
          reasons.push(`Invalid pool ${p.id} ${k} budget`);
      }
    if (root)
      for (const k of resourceKeys) {
        if (policy.systemReserve[k] !== root.reserve[k])
          reasons.push(`Root ${k} reserve does not match policy`);
        if (
          policy.systemReserve[k] + policy.attendedMaximum[k] >
            root.capacity[k] ||
          policy.systemReserve[k] + policy.unattendedMaximum[k] >
            root.capacity[k]
        )
          reasons.push(`Policy ${k} ceiling exceeds physical budget`);
      }
  }
  for (const hold of context.holds)
    if (["maintenance", "recovery"].includes(hold.kind))
      reasons.push(`Hold: ${hold.reason}`);
  const active = context.claims.filter((c) => c.state !== "released");
  const usage = new Map(context.pools.map((p) => [p.id, zeroResources()]));
  let workloadUsage = zeroResources();
  for (const claim of active) {
    const allocation = context.allocations.find(
      (a) => a.id === claim.allocationId,
    );
    const pool = context.pools.find((p) => p.id === claim.poolId);
    if (!pool || !allocation) {
      reasons.push("Claim ownership is inconsistent");
      continue;
    }
    usage.set(pool.id, addResources(usage.get(pool.id)!, claim.resources));
    if (allocation.purpose !== "infrastructure")
      workloadUsage = addResources(workloadUsage, claim.resources);
    // Every allocation is charged to its Node pool; cross-pool claims cannot evade the root envelope.
    if (
      context.nodes.find((n) => n.id === allocation.nodeId)?.poolId !== pool.id
    )
      reasons.push("Claim is outside its allocation Node pool");
  }
  // Only a requested/occupied subtree needs a running base. An unused, stopped base
  // may retain its child-pool definition and disk without disabling unrelated Nodes.
  const requiredPools = new Set(active.map((c) => c.poolId));
  if (node) requiredPools.add(node.poolId);
  for (let pass = 0; pass < context.pools.length; pass++)
    for (const p of context.pools) {
      if (!requiredPools.has(p.id) || !p.parentAllocationId) continue;
      const parent = context.allocations.find(
          (a) => a.id === p.parentAllocationId,
        ),
        parentNode = context.nodes.find((n) => n.id === parent?.nodeId);
      if (parentNode) requiredPools.add(parentNode.poolId);
    }
  for (const pool of context.pools) {
    const used = usage.get(pool.id)!;
    for (const k of resourceKeys)
      if (
        !Number.isSafeInteger(used[k]) ||
        used[k] + pool.reserve[k] > pool.capacity[k]
      )
        reasons.push(`Pool ${pool.id} ${k} is over budget`);
    if (pool.parentAllocationId !== null) {
      const parent = context.allocations.find(
        (a) => a.id === pool.parentAllocationId,
      );
      const parentClaims = active.filter(
        (c) => c.allocationId === parent?.id && c.state === "committed",
      );
      const backing = parentClaims.reduce(
        (sum, c) => addResources(sum, c.resources),
        zeroResources(),
      );
      if (
        requiredPools.has(pool.id) &&
        (!parent ||
          parent.purpose !== "infrastructure" ||
          parent.desiredState !== "present" ||
          parent.observedState !== "running" ||
          parent.cleanupStatus === "complete")
      )
        reasons.push(
          `Infrastructure dependency ${pool.parentAllocationId} is not running`,
        );
      if (
        requiredPools.has(pool.id) &&
        (parentClaims.length === 0 ||
          resourceKeys.some((k) => pool.capacity[k] > backing[k]))
      )
        reasons.push(
          `Child pool ${pool.id} exceeds committed infrastructure backing`,
        );
      const siblings = context.pools
        .filter((p) => p.parentAllocationId === pool.parentAllocationId)
        .reduce((sum, p) => addResources(sum, p.capacity), zeroResources());
      if (
        requiredPools.has(pool.id) &&
        resourceKeys.some((k) => siblings[k] > backing[k])
      )
        reasons.push(
          `Child pools exceed infrastructure ${pool.parentAllocationId} backing`,
        );
      // Walk ownership through Node pools. Missing parents and cycles fail closed.
      let cursor: PoolBudget | undefined = pool;
      const seen = new Set<string>();
      while (cursor?.parentAllocationId) {
        if (seen.has(cursor.id)) {
          reasons.push("Capacity dependency cycle");
          break;
        }
        seen.add(cursor.id);
        const owner = context.allocations.find(
          (a) => a.id === cursor?.parentAllocationId,
        );
        const ownerNode = context.nodes.find((n) => n.id === owner?.nodeId);
        cursor = context.pools.find((p) => p.id === ownerNode?.poolId);
      }
      if (cursor?.id !== root?.id)
        reasons.push(`Pool ${pool.id} is not rooted in this Machine`);
    }
  }
  const physicalUsage = root ? usage.get(root.id)! : zeroResources();
  const targetPool = context.pools.find((p) => p.id === node?.poolId);
  if (targetPool) {
    for (const k of resourceKeys)
      if (
        usage.get(targetPool.id)![k] + targetPool.reserve[k] + requested[k] >
        targetPool.capacity[k]
      )
        reasons.push(`Insufficient ${k} in Node pool`);
  }
  const ceiling = policy
    ? humanPresence === "absent" && !manual && !boundedPartial
      ? policy.unattendedMaximum
      : policy.attendedMaximum
    : zeroResources();
  const proposedPhysical =
    targetPool?.id === root?.id
      ? addResources(physicalUsage, requested)
      : physicalUsage;
  if (policy)
    for (const k of resourceKeys)
      if (proposedPhysical[k] > ceiling[k])
        reasons.push(
          `Machine ${k} exceeds ${humanPresence === "absent" && !manual && !boundedPartial ? "unattended" : "attended"} ceiling`,
        );
  const available = Object.fromEntries(
    resourceKeys.map((k) => [
      k,
      Math.max(
        0,
        Math.min(
          (targetPool?.capacity[k] ?? 0) -
            (targetPool?.reserve[k] ?? 0) -
            (usage.get(targetPool?.id ?? "")?.[k] ?? 0),
          targetPool?.id === root?.id
            ? ceiling[k] - physicalUsage[k]
            : Number.MAX_SAFE_INTEGER,
        ),
      ),
    ]),
  ) as Resources;
  const shutdownReasons = ["Automatic power is not implemented (D22a)"];
  if (humanPresence !== "absent")
    shutdownReasons.push(`Human presence is ${humanPresence}`);
  if (snapshot?.probeStatus !== "complete" || !fresh)
    shutdownReasons.push("Host evidence is incomplete or stale");
  if (snapshot?.unmanagedActivityHold !== false)
    shutdownReasons.push("Unmanaged activity is unknown or held");
  shutdownReasons.push(...context.holds.map((h) => `Hold: ${h.reason}`));
  if (active.length) shutdownReasons.push("Unreleased capacity claims remain");
  return {
    admissionAssurance,
    limitations,
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    hostObservation,
    policy,
    manual,
    physicalUsage,
    workloadUsage,
    available,
    ceiling,
    shutdownReasons,
    usage,
  };
}
