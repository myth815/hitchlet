import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  HostObservationService,
  HostTransientError,
} from "../src/host-service.js";
import { HostRequestError } from "../src/host-client.js";
import type { HostHeartbeat } from "@hitchlet/contracts/internal";
const evidence = {
  sessions: [],
  sessionsComplete: false,
  activeInteraction: "unknown" as const,
  resources: null,
  unmanagedActivityHold: null,
  probeStatus: "partial" as const,
  errorCodes: ["fixture"],
};
describe("physical Host outbound lifecycle", () => {
  it("replays identical lost heartbeats and recovers controller epoch changes using only Host credentials", async () => {
    const binding = {
      agentId: randomUUID(),
      machineId: randomUUID(),
      installationId: randomUUID(),
      credential: `hch_${"a".repeat(43)}`,
    };
    let epoch = 1,
      sessionEpoch = 0,
      bootId: string | null = null,
      lose = true;
    const received: HostHeartbeat[] = [];
    const client = {
      session: async () => ({
        installationId: binding.installationId,
        controllerEpoch: epoch,
        sessionEpoch,
        bootId,
      }),
      boot: async (_id: string, _key: string, raw: unknown) => {
        const input = raw as { bootId: string; expectedSessionEpoch: number };
        expect(input.expectedSessionEpoch).toBe(sessionEpoch);
        bootId = input.bootId;
        return { controllerEpoch: epoch, sessionEpoch: ++sessionEpoch, bootId };
      },
      heartbeat: async (_id: string, key: string, input: HostHeartbeat) => {
        expect(key).toBe(binding.credential);
        received.push(input);
        if (input.controllerEpoch !== epoch) throw new HostRequestError(412);
        if (lose) {
          lose = false;
          throw new Error("response lost");
        }
        return {
          sequence: input.snapshot.sequence,
          sessionEpoch: input.sessionEpoch,
          receivedAt: input.snapshot.observedAt,
          duplicate: received.length === 2,
          offlineLeaseEnforcement: false as const,
        };
      },
    };
    let samples = 0;
    const service = new HostObservationService(binding, client, async () => {
      samples++;
      return evidence;
    });
    await service.initialize();
    await expect(service.tick()).rejects.toBeInstanceOf(HostTransientError);
    await service.tick();
    expect(received[0]).toEqual(received[1]);
    expect(samples).toBe(1);
    epoch = 2;
    await service.tick();
    expect(sessionEpoch).toBe(2);
    await service.tick();
    expect(received.at(-1)).toMatchObject({
      controllerEpoch: 2,
      sessionEpoch: 2,
      snapshot: { sequence: 0 },
    });
    expect(received.at(-1)!.snapshot.bootId).not.toBe(
      received[0]!.snapshot.bootId,
    );
  });
  it("does not let a fenced process reacquire the same controller epoch or silently survive revocation", async () => {
    const binding = {
      agentId: randomUUID(),
      machineId: randomUUID(),
      installationId: randomUUID(),
      credential: `hch_${"a".repeat(43)}`,
    };
    let status = 412;
    const client = {
      session: async () => ({
        installationId: binding.installationId,
        controllerEpoch: 1,
        sessionEpoch: 0,
        bootId: null,
      }),
      boot: async (_a: string, _b: string, raw: unknown) => ({
        controllerEpoch: 1,
        sessionEpoch: 1,
        bootId: (raw as { bootId: string }).bootId,
      }),
      heartbeat: async () => {
        throw new HostRequestError(status);
      },
    };
    const service = new HostObservationService(
      binding,
      client,
      async () => evidence,
    );
    await service.initialize();
    await expect(service.tick()).rejects.toThrow("host_session_fenced");
    status = 401;
    await expect(service.tick()).rejects.toMatchObject({ status: 401 });
  });
});

describe("Host observation sample age", () => {
  it("timestamps before sampling and skips a stale lost-response sequence after a long network outage", async () => {
    const binding = {
      agentId: randomUUID(),
      machineId: randomUUID(),
      installationId: randomUUID(),
      credential: `hch_${"a".repeat(43)}`,
    };
    let now = 100_000,
      fail = true;
    const received: HostHeartbeat[] = [];
    const client = {
      session: async () => ({
        installationId: binding.installationId,
        controllerEpoch: 1,
        sessionEpoch: 0,
        bootId: null,
      }),
      boot: async (_a: string, _b: string, raw: unknown) => ({
        controllerEpoch: 1,
        sessionEpoch: 1,
        bootId: (raw as { bootId: string }).bootId,
      }),
      heartbeat: async (_a: string, _b: string, input: HostHeartbeat) => {
        received.push(input);
        if (fail) throw new Error("network down after commit");
        return {
          sequence: input.snapshot.sequence,
          sessionEpoch: 1,
          receivedAt: new Date(now).toISOString(),
          duplicate: false,
          offlineLeaseEnforcement: false as const,
        };
      },
    };
    const service = new HostObservationService(
      binding,
      client,
      async () => {
        now += 5_000;
        return evidence;
      },
      () => now,
    );
    await service.initialize();
    await expect(service.tick()).rejects.toBeInstanceOf(HostTransientError);
    expect(received[0]!.snapshot.observedAt).toBe(
      new Date(100_000).toISOString(),
    );
    now += 61_000;
    fail = false;
    await service.tick();
    expect(received[1]!.snapshot.sequence).toBe(1);
    expect(Date.parse(received[1]!.snapshot.observedAt)).toBe(166_000);
  });
});
