import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openStorage } from "../../dist/storage/index.js";
import {
  OperationWorker,
  AllocationCreateCalls,
} from "../../dist/application/operations.js";
import { AdminService } from "../../dist/application/admin.js";
import { SQLiteValidationStore } from "../../dist/storage/validation-store.js";
import { PersistentSimulator } from "../../dist/providers/simulator.js";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const db = await openStorage(input.dir);
const simulator = new PersistentSimulator(join(input.dir, "external"));
const now = () => input.now;
let createCount = 0;
let sendCount = 0;
const execution = {
  inspect: async (plan) => {
    const result = await simulator.inspect(plan);
    if (result.presence === "present" && input.effectName)
      return {
        ...result,
        evidence: {
          ...result.evidence,
          objects: result.evidence.objects.map((item) =>
            item.kind === "network_policy"
              ? {
                  ...item,
                  details: { ...item.details, nativeName: input.effectName },
                }
              : item,
          ),
        },
      };
    return result;
  },
  ready: (plan, inventory) => simulator.ready(plan, inventory),
  revokeStop: (plan) => simulator.revokeStop(plan),
  destroy: (plan, resource) => simulator.destroy(plan, resource),
  create: async (plan, journal) => {
    createCount++;
    if (input.mode === "hold-effect" || input.mode === "unknown-retry") {
      await journal.beforeCreate({
        kind: "network_policy",
        name: input.effectName,
        requestHash: "a".repeat(64),
      });
      sendCount++;
      const op = await db.get("SELECT * FROM operations WHERE id=?", [
        input.operationId,
      ]);
      if (input.mode === "hold-effect") {
        process.send({
          phase: "held",
          effectPlan: plan,
          snapshot: { op, token: op.owner_token },
        });
        await new Promise(() => {});
      }
      throw new Error("Unresolved native create must not be resent");
    }
    const objects = await simulator.create(plan, journal);
    if (input.mode === "hold-create" || input.mode === "hold-effect") {
      const inventory = await simulator.inspect(plan);
      if (inventory.presence !== "present")
        throw new Error("Expected simulated created objects");
      const receipt = await simulator.ready(plan, inventory.evidence);
      const op = await db.get("SELECT * FROM operations WHERE id=?", [
        input.operationId,
      ]);
      process.send({
        phase: "held",
        snapshot: { op, token: op.owner_token, receipt, objects },
      });
      await new Promise(() => {}); // The parent kills this controller process; no remote task is claimed to be fenced.
    }
    return objects;
  },
};
try {
  if (
    input.mode !== "hold-create" &&
    input.mode !== "hold-effect" &&
    input.mode !== "stale-epoch"
  )
    await db.run(
      "UPDATE installations SET controller_epoch=? WHERE singleton=1",
      [input.epoch],
    );
  const worker = new OperationWorker({
    storage: db,
    execution,
    installationId: input.installationId,
    controllerEpoch: input.epoch,
    now,
    createCalls: new AllocationCreateCalls(),
  });
  if (input.mode === "hold-create" || input.mode === "hold-effect") {
    await worker.run(input.operationId);
    throw new Error("Held create unexpectedly finished");
  }
  let lateReadyCode = null;
  let claimed = null;
  if (input.mode === "before-expiry" || input.mode === "unknown-empty") {
    const admin = new AdminService(
      db,
      async () => {
        throw new Error("No Provider probe expected");
      },
      now,
    );
    await admin.cancelValidation(input.validationId);
    if (input.snapshot)
      try {
        await new SQLiteValidationStore(db, now).completeTest({
          validationId: input.validationId,
          ...input.snapshot,
          now: input.now,
        });
      } catch (error) {
        lateReadyCode = error.code;
      }
    const cleanup = await db.get(
      "SELECT id FROM operations WHERE kind='allocation.cleanup' AND allocation_id=?",
      [
        (
          input.snapshot?.op ??
          (await db.get("SELECT allocation_id FROM operations WHERE id=?", [
            input.operationId,
          ]))
        ).allocation_id,
      ],
    );
    await worker.run(cleanup.id);
  } else if (input.mode === "stale-epoch") {
    claimed = await worker.run(input.operationId);
  } else {
    if (input.mode === "materialize-effect") {
      // Represents the original remote request completing after the controller crash.
      // The external simulator writes resources without delivering a controller receipt.
      await simulator.create(input.effectPlan, {
        recordCreated: async () => {},
      });
    }
    await worker.reconcileBeforeScheduling();
  }
  const report = await new SQLiteValidationStore(db, now).getValidation(
    input.validationId,
  );
  const claim = await db.get("SELECT state FROM capacity_claims LIMIT 1");
  const cleanup = await db.get(
    "SELECT result_json FROM operations WHERE kind='allocation.cleanup' LIMIT 1",
  );
  const effectResult = await db.get(
    "SELECT result_json FROM operations WHERE id=?",
    [input.operationId],
  );
  await db.close();
  process.send({
    phase: "done",
    report,
    claim,
    cleanup,
    createCount,
    sendCount,
    effectResultJson: effectResult?.result_json,
    claimed,
    lateReadyCode,
  });
  process.disconnect();
} catch (error) {
  await db.close().catch(() => undefined);
  process.send({ phase: "error", message: error.stack ?? String(error) });
  process.disconnect();
  process.exitCode = 1;
}
