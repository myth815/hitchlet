import React from "react";
import {
  Observation,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";

/** Daily operations use the safe actor directory, including current Node CAS. Registration remains full administrator only. */
export function DailyNodeActions({ client, disabled, action }: ManagementUI) {
  const load = React.useCallback(() => client.catalog(), [client]),
    snapshot = useManagementRead(load);
  const [nodeId, setNode] = React.useState(""),
    [artifactId, setArtifact] = React.useState(""),
    [reason, setReason] = React.useState("");
  const node = snapshot.data?.nodes.find((n) => n.id === nodeId);
  return (
    <details className="admin-card">
      <summary>授权 Node 排空、恢复与预热</summary>
      <Observation at={snapshot.at} error={snapshot.error} />
      <label>
        Node
        <select value={nodeId} onChange={(e) => setNode(e.target.value)}>
          <option value="">选择授权 Node</option>
          {snapshot.data?.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.machineName}/{n.name} · {n.admission}/{n.health} · v{n.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        理由
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </label>
      {(["draining", "enabled"] as const).map((admission) => (
        <button
          key={admission}
          disabled={
            disabled ||
            !!snapshot.error ||
            !node ||
            !reason.trim() ||
            node.admission === admission ||
            node.admission === "disabled"
          }
          onClick={() => {
            if (node)
              void action(`日常Node准入 ${node.id}`, (key) =>
                client.admin.management.admission(
                  "nodes",
                  node.id,
                  { expectedVersion: node.version, admission, reason },
                  key,
                ),
              ).then((ok) => {
                if (ok) void snapshot.refresh();
              });
          }}
        >
          {admission === "draining"
            ? "排空：阻止新申请"
            : "恢复已有取证的排空节点"}
        </button>
      ))}
      <label>
        已发布精确制品
        <select
          value={artifactId}
          onChange={(e) => setArtifact(e.target.value)}
        >
          <option value="">选择已授权制品</option>
          {snapshot.data?.versions.flatMap((v) =>
            v.platforms.map((p) => (
              <option value={p.artifactId} key={p.artifactId}>
                {v.imageName}/{v.version} · {p.architecture} · {p.digest}
              </option>
            )),
          )}
        </select>
      </label>
      <button
        disabled={disabled || !!snapshot.error || !nodeId || !artifactId}
        onClick={() =>
          void action(`日常缓存预热 ${nodeId} ${artifactId}`, (key) =>
            client.admin.inventory.prewarm(nodeId, artifactId, key),
          )
        }
      >
        预热精确制品
      </button>
      <p>
        准入恢复不生成能力证明；disabled Node 需要可信取证。预热受理不等于缓存
        ready，原操作见下面操作列表。viewer不能写入，operator始终由服务端复核Node范围。
      </p>
    </details>
  );
}
