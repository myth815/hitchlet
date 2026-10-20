import React from "react";
import { type NodeRuntimeConfigInput } from "@hitchlet/sdk";
import {
  ResourceFields,
  Observation,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";

/** Backend identity registration and fixed transport configuration; capability certification stays in the trusted evidence workflow. */
export function InventorySetup({ client, disabled, action }: ManagementUI) {
  const load = React.useCallback(async () => {
      const [connections, machines, nodes, installation, operations] =
        await Promise.all([
          client.admin.inventory.connections(),
          client.admin.machines(),
          client.admin.nodes(),
          client.admin.inventory.installation(),
          client.admin.management.operations(),
        ]);
      return { connections, machines, nodes, installation, operations };
    }, [client]),
    snapshot = useManagementRead(load);
  const [connectionId, setConnectionId] = React.useState(""),
    [endpointUrl, setEndpoint] = React.useState(""),
    [environmentId, setEnvironment] = React.useState(""),
    [secretVersionRef, setSecret] = React.useState("");
  const [operation, setOperation] = React.useState<Awaited<
      ReturnType<typeof client.admin.inventory.discover>
    > | null>(null),
    [proposal, setProposal] = React.useState(false);
  const [machine, setMachine] = React.useState({
      name: "",
      hostOs: "linux" as "linux" | "windows" | "macos",
      architecture: "amd64" as "amd64" | "arm64",
      capacity: { cpuMillis: 1000, memoryMiB: 2048, scratchMiB: 4096 },
    }),
    [nodeName, setNodeName] = React.useState(""),
    [machineId, setMachineId] = React.useState(""),
    [runtimeNode, setRuntimeNode] = React.useState("");
  const [runtimeVersion, setRuntimeVersion] = React.useState<number | null>(
      null,
    ),
    [readError, setReadError] = React.useState("");
  const [runtime, setRuntime] = React.useState({
    accessHost: "",
    networkCidrBase: "172.28.0.0/16",
    userlandProxy: false,
    agentId: "",
    baseUrl: "",
    tokenSecretRef: "",
    caSecretRef: "",
    clientCertSecretRef: "",
    clientKeySecretRef: "",
  });
  const selectedConnection = snapshot.data?.connections.find(
      (c) => c.id === connectionId,
    ),
    selectedNode = snapshot.data?.nodes.find((n) => n.id === runtimeNode);
  const blocked = disabled || !!snapshot.error;
  return (
    <section aria-label="后端节点登记">
      <h3>Portainer、Machine 与 Node 接入</h3>
      {readError ? (
        <p role="alert">读取原操作失败；请刷新身份和状态。</p>
      ) : null}
      <Observation at={snapshot.at} error={snapshot.error} />
      <button onClick={() => void snapshot.refresh()}>刷新身份与版本</button>
      <p>
        顺序：探测并登记同一 Engine → 保守机器预算 → Node → 部署 Agent 与秘密
        CLI → 固定 Runtime 配置 → 外部实测并提交有时效的能力报告。未取证 Node
        保持 disabled/unknown；此页不能勾选生成 verified。
      </p>
      <p>
        Simulator 的合成执行连接不列为真实 Portainer 连接，也不代表 Engine
        已验证；M0 可登记禁用资源，真实接入仍须完成上述取证。
      </p>
      <label>
        恢复已有连接探测
        <select
          value={operation?.operationId ?? ""}
          onChange={(e) => {
            const original = snapshot.data?.operations.find(
              (o) => o.id === e.target.value,
            );
            if (!original) {
              setOperation(null);
              return;
            }
            const isProposal = original.kind === "provider.connection.probe";
            setProposal(isProposal);
            setReadError("");
            void (
              isProposal
                ? client.admin.inventory.proposal(original.id)
                : client.admin.inventory.discovery(original.id)
            )
              .then((receipt) => {
                setOperation(receipt);
                if (receipt.result?.connectionId)
                  setConnectionId(receipt.result.connectionId);
              })
              .catch(() => setReadError("failed"));
          }}
        >
          <option value="">选择原操作，查看状态或继续激活</option>
          {snapshot.data?.operations
            .filter(
              (o) =>
                o.kind === "provider.discover" ||
                o.kind === "provider.connection.probe",
            )
            .map((o) => (
              <option value={o.id} key={o.id}>
                {o.kind} · {o.state} · {o.id}
              </option>
            ))}
        </select>
      </label>
      <form
        className="admin-card"
        onSubmit={(e) => {
          e.preventDefault();
          void action(
            connectionId ? "同runtime连接修订" : "Portainer登记探测",
            async (key) => {
              const body = { endpointUrl, environmentId, secretVersionRef };
              const receipt = connectionId
                ? await client.admin.inventory.proposeRevision(
                    connectionId,
                    body,
                    key,
                  )
                : await client.admin.inventory.discover(body, key);
              setOperation(receipt);
              setProposal(!!connectionId);
              await snapshot.refresh();
            },
          );
        }}
      >
        <h4>连接登记 / 同 runtime 修订</h4>
        <label>
          逻辑连接
          <select
            value={connectionId}
            onChange={(e) => {
              setConnectionId(e.target.value);
              setOperation(null);
            }}
          >
            <option value="">登记新的 Engine</option>
            {snapshot.data?.connections.map((c) => (
              <option value={c.id} key={c.id}>
                {c.evidence?.engineId ?? c.runtimeIdentityId} · v{c.version}
              </option>
            ))}
          </select>
        </label>
        <fieldset disabled={blocked}>
          <label>
            Portainer HTTPS endpoint
            <input
              type="url"
              required
              value={endpointUrl}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://portainer.example"
            />
          </label>
          <label>
            Portainer environment 编号
            <input
              required
              pattern="[0-9]+"
              value={environmentId}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </label>
          <label>
            固定凭据版本引用（secret CLI 输出）
            <input
              required
              pattern="secret:[a-f0-9]{32}"
              value={secretVersionRef}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="secret:…"
            />
          </label>
          <button>探测身份并保存原操作</button>
        </fieldset>
      </form>
      {selectedConnection ? (
        <article className="admin-card">
          <b>真实身份 {selectedConnection.evidence?.engineId ?? "尚未验证"}</b>
          <span>
            runtime {selectedConnection.runtimeIdentityId} · 当前 revision{" "}
            {selectedConnection.currentRevisionId ?? "无"} · v
            {selectedConnection.version}
          </span>
          <span>
            Docker {selectedConnection.evidence?.dockerVersion ?? "unknown"} ·
            Portainer{" "}
            {selectedConnection.evidence?.portainerVersion ?? "unknown"} ·{" "}
            {selectedConnection.evidence?.os}/
            {selectedConnection.evidence?.architecture} · 取证{" "}
            {selectedConnection.verifiedAtMs === null
              ? "未知"
              : new Date(selectedConnection.verifiedAtMs).toLocaleString()}
          </span>
        </article>
      ) : null}
      {operation ? (
        <article className="admin-card">
          <b>
            原操作 {operation.operationId} · {operation.state}
          </b>
          <span>
            {operation.result?.errorCode ?? ""} · Engine{" "}
            {operation.result?.engineId ?? "待确认"} · 修订{" "}
            {operation.result?.connectionRevisionId ?? "未建立"}
          </span>
          <button
            onClick={() =>
              void (
                proposal
                  ? client.admin.inventory.proposal(operation.operationId)
                  : client.admin.inventory.discovery(operation.operationId)
              )
                .then(setOperation)
                .catch(() => setReadError("failed"))
            }
          >
            检查原探测状态
          </button>
          <button
            disabled={blocked || !operation.retryable}
            onClick={() =>
              void action("重试原探测", async (key) =>
                setOperation(
                  await (proposal
                    ? client.admin.inventory.retryProposal(
                        operation.operationId,
                        key,
                      )
                    : client.admin.inventory.retryDiscovery(
                        operation.operationId,
                        key,
                      )),
                ),
              )
            }
          >
            重试原探测
          </button>
          {proposal &&
          operation.state === "succeeded" &&
          operation.result?.connectionRevisionId &&
          selectedConnection ? (
            <button
              disabled={blocked}
              onClick={() =>
                void action("激活同runtime修订", (key) =>
                  client.admin.inventory.activateRevision(
                    selectedConnection.id,
                    operation.result!.connectionRevisionId!,
                    selectedConnection.version,
                    key,
                  ),
                ).then((ok) => {
                  if (ok) void snapshot.refresh();
                })
              }
            >
              按当前版本激活已验证修订
            </button>
          ) : null}
        </article>
      ) : null}
      <div className="admin-grid">
        <form
          className="admin-card"
          onSubmit={(e) => {
            e.preventDefault();
            void action(`创建保守预算Machine ${machine.name}`, (key) =>
              client.admin.inventory.createMachine(machine, key),
            ).then((ok) => {
              if (ok) void snapshot.refresh();
            });
          }}
        >
          <h4>登记物理 Machine</h4>
          <fieldset disabled={blocked}>
            <label>
              名称
              <input
                value={machine.name}
                required
                maxLength={120}
                onChange={(e) =>
                  setMachine({ ...machine, name: e.target.value })
                }
              />
            </label>
            <label>
              宿主 OS
              <select
                value={machine.hostOs}
                onChange={(e) =>
                  setMachine({
                    ...machine,
                    hostOs: e.target.value as typeof machine.hostOs,
                  })
                }
              >
                {["linux", "windows", "macos"].map((os) => (
                  <option key={os}>{os}</option>
                ))}
              </select>
            </label>
            <label>
              硬件架构
              <select
                value={machine.architecture}
                onChange={(e) =>
                  setMachine({
                    ...machine,
                    architecture: e.target.value as typeof machine.architecture,
                  })
                }
              >
                <option>amd64</option>
                <option>arm64</option>
              </select>
            </label>
            <ResourceFields
              label="保守总预算"
              value={machine.capacity}
              onChange={(capacity) => setMachine({ ...machine, capacity })}
            />
            <p>
              预算不代表实测总硬件。共享宿主和人工 Linux
              底座需保留系统/人类余量，随后在机器政策页预览并保存；真实电源始终关闭。
            </p>
            <button>创建禁用机器与容量池</button>
          </fieldset>
        </form>
        <form
          className="admin-card"
          onSubmit={(e) => {
            e.preventDefault();
            void action(`登记Node ${machineId} ${nodeName}`, (key) =>
              client.admin.inventory.createNode(
                { name: nodeName, machineId, connectionId },
                key,
              ),
            ).then((ok) => {
              if (ok) void snapshot.refresh();
            });
          }}
        >
          <h4>登记 Docker Node</h4>
          <fieldset disabled={blocked}>
            <label>
              名称
              <input
                value={nodeName}
                required
                onChange={(e) => setNodeName(e.target.value)}
              />
            </label>
            <label>
              物理 Machine
              <select
                required
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
              >
                <option value="">选择尚未准入的机器</option>
                {snapshot.data?.machines
                  .filter((m) => m.admission === "disabled")
                  .map((m) => (
                    <option value={m.machineId} key={m.machineId}>
                      {m.name} · {m.machineId}
                    </option>
                  ))}
              </select>
            </label>
            <p>
              使用上方选中的已验证逻辑连接。Machine 平台与预算须不超过 Engine
              证据。
            </p>
            <button disabled={!connectionId}>创建 disabled Node</button>
          </fieldset>
        </form>
      </div>
      <form
        className="admin-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!selectedNode || !snapshot.data?.installation.platformNetworkDeny)
            return;
          const config: NodeRuntimeConfigInput = {
            accessHost: runtime.accessHost,
            networkCidrBase: runtime.networkCidrBase,
            userlandProxy: runtime.userlandProxy,
            runtimeAgent: {
              id: runtime.agentId,
              baseUrl: runtime.baseUrl,
              tokenSecretRef: runtime.tokenSecretRef,
              caSecretRef: runtime.caSecretRef,
              clientCertSecretRef: runtime.clientCertSecretRef,
              clientKeySecretRef: runtime.clientKeySecretRef,
            },
            managementDenyRevisionId:
              snapshot.data.installation.platformNetworkDeny.revisionId,
            managementDenyRules:
              snapshot.data.installation.platformNetworkDeny
                .managementDenyRules,
          };
          void action(`配置固定Runtime连接 ${selectedNode.id}`, (key) =>
            client.admin.inventory.configureRuntime(
              selectedNode.id,
              config,
              runtimeVersion ?? selectedNode.version,
              key,
            ),
          ).then((ok) => {
            if (ok) void snapshot.refresh();
          });
        }}
      >
        <h4>Runtime 传输配置</h4>
        <label>
          Node
          <select
            value={runtimeNode}
            onChange={(e) => {
              setRuntimeNode(e.target.value);
              setRuntimeVersion(
                snapshot.data?.nodes.find((n) => n.id === e.target.value)
                  ?.version ?? null,
              );
            }}
          >
            <option value="">选择 Node</option>
            {snapshot.data?.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} · {n.admission} · v{n.version}
              </option>
            ))}
          </select>
        </label>
        {selectedNode ? (
          <p>
            runtime {selectedNode.runtimeIdentityId} · 真实健康{" "}
            {selectedNode.observedHealth} · 能力{" "}
            {selectedNode.capabilities.verified ? "已有取证" : "未取证"}，有效至{" "}
            {selectedNode.capabilities.expiresAt ?? "unknown"}。disabled
            配置不会产生能力证明。
          </p>
        ) : null}
        <fieldset
          disabled={
            blocked || !selectedNode || selectedNode.admission !== "disabled"
          }
        >
          {(
            [
              ["accessHost", "消费者可达 SSH host"],
              ["networkCidrBase", "独立网络 CIDR 池"],
              ["agentId", "部署时固定的 Runtime Agent ID"],
              ["baseUrl", "Runtime Agent mTLS HTTPS URL"],
              ["tokenSecretRef", "Agent bearer secret版本引用"],
              ["caSecretRef", "CA secret版本引用"],
              ["clientCertSecretRef", "客户端证书 secret版本引用"],
              ["clientKeySecretRef", "客户端私钥 secret版本引用"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                required
                type={key === "baseUrl" ? "url" : "text"}
                pattern={
                  key.endsWith("SecretRef") ? "secret:[a-f0-9]{32}" : undefined
                }
                value={runtime[key]}
                onChange={(e) =>
                  setRuntime({ ...runtime, [key]: e.target.value })
                }
              />
            </label>
          ))}
          <label className="check-row">
            <input
              type="checkbox"
              checked={runtime.userlandProxy}
              onChange={(e) =>
                setRuntime({ ...runtime, userlandProxy: e.target.checked })
              }
            />
            Engine 的实际 userland-proxy 已开启（必须与可信观测一致）
          </label>
          <p>
            采用安装当前 deny revision{" "}
            {snapshot.data?.installation.platformNetworkDeny?.revisionId ??
              "缺失"}
            ；秘密值从不提交 GUI。完整保护基线由可信 CLI/部署配置维护；新 Node
            与修订必须重新取证。
          </p>
          <button disabled={!snapshot.data?.installation.platformNetworkDeny}>
            按 Node 当前版本保存配置
          </button>
        </fieldset>
      </form>
      {snapshot.data?.nodes.map((n) => (
        <article key={n.id} className="admin-card">
          <b>
            {n.name} · {n.admission} · {n.observedHealth} · v{n.version}
          </b>
          <small>
            {n.id} · runtime {n.runtimeIdentityId} · connection{" "}
            {n.providerConnectionId}
          </small>
          <p>
            取证{" "}
            {n.capabilities.verified
              ? "存在（须核对有效期与逐节点报告）"
              : "未验证"}{" "}
            · 架构 {n.capabilities.architectures.join("/") || "未知"} · 有效至{" "}
            {n.capabilities.expiresAt ?? "未知"} · 观测{" "}
            {n.observedAtMs === null
              ? "未知"
              : new Date(n.observedAtMs).toLocaleString()}
          </p>
          {["draining", "enabled", "disabled"].map((admission) => (
            <button
              key={admission}
              disabled={
                blocked ||
                n.admission === admission ||
                (n.admission === "disabled" && admission === "enabled")
              }
              onClick={() => {
                const reason =
                  window.prompt("记录准入变更理由（不会生成能力证明）");
                if (reason)
                  void action("Node准入变更", (key) =>
                    client.admin.management.admission(
                      "nodes",
                      n.id,
                      {
                        expectedVersion: n.version,
                        admission: admission as
                          | "draining"
                          | "enabled"
                          | "disabled",
                        reason,
                      },
                      key,
                    ),
                  ).then((ok) => {
                    if (ok) void snapshot.refresh();
                  });
              }}
            >
              {admission}
            </button>
          ))}
        </article>
      ))}
    </section>
  );
}
