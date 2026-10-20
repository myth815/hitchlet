import React from "react";
import type { ManagementTicketQuery, TicketView } from "@hitchlet/sdk";
import {
  Observation,
  managementError,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";
import { phaseLabel, dateLabel, cleanupLabel } from "./format.js";
import { DailyNodeActions } from "./DailyNodeActions.js";

/** Scoped operational view, separate from the owner's acquire/claim/access UI. Exports contain no request labels or access material. */
export function ManagementTickets({
  client,
  principal,
  disabled,
  action,
}: ManagementUI) {
  const [filters, setFilters] = React.useState({
      consumerId: "",
      nodeId: "",
      imageVersionId: "",
      phase: "",
    }),
    [query, setQuery] = React.useState<ManagementTicketQuery>({}),
    [selected, setSelected] = React.useState<TicketView | null>(null),
    [reason, setReason] = React.useState("");
  const [detailError, setDetailError] = React.useState("");
  const load = React.useCallback(
      () => client.admin.management.tickets(query),
      [client, query],
    ),
    snapshot = useManagementRead(load);
  const timelineLoad = React.useCallback(
    () =>
      selected
        ? client.admin.management.timeline(selected.id)
        : Promise.resolve({ operations: [], events: [] }),
    [client, selected?.id],
  );
  const timeline = useManagementRead(timelineLoad);
  const operationsLoad = React.useCallback(
    () => client.admin.management.operations(),
    [client],
  );
  const operations = useManagementRead(operationsLoad);
  const refresh = async () => {
    try {
      await snapshot.refresh();
      if (selected)
        setSelected(await client.admin.management.ticket(selected.id));
      await timeline.refresh();
      setDetailError("");
    } catch (e) {
      setDetailError(managementError(e));
    }
  };
  const exportPage = () => {
    if (!snapshot.data) return;
    const content = JSON.stringify(
        snapshot.data.items.map((t) => ({
          id: t.id,
          consumerId: t.consumerId,
          version: t.version,
          phase: t.phase,
          imageVersionId: t.pinnedImageVersionId,
          nodeId: t.placement?.nodeId ?? null,
          resources: t.acceptedRequest.resources.request,
          leaseExpiresAt: t.lease?.expiresAt ?? null,
          cleanupStatus: t.cleanupStatus,
          observedAt: snapshot.data!.observedAtMs,
        })),
        null,
        2,
      ),
      url = URL.createObjectURL(
        new Blob([content], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "hitchlet-tickets-redacted.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section aria-label="管理Ticket">
      <h3>授权范围内的 Ticket</h3>
      {detailError ? <p role="alert">{detailError}</p> : null}
      <DailyNodeActions
        client={client}
        principal={principal}
        disabled={disabled}
        action={action}
      />
      <Observation at={snapshot.at} error={snapshot.error} />
      <details className="admin-card">
        <summary>原操作与告警（最近200项；按授权范围）</summary>
        <Observation at={operations.at} error={operations.error} />
        <label>
          重试理由
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </label>
        {operations.data?.map((o) => (
          <article className="admin-card" key={o.id}>
            <b>
              {o.kind} · {o.state} · v{o.version} · 尝试{o.attemptCount}
            </b>
            <small>
              {o.id} · Node {o.nodeId ?? "无"} · runtime{" "}
              {o.runtimeIdentityId ?? "无"} · 下次对账{" "}
              {new Date(o.nextCheckAtMs).toLocaleString()}
            </small>
            <p>{o.errorCode ?? "无错误码"}；未知/历史不证明成功。</p>
            {o.ticketId ? (
              <button
                onClick={() =>
                  void client.admin.management
                    .ticket(o.ticketId!)
                    .then(setSelected)
                    .catch((e) => setDetailError(managementError(e)))
                }
              >
                关联 Ticket
              </button>
            ) : null}
            <button onClick={() => void operations.refresh()}>
              检查原状态
            </button>
            <button
              disabled={
                disabled || !!operations.error || !o.retryable || !reason.trim()
              }
              onClick={() =>
                void action(`重试原操作 ${o.id}`, (key) =>
                  client.admin.management.retryOperation(
                    o.id,
                    { expectedVersion: o.version, reason },
                    key,
                  ),
                ).then((ok) => {
                  if (ok) void operations.refresh();
                })
              }
            >
              重试已失败的原操作
            </button>
          </article>
        ))}
      </details>
      <form
        className="admin-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setSelected(null);
          setQuery(
            Object.fromEntries(
              Object.entries(filters).filter(([, v]) => v),
            ) as ManagementTicketQuery,
          );
        }}
      >
        {(
          [
            ["consumerId", "所有者 UUID"],
            ["nodeId", "Node UUID"],
            ["imageVersionId", "镜像版本 UUID"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              value={filters[key]}
              onChange={(e) =>
                setFilters({ ...filters, [key]: e.target.value })
              }
              placeholder="可选筛选"
            />
          </label>
        ))}
        <label>
          阶段
          <select
            value={filters.phase}
            onChange={(e) => setFilters({ ...filters, phase: e.target.value })}
          >
            <option value="">全部</option>
            {[
              "queued",
              "reserved",
              "provisioning",
              "ready",
              "releasing",
              "released",
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <button>应用筛选</button>
        <button type="button" onClick={() => void refresh()}>
          刷新快照
        </button>
        <button type="button" disabled={!snapshot.data} onClick={exportPage}>
          导出本页脱敏记录
        </button>
      </form>
      <div className="ticket-list">
        {snapshot.data?.items.map((t) => (
          <button
            className="ticket-row"
            key={t.id}
            onClick={() => {
              setSelected(t);
              setReason("");
            }}
          >
            <b>
              {phaseLabel(t.phase)} · {t.id}
            </b>
            <span>
              所有者 {t.consumerId} · 镜像 {t.pinnedImageVersionId}
            </span>
            <span>
              {t.acceptedRequest.resources.request.cpuMillis}m /{" "}
              {t.acceptedRequest.resources.request.memoryMiB} MiB · Node{" "}
              {t.placement?.nodeId ?? "未分配"}
            </span>
            <span>
              到期 {dateLabel(t.lease?.expiresAt ?? null)} ·{" "}
              {cleanupLabel(t.cleanupStatus)} · v{t.version}
            </span>
          </button>
        ))}
      </div>
      {snapshot.data?.items.length === 0 ? (
        <p>当前范围和筛选没有 Ticket。</p>
      ) : null}
      <button
        disabled={!snapshot.data?.nextCursor}
        onClick={() =>
          setQuery({ ...query, cursor: snapshot.data!.nextCursor! })
        }
      >
        下一页
      </button>
      <button onClick={() => setQuery({ ...query, cursor: undefined })}>
        回到第一页
      </button>
      {selected ? (
        <article className="admin-card">
          <h3>Ticket {selected.id}</h3>
          <p>
            冻结资源 {selected.acceptedRequest.resources.request.cpuMillis}m CPU
            / {selected.acceptedRequest.resources.request.memoryMiB} MiB /{" "}
            {selected.acceptedRequest.resources.request.scratchMiB} MiB scratch
            · {selected.acceptedRequest.resources.isolation}
          </p>
          <p>
            期望终止原因 {selected.terminalReason ?? "尚无"} · 实际{" "}
            {selected.phase} · 清理 {selected.cleanupStatus} · 健康{" "}
            {selected.health.state}（{dateLabel(selected.health.observedAt)}）
          </p>
          <p>
            版本 {selected.version} · generation{" "}
            {selected.lease?.generation ?? "未建立"} · 当前有效期{" "}
            {dateLabel(selected.lease?.expiresAt ?? null)} · 总截止{" "}
            {dateLabel(selected.lease?.renewUntil ?? null)}
          </p>
          {selected.renewalPending ? (
            <p>
              续租未决 {selected.renewalPending.renewalId}，仍只承认最后确认期限{" "}
              {dateLabel(selected.renewalPending.lastConfirmedExpiresAt)}
              ；拒绝或确认以原 renewal 查询为准。
            </p>
          ) : null}
          <p>
            排队原因 {selected.scheduling.reasonCodes.join("、") || "无"} ·
            清理阻塞{" "}
            {selected.cleanupBlockedResources
              .map((r) => `${r.kind}:${r.reasonCodes.join(",")}`)
              .join("；") || "无"}
          </p>
          <p>
            固定网络修订{" "}
            {selected.pinnedProfileRevisions.networkProfileRevisionId}
            ；固定存储修订{" "}
            {selected.pinnedProfileRevisions.storageProfileRevisionIds.join(
              "、",
            ) || "无"}
            。访问材料只能由所有者原语获取。
          </p>
          <label>
            操作理由
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
            />
          </label>
          <button
            disabled={
              disabled ||
              !!snapshot.error ||
              !!detailError ||
              !reason.trim() ||
              ["releasing", "released"].includes(selected.phase) ||
              principal.role === "viewer"
            }
            onClick={() =>
              void action(
                `撤销Ticket ${selected.id}`,
                (key) =>
                  client.admin.management.revoke(
                    selected.id,
                    {
                      expectedTicketVersion: selected.version,
                      generation: selected.lease?.generation ?? null,
                      reason,
                    },
                    key,
                  ),
                {
                  kind: "revoke",
                  ticketId: selected.id,
                  body: {
                    expectedTicketVersion: selected.version,
                    generation: selected.lease?.generation ?? null,
                    reason,
                  },
                },
              ).then((ok) => {
                if (ok) void refresh();
              })
            }
          >
            按当前版本撤销并回收
          </button>
          <p>
            撤销不表示消费者确认删除；容量保留至实际删除查实。终止后的失败操作可重试；unknown
            只检查原状态。
          </p>
          <Observation at={timeline.at} error={timeline.error} />
          {timeline.data?.operations.map((o) => (
            <div className="admin-card" key={o.id}>
              <b>
                {o.kind} · {o.state} · v{o.version}
              </b>
              <small>
                {o.id} · attempts {o.attemptCount} · runtime{" "}
                {o.runtimeIdentityId ?? "无"} · transport{" "}
                {o.connectionRevisionId ?? "无"} · 下次对账{" "}
                {new Date(o.nextCheckAtMs).toLocaleString()}
              </small>
              <p>{o.errorCode ?? "未记录错误码"}</p>
              <button
                disabled={
                  disabled || !!timeline.error || !o.retryable || !reason.trim()
                }
                onClick={() =>
                  void action("重试原操作", (key) =>
                    client.admin.management.retryOperation(
                      o.id,
                      { expectedVersion: o.version, reason },
                      key,
                    ),
                  ).then((ok) => {
                    if (ok) void refresh();
                  })
                }
              >
                {o.state === "unknown"
                  ? "未知：等待原操作查实"
                  : "重试可重试操作"}
              </button>
            </div>
          ))}
          <ol>
            {timeline.data?.events.map((event) => (
              <li key={event.id}>
                #{event.id} {new Date(event.occurredAtMs).toLocaleString()} ·{" "}
                {event.type} · v{event.version ?? "—"} · actor{" "}
                {event.actorId ?? "controller"} · {event.reason ?? "无附加理由"}
              </li>
            ))}
          </ol>
          <p>时间线保留策略可能裁剪历史；历史缺失不证明动作成功。</p>
        </article>
      ) : null}
    </section>
  );
}
