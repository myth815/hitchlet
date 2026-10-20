import React from "react";
import {
  ComputeClientError,
  type HitchletClient,
  type AuthenticatedPrincipal,
  type PreparedManagementRevoke,
} from "@hitchlet/sdk";

export type ManagementUI = {
  client: HitchletClient;
  principal: AuthenticatedPrincipal;
  disabled: boolean;
  action: (
    label: string,
    work: (key: string) => Promise<unknown>,
    recovery?: PreparedManagementRevoke,
  ) => Promise<boolean>;
};
export const managementError = (e: unknown) =>
  e instanceof ComputeClientError
    ? `${e.code} · ${e.message}${[409, 412].includes(e.statusCode ?? 0) ? "；重新读取最新版本后再确认修改。" : ""}`
    : "读取或输入校验失败，请检查字段并刷新。";

/** Cancels stale page updates and retains the last snapshot as historical on read failure. */
export function useManagementRead<T>(load: () => Promise<T>) {
  const [data, setData] = React.useState<T | null>(null),
    [error, setError] = React.useState(""),
    [at, setAt] = React.useState<number | null>(null);
  const generation = React.useRef(0),
    mounted = React.useRef(true),
    running = React.useRef<number | null>(null);
  const refresh = React.useCallback(async () => {
    if (running.current !== null) return;
    const g = ++generation.current;
    running.current = g;
    try {
      const value = await load();
      if (mounted.current && g === generation.current) {
        setData(value);
        setAt(Date.now());
        setError("");
      }
    } catch (e) {
      if (mounted.current && g === generation.current)
        setError(managementError(e));
    } finally {
      if (running.current === g) running.current = null;
    }
  }, [load]);
  React.useEffect(() => {
    mounted.current = true;
    running.current = null;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      mounted.current = false;
      generation.current++;
      window.clearInterval(timer);
    };
  }, [refresh]);
  return { data, error, at, refresh };
}
export function Observation({
  at,
  error,
}: {
  at: number | null;
  error: string;
}) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={error ? "error-inline" : "muted"}
    >
      {error
        ? `实时更新断开；以下为历史观测，写入已禁用。${error}`
        : "最近服务端快照"}{" "}
      · {at === null ? "尚未读取" : new Date(at).toLocaleString()}
    </p>
  );
}
export function ResourceFields({
  value,
  onChange,
  label = "资源",
}: {
  value: { cpuMillis: number; memoryMiB: number; scratchMiB: number };
  onChange: (v: typeof value) => void;
  label?: string;
}) {
  return (
    <div className="admin-grid">
      {(
        [
          ["cpuMillis", "CPU 毫核"],
          ["memoryMiB", "内存 MiB"],
          ["scratchMiB", "临时盘 MiB"],
        ] as const
      ).map(([key, name]) => (
        <label key={key}>
          {label} · {name}
          <input
            type="number"
            min={key === "scratchMiB" ? 0 : 1}
            step="1"
            required
            value={value[key]}
            onChange={(e) =>
              onChange({ ...value, [key]: Number(e.target.value) })
            }
          />
        </label>
      ))}
    </div>
  );
}
export function ChoiceList({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly { id: string; name: string }[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {choices.length ? (
        choices.map((c) => (
          <label className="check-row" key={c.id}>
            <input
              type="checkbox"
              checked={value.includes(c.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, c.id]
                    : value.filter((id) => id !== c.id),
                )
              }
            />
            {c.name}
            <small>{c.id}</small>
          </label>
        ))
      ) : (
        <p>目录为空；先完成对应登记。</p>
      )}
    </fieldset>
  );
}
