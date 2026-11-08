import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage, type Storage } from "../dist/storage/index.js";
import { HitchletClient } from "../../../packages/sdk/src/index.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MaintenanceHoldService } from "../src/application/maintenance-holds.js";
import { loadMachineAdmission } from "../src/storage/human-use-guard.js";
import { evaluateMachineAdmission } from "../src/domain/human-use.js";
import { SQLitePowerStore } from "../src/storage/power-store.js";
import { shutdownReasons } from "../src/domain/power.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hitchlet-maintenance-holds-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve("dist/init-simulator.js")],
    { env: { ...process.env, DATA_DIR: dir } },
  );
  const adminToken = stdout.match(
    /Initial admin bearer token \(shown once\): (\S+)/,
  )![1]!;
  const holderToken = stdout.match(/Bearer token \(shown once\): (\S+)/)![1]!;
  const db = await openStorage(dir);
  cleanup.push(() => db.close());
  const machine = await db.get<{ id: string }>(
    "SELECT id FROM machines LIMIT 1",
  );
  const node = await db.get<{ id: string }>(
    "SELECT id FROM nodes WHERE machine_id=? LIMIT 1",
    [machine!.id],
  );
  const holder = await db.get<{ id: string; authorization_json: string }>(
    "SELECT id,authorization_json FROM consumers WHERE role='consumer' LIMIT 1",
  );
  const authorization = JSON.parse(holder!.authorization_json) as Record<
    string,
    unknown
  >;
  authorization.nodeIds = [node!.id];
  await db.run("UPDATE consumers SET authorization_json=? WHERE id=?", [
    JSON.stringify(authorization),
    holder!.id,
  ]);
  await db.run(
    "UPDATE machines SET admission='enabled',observed_power='on',power_lifecycle='idle' WHERE id=?",
    [machine!.id],
  );
  const app = await buildApp(
    loadConfig({ DATA_DIR: dir, GUI_DIR: "/no-gui", LOG_LEVEL: "silent" }),
    { storage: db },
  );
  cleanup.push(() => app.close());
  const client = (token: string) =>
    new HitchletClient("https://controller.test", {
      auth: { kind: "bearer", token },
      fetch: async (input, init) => {
        const response = await app.inject({
          url: new URL(String(input)).pathname,
          method: init?.method as "GET" | "PUT" | "POST",
          headers: Object.fromEntries(new Headers(init?.headers)),
          ...(init?.body ? { payload: String(init.body) } : {}),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
    });
  return {
    app,
    db,
    machineId: machine!.id,
    nodeId: node!.id,
    holderId: holder!.id,
    holderToken,
    holder: client(holderToken),
    other: client(adminToken),
  };
}

async function insertPowerOperation(
  db: Storage,
  machineId: string,
  phase: "idle" | "draining" | "committing",
  now: number,
  epoch = 1,
) {
  const id = randomUUID(),
    agentId = randomUUID(),
    row = {
      id,
      machineId,
      agentId,
      version: 1,
      qualification: false,
      bindingHash: "binding-hash",
      guardHash: "guard-hash",
      executorHash: "a".repeat(64),
      phase,
      machineEpoch: epoch,
      controllerEpoch: 1,
      machineVersion: epoch,
      bootId: randomUUID(),
      conditionKey: "old-condition-key",
      idleSinceMs: phase === "idle" ? now - 60_000 : null,
      lastEvaluationAtMs: now - 30_000,
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
      reasons: [],
      createdAtMs: now - 60_000,
      updatedAtMs: now - 30_000,
    };
  await db.run(
    "INSERT INTO operations(id,machine_id,machine_epoch,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,result_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,1,'power.execution',?,?,'running',?,?,?,?,?,?)",
    [
      id,
      machineId,
      epoch,
      id,
      `power.execution:${id}`,
      "0".repeat(64),
      JSON.stringify({}),
      JSON.stringify(row),
      now,
      now - 60_000,
      now - 30_000,
    ],
  );
  return { id, agentId, row };
}

describe("collaborator maintenance Holds", () => {
  it("is owner-bound and idempotent, protects power without adding an admission veto, and remains explicitly releasable", async () => {
    const f = await fixture(),
      holdId = randomUUID(),
      key = randomUUID();
    const first = await f.holder.admin.acquireMaintenanceHold(
      f.machineId,
      holdId,
      { reason: "Collaborator maintenance" },
      key,
    );
    const replay = await f.holder.admin.acquireMaintenanceHold(
      f.machineId,
      holdId,
      { reason: "Collaborator maintenance" },
      key,
    );
    const reasserted = await f.holder.admin.acquireMaintenanceHold(
      f.machineId,
      holdId,
      { reason: "Collaborator maintenance" },
      randomUUID(),
    );
    expect(first).toEqual(replay);
    expect(first).toEqual(reasserted);
    expect(first).toMatchObject({
      id: holdId,
      machineId: f.machineId,
      createdByConsumerId: f.holderId,
      reason: "Collaborator maintenance",
      expiresAtMs: null,
      releasedAtMs: null,
      state: "active",
    });
    expect(await f.holder.admin.maintenanceHolds(f.machineId)).toEqual([first]);
    await expect(
      f.other.admin.maintenanceHold(f.machineId, holdId),
    ).rejects.toThrow();
    await expect(
      f.other.admin.releaseMaintenanceHold(f.machineId, holdId, randomUUID()),
    ).rejects.toThrow();
    await expect(
      f.holder.admin.acquireMaintenanceHold(
        f.machineId,
        holdId,
        { reason: "Different reason" },
        randomUUID(),
      ),
    ).rejects.toThrow();

    const forgedOwner = await f.app.inject({
      url: `/v1/machines/${f.machineId}/maintenance-holds/${randomUUID()}`,
      method: "PUT",
      headers: {
        authorization: `Bearer ${f.holderToken}`,
        "idempotency-key": randomUUID(),
      },
      payload: { reason: "forged", createdByConsumerId: f.holderId },
    });
    expect(forgedOwner.statusCode).toBe(422);
    const ignoredReleaseBody = await f.app.inject({
      url: `/v1/machines/${f.machineId}/maintenance-holds/${holdId}/release`,
      method: "POST",
      headers: { authorization: `Bearer ${f.holderToken}` },
      payload: { unexpected: true },
    });
    expect(ignoredReleaseBody.statusCode).toBe(422);
    expect(await f.holder.admin.maintenanceHold(f.machineId, holdId)).toEqual(
      first,
    );

    const snapshot = await loadMachineAdmission(f.db, f.machineId, Date.now()),
      admission = evaluateMachineAdmission(
        snapshot.context,
        Date.now(),
        f.nodeId,
      ),
      withoutNewHold = evaluateMachineAdmission(
        {
          ...snapshot.context,
          holds: snapshot.context.holds.filter((hold) => hold.id !== holdId),
        },
        Date.now(),
        f.nodeId,
      ),
      power = await new SQLitePowerStore(f.db).load(f.machineId, Date.now());
    expect(admission.reasonCodes).not.toContain("machine_hold");
    expect(admission.reasonCodes).toEqual(withoutNewHold.reasonCodes);
    expect(shutdownReasons(power.context, Date.now())).toContain(
      `Hold: ${holdId}: Collaborator maintenance`,
    );

    const grant = await f.db.get<{ authorization_json: string }>(
      "SELECT authorization_json FROM consumers WHERE id=?",
      [f.holderId],
    );
    const revoked = JSON.parse(grant!.authorization_json) as Record<
      string,
      unknown
    >;
    revoked.nodeIds = [];
    await f.db.run("UPDATE consumers SET authorization_json=? WHERE id=?", [
      JSON.stringify(revoked),
      f.holderId,
    ]);
    await expect(
      f.holder.admin.acquireMaintenanceHold(
        f.machineId,
        randomUUID(),
        { reason: "No current machine grant" },
        randomUUID(),
      ),
    ).rejects.toThrow();
    const releaseKey = randomUUID(),
      released = await f.holder.admin.releaseMaintenanceHold(
        f.machineId,
        holdId,
        releaseKey,
      ),
      repeated = await f.holder.admin.releaseMaintenanceHold(
        f.machineId,
        holdId,
        randomUUID(),
      );
    expect(released).toMatchObject({ state: "released", id: holdId });
    expect(repeated).toEqual(released);
    expect(await f.holder.admin.maintenanceHold(f.machineId, holdId)).toEqual(
      released,
    );
    await expect(
      f.holder.admin.acquireMaintenanceHold(
        f.machineId,
        holdId,
        { reason: "Collaborator maintenance" },
        randomUUID(),
      ),
    ).rejects.toThrow();
  });

  it("refuses acquisition after power commit may have been issued", async () => {
    const f = await fixture(),
      now = Date.now();
    const service = new MaintenanceHoldService(f.db, () => now);
    await f.db.run("UPDATE machines SET power_lifecycle='unknown' WHERE id=?", [
      f.machineId,
    ]);
    await expect(
      service.acquire({
        machineId: f.machineId,
        holdId: randomUUID(),
        body: { reason: "Unknown power state" },
        actor: { consumerId: f.holderId, scopes: ["tickets:write"] },
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.db.run("UPDATE machines SET power_lifecycle='idle' WHERE id=?", [
      f.machineId,
    ]);
    await insertPowerOperation(f.db, f.machineId, "committing", now);
    await expect(
      service.acquire({
        machineId: f.machineId,
        holdId: randomUUID(),
        body: { reason: "In-flight maintenance" },
        actor: { consumerId: f.holderId, scopes: ["tickets:write"] },
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      Number(
        (
          await f.db.get<{ count: bigint }>(
            "SELECT count(*) AS count FROM holds WHERE machine_id=? AND kind='manual' AND substr(reason,1,?)='[collaborator-maintenance:'",
            [f.machineId, "[collaborator-maintenance:".length],
          )
        )?.count,
      ),
    ).toBe(0);
  });

  it("cancels a pre-commit drain before confirming a new Hold", async () => {
    const f = await fixture(),
      now = Date.now(),
      holdId = randomUUID();
    await f.db.run(
      "UPDATE machines SET admission='draining',power_lifecycle='draining',machine_epoch=2,version=2 WHERE id=?",
      [f.machineId],
    );
    const operation = await insertPowerOperation(
      f.db,
      f.machineId,
      "draining",
      now,
      2,
    );
    const receipt = await f.holder.admin.acquireMaintenanceHold(
      f.machineId,
      holdId,
      { reason: "Stop before commit" },
      randomUUID(),
    );
    expect(receipt.state).toBe("active");
    const result = await f.db.get<{ result_json: string; state: string }>(
      "SELECT result_json,state FROM operations WHERE id=?",
      [operation.id],
    );
    expect(result!.state).toBe("cancelled");
    expect(JSON.parse(result!.result_json)).toMatchObject({
      phase: "cancelled",
    });
    expect(
      await f.db.get<{ admission: string; power_lifecycle: string }>(
        "SELECT admission,power_lifecycle FROM machines WHERE id=?",
        [f.machineId],
      ),
    ).toMatchObject({ admission: "enabled", power_lifecycle: "idle" });
  });

  it("resets an unobserved idle timer in the same release transaction", async () => {
    const f = await fixture(),
      now = Date.now(),
      holdId = randomUUID();
    const operation = await insertPowerOperation(
        f.db,
        f.machineId,
        "idle",
        now,
      ),
      service = new MaintenanceHoldService(f.db, () => now),
      actor = { consumerId: f.holderId, scopes: ["tickets:write"] };
    await service.acquire({
      machineId: f.machineId,
      holdId,
      body: { reason: "Short collaborator task" },
      actor,
      requestId: randomUUID(),
    });
    const receipts = await Promise.all(
      [randomUUID(), randomUUID()].map((requestId) =>
        service.release({
          machineId: f.machineId,
          holdId,
          actor,
          requestId,
        }),
      ),
    );
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]?.state).toBe("released");
    const updated = await f.db.get<{
      version: bigint;
      result_json: string;
    }>("SELECT version,result_json FROM operations WHERE id=?", [operation.id]);
    const result = JSON.parse(updated!.result_json) as Record<string, unknown>;
    expect(Number(updated!.version)).toBe(2);
    expect(result).toMatchObject({
      version: 2,
      idleSinceMs: null,
      conditionKey: `maintenance-hold-release:${holdId}`,
    });
    expect(
      Number(
        (
          await f.db.get<{ count: bigint }>(
            "SELECT count(*) AS count FROM events WHERE aggregate_type='power_execution' AND aggregate_id=? AND event_type='power.execution_updated'",
            [operation.id],
          )
        )?.count,
      ),
    ).toBe(1);
  });
});
