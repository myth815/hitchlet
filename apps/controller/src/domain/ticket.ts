import type {
  ResourceAmounts,
  TicketState,
  TerminalReason,
} from "@hitchlet/contracts";

export type TicketPhase = TicketState;
export type Capacity = ResourceAmounts;
export type CapacityClaimState =
  | "reserved"
  | "committed"
  | "quarantined"
  | "released";

export function terminalReasonFor(
  phase: TicketPhase,
  reason: TerminalReason,
): { phase: "releasing" | "released"; reason: TerminalReason } {
  if (
    phase !== "queued" &&
    phase !== "reserved" &&
    phase !== "provisioning" &&
    phase !== "ready"
  )
    throw new Error("Ticket already has a terminal decision");
  return { phase: phase === "queued" ? "released" : "releasing", reason };
}

export function leaseDeadline(createdAtMs: number, seconds: number): number {
  if (
    !Number.isSafeInteger(createdAtMs) ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0
  )
    throw new RangeError("Invalid lease deadline");
  return createdAtMs + seconds * 1000;
}

export function claimConsumesCapacity(state: CapacityClaimState): boolean {
  return state !== "released";
}

export function availableCapacity(
  total: Capacity,
  platformReserve: Capacity,
  claims: readonly { state: CapacityClaimState; amounts: Capacity }[],
): Capacity {
  const used = claims
    .filter((claim) => claimConsumesCapacity(claim.state))
    .reduce((sum, claim) => add(sum, claim.amounts), zero());
  return {
    cpuMillis: total.cpuMillis - platformReserve.cpuMillis - used.cpuMillis,
    memoryMiB: total.memoryMiB - platformReserve.memoryMiB - used.memoryMiB,
    scratchMiB: total.scratchMiB - platformReserve.scratchMiB - used.scratchMiB,
  };
}

export function fits(available: Capacity, requested: Capacity): boolean {
  return (
    available.cpuMillis >= requested.cpuMillis &&
    available.memoryMiB >= requested.memoryMiB &&
    available.scratchMiB >= requested.scratchMiB
  );
}

function zero(): Capacity {
  return { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 };
}
function add(a: Capacity, b: Capacity): Capacity {
  return {
    cpuMillis: a.cpuMillis + b.cpuMillis,
    memoryMiB: a.memoryMiB + b.memoryMiB,
    scratchMiB: a.scratchMiB + b.scratchMiB,
  };
}
