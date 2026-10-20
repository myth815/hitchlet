import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import dgram from "node:dgram";
import {
  PowerExecutionSchema,
  type PowerExecution,
  type PowerInstallation,
  type PowerInstallationMachine,
  type HostPowerEvent,
  type HostPowerDirective,
} from "@hitchlet/contracts/admin";
import { PowerExecutionStore } from "../storage/power-execution-store.js";
import type { Storage } from "../storage/index.js";
import type { PowerSnapshot, PowerActor } from "../storage/power-store.js";
import type { Statement } from "../storage/protocol.js";
import {
  bindingHash,
  executionConditionKey,
  realShutdownReasons,
  ownsDrain,
  powerReadyReasons,
} from "../domain/power-execution.js";
import { ApplicationError } from "./errors.js";
import { evaluateMachineAdmission } from "../domain/human-use.js";
const terminal = (p: PowerExecution) =>
  ["ready", "cancelled", "manual"].includes(p.phase);
const none: HostPowerDirective = {
  action: "none",
  cycleId: null,
  machineEpoch: null,
  token: null,
  expiresAtMs: null,
};

/** Only trusted installation configuration grants a fixed LAN target; HTTP cannot supply addresses. */
export async function sendLocalWol(route: PowerInstallationMachine["route"]) {
  if (
    !Object.values(networkInterfaces())
      .flat()
      .some(
        (i) =>
          i?.family === "IPv4" &&
          i.address === route.interfaceAddress &&
          !i.internal &&
          i.netmask === "255.255.255.0",
      )
  )
    throw new Error("power_lan_interface_unavailable");
  const ip = route.interfaceAddress.split(".").map(Number),
    broadcast = route.broadcastAddress.split(".").map(Number);
  if (
    ip[0] !== broadcast[0] ||
    ip[1] !== broadcast[1] ||
    ip[2] !== broadcast[2] ||
    broadcast[3] !== 255 ||
    !(
      ip[0] === 10 ||
      (ip[0] === 192 && ip[1] === 168) ||
      (ip[0] === 172 && ip[1]! >= 16 && ip[1]! <= 31)
    )
  )
    throw new Error("power_lan_route_requires_private_local_24");
  const mac = Buffer.from(route.macAddress.replaceAll(":", ""), "hex");
  const packet = Buffer.concat([
    Buffer.alloc(6, 255),
    ...Array<Buffer>(16).fill(mac),
  ]);
  const socket = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, route.interfaceAddress, resolve);
    });
    socket.setBroadcast(true);
    await new Promise<void>((resolve, reject) =>
      socket.send(packet, 9, route.broadcastAddress, (e) =>
        e ? reject(e) : resolve(),
      ),
    );
  } finally {
    socket.close();
  }
}
export class PowerExecutionService {
  readonly store: PowerExecutionStore;
  constructor(
    db: Storage,
    private readonly installation: PowerInstallation = { machines: [] },
    private readonly now = Date.now,
    private readonly wol = sendLocalWol,
  ) {
    this.store = new PowerExecutionStore(db);
  }
  private grant(machineId: string) {
    return this.installation.machines.find((m) => m.machineId === machineId);
  }
  private async verified(g: PowerInstallationMachine) {
    const p = g.qualificationId
      ? await this.store.get(g.machineId, g.qualificationId)
      : undefined;
    return (
      !!p &&
      p.qualification &&
      p.phase === "ready" &&
      p.bindingHash === bindingHash(g) &&
      p.onlineWolAtMs !== null &&
      p.recoveredBootId !== null
    );
  }
  /** A paused/recovering controller may cancel or restore, but cannot initiate shutdown. */
  private shutdownReasons(s: PowerSnapshot, now: number, p?: PowerExecution) {
    const control = s.data.maintenance;
    return [
      ...realShutdownReasons(s.context, now, p),
      ...(!control ||
      control.paused !== 0 ||
      control.diskState !== "healthy" ||
      control.recovering !== 0
        ? ["Controller maintenance, storage or recovery blocks new shutdown"]
        : []),
    ];
  }
  async view(machineId: string) {
    const g = this.grant(machineId),
      s = await this.store.safety.load(machineId, this.now());
    return {
      configured: !!g,
      enabled: !!g?.enabled,
      automatic: !!g?.automatic,
      verified: g ? await this.verified(g) : false,
      reasons: [
        ...(!g?.enabled
          ? [
              "Native power is not enabled in trusted installation configuration",
            ]
          : []),
        ...this.shutdownReasons(s, this.now()),
      ],
      executions: (await this.store.list(machineId)).map((p) => ({
        ...p,
        token: null,
      })),
    };
  }
  async start(machineId: string, qualification: boolean, actor?: PowerActor) {
    const g = this.grant(machineId),
      now = this.now();
    if (!g?.enabled || (!qualification && !(await this.verified(g))))
      throw new ApplicationError("execution_mode_unsupported");
    const s = await this.store.safety.load(machineId, now),
      c = s.context,
      host = c.admission.observation;
    if (
      !s.data.maintenance ||
      s.data.maintenance.paused !== 0 ||
      s.data.maintenance.diskState !== "healthy" ||
      s.data.maintenance.recovering !== 0
    )
      throw new ApplicationError("conflict");
    if (
      s.data.demands.length ||
      !host?.authenticated ||
      !host.snapshot.osBootId ||
      host.snapshot.agentId !== g.agentId ||
      s.admission.data.machine?.admission !== "enabled" ||
      s.data.operations.some((o) => o.kind.startsWith("power."))
    )
      throw new ApplicationError("conflict");
    const p = PowerExecutionSchema.parse({
      id: randomUUID(),
      machineId,
      agentId: g.agentId,
      version: 1,
      qualification,
      bindingHash: bindingHash(g),
      guardHash: g.guardHash,
      executorHash: g.executorHash,
      phase: "idle",
      machineEpoch: c.machineEpoch,
      controllerEpoch: c.controllerEpoch,
      machineVersion: c.machineVersion,
      bootId: host.snapshot.osBootId,
      conditionKey: executionConditionKey(c),
      idleSinceMs: null,
      lastEvaluationAtMs: now,
      token: null,
      tokenExpiresAtMs: null,
      cancelRequestedAtMs: null,
      resumeWakeOnDemand: false,
      acceptedAtMs: null,
      acceptedReceiptId: null,
      observedPower: "on",
      onlineWolAtMs: null,
      recoveredBootId: null,
      wakeAttempts: 0,
      nextWakeAtMs: null,
      deadlineMs: null,
      reasons: this.shutdownReasons(s, now),
      createdAtMs: now,
      updatedAtMs: now,
    });
    await this.store.write(s, p, null, [], actor);
    return p;
  }
  private next(p: PowerExecution): PowerExecution {
    return { ...p, version: p.version + 1, updatedAtMs: this.now() };
  }
  private fence(
    s: PowerSnapshot,
    p: PowerExecution,
    g: PowerInstallationMachine | undefined,
  ) {
    return (
      !!g?.enabled &&
      p.bindingHash === bindingHash(g) &&
      p.machineEpoch === s.context.machineEpoch &&
      p.machineVersion === s.context.machineVersion &&
      p.controllerEpoch === s.context.controllerEpoch &&
      (p.phase === "idle"
        ? s.context.admission.admission === "enabled"
        : ownsDrain(s.context, p))
    );
  }
  private machine(
    p: PowerExecution,
    sql: string,
    params: (string | number | null)[] = [],
  ): Statement {
    return {
      kind: "run",
      sql: `UPDATE machines SET ${sql},updated_at_ms=? WHERE id=? AND machine_epoch=?`,
      params: [...params, this.now(), p.machineId, p.machineEpoch],
      expectChanges: 1,
    };
  }
  private async cancel(
    s: PowerSnapshot,
    p: PowerExecution,
    reason: string,
    resumeWakeOnDemand = false,
    actor?: PowerActor,
  ) {
    const n = this.next(p);
    n.reasons = [reason];
    n.cancelRequestedAtMs = this.now();
    n.resumeWakeOnDemand = resumeWakeOnDemand && p.acceptedReceiptId !== null;
    n.token = null;
    n.tokenExpiresAtMs = null;
    n.phase = [
      "committing",
      "shutdown_requested",
      "off_expected",
      "waking",
      "cancel_pending",
    ].includes(p.phase)
      ? "cancel_pending"
      : "cancelled";
    const extra: Statement[] = [];
    if (n.phase === "cancelled" && ownsDrain(s.context, p))
      extra.push(
        this.machine(
          p,
          "admission='enabled',desired_power='unchanged',power_lifecycle='idle',machine_epoch=machine_epoch+1,version=version+1",
        ),
      );
    await this.store.write(s, n, p, extra, actor);
    return n;
  }
  private async finishCancellation(s: PowerSnapshot, p: PowerExecution) {
    const n = this.next(p);
    n.phase = "cancelled";
    n.token = null;
    n.tokenExpiresAtMs = null;
    n.cancelRequestedAtMs ??= this.now();
    n.resumeWakeOnDemand = false;
    n.observedPower = "on";
    if (!n.reasons.length)
      n.reasons = ["Host confirmed normal shutdown cancellation"];
    // Keep accepted receipt/history. Only our still-owned drain may restore machine admission.
    await this.store.write(
      s,
      n,
      p,
      ownsDrain(s.context, p)
        ? [
            this.machine(
              p,
              "admission='enabled',desired_power='unchanged',observed_power='on',power_lifecycle='idle',machine_epoch=machine_epoch+1,version=version+1",
            ),
          ]
        : [],
    );
  }
  async command(
    machineId: string,
    id: string,
    version: number,
    action: "cancel" | "wake",
    deadline?: number,
    actor?: PowerActor,
  ) {
    const p = await this.store.get(machineId, id);
    if (!p) throw new ApplicationError("not_found");
    if (p.version !== version || terminal(p))
      throw new ApplicationError("conflict");
    const s = await this.store.safety.load(machineId, this.now());
    if (action === "cancel")
      return this.cancel(s, p, "Operator cancelled power cycle", false, actor);
    if (
      !["off_expected", "waking"].includes(p.phase) ||
      !p.acceptedReceiptId ||
      !p.acceptedAtMs ||
      this.now() - p.acceptedAtMs < 120000
    )
      throw new ApplicationError("conflict");
    const n = this.next(p);
    n.phase = "waking";
    n.deadlineMs = Math.min(
      p.deadlineMs ?? Infinity,
      deadline ?? Infinity,
      this.now() + 300000,
    );
    await this.store.write(s, n, p, [], actor);
    return n;
  }
  async tick() {
    for (const p of await this.store.active()) {
      try {
        await this.evaluate(p);
      } catch (e) {
        if (!(e instanceof ApplicationError && e.code === "conflict")) throw e;
      }
    }
    for (const g of this.installation.machines)
      if (
        g.enabled &&
        g.automatic &&
        (await this.verified(g)) &&
        !(await this.store.list(g.machineId)).some((p) => !terminal(p))
      ) {
        try {
          await this.start(g.machineId, false);
        } catch (e) {
          if (!(e instanceof ApplicationError && e.code === "conflict"))
            throw e;
        }
      }
  }
  private async evaluate(p: PowerExecution) {
    const now = this.now(),
      s = await this.store.safety.load(p.machineId, now),
      g = this.grant(p.machineId),
      c = s.context,
      host = c.admission.observation;
    if (p.phase === "cancel_pending") {
      if (
        !this.fence(s, p, g) ||
        (p.deadlineMs !== null && now >= p.deadlineMs)
      ) {
        const n = this.next(p);
        n.phase = "manual";
        n.observedPower = "unknown";
        n.reasons = [
          "Cancellation could not be confirmed before fence/deadline; manual inspection required",
        ];
        await this.store.write(
          s,
          n,
          p,
          ownsDrain(s.context, p)
            ? [
                this.machine(
                  p,
                  "power_lifecycle='unknown',observed_power='unknown'",
                ),
              ]
            : [],
        );
        return;
      }
      if (
        p.resumeWakeOnDemand &&
        p.acceptedReceiptId &&
        p.acceptedAtMs !== null &&
        now - p.acceptedAtMs >= 120000 &&
        host &&
        now - host.receivedAtMs > 30000 &&
        s.data.demands.some((d) => d.deadlineMs > now) &&
        g?.automatic &&
        (await this.verified(g))
      ) {
        const n = this.next(p);
        n.phase = "off_expected";
        n.observedPower = "unknown";
        n.reasons = [];
        await this.store.write(s, n, p, [
          this.machine(
            p,
            "power_lifecycle='off_expected',observed_power='unknown'",
          ),
        ]);
      }
      return;
    }
    const demands = s.data.demands.filter((d) => d.deadlineMs > now);
    if (demands.length) {
      if (
        p.phase === "off_expected" &&
        g?.automatic &&
        (await this.verified(g)) &&
        this.fence(s, p, g)
      ) {
        const n = this.next(p);
        n.phase = "waking";
        n.deadlineMs = Math.min(
          p.deadlineMs ?? Infinity,
          now + 300000,
          ...demands.map((d) => d.deadlineMs),
        );
        await this.store.write(s, n, p);
        return;
      }
      if (
        [
          "idle",
          "draining",
          "prepared",
          "committing",
          "shutdown_requested",
        ].includes(p.phase)
      ) {
        await this.cancel(
          s,
          p,
          "New eligible queued demand cancelled pending shutdown",
          true,
        );
        return;
      }
    }
    if (!this.fence(s, p, g)) {
      await this.cancel(
        s,
        p,
        "Machine, controller or installation fence changed",
      );
      return;
    }
    const reasons = this.shutdownReasons(s, now, p),
      key = executionConditionKey(c, p);
    if (["shutdown_requested", "off_expected", "waking"].includes(p.phase)) {
      // Reuse the Host rule: authenticated, unrevoked, observed <= received <= now, both <=30s.
      // Partial/unknown presence may still be fresh evidence and must cancel; stale cache is not new.
      const freshHost =
        evaluateMachineAdmission(c.admission, now).hostObservation.state ===
        "fresh";
      if (
        p.phase === "waking" &&
        p.wakeAttempts > 0 &&
        freshHost &&
        host?.authenticated &&
        Date.parse(host.snapshot.observedAt) > (p.acceptedAtMs ?? now) &&
        host.snapshot.osBootId !== undefined &&
        host.snapshot.osBootId !== p.bootId &&
        !powerReadyReasons(c, now).length
      ) {
        const n = this.next(p);
        n.phase = "ready";
        n.observedPower = "on";
        n.recoveredBootId = host.snapshot.osBootId;
        n.reasons = [];
        await this.store.write(s, n, p, [
          this.machine(
            p,
            "admission='enabled',desired_power='on',observed_power='on',power_lifecycle='idle',machine_epoch=machine_epoch+1,version=version+1",
          ),
        ]);
        return;
      }
      if (
        ["off_expected", "waking"].includes(p.phase) &&
        host?.authenticated &&
        host.snapshot.osBootId === p.bootId &&
        freshHost
      ) {
        await this.cancel(
          s,
          p,
          "Fresh same-boot online evidence invalidated expected-off",
        );
        return;
      }
      if (
        c.admission.claims.length ||
        c.admission.holds.length ||
        c.operations.some(
          (o) =>
            o.kind !== "power.execution" &&
            ["planned", "running", "unknown"].includes(o.state),
        )
      ) {
        await this.cancel(
          s,
          p,
          "New claim, Hold or unresolved operation cancelled power cycle",
        );
        return;
      }
      if (
        freshHost &&
        host?.authenticated &&
        host.snapshot.osBootId === p.bootId &&
        host.receivedAtMs > (p.acceptedAtMs ?? now) &&
        reasons.length &&
        !reasons.every((r) => r.includes("Node"))
      ) {
        await this.cancel(
          s,
          p,
          "New online safety evidence invalidated shutdown",
        );
        return;
      }
      if (p.deadlineMs !== null && now >= p.deadlineMs) {
        const n = this.next(p);
        n.phase = "manual";
        n.observedPower = "unknown";
        n.reasons = [
          "Original cycle deadline exhausted; inspect without another shutdown",
        ];
        await this.store.write(s, n, p, [
          this.machine(p, "observed_power='unknown',power_lifecycle='unknown'"),
        ]);
        return;
      }
      if (
        p.phase === "shutdown_requested" &&
        p.acceptedReceiptId &&
        p.acceptedAtMs !== null &&
        now - p.acceptedAtMs >= 120000 &&
        host &&
        now - host.receivedAtMs > 30000
      ) {
        const n = this.next(p);
        n.phase = "off_expected";
        n.observedPower = "unknown";
        await this.store.write(s, n, p, [
          this.machine(
            p,
            "power_lifecycle='off_expected',observed_power='unknown'",
          ),
        ]);
        return;
      }
      if (
        p.phase === "waking" &&
        p.wakeAttempts < 3 &&
        (p.nextWakeAtMs === null || now >= p.nextWakeAtMs)
      ) {
        const n = this.next(p);
        n.wakeAttempts++;
        n.nextWakeAtMs = now + 30000;
        // Reserve attempt before UDP; lost send consumes an attempt, recovery cannot double-send it.
        await this.store.write(s, n, p, [
          this.machine(
            p,
            "power_lifecycle='waking',wake_attempt_count=?,wake_not_before_ms=?",
            [n.wakeAttempts, n.nextWakeAtMs],
          ),
        ]);
        await this.wol(g!.route);
      }
      return;
    }
    if (p.phase !== "idle") {
      if (
        reasons.length ||
        key !== p.conditionKey ||
        (p.deadlineMs !== null && now >= p.deadlineMs) ||
        now - (p.tokenExpiresAtMs ?? now) > 0
      ) {
        await this.cancel(
          s,
          p,
          "Safety changed or five-second preparation expired",
        );
      }
      return;
    }
    if (p.qualification && p.onlineWolAtMs === null && !reasons.length) {
      const n = this.next(p);
      n.onlineWolAtMs = now;
      n.idleSinceMs = null;
      n.lastEvaluationAtMs = now;
      // Qualification explicitly probes this exact route while online before expected-off is allowed.
      await this.store.write(s, n, p);
      await this.wol(g!.route);
      return;
    }
    const n = this.next(p);
    n.reasons = reasons;
    n.conditionKey = key;
    n.lastEvaluationAtMs = now;
    n.idleSinceMs =
      reasons.length ||
      (p.qualification &&
        p.onlineWolAtMs !== null &&
        (!host || host.receivedAtMs <= p.onlineWolAtMs))
        ? null
        : key === p.conditionKey && now - p.lastEvaluationAtMs <= 30000
          ? (p.idleSinceMs ?? now)
          : now;
    const extra: Statement[] = [];
    if (
      n.idleSinceMs !== null &&
      now - n.idleSinceMs >= g!.idleSeconds * 1000
    ) {
      n.phase = "draining";
      n.machineEpoch++;
      n.machineVersion++;
      n.deadlineMs = now + 300000;
      extra.push({
        kind: "run",
        sql: "UPDATE machines SET admission='draining',machine_epoch=machine_epoch+1,version=version+1,power_lifecycle='draining',power_cycle_id=?,power_transition_id=?,power_transition_deadline_ms=?,updated_at_ms=? WHERE id=? AND machine_epoch=? AND admission='enabled'",
        params: [p.id, p.id, n.deadlineMs, now, p.machineId, p.machineEpoch],
        expectChanges: 1,
      });
      extra.push({
        kind: "run",
        sql: "INSERT INTO agent_commands(id,agent_id,operation_id,sequence,controller_epoch,machine_epoch,kind,payload_json,request_hash,state,not_after_ms,created_at_ms) VALUES(?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM agent_commands WHERE agent_id=?),?,?,'power.shutdown',?,?,'queued',?,?)",
        params: [
          p.id,
          p.agentId,
          p.id,
          p.agentId,
          p.controllerEpoch,
          n.machineEpoch,
          JSON.stringify({ cycleId: p.id, guardHash: p.guardHash }),
          p.bindingHash,
          n.deadlineMs,
          now,
        ],
      });
    }
    await this.store.write(s, n, p, extra);
  }
  /** Caller has authenticated the Host credential/session. No administrative synthetic receipt path. */
  async hostEvent(agentId: string, event: HostPowerEvent) {
    const p = (await this.store.active()).find(
      (p) =>
        p.agentId === agentId && (!event.cycleId || p.id === event.cycleId),
    );
    if (!p) return none;
    const s = await this.store.safety.load(p.machineId, this.now()),
      h = s.admission.data.host;
    if (
      !h ||
      h.status !== "active" ||
      h.currentBootId !== event.bootId ||
      h.agentSessionEpoch !== event.sessionEpoch ||
      s.context.controllerEpoch !== event.controllerEpoch ||
      event.guardHash !== p.guardHash ||
      event.executorHash !== p.executorHash ||
      s.context.admission.observation?.snapshot.osBootId !== event.osBootId
    )
      throw new ApplicationError("conflict");
    if (p.phase === "cancel_pending") {
      // This is the existing ACK of an explicit controller cancel. A new live OS boot can
      // confirm the old shutdown cannot remain pending; it is distinct from an unsolicited fact.
      if (event.event === "cancelled") {
        await this.finishCancellation(s, p);
        return none;
      }
      return {
        action: "cancel",
        cycleId: p.id,
        machineEpoch: p.machineEpoch,
        token: null,
        expiresAtMs: null,
      };
    }
    if (
      event.event === "cancelled" &&
      event.cycleId === p.id &&
      event.osBootId === p.bootId &&
      ["draining", "committing", "shutdown_requested"].includes(p.phase)
    ) {
      await this.finishCancellation(s, p);
      return none;
    }
    if (
      ["idle", "shutdown_requested", "off_expected", "waking"].includes(p.phase)
    )
      return none;
    if (
      !this.fence(s, p, this.grant(p.machineId)) ||
      s.data.demands.some((d) => d.deadlineMs > this.now()) ||
      this.shutdownReasons(s, this.now(), p).length ||
      executionConditionKey(s.context, p) !== p.conditionKey ||
      event.osBootId !== p.bootId
    ) {
      await this.cancel(s, p, "Final controller safety recheck failed");
      return {
        action: "cancel",
        cycleId: p.id,
        machineEpoch: p.machineEpoch,
        token: null,
        expiresAtMs: null,
      };
    }
    if (event.event === "rejected") {
      await this.cancel(s, p, "Host refused local final check");
      return none;
    }
    if (p.phase === "draining") {
      if (event.event === "prepared" && event.token) {
        const n = this.next(p);
        n.phase = "committing";
        n.token = event.token;
        n.tokenExpiresAtMs = this.now() + 5000;
        await this.store.write(s, n, p);
        return {
          action: "commit",
          cycleId: p.id,
          machineEpoch: p.machineEpoch,
          token: n.token,
          expiresAtMs: n.tokenExpiresAtMs,
        };
      }
      return {
        action: "prepare",
        cycleId: p.id,
        machineEpoch: p.machineEpoch,
        token: null,
        expiresAtMs: this.now() + 5000,
      };
    }
    // A commit is delivered once. Poll/retry cannot issue another OS request.
    if (
      event.event === "accepted" &&
      p.phase === "committing" &&
      event.token === p.token &&
      p.tokenExpiresAtMs !== null &&
      this.now() <= p.tokenExpiresAtMs
    ) {
      const n = this.next(p);
      n.phase = "shutdown_requested";
      n.acceptedAtMs = this.now();
      n.acceptedReceiptId = randomUUID();
      n.observedPower = "unknown";
      n.token = null;
      n.tokenExpiresAtMs = null;
      await this.store.write(s, n, p, [
        {
          kind: "run",
          sql: "INSERT INTO agent_receipts(id,command_id,agent_id,agent_boot_id,receipt_sequence,phase,request_hash,result_json,observed_at_ms,received_at_ms) VALUES(?,?,?,?,0,'accepted',?,?,?,?)",
          params: [
            n.acceptedReceiptId,
            p.id,
            p.agentId,
            event.bootId,
            p.bindingHash,
            JSON.stringify({ accepted: true, force: false, cycleId: p.id }),
            this.now(),
            this.now(),
          ],
        },
        this.machine(
          p,
          "power_lifecycle='shutdown_requested',desired_power='off',observed_power='unknown',shutdown_operation_id=?,accepted_shutdown_receipt_id=?,shutdown_accepted_at_ms=?,wake_not_before_ms=?",
          [p.id, n.acceptedReceiptId, n.acceptedAtMs, n.acceptedAtMs + 120000],
        ),
      ]);
      return none;
    }
    return none;
  }
}
