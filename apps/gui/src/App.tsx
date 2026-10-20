import React from "react";
import { ComputeClientError, HitchletClient } from "@hitchlet/sdk";
import type {
  AuthenticatedPrincipal,
  AcquireRequest,
  PreparedTicketCommand,
  TicketState,
  TicketSummary,
  TicketView,
} from "@hitchlet/sdk";
import {
  cleanupLabel,
  dateLabel,
  phaseLabel,
  reasonLabel,
  terminalLabel,
} from "./format.js";
import {
  forgetPrepared,
  preparedHint,
  readPrepared,
  savePrepared,
} from "./prepared.js";
import {
  AcquirePanel,
  HealthPanel,
  LoginPanel,
  RecoveryPanel,
  TicketListPanel,
} from "./Panels.js";
import { ManagementConsole } from "./ManagementConsole.js";
import { EventUpdates } from "./EventUpdates.js";

const makeClient = () =>
  new HitchletClient(window.location.origin, {
    auth: { kind: "cookie", csrfToken: () => csrfCookie() },
  });

function csrfCookie() {
  const part = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("hitchlet_csrf="));
  return part ? decodeURIComponent(part.slice("hitchlet_csrf=".length)) : "";
}

function errorText(error: unknown) {
  if (error instanceof ComputeClientError) {
    const action = (
      {
        NETWORK_RESULT_UNKNOWN:
          "结果尚不确定。请在“待恢复操作”中使用原请求恢复。",
        WAIT_TIMEOUT: "等待超时只停止本地等待，Ticket 未被自动取消。",
        LEASE_VERSION_CONFLICT: "租约版本已变化，请刷新详情后再操作。",
        NOT_AUTHORIZED: "当前身份没有执行此操作的权限。",
        QUOTA_EXCEEDED: "申请超出当前配额，请调整资源或联系管理员。",
        NO_CAPACITY: "当前没有满足合同的容量，Ticket 可能继续排队。",
        ALREADY_CLAIMED: "此租约已接用，不能再次首次接用。",
        PREPARED_COMMAND_SAVE_FAILED:
          error.cause instanceof Error
            ? `${error.cause.message} 请恢复或确认旧请求结果后重试。`
            : "原请求未能保存，因此 SDK 没有发送它。请允许此站点使用会话存储后重试。",
        RENEWAL_PENDING: "续租仍在裁决中；原租期仍是唯一确认有效的截止时间。",
      } as Record<string, string>
    )[error.code];
    return `${error.message}（${error.code}）${action ? ` ${action}` : ""}`;
  }
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

type Health = Awaited<ReturnType<HitchletClient["health"]>>;

export function App({ client: injected }: { client?: HitchletClient }) {
  const [client] = React.useState(() => injected ?? makeClient());
  const [principal, setPrincipal] =
    React.useState<AuthenticatedPrincipal | null>(null);
  const [sessionReady, setSessionReady] = React.useState(false);
  const [issuedCredential, setIssuedCredential] = React.useState("");
  const [health, setHealth] = React.useState<Health | null>(null);
  const [healthError, setHealthError] = React.useState("");
  const [tickets, setTickets] = React.useState<readonly TicketSummary[]>([]);
  const [listLoading, setListLoading] = React.useState(false);
  const [listError, setListError] = React.useState("");
  const [phase, setPhase] = React.useState("");
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = React.useState<(string | null)[]>(
    [],
  );
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<TicketView | null>(null);
  const [images, setImages] = React.useState<
    Awaited<ReturnType<typeof client.images.list>>["items"]
  >([]);
  const [commands, setCommands] = React.useState<
    readonly ReturnType<typeof readPrepared>[number][]
  >([]);
  const [busy, setBusy] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");
  const [grant, setGrant] = React.useState<{
    host: string;
    port: number;
    username: string;
    secret: string;
    protocol: string;
    expiresAt: string;
  } | null>(null);
  const [savedConfirmed, setSavedConfirmed] = React.useState(false);
  const [reclaimConfirmed, setReclaimConfirmed] = React.useState(false);
  const [loginToken, setLoginToken] = React.useState("");
  const principalRef = React.useRef(principal);
  const sessionEpoch = React.useRef(0);
  principalRef.current = principal;
  const listRequest = React.useRef(0);
  const detailRequest = React.useRef(0);
  const acquireLock = React.useRef(false);
  const writeLock = React.useRef(false);
  const lastPreparedKey = React.useRef("");
  const accessTimer = React.useRef<number | undefined>(undefined);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (accessTimer.current !== undefined)
        window.clearTimeout(accessTimer.current);
    };
  }, []);

  const waitForRelease = React.useCallback(
    (ticketId: string, epoch: number) =>
      client.tickets.waitUntilReleased(ticketId, {
        timeoutMilliseconds: 300_000,
        isCancelled: () => !mounted.current || epoch !== sessionEpoch.current,
      }),
    [client],
  );

  const expireSession = React.useCallback(() => {
    sessionEpoch.current += 1;
    if (accessTimer.current !== undefined)
      window.clearTimeout(accessTimer.current);
    setPrincipal(null);
    setTickets([]);
    setListLoading(false);
    setImages([]);
    setDetail(null);
    setSelectedId(null);
    setCommands([]);
    setGrant(null);
    setBusy("");
    writeLock.current = false;
    setNotice("会话已失效，请重新登录。");
  }, []);
  const captureError = React.useCallback(
    (e: unknown) => {
      if (e instanceof ComputeClientError && e.statusCode === 401) {
        expireSession();
        return;
      }
      setError(errorText(e));
    },
    [expireSession],
  );
  const renderEpoch = sessionEpoch.current;
  const safeError = React.useCallback(
    (e: unknown) => {
      if (
        renderEpoch === sessionEpoch.current &&
        principalRef.current?.consumerId === principal?.consumerId
      )
        captureError(e);
    },
    [captureError, principal, renderEpoch],
  );

  React.useEffect(() => {
    let active = true;
    void client.session
      .me()
      .then((p) => {
        if (active) setPrincipal(p);
      })
      .catch((e: unknown) => {
        if (
          active &&
          !(e instanceof ComputeClientError && e.statusCode === 401)
        )
          setError(errorText(e));
      })
      .finally(() => {
        if (active) setSessionReady(true);
      });
    return () => {
      active = false;
    };
  }, [client]);

  React.useEffect(() => {
    let alive = true;
    const load = () =>
      void client
        .health()
        .then((value) => {
          if (alive) {
            setHealth(value);
            setHealthError("");
          }
        })
        .catch((e: unknown) => {
          if (alive) setHealthError(errorText(e));
        });
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [client]);

  const refreshList = React.useCallback(
    async (wantedCursor = cursor, wantedPhase = phase) => {
      if (!principal) return;
      const epoch = sessionEpoch.current;
      const request = ++listRequest.current;
      setListLoading(true);
      try {
        const result = await client.tickets.list({
          ...(wantedCursor ? { cursor: wantedCursor } : {}),
          ...(wantedPhase ? { phase: wantedPhase as TicketState } : {}),
        });
        if (epoch === sessionEpoch.current && request === listRequest.current) {
          setTickets(result.items);
          setNextCursor(result.nextCursor);
          setListError("");
          setError("");
        }
      } catch (e) {
        if (epoch === sessionEpoch.current && request === listRequest.current) {
          setListError(errorText(e));
          captureError(e);
        }
      } finally {
        if (epoch === sessionEpoch.current && request === listRequest.current)
          setListLoading(false);
      }
    },
    [client, principal, cursor, phase, captureError],
  );

  React.useEffect(() => {
    if (!principal) return;
    let active = true;
    const epoch = sessionEpoch.current;
    setImages([]);
    void client.images
      .list()
      .then((result) => {
        if (active && epoch === sessionEpoch.current) setImages(result.items);
      })
      .catch((e) => {
        if (active && epoch === sessionEpoch.current) safeError(e);
      });
    return () => {
      active = false;
    };
  }, [principal, client, safeError]);

  React.useEffect(() => {
    if (!principal) return;
    setCommands(readPrepared(principal.consumerId));
    void refreshList();
    const timer = window.setInterval(() => {
      void refreshList();
    }, 8_000);
    return () => {
      window.clearInterval(timer);
      listRequest.current += 1;
    };
  }, [principal, refreshList]);

  const refreshDetail = React.useCallback(
    async (id: string) => {
      const epoch = sessionEpoch.current;
      const request = ++detailRequest.current;
      try {
        const value = await client.tickets.get(id);
        if (
          epoch === sessionEpoch.current &&
          request === detailRequest.current
        ) {
          setDetail(value);
          setError("");
        }
      } catch (e) {
        if (epoch === sessionEpoch.current && request === detailRequest.current)
          captureError(e);
      }
    },
    [client, captureError],
  );

  React.useEffect(() => {
    setDetail(null);
    setGrant(null);
    if (accessTimer.current !== undefined)
      window.clearTimeout(accessTimer.current);
    setSavedConfirmed(false);
    setReclaimConfirmed(false);
    if (!selectedId || !principal) return;
    void refreshDetail(selectedId);
    const timer = window.setInterval(() => {
      void refreshDetail(selectedId);
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      detailRequest.current += 1;
    };
  }, [selectedId, principal, refreshDetail]);

  React.useEffect(() => {
    if (detail?.phase === "ready" && detail.lease?.state === "active") return;
    if (accessTimer.current !== undefined) {
      window.clearTimeout(accessTimer.current);
      accessTimer.current = undefined;
    }
    setGrant(null);
  }, [detail?.phase, detail?.lease?.state]);

  const withPrepared = (consumerId: string) => {
    const epoch = sessionEpoch.current;
    return async (command: PreparedTicketCommand) => {
      if (
        epoch !== sessionEpoch.current ||
        principalRef.current?.consumerId !== consumerId
      )
        throw new Error(
          "The active consumer session changed before this request was sent.",
        );
      lastPreparedKey.current = command.idempotencyKey;
      savePrepared(consumerId, command);
      if (principalRef.current?.consumerId === consumerId)
        setCommands(readPrepared(consumerId));
    };
  };
  const completeCommand = (consumerId: string, key: string) => {
    forgetPrepared(consumerId, key);
    if (principalRef.current?.consumerId === consumerId)
      setCommands(readPrepared(consumerId));
  };
  const runWrite = async <T,>(
    label: string,
    action: () => Promise<T>,
    success?: (result: T) => void,
  ) => {
    if (writeLock.current) return;
    const epoch = sessionEpoch.current;
    writeLock.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const result = await action();
      if (epoch === sessionEpoch.current) success?.(result);
    } catch (e) {
      if (epoch !== sessionEpoch.current) return;
      if (
        e instanceof ComputeClientError &&
        !e.retryable &&
        e.recovery.idempotencyKey &&
        principal
      )
        completeCommand(principal.consumerId, e.recovery.idempotencyKey);
      captureError(e);
    } finally {
      if (epoch === sessionEpoch.current) {
        writeLock.current = false;
        setBusy("");
      }
    }
  };

  async function login(event: React.FormEvent) {
    event.preventDefault();
    const token = loginToken;
    setLoginToken("");
    setError("");
    setNotice("");
    try {
      const authenticated = await client.session.create(token);
      sessionEpoch.current += 1;
      setImages([]);
      setTickets([]);
      setDetail(null);
      setSelectedId(null);
      setGrant(null);
      setPrincipal(authenticated);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function logout() {
    try {
      await client.session.logout();
    } catch (e) {
      captureError(e);
    }
    expireSession();
    setNotice("已退出会话。现有 Ticket 和租约不会因此自动取消或释放。");
  }

  async function acquire(request: AcquireRequest) {
    if (!principal || acquireLock.current) return;
    acquireLock.current = true;
    await runWrite(
      "申请提交中",
      async () => {
        const receipt = await client.tickets.acquire(request, {
          onPrepared: withPrepared(principal.consumerId),
        });
        completeCommand(principal.consumerId, receipt.idempotencyKey);
        return receipt;
      },
      (receipt) => {
        setNotice("申请已受理；准备环境状态以服务端 Ticket 为准。");
        setCursor(null);
        setCursorHistory([]);
        setSelectedId(receipt.ticket.id);
        void refreshList(null, phase);
      },
    );
    acquireLock.current = false;
  }

  async function resumeCommand(item: ReturnType<typeof readPrepared>[number]) {
    if (!principal) return;
    const hint = preparedHint(item.command);
    const epoch = sessionEpoch.current;
    await runWrite(
      "恢复原请求中",
      async () => {
        // The SDK validates this untrusted sessionStorage value with the shared runtime schema.
        const command = item.command as PreparedTicketCommand;
        const result = await client.tickets.resume(command);
        if (
          (hint.kind === "release" || hint.kind === "cancel") &&
          hint.ticketId
        )
          await waitForRelease(hint.ticketId, epoch);
        return result;
      },
      () => {
        if (hint.idempotencyKey)
          completeCommand(principal.consumerId, hint.idempotencyKey);
        setNotice("原准备请求已恢复并取得服务端结果。");
        if (hint.ticketId) {
          setSelectedId(hint.ticketId);
          void refreshDetail(hint.ticketId);
        } else {
          setCursor(null);
          void refreshList(null, phase);
        }
      },
    );
  }

  const ticket = detail;
  const lease = ticket?.lease;
  const canOperate =
    !!principal &&
    principal.role !== "viewer" &&
    principal.scopes.includes("tickets:write") &&
    !healthError &&
    health?.recoveryState === "ready";
  const canClaim =
    canOperate &&
    ticket?.phase === "ready" &&
    lease?.state === "active" &&
    !lease.claimedAt;
  const canRenew =
    canOperate &&
    ticket?.phase === "ready" &&
    lease?.state === "active" &&
    !!lease.claimedAt;
  const canAccess =
    canOperate &&
    ticket?.phase === "ready" &&
    lease?.state === "active" &&
    !!lease.claimedAt;
  const canCancel =
    canOperate && !!ticket && !["releasing", "released"].includes(ticket.phase);
  const canRelease =
    canOperate && ticket?.phase === "ready" && lease?.state === "active";
  const pendingFor = (kind: PreparedTicketCommand["kind"], ticketId?: string) =>
    commands.some((item) => {
      const hint = preparedHint(item.command);
      return hint.kind === kind && (!ticketId || hint.ticketId === ticketId);
    });

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">H</span>
          <span>
            HITCHLET<small>计算资源控制台</small>
          </span>
        </a>
        {principal ? (
          <div className="identity">
            <span>
              {principal.role} · {principal.consumerId.slice(0, 8)}…
            </span>
            <button className="quiet-button" onClick={() => void logout()}>
              退出
            </button>
          </div>
        ) : null}
      </header>
      <main>
        <section className="hero">
          <div>
            <div className="eyebrow">临时计算环境</div>
            <h1>
              搭个便车：
              <br className="mobile-break" />
              凭票上车，用完下车
            </h1>
            <p>为任务申请临时计算环境，并在确认保存结果后安全归还。</p>
          </div>
          <div className="hero-ornament" aria-hidden="true">
            <span>01</span>
            <i>→</i>
            <span>02</span>
            <i>→</i>
            <span>03</span>
          </div>
        </section>
        {issuedCredential ? (
          <section className="panel">
            <h2>新控制 token（立即安全保存）</h2>
            <textarea
              aria-label="新控制 token"
              readOnly
              value={issuedCredential}
            />
            <p>
              旧 token
              与其会话已失效。此值仅在当前页面内存中显示，刷新页面后无法再次领取。
            </p>
            <button onClick={() => setIssuedCredential("")}>
              已保存，清除 token 显示
            </button>
          </section>
        ) : null}
        <HealthPanel health={health} error={healthError} />
        {principal?.scopes.includes("events:read") ? (
          <EventUpdates
            key={`events:${principal.consumerId}`}
            client={client}
            onRefresh={() => {
              void refreshList();
              if (selectedId) void refreshDetail(selectedId);
            }}
          />
        ) : null}
        {principal &&
        ["admin", "operator", "viewer"].includes(principal.role) ? (
          <ManagementConsole
            key={`management:${principal.consumerId}`}
            client={client}
            principal={principal}
            onCredentialIssued={setIssuedCredential}
          />
        ) : null}
        {notice ? (
          <div className="notice" role="status">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : null}
        {!sessionReady ? (
          <LoginPanel
            token={loginToken}
            onToken={setLoginToken}
            onSubmit={login}
            loading
          />
        ) : !principal ? (
          <LoginPanel
            token={loginToken}
            onToken={setLoginToken}
            onSubmit={login}
            loading={false}
          />
        ) : (
          <>
            <TicketListPanel
              tickets={tickets}
              loading={listLoading}
              error={listError}
              phase={phase}
              cursorHistory={cursorHistory}
              nextCursor={nextCursor}
              selectedId={selectedId}
              onRefresh={() => void refreshList()}
              onPhase={(next) => {
                setPhase(next);
                setCursor(null);
                setCursorHistory([]);
                void refreshList(null, next);
              }}
              onPrevious={() => {
                const previous =
                  cursorHistory[cursorHistory.length - 1] ?? null;
                setCursorHistory(cursorHistory.slice(0, -1));
                setCursor(previous);
                void refreshList(previous);
              }}
              onNext={() => {
                setCursorHistory([...cursorHistory, cursor]);
                setCursor(nextCursor);
                void refreshList(nextCursor);
              }}
              onSelect={setSelectedId}
            />
            {ticket ? (
              <section className="detail-section">
                <div className="section-title-row">
                  <div>
                    <div className="section-kicker">Ticket 详情</div>
                    <h2>
                      {phaseLabel(ticket.phase)}{" "}
                      <span className="version-tag">v{ticket.version}</span>
                    </h2>
                  </div>
                  <button
                    className="quiet-button"
                    onClick={() => void refreshDetail(ticket.id)}
                  >
                    刷新详情 ↻
                  </button>
                </div>
                <div className="ticket-id">{ticket.id}</div>
                <div className="detail-grid">
                  <div>
                    <small>镜像版本</small>
                    <b>{ticket.acceptedRequest.image.versionId}</b>
                  </div>
                  <div>
                    <small>资源合同 · request / limit</small>
                    <b>
                      {ticket.acceptedRequest.resources.request.cpuMillis} /{" "}
                      {ticket.acceptedRequest.resources.limit.cpuMillis}m CPU ·{" "}
                      {ticket.acceptedRequest.resources.request.memoryMiB} /{" "}
                      {ticket.acceptedRequest.resources.limit.memoryMiB} MiB
                      内存 ·{" "}
                      {ticket.acceptedRequest.resources.request.scratchMiB} /{" "}
                      {ticket.acceptedRequest.resources.limit.scratchMiB} MiB
                      临时盘
                    </b>
                    <span>
                      {ticket.acceptedRequest.resources.scratchEnforcement ===
                      "required"
                        ? "要求硬限额"
                        : "空间预算，不保证硬限额"}
                    </span>
                  </div>
                  <div>
                    <small>放置</small>
                    <b>
                      {ticket.placement
                        ? `${ticket.placement.provider} · ${ticket.placement.architecture}`
                        : "尚未分配"}
                    </b>
                    <span>
                      {ticket.placement
                        ? `Node ${ticket.placement.nodeId}`
                        : "等待调度"}
                    </span>
                  </div>
                  <div>
                    <small>Lease generation / version</small>
                    <b>
                      {lease
                        ? `${lease.generation} / ${lease.version}`
                        : "尚未建立"}
                    </b>
                    <span>
                      接用：
                      {lease?.claimedAt
                        ? dateLabel(lease.claimedAt)
                        : "尚未接用"}
                    </span>
                  </div>
                  <div>
                    <small>首次接用截止</small>
                    <b>{dateLabel(lease?.claimBy ?? null)}</b>
                  </div>
                  <div>
                    <small>当前到期 / 总寿命截止</small>
                    <b>{dateLabel(lease?.expiresAt ?? null)}</b>
                    <span>
                      续租上限：{dateLabel(lease?.renewUntil ?? null)}
                    </span>
                  </div>
                </div>
                <div className="explain-box">
                  <b>技术状态：{ticket.health.state}</b>
                  <p>
                    技术健康只说明执行环境的观测结果，不代表你的业务任务成功或数据已保存。
                  </p>
                  {ticket.scheduling.reasonCodes.length ? (
                    <p>
                      等待原因：
                      {ticket.scheduling.reasonCodes
                        .map(reasonLabel)
                        .join("、")}
                    </p>
                  ) : null}
                  {ticket.cleanupBlockedResources.length ? (
                    <p className="error-inline">
                      回收阻塞：
                      {ticket.cleanupBlockedResources
                        .flatMap((r) => r.reasonCodes)
                        .map(reasonLabel)
                        .join("、") || "资源仍未查实"}
                    </p>
                  ) : null}
                  <p>
                    终止原因：{terminalLabel(ticket.terminalReason)} · 清理：
                    {cleanupLabel(ticket.cleanupStatus)}
                    {ticket.releasedAt
                      ? `（${dateLabel(ticket.releasedAt)}）`
                      : ""}
                  </p>
                </div>
                <div className="action-area">
                  <div className="action-buttons">
                    <button
                      className="primary-button"
                      disabled={
                        !canClaim || !!busy || pendingFor("renew", ticket.id)
                      }
                      onClick={() =>
                        void runWrite(
                          "首次接用中",
                          async () => {
                            const result = await client.tickets.claim(
                              ticket.id,
                              {
                                onPrepared: withPrepared(principal.consumerId),
                              },
                            );
                            completeCommand(
                              principal.consumerId,
                              lastPreparedKey.current,
                            );
                            return result;
                          },
                          () => {
                            setNotice("首次接用已确认，租约截止时间已更新。");
                            void refreshDetail(ticket.id);
                          },
                        )
                      }
                    >
                      {busy === "首次接用中" ? "确认中…" : "首次接用 / Claim"}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={
                        !canRenew || !!busy || pendingFor("renew", ticket.id)
                      }
                      onClick={() =>
                        void runWrite(
                          "续租确认中",
                          async () => {
                            const result = await client.tickets.renew(
                              ticket.id,
                              {},
                              {
                                onPrepared: withPrepared(principal.consumerId),
                              },
                            );
                            completeCommand(
                              principal.consumerId,
                              lastPreparedKey.current,
                            );
                            return result;
                          },
                          () => {
                            setNotice("续租已确认，详情中的期限将更新。");
                            void refreshDetail(ticket.id);
                          },
                        )
                      }
                    >
                      手动续租
                    </button>
                    <button
                      className="secondary-button"
                      disabled={
                        !canAccess || !!busy || pendingFor("access", ticket.id)
                      }
                      onClick={() =>
                        void runWrite(
                          "获取访问材料中",
                          async () => {
                            const value = await client.tickets.getAccess(
                              ticket.id,
                              {
                                onPrepared: withPrepared(principal.consumerId),
                              },
                            );
                            completeCommand(
                              principal.consumerId,
                              lastPreparedKey.current,
                            );
                            return value;
                          },
                          (value) => {
                            const auth = value.authentication;
                            const secret =
                              auth.kind === "ephemeral_password"
                                ? auth.password
                                : auth.kind === "ssh_certificate"
                                  ? auth.certificate
                                  : auth.kind === "ephemeral_private_key"
                                    ? auth.privateKey
                                    : auth.kind === "client_public_key"
                                      ? auth.publicKeyFingerprint
                                      : "";
                            setGrant({
                              host: value.access.host,
                              port: value.access.port,
                              username: value.access.username,
                              secret,
                              protocol: value.access.protocol,
                              expiresAt: value.access.expiresAt,
                            });
                            if (accessTimer.current !== undefined)
                              window.clearTimeout(accessTimer.current);
                            accessTimer.current = window.setTimeout(
                              () => setGrant(null),
                              60_000,
                            );
                            setNotice(
                              "访问材料仅在本页内存显示 60 秒；Simulator 不提供真实 SSH/RDP 连接能力。",
                            );
                          },
                        )
                      }
                    >
                      获取接用材料
                    </button>
                    <button
                      className="danger-button"
                      disabled={
                        !canCancel || !!busy || pendingFor("cancel", ticket.id)
                      }
                      onClick={() => {
                        if (
                          window.confirm(
                            "取消此 Ticket？如环境已创建，服务端会进入必要的清理流程。",
                          )
                        )
                          void runWrite(
                            "取消处理中",
                            async () => {
                              const result = await client.tickets.cancel(
                                ticket.id,
                                {},
                                {
                                  onPrepared: withPrepared(
                                    principal.consumerId,
                                  ),
                                },
                              );
                              completeCommand(
                                principal.consumerId,
                                lastPreparedKey.current,
                              );
                              return result;
                            },
                            () => {
                              setNotice("取消请求已受理；请等待清理状态确认。");
                              void refreshDetail(ticket.id);
                            },
                          );
                      }}
                    >
                      取消 Ticket
                    </button>
                    {ticket.phase === "releasing" ? (
                      <button
                        className="secondary-button"
                        disabled={!!busy}
                        onClick={() =>
                          void runWrite(
                            "等待清理完成",
                            () =>
                              waitForRelease(ticket.id, sessionEpoch.current),
                            () => {
                              setNotice(
                                "服务端已确认环境释放，临时资源清理完成。",
                              );
                              void refreshDetail(ticket.id);
                            },
                          )
                        }
                      >
                        等待回收完成
                      </button>
                    ) : null}
                  </div>
                  <div className="release-confirm">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={savedConfirmed}
                        onChange={(e) => setSavedConfirmed(e.target.checked)}
                      />
                      我已保存需要保留的数据
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={reclaimConfirmed}
                        onChange={(e) => setReclaimConfirmed(e.target.checked)}
                      />
                      我同意删除这个临时环境及其中未保存的数据
                    </label>
                    <button
                      className="danger-button"
                      disabled={
                        !canRelease ||
                        !savedConfirmed ||
                        !reclaimConfirmed ||
                        !!busy ||
                        pendingFor("release", ticket.id)
                      }
                      onClick={() => {
                        const actionEpoch = sessionEpoch.current;
                        void runWrite(
                          "归还并等待回收",
                          async () => {
                            await client.tickets.release(
                              ticket.id,
                              { reclaimable: true },
                              {
                                onPrepared: withPrepared(principal.consumerId),
                              },
                            );
                            if (
                              actionEpoch === sessionEpoch.current &&
                              mounted.current
                            )
                              setNotice(
                                "归还已请求，环境正在回收；容量释放须等服务端确认。",
                              );
                            const released = await waitForRelease(
                              ticket.id,
                              actionEpoch,
                            );
                            completeCommand(
                              principal.consumerId,
                              lastPreparedKey.current,
                            );
                            return released;
                          },
                          () => {
                            setNotice(
                              "服务端已确认环境释放，临时资源清理完成。",
                            );
                            void refreshDetail(ticket.id);
                            void refreshList();
                          },
                        );
                      }}
                    >
                      {busy === "归还并等待回收"
                        ? "等待回收确认…"
                        : "确认归还并删除临时环境"}
                    </button>
                  </div>
                  {grant ? (
                    <div className="access-card">
                      <b>短期访问材料 · {grant.protocol}</b>
                      <p>
                        {grant.protocol} {grant.username}@{grant.host}:
                        {grant.port}
                      </p>
                      <p>{grant.secret}</p>
                      <small>
                        有效至 {dateLabel(grant.expiresAt)} ·
                        请妥善复制，关闭详情或 60 秒后自动隐藏。
                      </small>
                      <button
                        className="secondary-button"
                        onClick={() =>
                          void navigator.clipboard?.writeText(
                            `Protocol: ${grant.protocol}\nHost: ${grant.host}\nPort: ${grant.port}\nUsername: ${grant.username}\nExpires: ${grant.expiresAt}\nCredential: ${grant.secret}`,
                          )
                        }
                      >
                        复制访问材料
                      </button>
                      <button
                        className="quiet-button"
                        onClick={() => {
                          if (accessTimer.current !== undefined)
                            window.clearTimeout(accessTimer.current);
                          setGrant(null);
                        }}
                      >
                        隐藏
                      </button>
                      <p className="muted">
                        当前 Simulator 不提供真实 Docker/SSH
                        连接；此材料只展示测试访问合同。
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
            <AcquirePanel
              images={images}
              canOperate={canOperate}
              busy={!!busy}
              blocked={pendingFor("acquire")}
              onAcquire={(request) => void acquire(request)}
              client={client}
              onError={safeError}
            />
            <RecoveryPanel
              commands={commands}
              busy={!!busy}
              onResume={(command) => void resumeCommand(command)}
            />
            <section className="catalog-section">
              <div className="section-title-row">
                <div>
                  <div className="section-kicker">只读授权目录</div>
                  <h2>可用镜像</h2>
                </div>
              </div>
              {images.length ? (
                <div className="catalog-grid">
                  {images.map((image) => (
                    <article key={image.id}>
                      <span className="image-glyph">▧</span>
                      <b>{image.name}</b>
                      <p>{image.description}</p>
                      <small>{image.id}</small>
                      <small>
                        申请向导提供当前授权的不可变版本、网络和存储选择。
                      </small>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">没有已授权镜像。</p>
              )}
            </section>
          </>
        )}
      </main>
      <footer>
        <span>Hitchlet · 凭票上车，用完下车</span>
        <span>接口是状态权威 · 最近轮询约 5 秒</span>
      </footer>
    </div>
  );
}
