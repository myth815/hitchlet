import { expect, it } from "vitest";
import {
  isReadOnlyObserverChain,
  observerArgvHash,
  observerArtifactPaths,
  observersOnlyReconcileFailure,
  type ObserverProofContext,
} from "../src/host-power-observer.js";
import {
  WorkloadGuardSchema,
  WorkloadInventorySchema,
  workloadReasons,
  type NativeObserverDiagnostic,
} from "../src/host-power.js";

function fixture() {
  const policy = {
    publisherSha256: "a".repeat(64),
    clientSha256: "b".repeat(64),
    collectorSha256: "e".repeat(64),
    collectorArgvSha256: "c".repeat(64),
    enumerationArgvSha256: "d".repeat(64),
    images: {
      wsl_system: "1".repeat(64),
      wsl_store: "2".repeat(64),
      powershell: "3".repeat(64),
      wsl_host: "4".repeat(64),
      conhost: "5".repeat(64),
    },
  };
  const context: ObserverProofContext = {
    policy,
    artifacts: {
      publisherSha256: policy.publisherSha256,
      clientSha256: policy.clientSha256,
      collectorSha256: policy.collectorSha256,
    },
    taskBound: true,
    producerPid: 10,
    producerCreationTicks: "1000",
    ownerSid: "S-1-5-21-1000",
  };
  const proof: NativeObserverDiagnostic = {
    producerPid: 10,
    producerCreationTicks: "1000",
    chain: [
      {
        pid: 11,
        parentPid: 10,
        creationTicks: "1100",
        role: "wsl_system",
        status: "stable",
        ownerSid: context.ownerSid,
        imageSha256: "1".repeat(64),
        argvSha256: policy.collectorArgvSha256,
        argc: 10,
      },
    ],
  };
  return { proof, context };
}
it("recognizes only the exact current collector root, its identical Store redirector, and 0x4 console", () => {
  const { proof, context } = fixture();
  expect(isReadOnlyObserverChain(proof, context)).toBe(true);
  proof.chain.unshift({
    ...proof.chain[0]!,
    pid: 12,
    parentPid: 11,
    creationTicks: "1200",
    role: "wsl_store",
    imageSha256: "2".repeat(64),
  });
  expect(isReadOnlyObserverChain(proof, context)).toBe(true);
  const console = fixture();
  console.proof.chain.unshift({
    ...console.proof.chain[0]!,
    pid: 13,
    parentPid: 11,
    creationTicks: "1200",
    role: "conhost",
    imageSha256: "5".repeat(64),
    argc: 2,
    argvSha256: observerArgvHash(["0x4"]),
  });
  expect(isReadOnlyObserverChain(console.proof, console.context)).toBe(true);
});
it.each([
  "no_policy",
  "source",
  "client",
  "collector_source",
  "task",
  "publisher_reuse",
  "sid",
  "parent",
  "image",
  "argc",
  "argv",
  "changed",
  "unavailable",
  "early_child",
] as const)("holds when %s evidence changes", (kind) => {
  const { proof, context } = fixture(),
    p = proof.chain[0]!;
  if (kind === "no_policy") context.policy = undefined;
  if (kind === "source") context.artifacts!.publisherSha256 = "e".repeat(64);
  if (kind === "client") context.artifacts!.clientSha256 = "e".repeat(64);
  if (kind === "collector_source")
    context.artifacts!.collectorSha256 = "a".repeat(64);
  if (kind === "task") context.taskBound = false;
  if (kind === "publisher_reuse") context.producerCreationTicks = "1001";
  if (kind === "sid") p.ownerSid = "S-1-5-21-2000";
  if (kind === "parent") p.parentPid = 9;
  if (kind === "image") p.imageSha256 = "e".repeat(64);
  if (kind === "argc") p.argc++;
  if (kind === "argv") p.argvSha256 = "e".repeat(64);
  if (kind === "changed") p.status = "changed";
  if (kind === "unavailable") p.status = "unavailable";
  if (kind === "early_child") p.creationTicks = "999";
  expect(isReadOnlyObserverChain(proof, context)).toBe(false);
});
it("does not inherit permission to a user command or an unproved host/console command", () => {
  for (const role of ["powershell", "wsl_host", "conhost"] as const) {
    const { proof, context } = fixture();
    proof.chain.unshift({
      ...proof.chain[0]!,
      pid: 12,
      parentPid: 11,
      creationTicks: "1200",
      role,
      imageSha256: context.policy!.images[role],
      argvSha256: "e".repeat(64),
      argc: 3,
    });
    expect(isReadOnlyObserverChain(proof, context)).toBe(false);
  }
});
it("never erases a prior, missing, truncated or other reconcile failure", () => {
  const { proof, context } = fixture(),
    own = { kind: "new_instance", pid: 11, parentPid: 10, observer: proof };
  expect(observersOnlyReconcileFailure(true, 1, [own], context)).toBe(true);
  expect(observersOnlyReconcileFailure(false, 1, [own], context)).toBe(false);
  expect(observersOnlyReconcileFailure(undefined, 1, [own], context)).toBe(
    false,
  );
  expect(observersOnlyReconcileFailure(true, 2, [own], context)).toBe(false);
  expect(
    observersOnlyReconcileFailure(
      true,
      2,
      [own, { kind: "live_read_failed", pid: 20, parentPid: 1 }],
      context,
    ),
  ).toBe(false);
  expect(observersOnlyReconcileFailure(true, 2, [own, own], context)).toBe(
    false,
  );
  expect(
    observersOnlyReconcileFailure(
      true,
      1,
      [{ ...own, parentPid: 99 }],
      context,
    ),
  ).toBe(false);
});
it("keeps no arguments distinct from a single empty argument", () => {
  expect(observerArgvHash([])).not.toBe(observerArgvHash([""]));
});
it("reads observer artifacts only from the approved literal module/config task action", () => {
  expect(
    observerArtifactPaths(
      '"C:\\Observer\\dist\\host-wsl-publisher.js" "C:\\Observer\\config.json"',
    ),
  ).toEqual({
    publisher: "C:\\Observer\\dist\\host-wsl-publisher.js",
    client: "C:\\Observer\\dist\\host-wsl-client.js",
    collector: "C:\\Observer\\dist\\host-wsl-linux.js",
  });
  for (const args of [
    '"C:\\Observer\\dist\\host-wsl-publisher.js" "C:\\Observer\\config.json" --extra',
    '-e "arbitrary program"',
    '"C:\\Observer\\dist\\other.js" "C:\\Observer\\config.json"',
  ])
    expect(observerArtifactPaths(args)).toBeUndefined();
});
function hostFixture() {
  const { proof, context } = fixture(),
    vm = "f".repeat(64),
    keeperArgv = "9".repeat(64);
  const root = proof.chain[0]!;
  const hostArguments = {
    shapeMatches: true,
    distributionMatches: true,
    vmGuidSha256: vm,
  };
  proof.chain.unshift({
    ...root,
    pid: 12,
    parentPid: 11,
    creationTicks: "1200",
    role: "wsl_store",
    imageSha256: "2".repeat(64),
  });
  proof.chain.unshift({
    ...root,
    pid: 13,
    parentPid: 12,
    creationTicks: "1300",
    role: "wsl_host",
    imageSha256: "4".repeat(64),
    argc: 11,
    argvSha256: "8".repeat(64),
    wslHostArguments: hostArguments,
  });
  context.keeper = { pid: 20, creationTicks: "1050", argvSha256: keeperArgv };
  proof.keeperReference = {
    pid: 20,
    creationTicks: "1050",
    vmGuidSha256: vm,
    chain: [
      {
        ...root,
        pid: 22,
        parentPid: 21,
        creationTicks: "1070",
        role: "wsl_host",
        imageSha256: "4".repeat(64),
        argc: 11,
        argvSha256: "7".repeat(64),
        wslHostArguments: { ...hostArguments },
      },
      {
        ...root,
        pid: 21,
        parentPid: 20,
        creationTicks: "1060",
        role: "wsl_store",
        imageSha256: "2".repeat(64),
        argvSha256: keeperArgv,
      },
      {
        ...root,
        pid: 20,
        parentPid: 10,
        creationTicks: "1050",
        argvSha256: keeperArgv,
      },
    ],
  };
  return { proof, context };
}
it("binds a fixed collector host to the current exact keeper VM and keeps its 0x4 console finite", () => {
  const { proof, context } = hostFixture();
  expect(isReadOnlyObserverChain(proof, context)).toBe(true);
  proof.chain.unshift({
    ...proof.chain[0]!,
    pid: 14,
    parentPid: 13,
    creationTicks: "1400",
    role: "conhost",
    imageSha256: "5".repeat(64),
    argc: 2,
    argvSha256: observerArgvHash(["0x4"]),
  });
  expect(isReadOnlyObserverChain(proof, context)).toBe(true);
});
it.each([
  "vm",
  "distro",
  "embedding",
  "missing_reference",
  "keeper_reuse",
  "keeper_command",
  "host_read_failed",
  "user_child",
] as const)("keeps host %s unproved", (key) => {
  const { proof, context } = hostFixture(),
    host = proof.chain[0]!;
  if (key === "vm") host.wslHostArguments!.vmGuidSha256 = "a".repeat(64);
  if (key === "distro") host.wslHostArguments!.distributionMatches = false;
  if (key === "embedding") {
    host.argc = 2;
    host.wslHostArguments!.shapeMatches = false;
  }
  if (key === "missing_reference") delete proof.keeperReference;
  if (key === "keeper_reuse") context.keeper!.creationTicks = "1051";
  if (key === "keeper_command")
    proof.keeperReference!.chain[2]!.argvSha256 = "a".repeat(64);
  if (key === "host_read_failed") host.status = "unavailable";
  if (key === "user_child")
    proof.chain.unshift({
      ...host,
      pid: 14,
      parentPid: 13,
      creationTicks: "1400",
      role: "powershell",
      imageSha256: "3".repeat(64),
      argc: 5,
    });
  expect(isReadOnlyObserverChain(proof, context)).toBe(false);
});

function integratedFixture() {
  const f = fixture(),
    owner = f.context.ownerSid,
    runtime = "6".repeat(64),
    now = 10000;
  const guard = WorkloadGuardSchema.parse({
    version: 1,
    acknowledgement:
      "Only reviewed Windows system services run; all other work is stopped",
    systemExecutables: [{ name: "svchost.exe", sha256: "7".repeat(64) }],
    systemServices: [],
    ownedRuntime: { executable: "E:\\Hitchlet\\node.exe", sha256: runtime },
    agentTask: {
      path: "\\Power",
      executable: "E:\\Hitchlet\\node.exe",
      arguments: "run",
    },
    wslObservation: {
      file: "C:\\Private\\receipt.json",
      producerTask: "\\ComputeNode",
      definitionSha256: "8".repeat(64),
      ownerSid: owner,
      readonlyObserver: f.context.policy,
    },
  });
  const process = (
    pid: number,
    parentPid: number,
    name: string,
    path: string,
    sha256: string,
    creationTicks: string,
  ) => ({
    pid,
    parentPid,
    name,
    path,
    sha256,
    creationTicks,
    ownerSid: owner,
    microsoftSigned: true,
    signerThumbprint: "9".repeat(40),
  });
  const inventory = WorkloadInventorySchema.parse({
    bootRecordId: "1",
    bootTime: "2026-10-20T10:00:00.0000000Z",
    complete: true,
    wslRunning: true,
    runningDistributions: [],
    services: [],
    runningTasks: [
      {
        path: "\\ComputeNode",
        executable: guard.ownedRuntime!.executable,
        arguments:
          '"C:\\Observer\\dist\\host-wsl-publisher.js" "C:\\Observer\\config.json"',
        definitionSha256: "8".repeat(64),
        principalId: owner,
        enginePid: 10,
      },
    ],
    processes: [
      process(
        10,
        4,
        "node.exe",
        guard.ownedRuntime!.executable,
        runtime,
        "1000",
      ),
      process(
        11,
        10,
        "wsl.exe",
        "C:\\Windows\\System32\\wsl.exe",
        "1".repeat(64),
        "1100",
      ),
      process(
        43,
        4,
        "wslhost.exe",
        "C:\\Program Files\\WSL\\wslhost.exe",
        "4".repeat(64),
        "1000",
      ),
    ],
    observerCandidates: [f.proof],
  });
  const receipt = {
    observedAt: new Date(now).toISOString(),
    producerPid: 10,
    producerStartedTicks: "1001",
    ownerSid: owner,
    runningDistributions: [],
    workloads: [],
    keeper: { pid: 44, startedTicks: "1001" },
  };
  const reasons = () =>
    workloadReasons(
      guard,
      inventory,
      43,
      100,
      [],
      receipt,
      now,
      f.context.artifacts,
    );
  return { ...f, guard, inventory, receipt, reasons };
}
it("wires the exact opt-in proof into normal inventory without exempting a real child workload", () => {
  const f = integratedFixture();
  expect(f.reasons()).not.toContain("unapproved_native_process");
  // This intentionally minimal fixture has no distro coverage. Own observer proof must not erase it.
  expect(f.reasons()).toContain("wsl_distribution_coverage_incomplete");
  f.inventory.processes.push({
    ...f.inventory.processes[1]!,
    pid: 99,
    parentPid: 11,
    name: "node.exe",
    path: "C:\\User\\node.exe",
  });
  expect(f.reasons()).toContain("unapproved_native_process");
});
it("recovers only the observer-only reconciliation gap after formally validating the same receipt", () => {
  const f = integratedFixture();
  f.inventory.complete = false;
  f.inventory.reconciliation = {
    completeBefore: true,
    completeAfter: false,
    diagnosticCount: 1,
  };
  f.inventory.diagnostics = [
    {
      kind: "new_instance",
      pid: 11,
      parentPid: 10,
      name: "wsl.exe",
      observer: f.proof,
    },
  ];
  expect(f.reasons()).not.toContain("workload_inventory_incomplete");
  f.inventory.reconciliation.completeBefore = false;
  expect(f.reasons()).toContain("workload_inventory_incomplete");
  f.inventory.reconciliation.completeBefore = true;
  f.receipt.observedAt = new Date(0).toISOString();
  expect(f.reasons()).toEqual(
    expect.arrayContaining([
      "wsl_receipt_invalid",
      "workload_inventory_incomplete",
      "unapproved_native_process",
    ]),
  );
});
it.each([
  "policy",
  "artifact",
  "owner",
  "instance",
  "other_diagnostic",
] as const)(
  "retains original protection with changed %s at the integration boundary",
  (kind) => {
    const f = integratedFixture();
    f.inventory.complete = false;
    f.inventory.reconciliation = {
      completeBefore: true,
      completeAfter: false,
      diagnosticCount: 1,
    };
    f.inventory.diagnostics = [
      {
        kind: "new_instance",
        pid: 11,
        parentPid: 10,
        name: "wsl.exe",
        observer: f.proof,
      },
    ];
    if (kind === "policy") delete f.guard.wslObservation!.readonlyObserver;
    if (kind === "artifact") f.context.artifacts!.clientSha256 = "f".repeat(64);
    if (kind === "owner") f.inventory.processes[0]!.ownerSid = "S-1-5-18";
    if (kind === "instance") f.inventory.processes[1]!.creationTicks = "1200";
    if (kind === "other_diagnostic")
      f.inventory.diagnostics[0]!.kind = "live_read_failed";
    const result = f.reasons();
    expect(result).toContain("workload_inventory_incomplete");
    if (kind !== "other_diagnostic")
      expect(result).toContain("unapproved_native_process");
  },
);
