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
  onRetry,
}: {
  health: Awaited<ReturnType<HitchletClient["health"]>> | null;
  error: string;
  onRetry?: () => void;
}) {
  const ready = !error && health?.recoveryState === "ready";
  return (
    <section className="health-panel" aria-label="控制面状态">
      <div className="health-head">
        <h2>控制面</h2>
        <span className={`status-pill ${ready ? "good" : "warn"}`}>
          {error
            ? "连接不可用"
            : ready
              ? "运行正常"
              : health?.recoveryState === "recovering"
                ? "恢复中"
                : health?.recoveryState === "unavailable"
                  ? "不可用"
                  : "读取中"}
        </span>
        <span className="connection-mode">
          {error
            ? "观测未知"
            : !health
              ? "正在连接控制器…"
              : health.executionMode === "simulator"
                ? "Simulator · 本机模拟"
                : health.executionMode === "disabled"
                  ? "执行器未启用"
                  : health.executionMode === "tart"
                    ? "Tart · 本机虚拟机"
                    : "Portainer Docker"}
        </span>
        {error && onRetry ? (
          <button className="secondary-button" onClick={onRetry}>
            重试连接
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="connection-error">
          <p>暂时无法读取控制器，当前状态未知。恢复连接前不能提交环境操作。</p>
          <details>
            <summary>错误详情</summary>
            <p>{error}</p>
          </details>
        </div>
      ) : health?.executionMode === "simulator" ? (
        <p className="simulator-banner">
          模拟环境，未连接真实 Docker/SSH；离线租约强制执行不受支持。
        </p>
      ) : health?.executionMode === "disabled" ? (
        <p className="muted-banner">Ticket 可查询，但环境执行不可用。</p>
      ) : health?.executionMode === "portainer" ||
        health?.executionMode === "tart" ? (
        <details className="mode-details">
          <summary>执行范围与限制</summary>
          <p>节点状态单独显示，离线租约强制执行不受支持。</p>
        </details>
      ) : null}
    </section>
  );
}

export function LoginPanel({
  token,
  onToken,
  onSubmit,
  loading,
  submitting = false,
}: {
  token: string;
  onToken: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  loading: boolean;
  submitting?: boolean;
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
            使用部署时领取的访问令牌登录。令牌不会保存在浏览器存储中。
          </p>
          <form onSubmit={onSubmit}>
            <label>
              访问令牌
              <input
                autoComplete="off"
                type="password"
                value={token}
                onChange={(event) => onToken(event.target.value)}
                placeholder="粘贴一次性显示的 token"
                required
              />
            </label>
            <button
              className="primary-button"
              disabled={!token.trim() || submitting}
            >
              {submitting ? "正在登录…" : "创建安全会话"} <span>→</span>
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
  onAcquire,
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
  onAcquire: () => void;
}) {
  return (
    <section className="ticket-section">
      <div className="section-title-row">
        <div>
          <div className="section-kicker">环境与票据</div>
          <h2>
            我的环境 <span className="count">本页 {tickets.length}</span>
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
      {error && tickets.length ? (
        <p role="alert" className="error-inline">
          刷新失败，以下为上次结果；请重新读取后判断状态。
        </p>
      ) : null}
      {loading && !tickets.length ? (
        <div className="skeleton">正在读取 Ticket…</div>
      ) : error && !tickets.length ? (
        <div className="error-inline" role="alert">
          列表读取失败：{error}。请重试刷新列表。
        </div>
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
                <b>
                  {item.phase === "ready" ? "环境就绪" : phaseLabel(item.phase)}
                </b>
                <small>{item.id}</small>
              </span>
              <span className="ticket-meta">
                <small>更新于 {dateLabel(item.updatedAt)}</small>
                <small>
                  {item.terminalReason
                    ? `终止：${terminalLabel(item.terminalReason)}`
                    : "未终止"}{" "}
                  · {cleanupLabel(item.cleanupStatus)}
                </small>
              </span>
              <span className="row-arrow">查看详情 →</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <b>{phase ? "当前筛选下没有环境" : "还没有环境"}</b>
          <p>
            {phase
              ? "切换阶段筛选可查看其他票据。"
              : "选择镜像并申请，随后在这里接用、续租和归还。"}
          </p>
          {!phase ? (
            <button className="primary-button" onClick={onAcquire}>
              申请第一个环境
            </button>
          ) : null}
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
