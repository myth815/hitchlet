import { randomUUID } from "node:crypto";
import {
  hostHeartbeatSchema,
  type HostHeartbeat,
  type HostSnapshot,
} from "@hitchlet/contracts/internal";
import type { HostClient } from "./host-client.js";
import { HostRequestError } from "./host-client.js";

export type HostBinding = {
  agentId: string;
  machineId: string;
  installationId: string;
  credential: string;
};
/** One process owns one bootId. A fenced process exits instead of stealing a newer process's session. */
export class HostObservationService {
  private bootId = randomUUID();
  private sequence = 0;
  private controllerEpoch = 0;
  private sessionEpoch = 0;
  private pending: HostHeartbeat | undefined;
  constructor(
    private readonly binding: HostBinding,
    private readonly client: Pick<HostClient, "session" | "boot" | "heartbeat">,
    private readonly collect: () => Promise<
      Omit<
        HostSnapshot,
        "agentId" | "machineId" | "bootId" | "sequence" | "observedAt"
      >
    >,
    private readonly now = Date.now,
  ) {}
  async initialize() {
    const s = await this.client.session(
      this.binding.agentId,
      this.binding.credential,
    );
    if (s.installationId !== this.binding.installationId)
      throw new Error("host_installation_mismatch");
    await this.start(s.controllerEpoch, s.sessionEpoch);
  }
  private async start(controllerEpoch: number, expectedSessionEpoch: number) {
    const boot = await this.client.boot(
      this.binding.agentId,
      this.binding.credential,
      {
        installationId: this.binding.installationId,
        controllerEpoch,
        expectedSessionEpoch,
        bootId: this.bootId,
      },
    );
    if (
      boot.bootId !== this.bootId ||
      boot.controllerEpoch !== controllerEpoch ||
      boot.sessionEpoch !== expectedSessionEpoch + 1
    )
      throw new Error("host_boot_receipt_mismatch");
    this.controllerEpoch = controllerEpoch;
    this.sessionEpoch = boot.sessionEpoch;
  }
  async tick() {
    // A lost response may already be committed. Skip its sequence when discarding stale evidence.
    if (
      this.pending &&
      this.now() - Date.parse(this.pending.snapshot.observedAt) > 30_000
    ) {
      this.pending = undefined;
      this.sequence++;
    }
    if (!this.pending) {
      const observedAt = new Date(this.now()).toISOString();
      const evidence = await this.collect();
      this.pending = hostHeartbeatSchema.parse({
        installationId: this.binding.installationId,
        controllerEpoch: this.controllerEpoch,
        sessionEpoch: this.sessionEpoch,
        protocolVersion: 1,
        agentVersion: "0.1.0",
        snapshot: {
          ...evidence,
          agentId: this.binding.agentId,
          machineId: this.binding.machineId,
          bootId: this.bootId,
          sequence: this.sequence,
          observedAt,
        },
      });
    }
    try {
      const result = await this.client.heartbeat(
        this.binding.agentId,
        this.binding.credential,
        this.pending,
      );
      if (
        result.sequence !== this.sequence ||
        result.sessionEpoch !== this.sessionEpoch
      )
        throw new Error("host_heartbeat_receipt_mismatch");
      this.sequence++;
      this.pending = undefined;
    } catch (error) {
      if (
        error instanceof HostRequestError &&
        (error.status === 412 || error.status === 409)
      ) {
        const current = await this.client.session(
          this.binding.agentId,
          this.binding.credential,
        );
        if (
          current.installationId !== this.binding.installationId ||
          current.controllerEpoch <= this.controllerEpoch
        )
          throw new Error("host_session_fenced");
        this.bootId = randomUUID();
        this.sequence = 0;
        this.pending = undefined;
        await this.start(current.controllerEpoch, current.sessionEpoch);
      } else if (
        error instanceof HostRequestError &&
        error.status >= 400 &&
        error.status < 500
      )
        throw error;
      else throw new HostTransientError();
    }
  }
}
export class HostTransientError extends Error {
  constructor() {
    super("host_temporarily_unavailable");
  }
}
