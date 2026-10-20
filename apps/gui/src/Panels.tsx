import { AuthorizedAcquire } from "./AuthorizedAcquire.js";
import React, { type FormEvent } from "react";
import type {
  AcquireRequest,
  HitchletClient,
  ImageSummary,
  TicketSummary,
} from "@hitchlet/sdk";
import {
  cleanupLabel,
  dateLabel,
  phaseLabel,
  terminalLabel,
} from "./format.js";
import { preparedHint, type SavedCommand } from "./prepared.js";

export function HealthPanel({
  health,
  error,
}: {
  health: Awaited<ReturnType<HitchletClient["health"]>> | null;
  error: string;
}) {
  return (
    <section className="health-panel">
      <div className="health-head">
        <div>
          <div className="section-kicker">控制面状态</div>
          <h2>服务健康</h2>
        </div>
        <span
          className={`status-pill ${!error && health?.recoveryState === "ready" ? "good" : "warn"}`}
        >
          {error
            ? "连接不可用"
            : health?.recoveryState === "ready"
              ? "运行正常"
              : health?.recoveryState === "recovering"
                ? "恢复中"
                : health?.recoveryState === "unavailable"
                  ? "不可用"
                  : "读取中"}
        </span>
      </div>
      <div className="health-facts">
        <div>
          <small>执行模式</small>
          <b>
            {error
              ? "未知"
              : health?.executionMode === "simulator"
                ? "Simulator"
                : health?.executionMode === "disabled"
                  ? "Disabled"
                  : health?.executionMode === "portainer"
                    ? "Portainer"
                    : "未知"}
          </b>
        </div>
        <div>
          <small>账本恢复</small>
          <b>{error ? "观测未知" : (health?.recoveryState ?? "读取中")}</b>
        </div>
      </div>
      {!error && health?.executionMode === "simulator" ? (
        <p className="simulator-banner">
          模拟环境，未连接真实 Docker/SSH；离线租约强制执行不受支持。
        </p>
      ) : !error && health?.executionMode === "disabled" ? (
        <p className="muted-banner">
          执行器未启用。Ticket 可查询，但环境执行不可用。
        </p>
      ) : !error && health?.executionMode === "portainer" ? (
        <p className="muted-banner">
          Portainer Docker
          执行模式；节点状态单独显示，离线租约强制执行不受支持。
        </p>
      ) : null}
      {error ? <p className="error-inline">健康状态读取失败：{error}</p> : null}
    </section>
  );
}

export function LoginPanel({
  token,
  onToken,
  onSubmit,
  loading,
}: {
  token: string;
  onToken: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  loading: boolean;
}) {
  return (
    <section className="login-card">
      {loading ? (
        <div className="skeleton">正在恢复会话…</div>
      ) : (
        <>
          <div className="section-kicker">安全登录</div>
          <h2>登录 Hitchlet</h2>
          <p className="muted">
            粘贴部署时领取的 Consumer token。token
            仅用于换取短期会话，不会保存在浏览器存储中。
          </p>
          <form onSubmit={onSubmit}>
            <label>
              Consumer token
              <input
                autoComplete="off"
                type="password"
                value={token}
                onChange={(event) => onToken(event.target.value)}
                placeholder="粘贴一次性显示的 token"
                required
              />
            </label>
            <button className="primary-button" disabled={!token.trim()}>
              创建安全会话 <span>→</span>
            </button>
          </form>
        </>
      )}
    </section>
  );
}

export function TicketListPanel({
  tickets,
  loading,
  error,
  phase,
  cursorHistory,
  nextCursor,
  selectedId,
  onRefresh,
  onPhase,
  onPrevious,
  onNext,
  onSelect,
}: {
  tickets: readonly TicketSummary[];
  loading: boolean;
  error: string;
  phase: string;
  cursorHistory: readonly (string | null)[];
  nextCursor: string | null;
  selectedId: string | null;
  onRefresh: () => void;
  onPhase: (phase: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="ticket-section">
      <div className="section-title-row">
        <div>
          <div className="section-kicker">你的资源</div>
          <h2>
            我的 Ticket <span className="count">{tickets.length}</span>
          </h2>
        </div>
        <button className="secondary-button" onClick={onRefresh}>
          刷新列表 ↻
        </button>
      </div>
      <div className="filter-row">
        <label>
          阶段筛选
          <select
            value={phase}
            onChange={(event) => onPhase(event.target.value)}
          >
            <option value="">全部阶段</option>
            <option value="queued">排队中</option>
            <option value="reserved">已预留</option>
            <option value="provisioning">准备环境</option>
            <option value="ready">可接用</option>
            <option value="releasing">回收中</option>
            <option value="released">已释放</option>
          </select>
        </label>
        <div className="pager">
          <button disabled={!cursorHistory.length} onClick={onPrevious}>
            上一页
          </button>
          <button disabled={!nextCursor} onClick={onNext}>
            下一页
          </button>
        </div>
      </div>
      {loading && !tickets.length ? (
        <div className="skeleton">正在读取 Ticket…</div>
      ) : error && !tickets.length ? (
        <div className="error-inline">列表读取失败：{error}</div>
      ) : tickets.length ? (
        <div className="ticket-list">
          {tickets.map((item) => (
            <button
              key={item.id}
              className={`ticket-row ${selectedId === item.id ? "selected" : ""}`}
              onClick={() => onSelect(item.id)}
            >
              <span className={`phase-dot phase-${item.phase}`} />
              <span className="ticket-main">
                <b>{phaseLabel(item.phase)}</b>
                <small>{item.id}</small>
              </span>
              <span className="ticket-meta">
                <small>创建于 {dateLabel(item.createdAt)}</small>
                <small>
                  {item.terminalReason
                    ? `终止：${terminalLabel(item.terminalReason)}`
                    : "未终止"}{" "}
                  · {cleanupLabel(item.cleanupStatus)}
                </small>
              </span>
              <span className="row-arrow">↗</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <span>◌</span>
          <b>还没有 Ticket</b>
          <p>从下方申请表选择授权镜像，提交后会在这里跟踪准备和回收状态。</p>
        </div>
      )}
    </section>
  );
}

export function AcquirePanel(props: {
  images: readonly ImageSummary[];
  canOperate: boolean;
  busy: boolean;
  blocked: boolean;
  onAcquire: (request: AcquireRequest) => void;
  client: HitchletClient;
  onError: (error: unknown) => void;
}) {
  return <AuthorizedAcquire {...props} />;
}

export function RecoveryPanel({
  commands,
  busy,
  onResume,
}: {
  commands: readonly SavedCommand[];
  busy: boolean;
  onResume: (command: SavedCommand) => void;
}) {
  if (!commands.length) return null;
  return (
    <section className="recovery-section">
      <div className="section-kicker">结果不确定时继续</div>
      <h2>
        待恢复操作 <span className="count">{commands.length}</span>
      </h2>
      <p className="muted">
        这些请求已在第一次发送前保存。恢复会原样重放同一请求和幂等键，不会自动新建申请。
      </p>
      {commands.map((item, index) => {
        const hint = preparedHint(item.command);
        return (
          <div
            className="recovery-row"
            key={hint.idempotencyKey ?? `${item.savedAt}-${index}`}
          >
            <div>
              <b>
                {hint.kind ?? "未知格式"} ·{" "}
                {hint.ticketId ?? "新申请或未知 Ticket"}
              </b>
              <small>
                {hint.idempotencyKey
                  ? `key ${hint.idempotencyKey} · `
                  : "缺少幂等键 · "}
                保存于 {dateLabel(item.savedAt)}
              </small>
            </div>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => onResume(item)}
            >
              恢复原操作
            </button>
          </div>
        );
      })}
    </section>
  );
}
