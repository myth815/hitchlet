import { z } from "zod";
import {
  runningWslSchema,
  wslWorkloadSchema,
  wslKeeperProofSchema,
} from "./host-wsl.js";
export const wslReceiptPolicySchema = z
  .object({
    file: z.string().regex(/^[A-Za-z]:\\/),
    producerTask: z.string().startsWith("\\"),
    definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    ownerSid: z.string().regex(/^S-1-5-[0-9-]+$/),
    readonlyObserver: z
      .object({
        publisherSha256: z.string().regex(/^[a-f0-9]{64}$/),
        clientSha256: z.string().regex(/^[a-f0-9]{64}$/),
        collectorSha256: z.string().regex(/^[a-f0-9]{64}$/),
        collectorArgvSha256: z.string().regex(/^[a-f0-9]{64}$/),
        enumerationArgvSha256: z.string().regex(/^[a-f0-9]{64}$/),
        images: z
          .object({
            powershell: z.string().regex(/^[a-f0-9]{64}$/),
            wsl_system: z.string().regex(/^[a-f0-9]{64}$/),
            wsl_store: z.string().regex(/^[a-f0-9]{64}$/),
            wsl_host: z.string().regex(/^[a-f0-9]{64}$/),
            conhost: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const wslReceiptSchema = z
  .object({
    observedAt: z.string().datetime(),
    producerPid: z.number().int().positive(),
    producerStartedTicks: z.string().regex(/^\d+$/),
    ownerSid: z.string(),
    runningDistributions: z.array(runningWslSchema).max(16),
    workloads: z.array(wslWorkloadSchema.nullable()).max(16),
    keeper: z
      .object({
        pid: z.number().int().positive(),
        startedTicks: z.string().regex(/^\d+$/),
        native: wslKeeperProofSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type WslReceipt = z.infer<typeof wslReceiptSchema>;
/** A local native file is trusted only as output from the exact existing user task. */
export function validateWslReceipt(
  raw: unknown,
  policy: z.infer<typeof wslReceiptPolicySchema>,
  inventory: {
    processes: readonly {
      pid: number;
      parentPid: number;
      ownerSid: string;
      creationTicks: string;
      path: string;
      sha256: string;
    }[];
    runningTasks: readonly {
      path: string;
      definitionSha256: string;
      principalId: string;
      enginePid: number;
      loadedActionVerified: boolean;
    }[];
  },
  ownedRuntime: { executable: string; sha256: string } | undefined,
  now: number,
) {
  const r = wslReceiptSchema.parse(raw);
  const matches = (native: string, expected: string) =>
    native.length === expected.length &&
    native.endsWith("0") &&
    native.slice(0, -1) === expected.slice(0, -1);
  if (
    !ownedRuntime ||
    r.ownerSid !== policy.ownerSid ||
    now < Date.parse(r.observedAt) ||
    now - Date.parse(r.observedAt) > 5000
  )
    throw Error("wsl_receipt_stale_or_unbound");
  const p = inventory.processes.find((p) => p.pid === r.producerPid);
  if (
    !p ||
    p.ownerSid !== policy.ownerSid ||
    !matches(p.creationTicks, r.producerStartedTicks) ||
    p.path.toLowerCase() !== ownedRuntime.executable.toLowerCase() ||
    p.sha256 !== ownedRuntime.sha256
  )
    throw Error("wsl_receipt_producer_changed");
  if (
    !inventory.runningTasks.some(
      (t) =>
        t.path === policy.producerTask &&
        t.definitionSha256 === policy.definitionSha256 &&
        t.principalId === policy.ownerSid &&
        t.enginePid === p.pid,
    )
  )
    throw Error("wsl_receipt_task_changed");
  const owners = inventory.processes
    .filter((p) => /\\wsl(?:host|relay)\.exe$/i.test(p.path))
    .map((p) => p.ownerSid);
  if (!owners.length || owners.some((s) => s !== policy.ownerSid))
    throw Error("wsl_owner_coverage_incomplete");
  return r;
}
