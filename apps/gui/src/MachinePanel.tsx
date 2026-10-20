import { PowerExecutionPanel } from "./PowerExecutionPanel.js";
import { PowerPanel } from "./PowerPanel.js";
import React from "react";
import { ComputeClientError, type HitchletClient } from "@hitchlet/sdk";

type Admin = HitchletClient["admin"];
type Machine = Awaited<ReturnType<Admin["machines"]>>[number];
type Policy = Parameters<Admin["updateHumanUsePolicy"]>[1]["policy"];
type Preview = Awaited<ReturnType<Admin["previewHumanUsePolicy"]>>;
const resources = ["cpuMillis", "memoryMiB", "scratchMiB"] as const;
const budgets = [
  "humanReserved",
  "systemReserve",
  "attendedMaximum",
  "unattendedMaximum",
] as const;
const labels = {
  humanReserved: "人类最低保留（包含在系统保留）",
  systemReserve: "系统总保留（含人类保留，仅扣一次）",
  attendedMaximum: "有人时物理根池占用上限",
  unattendedMaximum: "无人时物理根池占用上限",
};
const assuranceLabels: Record<
  Machine["nodes"][number]["admissionAssurance"],
  string
> = {
  manual_inventory_trial: "人工冻结预算试用",
  bounded_partial_host: "不完整宿主观测，仅有人预算",
  complete_host: "完整可信宿主观测",
  unavailable_host: "宿主观测证据不可用或不足",
};
const format = (r: Machine["capacity"]) =>
  `${r.cpuMillis}m CPU / ${r.memoryMiB} MiB 内存 / ${r.scratchMiB} MiB 临时盘`;
const message = (cause: unknown) =>
  cause instanceof ComputeClientError
    ? `${cause.message}（${cause.code}）`
    : cause instanceof Error
      ? cause.message
      : "请求失败";

export function MachinePanel({
  client,
  machines,
  onRefresh,
  canWrite,
  connected,
}: {
  client: HitchletClient;
  machines: Machine[];
  onRefresh: () => Promise<void>;
  canWrite: boolean;
  connected: boolean;
}) {
  return (
    <section className="admin-card">
      <h3>机器与人机共用</h3>
      <button className="secondary-button" onClick={() => void onRefresh()}>
        刷新机器观测与依赖
      </button>
      {!connected ? (
        <p role="alert" className="error-banner">
          控制器连接中断；以下为历史依赖数据，观测与准入当前均未知，策略保存禁用。
        </p>
      ) : null}
      {machines.length ? (
        machines.map((machine) => (
          <MachineCard
            key={machine.machineId}
            client={client}
            machine={machine}
            connected={connected}
            canWrite={canWrite && connected}
            permissionReadOnly={!canWrite}
            onRefresh={onRefresh}
          />
        ))
      ) : (
        <p>尚未登记机器。</p>
      )}
    </section>
  );
}
function DependencyTree({
  items,
  parentKey,
  seen = new Set<string>(),
}: {
  items: Machine["dependencyTree"];
  parentKey: string | null;
  seen?: Set<string>;
}) {
  return (
    <ul>
      {items
        .filter((item) => item.parentKey === parentKey && !seen.has(item.key))
        .map((item) => (
          <li key={item.key}>
            {item.name} · {item.kind} · {item.id}
            <small>占用 {format(item.claimed)}</small>
            <DependencyTree
              items={items}
              parentKey={item.key}
              seen={new Set([...seen, item.key])}
            />
          </li>
        ))}
    </ul>
  );
}
function MachineCard({
  client,
  machine,
  canWrite,
  onRefresh,
  connected,
  permissionReadOnly,
}: {
  client: HitchletClient;
  machine: Machine;
  permissionReadOnly: boolean;
  canWrite: boolean;
  onRefresh: () => Promise<void>;
  connected: boolean;
}) {
  const [draft, setDraft] = React.useState<Policy | null>(
    machine.humanUsePolicy,
  );
  const [baseVersion, setBaseVersion] = React.useState(machine.version);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewHostFingerprint, setPreviewHostFingerprint] = React.useState<
    string | null
  >(null);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const active = React.useRef(true),
    revision = React.useRef(0),
    inFlight = React.useRef(false);
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      revision.current += 1;
    };
  }, []);
  React.useEffect(() => {
    revision.current += 1;
    setPreview(null);
  }, [canWrite, client]);
  // Policy saveability depends on authority and budgets. A routine heartbeat only
  // ages the admission explanation; it must not make a human race the refresh timer.
  const budgetFingerprint = JSON.stringify({
    version: machine.version,
    hostAuthority: ["missing", "revoked"].includes(
      machine.hostObservation.state,
    )
      ? machine.hostObservation.state
      : "authenticated",
    capacity: machine.capacity,
    reserve: machine.systemReserve,
    usage: machine.physicalUsage,
    workloadUsage: machine.workloadUsage,
    holds: machine.holds,
    nodes: machine.nodes.map((n) => ({
      id: n.id,
      version: n.version,
      mode: n.admissionMode,
    })),
  });
  React.useEffect(() => {
    revision.current += 1;
    setPreview(null);
  }, [budgetFingerprint, connected]);
  const explanationIsHistorical =
    preview !== null &&
    previewHostFingerprint !== JSON.stringify(machine.hostObservation);
  const stale = baseVersion !== machine.version;
  function edit(next: Policy) {
    revision.current += 1;
    setDraft(next);
    setPreview(null);
    setStatus("");
  }
  function reload() {
    revision.current += 1;
    setBaseVersion(machine.version);
    setDraft(
      machine.humanUsePolicy ?? {
        blockShutdownForAnyInteractiveSession: true,
        blockShutdownOnUnknownPresence: true,
        maximumObservationAgeSeconds: 30,
        admissionDuringInteraction: "block_new",
        humanReserved: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
        systemReserve: machine.systemReserve,
        attendedMaximum: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
        unattendedMaximum: { cpuMillis: 0, memoryMiB: 0, scratchMiB: 0 },
        cpuPressureLimitPercent: 80,
        memoryPressureLimitPercent: 80,
      },
    );
    setPreview(null);
    setError("");
    setStatus("");
  }
  async function run(save: boolean) {
    if (
      !draft ||
      !canWrite ||
      stale ||
      inFlight.current ||
      (save && !preview?.canApply)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    const token = revision.current,
      cancelled = () => !active.current || revision.current !== token;
    try {
      const body = { expectedVersion: baseVersion, policy: draft };
      if (save) {
        const receipt = await client.admin.updateHumanUsePolicy(
          machine.machineId,
          body,
          crypto.randomUUID(),
          cancelled,
        );
        if (cancelled()) return;
        setBaseVersion(receipt.version);
        setPreview(null);
        setStatus("策略已保存；现有资源继续保留占用，降低上限只阻止新增。");
        await onRefresh();
      } else {
        const result = await client.admin.previewHumanUsePolicy(
          machine.machineId,
          body,
          cancelled,
        );
        if (!cancelled()) {
          setPreviewHostFingerprint(JSON.stringify(machine.hostObservation));
          setPreview(result);
        }
      }
    } catch (cause) {
      if (!cancelled()) {
        setError(message(cause));
        setPreview(null);
        await onRefresh();
      }
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <article className="admin-card">
      <h4>
        {machine.name} · {machine.usageMode} · {machine.admission}
      </h4>
      <p>
        宿主观测 {connected ? machine.hostObservation.state : "历史 / 当前未知"}{" "}
        / 人员 {connected ? machine.hostObservation.humanPresence : "unknown"} ·
        CPU{" "}
        {machine.hostObservation.cpuPercent === null
          ? "未知"
          : `${machine.hostObservation.cpuPercent.toFixed(1)}%`}{" "}
        · 内存{" "}
        {machine.hostObservation.memoryPercent === null
          ? "未知"
          : `${machine.hostObservation.memoryPercent.toFixed(1)}%`}{" "}
        · 未管理工作{" "}
        {machine.hostObservation.unmanagedActivityHold === null
          ? "未知"
          : String(machine.hostObservation.unmanagedActivityHold)}
      </p>
      <p>
        根池总量 {format(machine.capacity)}；系统保留{" "}
        {format(machine.systemReserve)}；物理占用{" "}
        {format(machine.physicalUsage)}。
      </p>
      <small>
        租客与验证的全部未释放 Claim {format(machine.workloadUsage)}
        。底座已占物理预算，子池资源不再重复扣根池。reserved / committed /
        quarantined 都保留占用，查实回收后才释放。
      </small>
      {machine.nodes.some(
        (n) => n.admissionMode === "constant_online_manual_inventory",
      ) ? (
        <p className="error-banner">
          常开手工冻结预算试用：不代表已验证人机共用。未知宿主负载不会显示为无负载；无自动电源、无执行端离线截止保证。
        </p>
      ) : null}
      <p>
        策略来源 {machine.policySource} · 准入{" "}
        {!connected
          ? "未知（连接中断）"
          : machine.canAdmitTenants
            ? "允许按各 Node 余量申请"
            : "阻止"}
      </p>
      {machine.disabledReasons.map((reason) => (
        <small key={reason} className="error-banner">
          {reason}
        </small>
      ))}
      {machine.nodes.map((node) => (
        <p key={node.id}>
          {node.name} · {node.admissionMode} /{" "}
          {connected
            ? assuranceLabels[node.admissionAssurance]
            : assuranceLabels.unavailable_host}{" "}
          · {node.limitations.join("；")} · 可用 {format(node.available)} ·{" "}
          {!connected
            ? "当前准入未知"
            : node.canAdmit
              ? "可准入"
              : node.disabledReasons.join("；")}
        </p>
      ))}
      {machine.nodes.map((node) => (
        <NodeModeEditor
          key={node.id}
          client={client}
          node={node}
          canWrite={canWrite}
          onRefresh={onRefresh}
        />
      ))}
      <details>
        <summary>依赖树与常开 Hold</summary>
        <DependencyTree items={machine.dependencyTree} parentKey={null} />
        {machine.holds.map((h) => (
          <p key={h.id}>
            {h.kind} Hold：{h.reason}
          </p>
        ))}
      </details>
      <details>
        <summary>沙盘停机禁用原因（原生执行见独立面板）</summary>
        {machine.shutdownDisabledReasons.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
      </details>
      <details>
        <summary>人机共用策略编辑 · version {baseVersion}</summary>
        <p>
          上限指物理根池占用（包括底座预算）；人类保留已经包含在系统保留中。观测有效期同时受
          Host 协议 30 秒上限约束。
        </p>
        {permissionReadOnly ? <p>当前权限只允许查看，不能编辑策略。</p> : null}
        {stale ? (
          <p className="error-banner">Machine 版本已变化，请重新载入后预演。</p>
        ) : null}
        <button disabled={!canWrite || busy} onClick={reload}>
          载入当前策略 / 创建策略
        </button>
        {draft ? (
          <fieldset disabled={!canWrite || busy || stale}>
            <label>
              交互时准入
              <select
                aria-label="交互时准入"
                value={draft.admissionDuringInteraction}
                onChange={(e) =>
                  edit({
                    ...draft,
                    admissionDuringInteraction: e.target
                      .value as Policy["admissionDuringInteraction"],
                  })
                }
              >
                <option value="block_new">有人时阻止新增</option>
                <option value="within_reserved_budget">
                  有人时仅按保留预算
                </option>
              </select>
            </label>
            {budgets.map((group) => (
              <fieldset key={group}>
                <legend>{labels[group]}</legend>
                {resources.map((resource) => (
                  <label key={resource}>
                    {resource}
                    <input
                      aria-label={`${group} ${resource}`}
                      type="number"
                      min="0"
                      step="1"
                      value={
                        Number.isNaN(draft[group][resource])
                          ? ""
                          : draft[group][resource]
                      }
                      onChange={(e) =>
                        edit({
                          ...draft,
                          [group]: {
                            ...draft[group],
                            [resource]:
                              e.target.value === ""
                                ? NaN
                                : Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ))}
            {(
              [
                "maximumObservationAgeSeconds",
                "cpuPressureLimitPercent",
                "memoryPressureLimitPercent",
              ] as const
            ).map((key) => (
              <label key={key}>
                {key}
                <input
                  aria-label={key}
                  type="number"
                  min="1"
                  max={key === "maximumObservationAgeSeconds" ? 3600 : 100}
                  value={draft[key]}
                  onChange={(e) =>
                    edit({ ...draft, [key]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
            <p>任何交互会话、未知人员状态均阻止自动关机（固定保护）。</p>
            <button type="button" onClick={() => void run(false)}>
              预演策略影响
            </button>
            <button
              type="button"
              disabled={!preview?.canApply}
              onClick={() => void run(true)}
            >
              保存已预演策略
            </button>
          </fieldset>
        ) : null}
        {preview ? (
          <div role="status">
            {explanationIsHistorical ? (
              <p>
                宿主观测已更新；以下准入解释来自预演时的历史观测。预算预演仍可保存，服务端将重新核对当前身份与预算。
              </p>
            ) : null}
            <p>
              可保存：{String(preview.canApply)} · 拟议准入：
              {preview.machine.canAdmitTenants ? "允许" : "阻止"}
            </p>
            {[
              ...preview.updateDisabledReasons,
              ...preview.machine.disabledReasons,
            ].map((r, i) => (
              <p key={i}>{r}</p>
            ))}
          </div>
        ) : null}
        {status ? <p role="status">{status}</p> : null}
        {error ? (
          <p role="alert" className="error-banner">
            {error}
          </p>
        ) : null}
      </details>
      <PowerExecutionPanel
        client={client}
        machineId={machine.machineId}
        connected={connected}
        canWrite={canWrite}
      />
      <PowerPanel
        client={client}
        machineId={machine.machineId}
        machineVersion={machine.version}
        canWrite={canWrite}
        connected={connected}
      />
    </article>
  );
}

function NodeModeEditor({
  client,
  node,
  canWrite,
  onRefresh,
}: {
  client: HitchletClient;
  node: Machine["nodes"][number];
  canWrite: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [mode, setMode] = React.useState(node.admissionMode),
    [reason, setReason] = React.useState(""),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const active = React.useRef(true),
    version = React.useRef(node.version),
    pending = React.useRef(false);
  version.current = node.version;
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  React.useEffect(() => {
    setMode(node.admissionMode);
    setReason("");
  }, [node.version, node.admissionMode]);
  async function save() {
    if (!canWrite || !reason.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const expectedVersion = node.version;
    try {
      await client.admin.updateNodeAdmissionMode(
        node.id,
        { expectedVersion, mode, reason },
        crypto.randomUUID(),
        () => !active.current || version.current !== expectedVersion,
      );
      if (active.current) await onRefresh();
    } catch (cause) {
      if (active.current) {
        setError(message(cause));
        await onRefresh();
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <details>
      <summary>{node.name} 准入模式设置</summary>
      <p>
        正式观测准入要求当前 Node
        能力报告仍有效、Engine/连接修订/架构匹配，且已认证 Host
        与当前策略允许接单。partial 仅在
        within_reserved_budget、人员可判定且资源压力低于阈值时使用 attended
        上限；不会获得无人或电源能力。能力报告到期后需重新实测取证，心跳不会延长有效期。常开手工模式仅为人工冻结预算试用。
      </p>
      <fieldset disabled={!canWrite || busy}>
        <label>
          准入模式
          <select
            aria-label={`${node.name} 准入模式`}
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="observed_host">可信 Host 观测</option>
            <option value="constant_online_manual_inventory">
              常开手工冻结预算试用
            </option>
          </select>
        </label>
        <label>
          变更理由
          <input
            aria-label={`${node.name} 模式变更理由`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          disabled={!reason.trim() || mode === node.admissionMode}
          onClick={() => void save()}
        >
          保存 Node 准入模式
        </button>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
