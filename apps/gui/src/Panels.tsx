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
          className={`status-pill ${health?.recoveryState === "ready" ? "good" : "warn"}`}
        >
          {health?.recoveryState === "ready"
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
            {health?.executionMode === "simulator"
              ? "Simulator"
              : health?.executionMode === "disabled"
                ? "Disabled"
                : "未知"}
          </b>
        </div>
        <div>
          <small>账本恢复</small>
          <b>{health?.recoveryState ?? (error ? "连接不可用" : "读取中")}</b>
        </div>
        <div>
          <small>阶段</small>
          <b>{health?.stage ?? "—"}</b>
        </div>
      </div>
      {health?.executionMode === "simulator" ? (
        <p className="simulator-banner">
          模拟环境，未连接真实 Docker/SSH；离线租约强制执行不受支持。
        </p>
      ) : health?.executionMode === "disabled" ? (
        <p className="muted-banner">
          执行器未启用。Ticket 可查询，但环境执行不可用。
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

export function AcquirePanel({
  images,
  canOperate,
  busy,
  blocked,
  onAcquire,
  client,
  onError,
}: {
  images: readonly ImageSummary[];
  canOperate: boolean;
  busy: boolean;
  blocked: boolean;
  onAcquire: (request: AcquireRequest) => void;
  client: HitchletClient;
  onError: (error: unknown) => void;
}) {
  const [form, setForm] = React.useState({
    imageId: "",
    alias: "latest",
    versionId: "",
    exact: false,
    cpuMillis: "1000",
    memoryMiB: "2048",
    scratchMiB: "2048",
    networkProfileId: "",
    clientRef: "",
    requestedSeconds: "900",
  });
  const [versionInfo, setVersionInfo] = React.useState("");
  React.useEffect(() => {
    if (!form.imageId && images.length)
      setForm((value) => ({ ...value, imageId: images[0]!.id }));
  }, [form.imageId, images]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.networkProfileId.trim()) return;
    onAcquire({
      image: form.exact
        ? { versionId: form.versionId.trim() }
        : { imageId: form.imageId, alias: form.alias.trim() },
      resources: {
        cpuMillis: Number(form.cpuMillis),
        memoryMiB: Number(form.memoryMiB),
        scratchMiB: Number(form.scratchMiB),
      },
      networkProfileId: form.networkProfileId.trim(),
      lease: { requestedSeconds: Number(form.requestedSeconds) },
      ...(form.clientRef.trim() ? { clientRef: form.clientRef.trim() } : {}),
    });
  };
  return (
    <section className="acquire-section">
      <div className="section-kicker">开始一项新任务</div>
      <h2>申请计算环境</h2>
      <p className="muted">
        选择已授权镜像并提交资源合同。暂不支持任意宿主路径或 NAS 地址。
      </p>
      <form className="acquire-form" onSubmit={submit}>
        <label className="span-two">
          镜像选择
          <select
            value={form.imageId}
            onChange={(event) =>
              setForm({ ...form, imageId: event.target.value })
            }
          >
            {images.map((image) => (
              <option key={image.id} value={image.id}>
                {image.name} · {image.description}
              </option>
            ))}
          </select>
        </label>
        <div className="span-two choice-row">
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.exact}
              onChange={(event) => {
                setVersionInfo("");
                setForm({ ...form, exact: event.target.checked });
              }}
            />
            按不可变 versionId 精确选择
          </label>
          {form.exact ? (
            <input
              aria-label="精确镜像版本 ID"
              value={form.versionId}
              onChange={(event) => {
                setVersionInfo("");
                setForm({ ...form, versionId: event.target.value });
              }}
              placeholder="粘贴已授权的 versionId"
              required
            />
          ) : (
            <label>
              授权别名
              <input
                value={form.alias}
                onChange={(event) =>
                  setForm({ ...form, alias: event.target.value })
                }
                placeholder="Simulator seed: latest"
                required
              />
            </label>
          )}
        </div>
        {form.exact ? (
          <button
            className="secondary-button"
            type="button"
            disabled={!form.versionId.trim()}
            onClick={() =>
              void client.images
                .getVersion(form.versionId.trim())
                .then((version) =>
                  setVersionInfo(
                    `${version.version} · ${version.status} · ${version.artifacts.map((artifact) => `${artifact.architecture} ${artifact.digest.slice(0, 15)}…`).join(" / ")}`,
                  ),
                )
                .catch(onError)
            }
          >
            查询精确版本
          </button>
        ) : null}
        {versionInfo ? (
          <p className="span-two version-result">{versionInfo}</p>
        ) : null}
        <label>
          CPU（毫核）
          <input
            type="number"
            min="1"
            step="1"
            value={form.cpuMillis}
            onChange={(event) =>
              setForm({ ...form, cpuMillis: event.target.value })
            }
            required
          />
        </label>
        <label>
          内存（MiB）
          <input
            type="number"
            min="1"
            step="1"
            value={form.memoryMiB}
            onChange={(event) =>
              setForm({ ...form, memoryMiB: event.target.value })
            }
            required
          />
        </label>
        <label>
          临时盘（MiB）
          <input
            type="number"
            min="0"
            step="1"
            value={form.scratchMiB}
            onChange={(event) =>
              setForm({ ...form, scratchMiB: event.target.value })
            }
            required
          />
          <small>仅空间预算；镜像/能力未验证硬限制时不会承诺硬限额。</small>
        </label>
        <label>
          租期偏好（秒）
          <input
            type="number"
            min="60"
            step="1"
            value={form.requestedSeconds}
            onChange={(event) =>
              setForm({ ...form, requestedSeconds: event.target.value })
            }
          />
        </label>
        <label className="span-two">
          networkProfileId（必填）
          <input
            value={form.networkProfileId}
            onChange={(event) =>
              setForm({ ...form, networkProfileId: event.target.value })
            }
            placeholder="由管理员提供的网络配置 ID"
            required
          />
          <small>D05 尚无网络配置目录 API，请向管理员获取已授权 ID。</small>
        </label>
        <label className="span-two">
          clientRef（可选）
          <input
            value={form.clientRef}
            onChange={(event) =>
              setForm({ ...form, clientRef: event.target.value })
            }
            placeholder="关联你自己的任务编号"
          />
        </label>
        <button
          className="primary-button span-two"
          disabled={
            !canOperate ||
            busy ||
            blocked ||
            images.length === 0 ||
            (form.exact && !form.versionId.trim())
          }
        >
          {busy ? "已保存请求，提交中…" : "保存请求并申请 →"}
        </button>
        {!canOperate ? (
          <p className="span-two muted">
            当前身份没有 Ticket 写入权限，无法发起或管理 Ticket。
          </p>
        ) : images.length === 0 ? (
          <p className="span-two muted">
            当前身份没有可见授权镜像，或镜像目录暂不可用。
          </p>
        ) : null}
      </form>
    </section>
  );
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
