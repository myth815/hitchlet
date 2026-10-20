import React from "react";
import type { HitchletClient } from "@hitchlet/sdk";
type View = Awaited<ReturnType<HitchletClient["admin"]["powerExecutions"]>>;
function allowsCommand(
  phase: View["executions"][number]["phase"],
  action: "cancel" | "wake",
) {
  return action === "wake"
    ? ["off_expected", "waking"].includes(phase)
    : !["ready", "cancelled", "manual"].includes(phase);
}
export function PowerExecutionPanel({
  client,
  machineId,
  connected,
  canWrite,
}: {
  client: HitchletClient;
  machineId: string;
  connected: boolean;
  canWrite: boolean;
}) {
  const [open, setOpen] = React.useState(false),
    [view, setView] = React.useState<View | null>(null),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open || !connected) return;
    let active = true;
    const refresh = () =>
      client.admin
        .powerExecutions(machineId)
        .then((v) => {
          if (active) {
            setView(v);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("真实电源状态读取失败；历史状态不可执行");
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, connected, client, machineId]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      setView(await client.admin.powerExecutions(machineId));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "真实电源请求失败；先刷新状态再决定",
      );
    } finally {
      setBusy(false);
    }
  }
  async function command(cycleId: string, action: "cancel" | "wake") {
    const current = await client.admin.powerExecutions(machineId);
    setView(current);
    const cycle = current.executions.find((p) => p.id === cycleId);
    if (!cycle || !allowsCommand(cycle.phase, action))
      throw new Error("目标闭环已结束或当前阶段不允许此动作；未发送请求");
    // One fresh CAS attempt; a later conflict remains in the SDK management recovery flow.
    await client.admin.commandPowerExecution(machineId, cycleId, {
      expectedVersion: cycle.version,
      action,
      ...(action === "wake"
        ? { provisionDeadlineMs: Date.now() + 300000 }
        : {}),
    });
  }
  const permitted = connected && canWrite && !busy && !error;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>原生正常关机与 WOL（D22b 实际执行）</summary>
      <p>
        默认关闭。此处执行真实电源动作，须本机显式安装电源服务及可信安装配置；D22a
        沙盘不授予权限。资格运行仍复核所有人员、工作负载、Claim 与 Hold。
      </p>
      {!connected ? <p role="alert">连接中断；以下仅为历史状态。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {view ? (
        <>
          <p>
            安装启用：{view.enabled ? "是" : "否"}；逐机闭环：
            {view.verified ? "已验证" : "未验证"}；自动策略：
            {view.automatic ? "启用" : "关闭"}
          </p>
          <ul>
            {view.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <button
            disabled={
              !permitted ||
              !view.enabled ||
              view.executions.some(
                (p) => !["ready", "cancelled", "manual"].includes(p.phase),
              )
            }
            onClick={() =>
              void run(() =>
                client.admin.startPowerExecution(machineId, {
                  qualification: !view.verified,
                }),
              )
            }
          >
            {view.verified ? "开始安全关机闭环" : "开始受守卫的逐机资格运行"}
          </button>
          {view.executions.map((p) => (
            <article key={p.id}>
              <p>
                {p.qualification ? "资格运行" : "实际闭环"} {p.id}：{p.phase}
                ；OS 受理 {p.acceptedReceiptId
                  ? "已记录"
                  : "未记录"}；实测电源 {p.observedPower}；WOL {p.wakeAttempts}
                /3
              </p>
              <ul>
                {p.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <button
                disabled={!permitted || !allowsCommand(p.phase, "cancel")}
                onClick={() => void run(() => command(p.id, "cancel"))}
              >
                取消闭环并请求取消待关机
              </button>
              <button
                disabled={!permitted || !allowsCommand(p.phase, "wake")}
                onClick={() => void run(() => command(p.id, "wake"))}
              >
                请求有界 WOL 恢复
              </button>
            </article>
          ))}
          <p>
            accepted 只表示操作系统受理。off_expected 仍为
            observedPower=unknown；只有新的原生 OS boot、认证 Host
            和全部已登记依赖健康后才 ready。无 Docker Node 的资格记录仅证明 Host
            恢复。
          </p>
        </>
      ) : null}
    </details>
  );
}
