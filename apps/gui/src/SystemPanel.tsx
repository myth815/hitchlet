import React from "react";
import type { HitchletClient } from "@hitchlet/sdk";
type Admin = HitchletClient["admin"];
const admissionLabels: Record<string, string> = {
  open: "开放",
  paused: "管理员暂停",
  recovery_required: "恢复隔离",
  disk_low: "磁盘低水位",
  disk_full: "磁盘满或写入失败",
  disk_unknown: "磁盘事实未知",
};
/** Operational essentials; database replacement remains an offline CLI workflow. */
export function SystemPanel({
  client,
  canWrite,
  onCredentialIssued,
}: {
  client: HitchletClient;
  canWrite: boolean;
  onCredentialIssued?: (token: string) => void;
}) {
  const [open, setOpen] = React.useState(false),
    [connected, setConnected] = React.useState(false),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState("");
  const [health, setHealth] = React.useState<Awaited<
      ReturnType<Admin["systemHealth"]>
    > | null>(null),
    [backups, setBackups] = React.useState<
      Awaited<ReturnType<Admin["backups"]>>
    >([]),
    [credentials, setCredentials] = React.useState<
      Awaited<ReturnType<Admin["credentials"]>>
    >([]);
  const [reason, setReason] = React.useState(""),
    [confirmed, setConfirmed] = React.useState(false),
    [newToken, setNewToken] = React.useState("");
  const permission = React.useRef(canWrite);
  permission.current = canWrite;
  React.useEffect(() => {
    if (!canWrite) {
      setNewToken("");
      setConnected(false);
    }
  }, [canWrite]);
  const mounted = React.useRef(true),
    inflight = React.useRef(false);
  const refresh = React.useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [health, backups, credentials] = await Promise.all([
        client.admin.systemHealth(),
        client.admin.backups(),
        client.admin.credentials(),
      ]);
      if (mounted.current) {
        setHealth(health);
        setBackups(backups);
        setCredentials(credentials);
        setConnected(true);
        setError("");
      }
    } catch {
      if (mounted.current) {
        setConnected(false);
        setError("连接中断：下方为历史状态，当前状态未知。");
      }
    } finally {
      inflight.current = false;
    }
  }, [client]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (!open || newToken) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [open, newToken, refresh]);
  const act = async (work: () => Promise<unknown>) => {
    if (busy || !canWrite || !connected) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : "维护操作失败");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <details
      className="admin-card"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (!event.currentTarget.open) setNewToken("");
      }}
    >
      <summary>系统维护与控制凭据</summary>
      {error ? <p role="alert">{error}</p> : null}
      <p>
        准入：{health ? admissionLabels[health.admission] : "尚未读取"}。
        {health?.reason}
      </p>
      <p>
        数据库卷可用 {health?.disk.availableMiB ?? "未知"} MiB；低水位{" "}
        {health?.disk.lowWaterMiB ?? "—"} MiB。离线租期截止：unsupported。
      </p>
      {health?.runtimeDisks.map((d) => (
        <p key={d.nodeId}>
          Node {d.nodeId}：{d.state}，可用 {d.availableMiB ?? "未知"} MiB
        </p>
      ))}
      <label>
        维护原因
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button
        disabled={!connected || !canWrite || busy || !reason.trim()}
        onClick={() => void act(() => client.admin.pauseAdmission(reason))}
      >
        暂停新准入
      </button>
      <button
        disabled={
          !connected ||
          !canWrite ||
          busy ||
          !reason.trim() ||
          health?.admission !== "paused"
        }
        onClick={() => void act(() => client.admin.resumeAdmission(reason))}
      >
        显式开放准入
      </button>
      <button
        disabled={
          !connected ||
          !canWrite ||
          busy ||
          (health?.admission !== "open" && health?.admission !== "paused")
        }
        onClick={() => void act(() => client.admin.backup())}
      >
        创建一致性备份
      </button>
      <p>
        最近成功备份：
        {backups[0]
          ? new Date(backups[0].createdAtMs).toLocaleString()
          : "尚无备份"}
        ；本地 {backups.length} 份。主密钥和加密秘密目录须独立保管。
      </p>
      <p>恢复使用停服 CLI，并保留故障库；页面不覆盖当前数据库。</p>
      {health?.recoveryRequired ? (
        <>
          <p>恢复阶段：{health.recovery?.stage}；未知资源所在节点继续隔离。</p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            已停旧端、撤销旧 Provider/Runtime 凭据，确认对账与隔离结果
          </label>
          <button
            disabled={
              !connected ||
              !canWrite ||
              busy ||
              !confirmed ||
              !reason.trim() ||
              health.recovery?.stage !== "reconciling"
            }
            onClick={() =>
              void act(() =>
                client.admin.approveRecovery({
                  reason,
                  oldControllerStopped: true,
                  oldProviderCredentialsRevoked: true,
                  oldRuntimeCredentialsRevoked: true,
                }),
              )
            }
          >
            确认恢复检查（保持暂停）
          </button>
        </>
      ) : null}
      <h4>凭据元数据</h4>
      <p>
        轮换会立即使旧 token 与其浏览器会话失效。新 token 仅在本页显示一次。
      </p>
      {credentials.map((c) => (
        <div key={c.credentialId}>
          <span>
            {c.consumerName} · {c.credentialId} · {c.tokenPrefix}… · {c.status}
          </span>
          <button
            disabled={
              !connected ||
              !canWrite ||
              busy ||
              !!newToken ||
              (c.status === "revoked" &&
                credentials.some(
                  (other) =>
                    other.consumerId === c.consumerId &&
                    other.status === "active",
                ))
            }
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void client.admin
                .rotateCredential({
                  consumerId: c.consumerId,
                  credentialId: c.credentialId,
                })
                .then((r) => {
                  if (mounted.current && permission.current) {
                    setNewToken(r.token);
                    onCredentialIssued?.(r.token);
                    setConnected(false);
                  }
                })
                .catch((e) => {
                  if (mounted.current)
                    setError(e instanceof Error ? e.message : "轮换失败");
                })
                .finally(() => {
                  if (mounted.current) setBusy(false);
                });
            }}
          >
            轮换此凭据
          </button>
        </div>
      ))}
      {newToken && canWrite && !onCredentialIssued ? (
        <>
          <label>
            新 token（立即安全保存）
            <textarea readOnly value={newToken} />
          </label>
          <button
            onClick={() => {
              setNewToken("");
              setOpen(false);
            }}
          >
            已保存，清除显示
          </button>
          <p>轮换当前登录凭据后，请使用新 token 重新登录。</p>
        </>
      ) : null}
    </details>
  );
}
