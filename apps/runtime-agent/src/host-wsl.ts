import { z } from "zod";
import { createHash } from "node:crypto";
import {
  runtimeNativeContextSchema,
  runtimeNativeWorkloadSchema,
  runtimeContainerWorkloadSchema,
  runtimeBackgroundServiceSchema,
} from "@hitchlet/contracts/internal";

/** Opt-in identity for WSL's own systemd user-session PTYs, not user terminals. */
export const wslSystemdSessionPolicySchema = z
  .object({
    initSha256: z.string().regex(/^[a-f0-9]{64}$/),
    loginExecutable: z.string().startsWith("/"),
    loginSha256: z.string().regex(/^[a-f0-9]{64}$/),
    users: z
      .array(
        z
          .object({
            uid: z.number().int().nonnegative(),
            shellExecutable: z.string().startsWith("/"),
            shellSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(16)
      .refine(
        (users) => new Set(users.map((u) => u.uid)).size === users.length,
      ),
  })
  .strict();
export type WslSystemdSessionPolicy = z.infer<
  typeof wslSystemdSessionPolicySchema
>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const wslKeeperPolicySchema = z
  .object({
    uid: z.number().int().nonnegative(),
    nodeExecutable: z.string().startsWith("/"),
    nodeSha256: digest,
    helperSha256: digest,
    initSha256: digest,
  })
  .strict();
export const wslKeeperProofSchema = z
  .object({
    pid: z.number().int().positive(),
    parentPid: z.number().int().positive(),
    uid: z.number().int().nonnegative(),
    startTicks: z.string().regex(/^\d+$/),
    executable: z.string().startsWith("/"),
    pidNamespace: z.string(),
    bootId: z.string().uuid(),
    distributionMachineId: z.string().regex(/^[a-f0-9]{32}$/),
    nodeSha256: digest,
    helperSha256: digest,
    nodeFile: z
      .object({
        dev: z.number().int().nonnegative(),
        ino: z.number().int().nonnegative(),
        size: z.number().int().positive(),
        mtimeMs: z.number(),
        ctimeMs: z.number(),
      })
      .strict(),
  })
  .strict();
export type WslKeeperPolicy = z.infer<typeof wslKeeperPolicySchema>;
export type WslKeeperProof = z.infer<typeof wslKeeperProofSchema>;
const fixedManagementBinary = z
  .object({
    executable: z.string().startsWith("/"),
    sha256: digest,
    file: z
      .object({
        dev: z.number().int().nonnegative(),
        ino: z.number().int().nonnegative(),
        size: z.number().int().positive(),
        mtimeMs: z.number(),
        ctimeMs: z.number(),
        uid: z.number().int().nonnegative(),
        mode: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const wslManagementPolicySchema = z
  .object({
    wslBase: fixedManagementBinary.optional(),
    systemdPam: fixedManagementBinary.optional(),
    udevWorkers: fixedManagementBinary.optional(),
    unattendedShutdown: z
      .object({ python: fixedManagementBinary, script: fixedManagementBinary })
      .strict()
      .optional(),
    rootlessDocker: z
      .object({
        uid: z.number().int().nonnegative(),
        unit: z.literal("docker.service"),
        rootlesskit: fixedManagementBinary,
        slirp: fixedManagementBinary,
        dockerd: fixedManagementBinary,
        containerd: fixedManagementBinary,
        shim: fixedManagementBinary.optional(),
        proxy: fixedManagementBinary.optional(),
        containerdAddress: z.string().startsWith("/run/user/"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WslManagementPolicy = z.infer<typeof wslManagementPolicySchema>;
export type WslManagementBinary = z.infer<typeof fixedManagementBinary>;

export const wslBindingSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    registrationId: z.string().uuid(),
    distributionMachineId: z.string().regex(/^[a-f0-9]{32}$/),
    collectorPath: z
      .string()
      .regex(/^\/opt\/hitchlet-observers\/[A-Za-z0-9._-]+\/host-wsl-linux\.js$/)
      .default("/opt/hitchlet-observers/native-workload/host-wsl-linux.js"),
    backgroundServices: z
      .array(runtimeBackgroundServiceSchema)
      .max(64)
      .optional(),
    systemdUserSessions: wslSystemdSessionPolicySchema.optional(),
    keeper: wslKeeperPolicySchema.optional(),
    management: wslManagementPolicySchema.optional(),
    engines: z
      .array(
        z
          .object({
            nativeEngineId: z.string().min(1).max(256),
            dockerHost: z.string().startsWith("unix:///").max(4096),
            backgroundContainers: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-f0-9]{64}$/),
                    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
                    uid: z.number().int().nonnegative(),
                    executable: z.string().startsWith("/").max(4096),
                  })
                  .strict(),
              )
              .max(16)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type WslBinding = z.infer<typeof wslBindingSchema>;
export const runningWslSchema = z
  .object({ name: z.string(), registrationId: z.string().uuid() })
  .strict();
export const wslWorkloadSchema = z
  .object({
    name: z.string(),
    registrationId: z.string().uuid(),
    observedAt: z.string().datetime(),
    bindingHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    before: runtimeNativeContextSchema,
    after: runtimeNativeContextSchema,
    native: runtimeNativeWorkloadSchema,
    engines: z
      .array(
        z
          .object({
            nativeEngineId: z.string(),
            complete: z.boolean(),
            containers: z.array(runtimeContainerWorkloadSchema).max(1024),
            backgroundContainers: z
              .array(
                z
                  .object({
                    id: z.string().regex(/^[a-f0-9]{64}$/),
                    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
                    pid: z.number().int().positive(),
                    startTicks: z.string().regex(/^\d+$/),
                    cgroupBound: z.boolean(),
                  })
                  .strict(),
              )
              .max(16)
              .optional(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type WslWorkload = z.infer<typeof wslWorkloadSchema>;
export const wslBindingHash = (binding: WslBinding) =>
  createHash("sha256").update(JSON.stringify(binding)).digest("hex");

/** An authenticated Host's native observation complements, never replaces, Machine Claims. */
export function wslWorkloadReasons(
  bindings: readonly WslBinding[],
  running: readonly z.infer<typeof runningWslSchema>[],
  raw: unknown,
  now: number,
): string[] {
  const parsed = z.array(wslWorkloadSchema).max(16).safeParse(raw);
  if (!parsed.success) return ["wsl_workload_evidence_missing"];
  if (
    !running.length ||
    new Set(running.map((x) => x.registrationId)).size !== running.length ||
    parsed.data.length !== running.length
  )
    return ["wsl_distribution_coverage_incomplete"];
  const reasons = new Set<string>();
  for (const live of running) {
    const matches = bindings.filter(
      (b) => b.name === live.name && b.registrationId === live.registrationId,
    );
    const facts = parsed.data.filter(
      (f) => f.name === live.name && f.registrationId === live.registrationId,
    );
    if (matches.length !== 1 || facts.length !== 1) {
      reasons.add("wsl_distribution_unbound");
      continue;
    }
    const b = matches[0]!,
      f = facts[0]!;
    if (
      (b.backgroundServices?.length ||
        b.systemdUserSessions !== undefined ||
        b.keeper !== undefined ||
        b.management !== undefined ||
        b.engines.some((e) => e.backgroundContainers?.length)) &&
      f.bindingHash !== wslBindingHash(b)
    )
      reasons.add("wsl_background_policy_changed");
    if (now < Date.parse(f.observedAt) || now - Date.parse(f.observedAt) > 5000)
      reasons.add("wsl_workload_evidence_stale");
    if (
      JSON.stringify(f.before) !== JSON.stringify(f.after) ||
      f.before.distributionMachineId !== b.distributionMachineId ||
      f.native.distributionMachineId !== b.distributionMachineId ||
      f.native.bootId !== f.before.bootId ||
      f.native.namespaces?.pid !== f.before.pidNamespace
    )
      reasons.add("wsl_distribution_identity_changed");
    if (!f.native.complete || f.native.errorCodes.length)
      reasons.add("wsl_native_inventory_incomplete");
    const background = new Set(f.native.backgroundPids);
    if (
      new Set(b.engines.map((e) => e.nativeEngineId)).size !==
        b.engines.length ||
      f.engines.length !== b.engines.length ||
      new Set(f.engines.map((e) => e.nativeEngineId)).size !==
        f.engines.length ||
      b.engines.some(
        (e) => !f.engines.some((a) => a.nativeEngineId === e.nativeEngineId),
      )
    )
      reasons.add("wsl_engine_coverage_incomplete");
    for (const e of f.engines) {
      if (!e.complete) reasons.add("wsl_container_inventory_incomplete");
      const approved = new Set<string>();
      const policy =
        b.engines.find((x) => x.nativeEngineId === e.nativeEngineId)
          ?.backgroundContainers ?? [];
      for (const c of e.containers) {
        const rule = policy.find((p) => p.id === c.id);
        if (
          !rule ||
          !c.running ||
          c.paused ||
          c.allocationId !== null ||
          c.installationId !== null ||
          c.runtimeIdentityId !== null
        )
          continue;
        const proofs =
          e.backgroundContainers?.filter((p) => p.id === c.id) ?? [];
        const proof = proofs[0];
        const native =
          proof &&
          f.native.processes.find(
            (p) => p.pid === proof.pid && p.startTicks === proof.startTicks,
          );
        if (
          proofs.length !== 1 ||
          !proof?.cgroupBound ||
          proof.imageId !== rule.imageId ||
          native?.uid !== rule.uid ||
          native.executable !== rule.executable
        ) {
          reasons.add("wsl_management_identity_unproven");
          continue;
        }
        approved.add(c.id);
        background.add(proof.pid);
      }
      if (
        e.containers.some(
          (c) =>
            !approved.has(c.id) &&
            (c.running || c.paused || c.allocationId !== null),
        )
      )
        reasons.add("wsl_container_work");
    }
    // Only proven MainPIDs/container init processes; arbitrary child jobs remain work.
    if (f.native.processes.some((p) => !background.has(p.pid)))
      reasons.add("wsl_unmanaged_native_work");
  }
  return [...reasons];
}
