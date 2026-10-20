import { randomUUID } from "node:crypto";
import {
  hostHeartbeatSchema,
  type HostHeartbeat,
  type HostSnapshot,
} from "@hitchlet/contracts/internal";
import type { HostClient } from "./host-client.js";
import {
  HostRequestError,
  HostTransientError,
  isTransientHostFailure,
} from "./host-client.js";
export { HostTransientError } from "./host-client.js";

export type HostBinding = {
  agentId: string;
  machineId: string;
  installationId: string;
  credential: string;
};
/** One process owns one bootId. A fenced process exits instead of stealing a newer process's session. */
export class HostObservationService {
  private bootId: string = randomUUID();
  private sequence = 0;
  private controllerEpoch = 0;
  private sessionEpoch = 0;
  private pending: HostHeartbeat | undefined;
  private pendingInitialization:
    | { controllerEpoch: number; sessionEpoch: number }
    | undefined;
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
    private readonly physicalBootId?: string,
  ) {}
  async initialize() {
    if (!this.pendingInitialization) {
      const s = await this.client.session(
        this.binding.agentId,
        this.binding.credential,
      );
      if (s.installationId !== this.binding.installationId)
        throw new Error("host_installation_mismatch");
      this.pendingInitialization = {
        controllerEpoch: s.controllerEpoch,
        sessionEpoch: s.sessionEpoch,
      };
    }
    // A lost boot response may already be committed. Retry the same process boot/expected epoch.
    await this.start(
      this.pendingInitialization.controllerEpoch,
      this.pendingInitialization.sessionEpoch,
    );
    this.pendingInitialization = undefined;
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
  /** True only when this call collected new evidence and its heartbeat was acknowledged. */
  async tick(): Promise<boolean> {
    let sampled = false;
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
          ...(this.physicalBootId ? { osBootId: this.physicalBootId } : {}),
          sequence: this.sequence,
          observedAt,
        },
      });
      sampled = true;
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
      return sampled;
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
        return false;
      } else if (isTransientHostFailure(error)) throw new HostTransientError();
      else throw error;
    }
  }
}
