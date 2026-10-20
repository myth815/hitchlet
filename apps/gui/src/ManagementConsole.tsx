import React from "react";
import {
  ComputeClientError,
  PreparedManagementRevokeSchema,
  type AuthenticatedPrincipal,
  type HitchletClient,
  type PreparedManagementRevoke,
} from "@hitchlet/sdk";
import { AdminPanel } from "./AdminPanel.js";
import {
  managementPrepared,
  saveManagementPrepared,
  forgetManagementPrepared,
} from "./management-prepared.js";
import { ManagementTickets } from "./ManagementTickets.js";
import { InventorySetup } from "./InventorySetup.js";
import { ProfileSetup } from "./ProfileSetup.js";
import { ConsumerSetup } from "./ConsumerSetup.js";
import { ImageSetup } from "./ImageSetup.js";
import {
  Observation,
  managementError,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";

export function ManagementConsole({
  client: sourceClient,
  principal,
  onCredentialIssued,
}: {
  client: HitchletClient;
  principal: AuthenticatedPrincipal;
  onCredentialIssued: (token: string) => void;
}) {
  const [tab, setTab] = React.useState("overview"),
    [busy, setBusy] = React.useState(false),
    [message, setMessage] = React.useState("");
  const storageKey = `hitchlet.management.pending.${principal.consumerId}`;
  type Pending = {
    key: string;
    label: string;
    page: string;
    path?: string;
    recovery?: PreparedManagementRevoke;
  };
  const [pending, setPending] = React.useState<Pending[]>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return [];
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return [];
      return value.flatMap((p: unknown) => {
        if (
          !p ||
          typeof p !== "object" ||
          !("key" in p) ||
          typeof p.key !== "string" ||
          !("label" in p) ||
          typeof p.label !== "string"
        )
          return [];
        const recovery = PreparedManagementRevokeSchema.safeParse(
          "recovery" in p ? p.recovery : undefined,
        );
        return [
          {
            key: p.key,
            label: p.label,
            page:
              "page" in p && typeof p.page === "string" ? p.page : "overview",
            ...("path" in p && typeof p.path === "string"
              ? { path: p.path }
              : {}),
            ...(recovery.success ? { recovery: recovery.data } : {}),
          },
        ];
      });
    } catch {
      return [];
    }
  });
  const lock = React.useRef(false),
    mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pendingRef = React.useRef(pending);
  pendingRef.current = pending;
  const client = React.useMemo(
    () =>
      sourceClient.withManagementPreparation(
        (command) => {
          saveManagementPrepared(principal.consumerId, command);
          const path = `${command.method} ${command.path}`;
          const records = pendingRef.current.some(
            (p) => p.key === command.idempotencyKey,
          )
            ? pendingRef.current.map((p) =>
                p.key === command.idempotencyKey ? { ...p, path } : p,
              )
            : [
                ...pendingRef.current,
                {
                  key: command.idempotencyKey,
                  label: `${command.method} ${command.path}`,
                  page: "maintenance",
                  path,
                },
              ];
          sessionStorage.setItem(storageKey, JSON.stringify(records));
          pendingRef.current = records;
          if (mounted.current) setPending(records);
        },
        (key) => {
          forgetManagementPrepared(principal.consumerId, key);
          const records = pendingRef.current.filter((p) => p.key !== key);
          sessionStorage.setItem(storageKey, JSON.stringify(records));
          pendingRef.current = records;
          if (mounted.current) setPending(records);
        },
      ),
    [sourceClient, principal.consumerId, storageKey],
  );
  const load = React.useCallback(
    () => client.admin.management.overview(),
    [client],
  );
  const overview = useManagementRead(load);
  const canWrite =
    ["admin", "operator"].includes(principal.role) &&
    principal.scopes.includes("tickets:revoke");
  const disabled = !canWrite || busy || !!overview.error || !overview.data;
  const remember = (records: Pending[]) => {
    sessionStorage.setItem(storageKey, JSON.stringify(records));
    pendingRef.current = records;
    setPending(records);
  };
  const action: ManagementUI["action"] = async (label, work, recovery) => {
    if (disabled || lock.current) return false;
    if (pending.some((p) => p.label === label)) {
      setMessage(
        "这项原命令尚未确认。先检查原回执和目标状态；其他回收与维护仍可操作。",
      );
      return false;
    }
    if (pending.length >= 8) {
      setMessage("此标签页已有8项未决管理命令。请先调查原操作；不会丢弃旧键。");
      return false;
    }
    lock.current = true;
    setBusy(true);
    setMessage("");
    const record = {
      key: crypto.randomUUID(),
      label,
      page: tab,
      ...(recovery ? { recovery } : {}),
    };
    try {
      remember([...pending, record]);
      await work(record.key);
      remember(pending);
      if (mounted.current) {
        setMessage("请求已由服务端确认；以刷新后的状态和清理证据为准。");
        void overview.refresh();
      }
      return true;
    } catch (e) {
      const unknown =
        e instanceof ComputeClientError &&
        (e.code === "NETWORK_RESULT_UNKNOWN" ||
          e.code === "INVALID_RESPONSE" ||
          e.code === "WAIT_CANCELLED" ||
          e.code === "management_result_unknown" ||
          (e.statusCode ?? 0) >= 500);
      if (!unknown) {
        forgetManagementPrepared(principal.consumerId, record.key);
        remember(pending);
      }
      if (mounted.current)
        setMessage(
          unknown
            ? "结果未知。保存原命令键，仅阻止重复该意图；无关回收与维护仍可操作。"
            : managementError(e),
        );
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const savedRequest = (key: string) => {
    try {
      return managementPrepared(principal.consumerId).find(
        (c) => c.idempotencyKey === key,
      );
    } catch {
      return undefined;
    }
  };
  const ui: ManagementUI = { client, principal, disabled, action };
  const requestPath = (record: Pending) => {
    const command = savedRequest(record.key);
    return command ? `${command.method} ${command.path}` : record.path;
  };
  const resolve = async (record: Pending) => {
    try {
      const receipt = (await client.admin.management.commandReceipts()).find(
        (r) => r.key === record.key,
      );
      if (receipt?.state === "completed") {
        forgetManagementPrepared(principal.consumerId, record.key);
        remember(pending.filter((p) => p.key !== record.key));
        setMessage(
          `原命令返回 HTTP ${receipt.status}。刷新对应目录核对结果；受理不等于实际清理完成。`,
        );
        void overview.refresh();
      } else {
        if (receipt)
          remember(
            pending.map((p) =>
              p.key === record.key ? { ...p, path: receipt.path } : p,
            ),
          );
        setMessage(
          "原命令仍未知。到对应目录和原持久操作核对真实状态；禁止据超时推断未创建。只有查实后才记录人工调查；不会把unknown改成成功或释放Claim。凭据签发需先读凭据元数据并轮换。",
        );
      }
    } catch (e) {
      setMessage(managementError(e));
    }
  };
  const review = async (record: Pending) => {
    const path = requestPath(record);
    if (!path) {
      await resolve(record);
      return;
    }
    const evidenceTargetId = window.prompt(
      "输入已查实的原 Operation/资源 UUID（从目录/原操作复制），此动作仅记录调查，不确认成功、不执行任何资源变更。",
    );
    if (!evidenceTargetId) return;
    const reason = window.prompt(
      "记录调查证据与处理结论（至少10字）。只有实际结果已查实后才结束本地等待；未查实请取消。",
    );
    if (!reason) return;
    try {
      await client.admin.management.reviewCommand({
        key: record.key,
        path,
        evidenceTargetId,
        reason,
      });
      forgetManagementPrepared(principal.consumerId, record.key);
      remember(pending.filter((p) => p.key !== record.key));
      setMessage(
        "人工调查已审计。原命令真实状态未被改写，原键仍不能重复执行；请继续使用已查实的资源/Operation处理后续工作。",
      );
    } catch (e) {
      setMessage(managementError(e));
    }
  };
  return (
    <section className="admin-section" aria-label="完整管理工作台">
      <h2>管理工作台 · {principal.role}</h2>
      <p>
        Docker 底座由人工常开维护 · shared_kernel · scratch best_effort ·
        offline unsupported · 原生电源默认关闭，逐机资格见机器面板。可信 Agent
        部署和能力取证先按接入手册完成。
      </p>
      <Observation at={overview.at} error={overview.error} />
      <nav className="management-tabs" aria-label="管理页面">
        {[
          ["overview", "总览"],
          ["tickets", "Ticket 与操作"],
          ...(principal.role === "admin"
            ? [
                ["inventory", "后端与节点"],
                ["profiles", "网络与存储"],
                ["consumers", "消费者与配额"],
                ["images", "镜像登记"],
                ["maintenance", "验证、机器与系统维护"],
              ]
            : []),
        ].map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      {message ? <p role="status">{message}</p> : null}
      {pending.map((record) => (
        <div className="error-banner" key={record.key}>
          <b>待调查：{record.label}</b>
          <button
            disabled={busy || !savedRequest(record.key)}
            onClick={() => {
              const command = savedRequest(record.key);
              if (command)
                void client.admin
                  .resumeManagement(command)
                  .then(() => {
                    forgetManagementPrepared(principal.consumerId, record.key);
                    remember(pending.filter((p) => p.key !== record.key));
                    setMessage(
                      "已按原方法、原body、原CAS和原key恢复。请刷新实际状态。",
                    );
                  })
                  .catch((e) => setMessage(managementError(e)));
            }}
          >
            按保存的原请求恢复
          </button>
          <p>
            原 key {record.key} ·{" "}
            {requestPath(record) ?? "点击检查以读取原路径"}
            ；刷新保留，不会自动重发。
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setTab(record.page);
              void resolve(record);
            }}
          >
            检查原命令回执 / 转到原页面
          </button>
          <button
            disabled={busy || !record.recovery}
            onClick={() => {
              if (record.recovery)
                void client.admin.management
                  .revoke(
                    record.recovery.ticketId,
                    record.recovery.body,
                    record.key,
                  )
                  .then(() => {
                    remember(pending.filter((p) => p.key !== record.key));
                    setMessage("已用原key恢复撤销；请刷新Ticket与清理状态。");
                  })
                  .catch((e) => setMessage(managementError(e)));
            }}
          >
            按原键恢复Ticket撤销
          </button>
          <button
            disabled={busy || !requestPath(record)}
            onClick={() => void review(record)}
          >
            已查实原目标，记录人工调查
          </button>
          <p>
            未知意图禁止重复。无关回收、备份和维护继续可用。人工调查只是审计确认，不是后端成功证据。
          </p>
        </div>
      ))}
      {tab === "overview" && overview.data ? (
        <>
          <div className="admin-grid">
            {Object.entries(overview.data.phases).map(([phase, count]) => (
              <button key={phase} onClick={() => setTab("tickets")}>
                {phase}：{count} · 查看 Ticket
              </button>
            ))}
            <button onClick={() => setTab("tickets")}>
              清理阻塞 {overview.data.cleanupBlocked} / 未知操作{" "}
              {overview.data.unknownOperations}
            </button>
          </div>
          <div className="admin-grid">
            {overview.data.machines.map((m) => (
              <article className="admin-card" key={m.id}>
                <b>
                  {m.name} · {m.admission} · 电源账本 {m.observedPower}
                </b>
                <p>
                  Host {m.hostObservation} · 人 {m.humanPresence}
                  ；未知不视为无人。
                </p>
                <p>
                  总预算 {m.capacity.cpuMillis}m / {m.capacity.memoryMiB} MiB /{" "}
                  {m.capacity.scratchMiB} MiB · 已占 {m.claimed.cpuMillis}m /{" "}
                  {m.claimed.memoryMiB} MiB / {m.claimed.scratchMiB} MiB ·
                  系统保留 {m.systemReserve.cpuMillis}m /{" "}
                  {m.systemReserve.memoryMiB} MiB
                </p>
                {m.nodes.map((n) => (
                  <p key={n.id}>
                    {n.name} · {n.admission}/{n.health} ·{" "}
                    {n.canAdmit ? "可进入准入裁决" : "禁止新准入"} · 预算余量{" "}
                    {n.available.cpuMillis}m / {n.available.memoryMiB} MiB /{" "}
                    {n.available.scratchMiB} MiB · {n.reasons.join("、")}
                  </p>
                ))}
              </article>
            ))}
          </div>
          <h3>初始化与接入清单</h3>
          <ol>
            <li>
              登记并探测 Portainer：{overview.data.initialization.connections}
            </li>
            <li>
              登记保守预算 Machine / Node：
              {overview.data.initialization.machines} /{" "}
              {overview.data.initialization.nodes}
            </li>
            <li>通过可信 CLI 部署 Agent、录入秘密版本并取证</li>
            <li>
              创建授权 profiles；验证并发布镜像：
              {overview.data.initialization.publishedVersions}
            </li>
            <li>为消费者配置配额和目录授权；申请、接用、续租及归还试租</li>
          </ol>
          <p>
            容量、依赖、Host人与电源未知观测见「验证、机器与系统维护」中的机器页；未知不表示零占用。
          </p>
        </>
      ) : null}
      {tab === "tickets" ? <ManagementTickets {...ui} /> : null}
      {tab === "inventory" ? <InventorySetup {...ui} /> : null}
      {tab === "profiles" ? <ProfileSetup {...ui} /> : null}
      {tab === "consumers" ? (
        <ConsumerSetup {...ui} onCredentialIssued={onCredentialIssued} />
      ) : null}
      {tab === "images" ? <ImageSetup {...ui} /> : null}
      {tab === "maintenance" ? (
        <AdminPanel
          client={client}
          principal={principal}
          onCredentialIssued={onCredentialIssued}
          connected={!!overview.data && !overview.error}
        />
      ) : null}
    </section>
  );
}
