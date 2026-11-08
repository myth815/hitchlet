import { createHash } from "node:crypto";
import { win32, posix } from "node:path";
import type {
  NativeObserverDiagnostic,
  WorkloadGuard,
  WorkloadInventory,
} from "./host-power.js";
import type { WslReceipt } from "./host-wsl-receipt.js";

export const observerArgvHash = (tail: readonly string[]) =>
  createHash("sha256")
    .update(tail.length + ":" + tail.join("\0"))
    .digest("hex");

export type ReadOnlyObserverPolicy = NonNullable<
  NonNullable<WorkloadGuard["wslObservation"]>["readonlyObserver"]
>;
export type ObserverProofContext = {
  policy?: ReadOnlyObserverPolicy | undefined;
  artifacts?:
    | { publisherSha256: string; clientSha256: string; collectorSha256: string }
    | undefined;
  taskBound: boolean;
  producerPid: number;
  producerCreationTicks: string;
  ownerSid: string;
  keeper?:
    | { pid: number; creationTicks: string; argvSha256: string }
    | undefined;
};
function stableChain(
  nodes: NativeObserverDiagnostic["chain"],
  c: ObserverProofContext,
) {
  if (
    !nodes.length ||
    nodes.length > 4 ||
    new Set(nodes.map((p) => p.pid)).size !== nodes.length
  )
    return false;
  for (let n = 0; n < nodes.length; n++) {
    const p = nodes[n]!,
      parent = n ? nodes[n - 1]! : undefined;
    if (
      p.pid <= 4 ||
      p.pid === c.producerPid ||
      p.status !== "stable" ||
      p.ownerSid !== c.ownerSid ||
      !p.imageSha256 ||
      !p.argvSha256 ||
      c.policy?.images[p.role] !== p.imageSha256 ||
      p.parentPid !== (parent?.pid ?? c.producerPid) ||
      BigInt(p.creationTicks) <
        BigInt(parent?.creationTicks ?? c.producerCreationTicks)
    )
      return false;
  }
  return true;
}
function boundVm(proof: NativeObserverDiagnostic, c: ObserverProofContext) {
  const ref = proof.keeperReference,
    expected = c.keeper;
  if (
    !ref ||
    !expected ||
    ref.pid !== expected.pid ||
    ref.creationTicks !== expected.creationTicks
  )
    return undefined;
  const nodes = [...ref.chain].reverse();
  if (!stableChain(nodes, c)) return undefined;
  const [root, store, host] = nodes;
  if (
    !root ||
    !store ||
    !host ||
    root.role !== "wsl_system" ||
    root.pid !== expected.pid ||
    root.creationTicks !== expected.creationTicks ||
    root.argc !== 10 ||
    root.argvSha256 !== expected.argvSha256 ||
    store.role !== "wsl_store" ||
    store.argc !== 10 ||
    store.argvSha256 !== expected.argvSha256 ||
    host.role !== "wsl_host" ||
    host.argc !== 11 ||
    !host.wslHostArguments?.shapeMatches ||
    !host.wslHostArguments.distributionMatches ||
    host.wslHostArguments.vmGuidSha256 !== ref.vmGuidSha256
  )
    return undefined;
  return ref.vmGuidSha256;
}
/** Only these complete literal calls are read-only. No child-tree inheritance. */
export function isReadOnlyObserverChain(
  proof: NativeObserverDiagnostic,
  c: ObserverProofContext,
) {
  const policy = c.policy;
  if (
    !policy ||
    !c.taskBound ||
    c.artifacts?.publisherSha256 !== policy.publisherSha256 ||
    c.artifacts?.clientSha256 !== policy.clientSha256 ||
    c.artifacts?.collectorSha256 !== policy.collectorSha256 ||
    proof.producerPid !== c.producerPid ||
    proof.producerCreationTicks !== c.producerCreationTicks ||
    !proof.chain.length ||
    proof.chain.length > 4 ||
    new Set(proof.chain.map((p) => p.pid)).size !== proof.chain.length
  )
    return false;
  const nodes = [...proof.chain].reverse();
  if (!stableChain(nodes, c)) return false;
  const root = nodes[0]!;
  const collector =
    root.role === "wsl_system" &&
    root.argc === 10 &&
    root.argvSha256 === policy.collectorArgvSha256;
  const list =
    root.role === "wsl_system" &&
    root.argc === 4 &&
    root.argvSha256 === observerArgvHash(["--list", "--running", "--quiet"]);
  const enumeration =
    root.role === "powershell" &&
    root.argc === 5 &&
    root.argvSha256 === policy.enumerationArgvSha256;
  if (!collector && !list && !enumeration) return false;
  let kind = collector ? "wsl_collector" : list ? "wsl_list" : "enumeration";
  for (let n = 1; n < nodes.length; n++) {
    const p = nodes[n]!,
      parent = nodes[n - 1]!;
    if (
      p.role === "wsl_system" &&
      kind === "enumeration" &&
      p.argc === 4 &&
      p.argvSha256 === observerArgvHash(["--list", "--running", "--quiet"])
    ) {
      kind = "wsl_list";
      continue;
    }
    if (
      p.role === "wsl_store" &&
      (kind === "wsl_collector" || kind === "wsl_list") &&
      p.argc === parent.argc &&
      p.argvSha256 === parent.argvSha256
    ) {
      kind = kind === "wsl_collector" ? "store_collector" : "store_list";
      continue;
    }
    if (
      p.role === "wsl_host" &&
      kind === "store_collector" &&
      p.argc === 11 &&
      p.wslHostArguments?.shapeMatches &&
      p.wslHostArguments.distributionMatches &&
      p.wslHostArguments.vmGuidSha256 &&
      p.wslHostArguments.vmGuidSha256 === boundVm(proof, c)
    ) {
      kind = "bound_host";
      continue;
    }
    if (
      p.role === "conhost" &&
      ["enumeration", "wsl_collector", "wsl_list", "bound_host"].includes(
        kind,
      ) &&
      p.argc === 2 &&
      p.argvSha256 === observerArgvHash(["0x4"])
    ) {
      kind = "console";
      continue;
    }
    return false;
  }
  return true;
}

/** A pre-existing failure or truncated/other reconcile reason can never be erased by observers. */
export function observersOnlyReconcileFailure(
  completeBefore: boolean | undefined,
  originalReasonCount: number | undefined,
  diagnostics:
    | readonly {
        kind: string;
        pid: number;
        parentPid: number;
        observer?: NativeObserverDiagnostic | undefined;
      }[]
    | undefined,
  c: ObserverProofContext,
) {
  return (
    completeBefore === true &&
    diagnostics !== undefined &&
    diagnostics.length > 0 &&
    originalReasonCount === diagnostics.length &&
    new Set(diagnostics.map((d) => d.pid)).size === diagnostics.length &&
    diagnostics.every(
      (d) =>
        d.kind === "new_instance" &&
        d.observer?.chain[0]?.pid === d.pid &&
        d.observer.chain[0].parentPid === d.parentPid &&
        isReadOnlyObserverChain(d.observer, c),
    )
  );
}

export type ObserverArtifacts = NonNullable<ObserverProofContext["artifacts"]>;
/** The original approved task has exactly a module and JSON config argument, never a shell command. */
export function observerArtifactPaths(argumentsText: string) {
  const m =
    /^"([A-Za-z]:\\[^"\r\n]+\\dist\\host-wsl-publisher\.js)" "[A-Za-z]:\\[^"\r\n]+\.json"$/.exec(
      argumentsText,
    );
  if (!m) return undefined;
  return {
    publisher: m[1]!,
    client: win32.join(win32.dirname(m[1]!), "host-wsl-client.js"),
    collector: win32.join(win32.dirname(m[1]!), "host-wsl-linux.js"),
  };
}
const sameCreation = (cim: string, native: string) =>
  cim.length === native.length &&
  cim.endsWith("0") &&
  cim.slice(0, -1) === native.slice(0, -1);
/** One proof is reused for both existing inventory rows and the exact late observer instances. */
export function assessOwnWslObservers(
  g: WorkloadGuard,
  i: WorkloadInventory,
  receipt: WslReceipt | undefined,
  artifacts: ObserverArtifacts | undefined,
) {
  const policy = g.wslObservation?.readonlyObserver;
  const artifactMatched = !!(
    policy &&
    artifacts &&
    policy.publisherSha256 === artifacts.publisherSha256 &&
    policy.clientSha256 === artifacts.clientSha256 &&
    policy.collectorSha256 === artifacts.collectorSha256
  );
  const none = {
    artifactMatched,
    processPids: new Set<number>(),
    reconcilerOnlyObservers: false,
  };
  if (!policy || !receipt || !artifactMatched) return none;
  const producer = i.processes.find((p) => p.pid === receipt.producerPid);
  if (
    !producer ||
    !sameCreation(producer.creationTicks, receipt.producerStartedTicks)
  )
    return none;
  const c: ObserverProofContext = {
    policy,
    artifacts,
    taskBound: i.runningTasks.some(
      (t) =>
        t.path === g.wslObservation?.producerTask &&
        t.definitionSha256 === g.wslObservation.definitionSha256 &&
        t.principalId === receipt.ownerSid &&
        t.enginePid === receipt.producerPid,
    ),
    producerPid: producer.pid,
    producerCreationTicks: producer.creationTicks,
    ownerSid: receipt.ownerSid,
  };
  const binding = g.wslDistributions.find((b) => b.name === "ComputeNode");
  const keeper = i.processes.find(
    (p) =>
      p.pid === receipt.keeper.pid &&
      p.parentPid === receipt.producerPid &&
      p.ownerSid === receipt.ownerSid &&
      p.sha256 === policy.images.wsl_system &&
      sameCreation(p.creationTicks, receipt.keeper.startedTicks),
  );
  if (
    binding?.keeper &&
    keeper &&
    receipt.keeper.native?.helperSha256 === binding.keeper.helperSha256 &&
    receipt.keeper.native.nodeSha256 === binding.keeper.nodeSha256 &&
    receipt.keeper.native.uid === binding.keeper.uid
  )
    c.keeper = {
      pid: keeper.pid,
      creationTicks: keeper.creationTicks,
      argvSha256: observerArgvHash([
        "-d",
        "ComputeNode",
        "-u",
        "openclaw",
        "--cd",
        "/",
        "--exec",
        binding.keeper.nodeExecutable,
        posix.join(posix.dirname(binding.collectorPath), "host-wsl-keeper.js"),
      ]),
    };
  const proofs = [
    ...(i.observerCandidates ?? []),
    ...(i.diagnostics ?? []).flatMap((d) => (d.observer ? [d.observer] : [])),
  ].filter((p) => isReadOnlyObserverChain(p, c));
  const sameRow = (
    p: WorkloadInventory["processes"][number],
    o: NativeObserverDiagnostic["chain"][number],
  ) =>
    o.pid === p.pid &&
    o.parentPid === p.parentPid &&
    o.creationTicks === p.creationTicks &&
    (p.ownerSid === "" || o.ownerSid === p.ownerSid) &&
    o.imageSha256 === p.sha256;
  const processPids = new Set<number>();
  for (const p of i.processes)
    if (proofs.some((proof) => proof.chain.some((o) => sameRow(p, o))))
      processPids.add(p.pid);
  return {
    artifactMatched,
    processPids,
    reconcilerOnlyObservers:
      i.reconciliation?.completeAfter === false &&
      (i.diagnostics ?? []).every((d) => {
        const row = i.processes.find((p) => p.pid === d.pid);
        return (
          !row || (!!d.observer?.chain[0] && sameRow(row, d.observer.chain[0]))
        );
      }) &&
      observersOnlyReconcileFailure(
        i.reconciliation.completeBefore,
        i.reconciliation.diagnosticCount,
        i.diagnostics,
        c,
      ),
  };
}
