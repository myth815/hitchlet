/** Fixed, read-only WSL native entry. Receives no shell/action/path commands. */
import { readFile, readlink, readdir } from "node:fs/promises";
import { z } from "zod";
import { dirname } from "node:path";
import { LocalEngine } from "./engine.js";
import { collectLinuxWorkloads } from "./workloads.js";
import {
  collectWslSystemdSessionBackground,
  beginWslObserverBridgeObservation,
} from "./host-wsl-platform.js";
import {
  beginWslKeeperObservation,
  collectWslManagementBackground,
  type ManagementContainer,
} from "./host-wsl-management.js";
import {
  wslBindingSchema,
  wslWorkloadSchema,
  wslBindingHash,
  wslKeeperProofSchema,
} from "./host-wsl.js";
import { runtimeNativeContextSchema } from "@hitchlet/contracts/internal";
const input = z
  .object({
    binding: wslBindingSchema,
    before: runtimeNativeContextSchema,
    keeperProof: wslKeeperProofSchema.optional(),
  })
  .strict();
async function main() {
  let raw = "";
  for await (const b of process.stdin) {
    raw += String(b);
    if (raw.length > 65536) throw Error("wsl_input_limit");
  }
  const { binding, before, keeperProof } = input.parse(JSON.parse(raw));
  const started = Date.now();
  const finishObserverBridge = binding.systemdUserSessions
    ? await beginWslObserverBridgeObservation(
        binding.systemdUserSessions.initSha256,
      )
    : undefined;
  const finishKeeper =
    binding.keeper && keeperProof
      ? await beginWslKeeperObservation(
          binding.keeper,
          keeperProof,
          dirname(binding.collectorPath) + "/host-wsl-keeper.js",
        )
      : undefined;
  const native = await collectLinuxWorkloads(
    binding.backgroundServices ?? [],
    Date.now() + 5000,
    before,
  );
  // Only this exact read-only observer is omitted; no descendants/other Node processes.
  native.processes = native.processes.filter((p) => p.pid !== process.pid);
  if (binding.systemdUserSessions)
    native.backgroundPids.push(
      ...(await collectWslSystemdSessionBackground(
        binding.systemdUserSessions,
        native,
      )),
    );
  const engines = [];
  const managementContainers: ManagementContainer[] = [];
  for (const config of binding.engines) {
    const engine = new LocalEngine({
      ...config,
      ipv6SysctlRoot: "/proc/sys/net/ipv6/conf",
    });
    const inventory = await engine.workloadInventory();
    const proofs = [];
    for (const rule of config.backgroundContainers ?? []) {
      if (
        !inventory.containers.some(
          (c) => c.id === rule.id && c.running && !c.paused,
        )
      )
        continue;
      try {
        const proof = await engine.backgroundContainerIdentity(rule.id);
        const process = native.processes.find((p) => p.pid === proof.pid);
        if (!process) throw Error("Management init not in native PID view");
        const cgroup = await readFile(`/proc/${proof.pid}/cgroup`, "utf8");
        const status = await readFile(`/proc/${proof.pid}/status`, "utf8");
        const stat = await readFile(`/proc/${proof.pid}/stat`, "utf8");
        const ticks = stat
          .slice(stat.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/)[19];
        const pids = status
          .match(/^NSpid:\s+(.+)$/m)?.[1]
          ?.trim()
          .split(/\s+/)
          .map(Number);
        const bound =
          cgroup.split(/[\/\n]/).includes(`docker-${rule.id}.scope`) ||
          cgroup.split(/[\/\n]/).includes(rule.id);
        const cgroupBound =
          bound &&
          pids?.[0] === proof.pid &&
          pids.at(-1) === 1 &&
          ticks === process.startTicks &&
          (await readlink(`/proc/${proof.pid}/exe`)) === process.executable;
        proofs.push({
          ...proof,
          startTicks: ticks,
          cgroupBound: cgroupBound,
        });
        if (
          binding.management?.rootlessDocker &&
          cgroupBound &&
          proof.imageId === rule.imageId &&
          process.uid === rule.uid &&
          process.executable === rule.executable
        ) {
          try {
            const detail = await engine.backgroundContainerManagement(rule.id);
            if (
              detail.id === rule.id &&
              detail.imageId === rule.imageId &&
              detail.pid === proof.pid
            )
              managementContainers.push(detail);
          } catch {
            /* Keep unproved management helpers visible as work. */
          }
        }
      } catch {
        inventory.complete = false;
      }
    }
    engines.push({
      nativeEngineId: config.nativeEngineId,
      ...inventory,
      backgroundContainers: proofs,
    });
  }
  const after = runtimeNativeContextSchema.parse({
    distributionMachineId: (await readFile("/etc/machine-id", "utf8")).trim(),
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    pidNamespace: await readlink("/proc/1/ns/pid"),
  });
  if (finishObserverBridge)
    native.backgroundPids.push(...(await finishObserverBridge(native)));
  if (finishKeeper) native.backgroundPids.push(...(await finishKeeper(native)));
  if (binding.management)
    native.backgroundPids.push(
      ...(await collectWslManagementBackground(
        binding,
        native,
        managementContainers,
      )),
    );
  const observed = new Set(native.processes.map((p) => p.pid));
  observed.add(process.pid);
  if (
    (await readdir("/proc")).some(
      (p) => /^[1-9]\d*$/.test(p) && !observed.has(Number(p)),
    )
  ) {
    native.complete = false;
    native.errorCodes.push("native_process_set_changed");
  }
  process.stdout.write(
    JSON.stringify(
      wslWorkloadSchema.parse({
        name: binding.name,
        registrationId: binding.registrationId,
        observedAt: new Date(started).toISOString(),
        bindingHash: wslBindingHash(binding),
        before,
        after,
        native,
        engines,
      }),
    ) + "\n",
  );
}
main().catch(() => {
  process.stderr.write("wsl_workload_observation_failed\n");
  process.exitCode = 1;
});
