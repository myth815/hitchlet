import { createHash, randomBytes } from "node:crypto";
import {
  hostPairingReceiptSchema,
  hostEnrollReceiptSchema,
  hostBootReceiptSchema,
  hostHeartbeatReceiptSchema,
  hostSessionViewSchema,
  type HostPairingRequest,
  type HostEnrollRequest,
  type HostBootRequest,
  type HostHeartbeat,
} from "@hitchlet/contracts/internal";
import type { Storage } from "../storage/index.js";
import { HostAgentStore } from "../storage/host-agent-store.js";
import { AuthFailure } from "../application/errors.js";

/** Only the full-admin HTTP boundary calls pair/revoke; Host credentials have no consumer permissions. */
export class HostAgents {
  private readonly store: HostAgentStore;
  constructor(
    db: Storage,
    private readonly now = Date.now,
  ) {
    this.store = new HostAgentStore(db);
  }
  async pair(input: HostPairingRequest, actorId: string, requestId: string) {
    const pairingToken = `hcp_${randomBytes(32).toString("base64url")}`;
    return hostPairingReceiptSchema.parse({
      ...(await this.store.pair(
        input,
        digest(pairingToken),
        this.now(),
        actorId,
        requestId,
      )),
      pairingToken,
    });
  }
  async enroll(input: HostEnrollRequest) {
    const credential = `hch_${randomBytes(32).toString("base64url")}`;
    return hostEnrollReceiptSchema.parse({
      ...(await this.store.enroll(input, digest(credential), this.now())),
      credential,
    });
  }
  async start(
    agentId: string,
    authorization: string | undefined,
    input: HostBootRequest,
  ) {
    return hostBootReceiptSchema.parse(
      await this.store.start(
        agentId,
        this.credentialHash(authorization),
        input,
        this.now(),
      ),
    );
  }
  async heartbeat(
    agentId: string,
    authorization: string | undefined,
    input: HostHeartbeat,
  ) {
    return hostHeartbeatReceiptSchema.parse(
      await this.store.heartbeat(
        agentId,
        this.credentialHash(authorization),
        input,
        this.now(),
      ),
    );
  }
  revoke(
    agentId: string,
    expected: number,
    reason: string,
    actorId: string,
    requestId: string,
  ) {
    return this.store.revoke(
      agentId,
      expected,
      reason,
      actorId,
      requestId,
      this.now(),
    );
  }
  async session(agentId: string, authorization: string | undefined) {
    return hostSessionViewSchema.parse(
      await this.store.session(agentId, this.credentialHash(authorization)),
    );
  }
  view(agentId: string) {
    return this.store.view(agentId);
  }
  snapshot(machineId: string) {
    return this.store.snapshot(machineId, this.now());
  }
  private credentialHash(authorization: string | undefined) {
    if (!authorization || !/^Bearer hch_[A-Za-z0-9_-]{43}$/.test(authorization))
      throw new AuthFailure("unauthenticated");
    return digest(authorization.slice(7));
  }
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
