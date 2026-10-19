import { describe, expect, it } from "vitest";
import {
  availableCapacity,
  claimConsumesCapacity,
  fits,
  leaseDeadline,
  terminalReasonFor,
} from "../src/domain/ticket.js";

describe("Ticket and capacity rules", () => {
  it("keeps the first terminal decision and sends allocated Tickets through cleanup", () => {
    expect(terminalReasonFor("queued", "consumer_cancel")).toEqual({
      phase: "released",
      reason: "consumer_cancel",
    });
    expect(terminalReasonFor("reserved", "consumer_cancel")).toEqual({
      phase: "releasing",
      reason: "consumer_cancel",
    });
    expect(() => terminalReasonFor("releasing", "lease_expired")).toThrow();
  });
  it("holds reserved and unknown claims, subtracting the platform reserve once", () => {
    const available = availableCapacity(
      { cpuMillis: 8000, memoryMiB: 8000, scratchMiB: 10000 },
      { cpuMillis: 1000, memoryMiB: 1000, scratchMiB: 1000 },
      [
        {
          state: "reserved",
          amounts: { cpuMillis: 2000, memoryMiB: 2000, scratchMiB: 3000 },
        },
        {
          state: "quarantined",
          amounts: { cpuMillis: 1000, memoryMiB: 3000, scratchMiB: 2000 },
        },
        {
          state: "released",
          amounts: { cpuMillis: 5000, memoryMiB: 5000, scratchMiB: 5000 },
        },
      ],
    );
    expect(available).toEqual({
      cpuMillis: 4000,
      memoryMiB: 2000,
      scratchMiB: 4000,
    });
    expect(
      fits(available, { cpuMillis: 4000, memoryMiB: 2000, scratchMiB: 4000 }),
    ).toBe(true);
    expect(claimConsumesCapacity("quarantined")).toBe(true);
  });
  it("uses fixed accepted lease seconds and a service timestamp", () => {
    expect(leaseDeadline(10_000, 900)).toBe(910_000);
    expect(() => leaseDeadline(10_000, 0)).toThrow();
  });
});
