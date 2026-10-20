import React from "react";
import type {
  HitchletClient,
  AuthorizedCatalog,
  StorageRequest,
} from "@hitchlet/sdk";
import { managementError } from "./ManagementUI.js";

/** Optional validation mounts use the same safe authorized directory as tenant requests. */
export function ValidationStorage({
  client,
  value,
  onChange,
  disabled,
}: {
  client: HitchletClient;
  value: StorageRequest[];
  onChange: (v: StorageRequest[]) => void;
  disabled: boolean;
}) {
  const [profiles, setProfiles] = React.useState<AuthorizedCatalog["storage"]>(
      [],
    ),
    [error, setError] = React.useState("");
  return (
    <div className="admin-card">
      <h4>验证用授权挂载（可选）</h4>
      <button
        type="button"
        onClick={() =>
          void client
            .catalog()
            .then((c) => {
              setProfiles(c.storage);
              setError("");
            })
            .catch((e) => setError(managementError(e)))
        }
      >
        读取安全存储目录
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <fieldset disabled={disabled}>
        {value.map((m, i) => {
          const profile = profiles.find((p) => p.id === m.storageProfileId);
          const set = (patch: Partial<StorageRequest>) =>
            onChange(value.map((m, j) => (i === j ? { ...m, ...patch } : m)));
          return (
            <div className="admin-card" key={i}>
              <label>
                Profile
                <select
                  value={m.storageProfileId}
                  onChange={(e) => {
                    const p = profiles.find((p) => p.id === e.target.value);
                    if (p)
                      set({
                        storageProfileId: p.id,
                        authorizedSubpath: p.allowedSubpaths[0] ?? "",
                        mode: p.allowedModes[0] ?? "read_only",
                      });
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · revision{p.revision}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                允许相对子路径
                <select
                  value={m.authorizedSubpath}
                  onChange={(e) => set({ authorizedSubpath: e.target.value })}
                >
                  {profile?.allowedSubpaths.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                模式
                <select
                  value={m.mode}
                  onChange={(e) =>
                    set({ mode: e.target.value as StorageRequest["mode"] })
                  }
                >
                  {profile?.allowedModes.map((mode) => (
                    <option key={mode}>{mode}</option>
                  ))}
                </select>
              </label>
              <label>
                容器目标
                <input
                  value={m.mountPath}
                  required
                  onChange={(e) => set({ mountPath: e.target.value })}
                />
              </label>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                移除验证挂载
              </button>
            </div>
          );
        })}
        <button
          type="button"
          disabled={!profiles.length}
          onClick={() => {
            const p = profiles[0];
            if (p)
              onChange([
                ...value,
                {
                  storageProfileId: p.id,
                  authorizedSubpath: p.allowedSubpaths[0] ?? "",
                  mode: p.allowedModes[0] ?? "read_only",
                  mountPath: `/workspace/validation${value.length + 1}`,
                },
              ]);
          }}
        >
          添加验证挂载
        </button>
      </fieldset>
      <p>
        使用具有真实存储隔离证据的 Node；挂载失败或清理未查实不会空出
        Claim。没有持久存储需求可保持无挂载。
      </p>
    </div>
  );
}
export function ValidationEvidence({
  client,
  id,
}: {
  client: HitchletClient;
  id: string;
}) {
  const [view, setView] = React.useState<Awaited<
      ReturnType<HitchletClient["admin"]["validation"]>
    > | null>(null),
    [error, setError] = React.useState("");
  React.useEffect(() => {
    setView(null);
    setError("");
  }, [id]);
  const scalar = (v: unknown) =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : null;
  return (
    <div>
      <button
        onClick={() =>
          void client.admin
            .validation(id)
            .then(setView)
            .catch((e) => setError(managementError(e)))
        }
      >
        检查原验证报告与截止
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {view ? (
        <>
          <p>
            report {view.reportId ?? "未生成"} · test {view.testOutcome} ·
            cleanup {view.cleanupStatus} · 截止{" "}
            {new Date(view.deadlineMs).toLocaleString()} · 证据有效至{" "}
            {view.evidenceExpiresAtMs === null
              ? "未确认"
              : new Date(view.evidenceExpiresAtMs).toLocaleString()}
          </p>
          <ul>
            {Object.entries(view.checks).map(([key, value]) => (
              <li key={key}>
                {key}：
                {scalar(value) ??
                  "结构化检查已记录；发布时服务端校验其范围/指纹"}
              </li>
            ))}
          </ul>
          <p>报告只能证明其明确范围；历史 passed 或清理中不表示可发布。</p>
        </>
      ) : null}
    </div>
  );
}
