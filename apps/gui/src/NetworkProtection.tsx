import React from "react";
import {
  Observation,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";
/** Versioned management protection is separate from tenant allow rules. Active Claims permit only retained/additional deny rules. */
export function NetworkProtection({ client, disabled, action }: ManagementUI) {
  const load = React.useCallback(
      () => client.admin.inventory.installation(),
      [client],
    ),
    snapshot = useManagementRead(load);
  type Update = Parameters<typeof client.admin.inventory.updateNetworkDeny>[0];
  const [draft, setDraft] = React.useState<Omit<Update, "reason"> | null>(null),
    [cidr, setCidr] = React.useState(""),
    [protocol, setProtocol] = React.useState<"any" | "tcp" | "udp">("any"),
    [ports, setPorts] = React.useState("any"),
    [reason, setReason] = React.useState("");
  const baseline = snapshot.data?.platformNetworkDeny,
    rules = draft?.rules ?? baseline?.managementDenyRules ?? [];
  const edit = (rules: Update["rules"]) => {
    if (baseline)
      setDraft({
        expectedRevisionId: draft?.expectedRevisionId ?? baseline.revisionId,
        rules,
      });
  };
  return (
    <details className="admin-card">
      <summary>平台管理保护基线（先于租客网络 allow）</summary>
      <Observation at={snapshot.at} error={snapshot.error} />
      <p>
        当前 revision {baseline?.revision ?? "缺失"} ·{" "}
        {baseline?.revisionId ?? "未初始化"}
        。首次初始化的空基线不证明隔离。列出控制器、Portainer、Agent、NAS
        管理口和其他受保护地址；NAS 数据端口可单独允许。
      </p>
      <fieldset disabled={disabled || !!snapshot.error || !baseline}>
        {rules.map((rule, i) => (
          <div key={i}>
            <span>
              {rule.cidr} · {rule.protocol} ·{" "}
              {rule.ports === "any" ? "全部端口" : rule.ports.join(",")}
            </span>
            <button onClick={() => edit(rules.filter((_, j) => j !== i))}>
              从草案移除
            </button>
          </div>
        ))}
        <label>
          管理 CIDR
          <input
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            placeholder="192.0.2.10/32"
          />
        </label>
        <label>
          协议
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as typeof protocol)}
          >
            <option>any</option>
            <option>tcp</option>
            <option>udp</option>
          </select>
        </label>
        <label>
          端口（any 或逗号分隔）
          <input
            disabled={protocol === "any"}
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
          />
        </label>
        <button
          disabled={!cidr.trim()}
          onClick={() => {
            const rule: Update["rules"][number] =
              protocol === "any"
                ? { cidr, protocol, ports: "any" }
                : {
                    cidr,
                    protocol,
                    ports:
                      ports === "any"
                        ? "any"
                        : ports.split(",").map((s) => Number(s.trim())),
                  };
            edit([...rules, rule]);
            setCidr("");
          }}
        >
          加入保护草案
        </button>
        <label>
          变更理由
          <input
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          disabled={!draft || !reason.trim() || !rules.length}
          onClick={() => {
            if (draft)
              void action("更新平台管理保护基线", (key) =>
                client.admin.inventory.updateNetworkDeny(
                  { ...draft, reason },
                  key,
                ),
              ).then((ok) => {
                if (ok) {
                  setDraft(null);
                  void snapshot.refresh();
                }
              });
          }}
        >
          按草案原revision保存
        </button>
        <button
          onClick={() => {
            setDraft(null);
            void snapshot.refresh();
          }}
        >
          放弃草案并刷新
        </button>
      </fieldset>
      <p>
        有活动/未知 Claim
        或未完成清理时，服务端只允许保留原规则并增加拒绝。缩减须先排空并查实全部清理；旧冻结合同仍保留原限制。变更会影响最新执行保护及验证指纹，重新验证镜像/Node证据后再开放新工作。
      </p>
    </details>
  );
}
