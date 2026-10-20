import { SystemPanel } from "./SystemPanel.js";
import React from "react";
import { MachinePanel } from "./MachinePanel.js";
import {
  ComputeClientError,
  type HitchletClient,
  type AuthenticatedPrincipal,
  type AdminImageAliasView,
  type AdminImageVersionSummary,
  type AdminValidationHistoryItem,
} from "@hitchlet/sdk";

type AdminClient = HitchletClient["admin"];
type MachineView = Awaited<ReturnType<AdminClient["machines"]>>[number];
type NodeView = Awaited<ReturnType<AdminClient["nodes"]>>[number];
type ProfileView = Awaited<ReturnType<AdminClient["networkProfiles"]>>[number];

function errorMessage(error: unknown) {
  return error instanceof ComputeClientError
    ? `${error.message}（${error.code}）`
    : error instanceof Error
      ? error.message
      : "请求失败";
}

function activeValidation(run: AdminValidationHistoryItem | undefined) {
  return (
    !!run &&
    (run.state === "queued" ||
      run.state === "running" ||
      run.state === "releasing" ||
      run.cleanupStatus !== "complete")
  );
}

export function AdminPanel({
  client,
  principal,
  onCredentialIssued,
}: {
  client: HitchletClient;
  principal: AuthenticatedPrincipal;
  onCredentialIssued?: (token: string) => void;
}) {
  const canRead =
    principal.role === "admin" &&
    ["tickets:read", "images:read", "events:read"].every((scope) =>
      principal.scopes.includes(scope),
    );
  const canWrite =
    canRead &&
    ["tickets:write", "tickets:revoke"].every((scope) =>
      principal.scopes.includes(scope),
    );
  const [versions, setVersions] = React.useState<AdminImageVersionSummary[]>(
    [],
  );
  const [machineConnection, setMachineConnection] = React.useState(true);
  const [machines, setMachines] = React.useState<MachineView[]>([]);
  const [nodes, setNodes] = React.useState<NodeView[]>([]);
  const [profiles, setProfiles] = React.useState<ProfileView[]>([]);
  const [selectedVersionId, setSelectedVersionId] = React.useState("");
  const [selectedArtifactId, setSelectedArtifactId] = React.useState("");
  const [detail, setDetail] = React.useState<Awaited<
    ReturnType<AdminClient["draftVersion"]>
  > | null>(null);
  const [runs, setRuns] = React.useState<AdminValidationHistoryItem[]>([]);
  const runsRef = React.useRef(runs);
  runsRef.current = runs;
  const [selectedRunId, setSelectedRunId] = React.useState("");
  const [selectedNodeId, setSelectedNodeId] = React.useState("");
  const [profileId, setProfileId] = React.useState("");
  const [resources, setResources] = React.useState({
    cpuMillis: "1000",
    memoryMiB: "2048",
    scratchMiB: "2048",
  });
  const [deadline, setDeadline] = React.useState("900");
  const [aliases, setAliases] = React.useState<AdminImageAliasView[]>([]);
  const [aliasesLoaded, setAliasesLoaded] = React.useState(false);
  const [aliasName, setAliasName] = React.useState("latest");
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const actionInFlight = React.useRef(false);
  const lifecycle = React.useRef(0);
  const previousConsumerId = React.useRef(principal.consumerId);
  const selectedRunVersionId = React.useRef("");
  const selectedSummary = versions.find(
    (item) => item.id === selectedVersionId,
  );
  const selectedRun = runs.find((item) => item.id === selectedRunId);
  const selectedRunIsActive = activeValidation(selectedRun);
  const networkProfiles = profiles.filter(
    (profile) => profile.kind === "network" && profile.status === "active",
  );
  const detailArtifacts = detail?.artifacts ?? [];
  const canValidate =
    canWrite &&
    !!selectedSummary &&
    ["draft", "validating"].includes(selectedSummary.status) &&
    detailArtifacts.length > 0 &&
    !!selectedArtifactId &&
    !!selectedNodeId &&
    !!profileId &&
    !runs.some(activeValidation);
  const canPublish =
    canWrite &&
    !!selectedSummary &&
    ["draft", "validating"].includes(selectedSummary.status) &&
    !!selectedRun &&
    selectedRun.state === "succeeded" &&
    selectedRun.testOutcome === "passed" &&
    selectedRun.cleanupStatus === "complete" &&
    !!selectedRun.reportId &&
    detailArtifacts.some(
      (artifact) => artifact.id === selectedRun.imageArtifactId,
    );

  const refreshVersions = React.useCallback(
    async (isCancelled: () => boolean) => {
      const items = await client.admin.imageVersions(isCancelled);
      if (!isCancelled()) setVersions(items);
    },
    [client],
  );
  const refreshRuns = React.useCallback(
    async (versionId: string, isCancelled: () => boolean) => {
      const items = await client.admin.validationHistory(
        versionId,
        isCancelled,
      );
      if (!isCancelled()) setRuns(items);
    },
    [client],
  );
  const refreshAliases = React.useCallback(
    async (imageId: string, isCancelled: () => boolean) => {
      const items = await client.admin.imageAliases(imageId, isCancelled);
      if (!isCancelled()) {
        setAliases(items);
        setAliasesLoaded(true);
      }
    },
    [client],
  );

  React.useEffect(() => {
    const epoch = ++lifecycle.current;
    let active = true;
    const cancelled = () => !active || epoch !== lifecycle.current;
    if (!canRead)
      return () => {
        active = false;
      };
    if (previousConsumerId.current !== principal.consumerId) {
      previousConsumerId.current = principal.consumerId;
      setVersions([]);
      setNodes([]);
      setMachines([]);
      setProfiles([]);
      setSelectedVersionId("");
      setSelectedArtifactId("");
      setDetail(null);
      setRuns([]);
      setSelectedRunId("");
      setAliases([]);
      setAliasesLoaded(false);
    }
    void Promise.all([
      client.admin.imageVersions(cancelled),
      client.admin.nodes(cancelled),
      client.admin.machines(cancelled),
      client.admin.networkProfiles(cancelled),
    ])
      .then(([foundVersions, foundNodes, foundMachines, foundProfiles]) => {
        if (cancelled()) return;
        setVersions(foundVersions);
        setNodes(foundNodes);
        setMachines(foundMachines);
        setMachineConnection(true);
        setProfiles(foundProfiles);
        setSelectedVersionId(
          (current) => current || foundVersions[0]?.id || "",
        );
        setSelectedNodeId(
          (current) =>
            current ||
            foundNodes.find((node) => node.admission === "enabled")?.id ||
            foundNodes[0]?.id ||
            "",
        );
        setProfileId(
          (current) =>
            current ||
            foundProfiles.find(
              (profile) =>
                profile.kind === "network" && profile.status === "active",
            )?.id ||
            "",
        );
        setError("");
      })
      .catch((cause: unknown) => {
        if (!cancelled()) setError(errorMessage(cause));
      });
    return () => {
      active = false;
      lifecycle.current += 1;
    };
  }, [canRead, client, principal.consumerId]);

  React.useEffect(() => {
    if (!canRead) return;
    const epoch = lifecycle.current;
    let active = true,
      running = false;
    const cancelled = () => !active || epoch !== lifecycle.current;
    const poll = async () => {
      if (running || cancelled()) return;
      running = true;
      try {
        const found = await client.admin.machines(cancelled);
        if (!cancelled()) {
          setMachines(found);
          setMachineConnection(true);
        }
      } catch {
        if (!cancelled()) setMachineConnection(false);
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [canRead, client, principal.consumerId]);

  React.useEffect(() => {
    if (!selectedSummary) {
      setDetail(null);
      setRuns([]);
      return;
    }
    if (selectedRunVersionId.current !== selectedSummary.id) {
      selectedRunVersionId.current = selectedSummary.id;
      setSelectedRunId("");
    }
    const epoch = lifecycle.current;
    let active = true;
    const cancelled = () => !active || epoch !== lifecycle.current;
    setAliasesLoaded(false);
    void Promise.all([
      client.admin
        .draftVersion(selectedSummary.id, cancelled)
        .catch((cause: unknown) => {
          if (cause instanceof ComputeClientError && cause.statusCode === 404)
            return null;
          throw cause;
        }),
      refreshRuns(selectedSummary.id, cancelled),
    ])
      .then(([draft]) => {
        if (!cancelled()) {
          setDetail(draft);
          setSelectedArtifactId(draft?.artifacts[0]?.id ?? "");
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled()) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [
    client,
    refreshRuns,
    selectedSummary?.entityVersion,
    selectedSummary?.id,
    selectedSummary?.status,
  ]);

  React.useEffect(() => {
    if (!selectedSummary || selectedSummary.status !== "published") {
      setAliases([]);
      setAliasesLoaded(false);
      return;
    }
    const epoch = lifecycle.current;
    let active = true;
    const cancelled = () => !active || epoch !== lifecycle.current;
    void refreshAliases(selectedSummary.imageId, cancelled).catch(
      (cause: unknown) => {
        if (!cancelled()) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [refreshAliases, selectedSummary?.imageId, selectedSummary?.status]);

  React.useEffect(() => {
    if (!selectedSummary || !selectedRunIsActive) return;
    const epoch = lifecycle.current;
    let active = true;
    let running = false;
    const cancelled = () => !active || epoch !== lifecycle.current;
    const poll = async () => {
      if (
        running ||
        cancelled() ||
        !runsRef.current.some(
          (run) => run.id === selectedRunId && activeValidation(run),
        )
      )
        return;
      running = true;
      try {
        const [foundRuns, foundVersions] = await Promise.all([
          client.admin.validationHistory(selectedSummary.id, cancelled),
          client.admin.imageVersions(cancelled),
        ]);
        if (!cancelled()) {
          setRuns(foundRuns);
          setVersions(foundVersions);
        }
      } catch (cause) {
        if (!cancelled()) setError(errorMessage(cause));
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2500);
    void poll();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [client, selectedRunId, selectedRunIsActive, selectedSummary?.id]);

  async function runAction(
    action: (isCancelled: () => boolean) => Promise<void>,
  ) {
    if (!canWrite || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    const epoch = lifecycle.current;
    const cancelled = () => epoch !== lifecycle.current;
    try {
      await action(cancelled);
    } catch (cause) {
      if (!cancelled()) setError(errorMessage(cause));
    } finally {
      actionInFlight.current = false;
      if (!cancelled()) setBusy(false);
    }
  }

  async function schedule() {
    if (!selectedSummary || !detailArtifacts[0]) return;
    await runAction(async (isCancelled) => {
      let receipt;
      try {
        receipt = await client.admin.scheduleValidation(
          selectedSummary.id,
          {
            imageArtifactId: selectedArtifactId,
            nodeId: selectedNodeId,
            networkProfileId: profileId,
            storage: [],
            resources: {
              request: {
                cpuMillis: Number(resources.cpuMillis),
                memoryMiB: Number(resources.memoryMiB),
                scratchMiB: Number(resources.scratchMiB),
              },
              limit: {
                cpuMillis: Number(resources.cpuMillis),
                memoryMiB: Number(resources.memoryMiB),
                scratchMiB: Number(resources.scratchMiB),
              },
              scratchEnforcement: "best_effort",
              isolation: "shared_kernel",
              accelerators: [],
            },
            deadlineSeconds: Number(deadline),
          },
          crypto.randomUUID(),
          isCancelled,
        );
      } catch (cause) {
        if (
          cause instanceof ComputeClientError &&
          cause.code === "NETWORK_RESULT_UNKNOWN"
        ) {
          const history = await client.admin.validationHistory(
            selectedSummary.id,
            isCancelled,
          );
          if (!isCancelled()) {
            setRuns(history);
            setSelectedRunId("");
            setStatus(
              "验证请求结果未知，已刷新validationHistory。请先从历史中检查原run；本页面不会自动重发或新建验证。",
            );
          }
          return;
        }
        throw cause;
      }
      if (isCancelled()) return;
      setSelectedRunId(receipt.validationId);
      setStatus(
        `Validation ${receipt.validationId} ${receipt.scheduler}${receipt.blockReason ? ` · ${receipt.blockReason}` : ""}。持续读取这次原始 run 的结果。`,
      );
      await Promise.all([
        refreshRuns(selectedSummary.id, isCancelled),
        refreshVersions(isCancelled),
      ]);
    });
  }

  async function publish() {
    if (!selectedSummary || !selectedRun || !canPublish) return;
    await runAction(async (isCancelled) => {
      let receipt;
      try {
        receipt = await client.admin.publish(
          selectedSummary.id,
          selectedSummary.entityVersion,
          crypto.randomUUID(),
          isCancelled,
        );
      } catch (cause) {
        if (
          cause instanceof ComputeClientError &&
          [409, 412].includes(cause.statusCode ?? 0)
        )
          await refreshVersions(isCancelled);
        throw cause;
      }
      if (isCancelled()) return;
      setStatus(
        `已发布 version ${receipt.versionId}，entityVersion ${receipt.entityVersion}。草稿详情已转为发布回执/目录摘要。`,
      );
      setDetail(null);
      await refreshVersions(isCancelled);
    });
  }

  async function moveAlias() {
    if (
      !selectedSummary ||
      selectedSummary.status !== "published" ||
      !aliasName.trim()
    )
      return;
    const current = aliases.find((alias) => alias.alias === aliasName.trim());
    if (!aliasesLoaded) return;
    await runAction(async (isCancelled) => {
      let receipt;
      try {
        receipt = await client.admin.setAlias(
          selectedSummary.imageId,
          aliasName.trim(),
          selectedSummary.id,
          current?.version ?? 0,
          crypto.randomUUID(),
          isCancelled,
        );
      } catch (cause) {
        if (
          cause instanceof ComputeClientError &&
          [409, 412].includes(cause.statusCode ?? 0)
        )
          await refreshAliases(selectedSummary.imageId, isCancelled);
        throw cause;
      }
      if (isCancelled()) return;
      setStatus(`别名 ${receipt.alias} 已显式更新到版本 ${receipt.version}。`);
      await refreshAliases(selectedSummary.imageId, isCancelled);
    });
  }

  if (!canRead)
    return (
      <section className="admin-section">
        <h2>管理工作台</h2>
        <p className="muted">当前角色或 scopes 不允许读取管理数据。</p>
      </section>
    );
  return (
    <section className="admin-section">
      <div className="section-title-row">
        <div>
          <div className="section-kicker">镜像管理</div>
          <h2>镜像验证与发布</h2>
        </div>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void refreshVersions(() => false)}
        >
          刷新管理数据 ↻
        </button>
      </div>
      {error ? (
        <p className="error-inline" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="notice" role="status">
          {status}
        </p>
      ) : null}
      <MachinePanel
        client={client}
        machines={machines}
        connected={machineConnection}
        canWrite={canWrite}
        onRefresh={async () => {
          const epoch = lifecycle.current;
          try {
            const found = await client.admin.machines(
              () => epoch !== lifecycle.current,
            );
            if (epoch === lifecycle.current) {
              setMachines(found);
              setMachineConnection(true);
            }
          } catch (cause) {
            if (epoch === lifecycle.current) {
              setMachineConnection(false);
              setError(errorMessage(cause));
            }
          }
        }}
      />
      <div className="admin-grid">
        <div>
          <h3>Nodes</h3>
          {nodes.length ? (
            nodes.map((node) => (
              <article className="admin-card" key={node.id}>
                <b>
                  {node.name} · {node.backendKind}
                </b>
                <span>
                  {node.admission} · {node.observedHealth}
                </span>
                <small>
                  能力 {node.capabilities.verified ? "已验证" : "未验证"} · 架构{" "}
                  {node.capabilities.architectures.join(", ") || "无"} · 访问{" "}
                  {node.capabilities.supportedAccess.join(", ") || "无"}
                </small>
                <small>
                  此页面不配置Runtime Agent或能力attestation；仅显示观测投影。
                </small>
              </article>
            ))
          ) : (
            <p className="muted">没有可见 Node。</p>
          )}
        </div>
        <div>
          <h3>镜像版本</h3>
          <label>
            选择目录版本
            <select
              value={selectedVersionId}
              onChange={(event) => setSelectedVersionId(event.target.value)}
            >
              <option value="">选择版本</option>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.imageName} · {version.version} · {version.status}
                </option>
              ))}
            </select>
          </label>
          {selectedSummary ? (
            <article className="admin-card">
              <b>
                {selectedSummary.imageName} · {selectedSummary.version} ·{" "}
                {selectedSummary.status}
              </b>
              <small>{selectedSummary.id}</small>
              <small>
                entityVersion {selectedSummary.entityVersion} ·{" "}
                {selectedSummary.artifacts
                  .map((item) => `${item.architecture} ${item.digest}`)
                  .join(" / ") || "无制品"}
              </small>
              {detail ? (
                <small>
                  草稿合同：
                  {detail.artifacts
                    .map(
                      (item) =>
                        `${item.architecture} · ${item.minimumResources.cpuMillis}m CPU · ${item.minimumResources.memoryMiB}MiB`,
                    )
                    .join(" / ")}
                </small>
              ) : selectedSummary.status === "published" ? (
                <small>
                  此已发布版本通过目录摘要展示；draft detail
                  端点只对可编辑草稿开放。
                </small>
              ) : null}
            </article>
          ) : (
            <p className="muted">
              尚无已登记版本。可以继续用现有CLI/API登记草稿。
            </p>
          )}
        </div>
      </div>
      <div className="admin-card validation-form">
        <h3>显式安排验证</h3>
        <label>
          Node
          <select
            value={selectedNodeId}
            onChange={(event) => setSelectedNodeId(event.target.value)}
          >
            <option value="">选择 Node</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} · {node.admission} · {node.observedHealth}
              </option>
            ))}
          </select>
        </label>
        <label>
          草稿制品
          <select
            value={selectedArtifactId}
            onChange={(event) => setSelectedArtifactId(event.target.value)}
          >
            <option value="">选择制品</option>
            {detailArtifacts.map((artifact) => (
              <option key={artifact.id} value={artifact.id}>
                {artifact.architecture} · {artifact.digest}
              </option>
            ))}
          </select>
        </label>
        <label>
          Network profile
          <select
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
          >
            <option value="">选择网络配置</option>
            {networkProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · v{profile.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          CPU毫核
          <input
            type="number"
            min="1"
            value={resources.cpuMillis}
            onChange={(event) =>
              setResources({ ...resources, cpuMillis: event.target.value })
            }
          />
        </label>
        <label>
          内存MiB
          <input
            type="number"
            min="1"
            value={resources.memoryMiB}
            onChange={(event) =>
              setResources({ ...resources, memoryMiB: event.target.value })
            }
          />
        </label>
        <label>
          临时盘MiB
          <input
            type="number"
            min="0"
            value={resources.scratchMiB}
            onChange={(event) =>
              setResources({ ...resources, scratchMiB: event.target.value })
            }
          />
        </label>
        <label>
          截止秒
          <input
            type="number"
            min="1"
            max="1800"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
          />
        </label>
        <p className="muted">
          storage为空，scratch按best_effort，shared
          kernel。当前批次不提供任意JSON编辑或节点/秘密创建。
        </p>
        <button
          className="primary-button"
          disabled={!canValidate || busy}
          onClick={() => void schedule()}
        >
          安排验证
        </button>
      </div>
      <SystemPanel
        key={principal.consumerId}
        client={client}
        canWrite={canWrite}
        {...(onCredentialIssued ? { onCredentialIssued } : {})}
      />
      <div className="admin-card">
        <h3>验证历史与回收</h3>
        {runs.length ? (
          <>
            <label>
              选择既有 run
              <select
                value={selectedRunId}
                onChange={(event) => setSelectedRunId(event.target.value)}
              >
                <option value="">选择 run</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id.slice(0, 8)} · {run.state} · test {run.testOutcome}{" "}
                    · cleanup {run.cleanupStatus}
                  </option>
                ))}
              </select>
            </label>
            {selectedRun ? (
              <p>
                Run {selectedRun.id} · test {selectedRun.testOutcome} · cleanup{" "}
                {selectedRun.cleanupStatus} · report{" "}
                {selectedRun.reportId ?? "未生成"} · version{" "}
                {selectedRun.version}
              </p>
            ) : null}
          </>
        ) : (
          <p className="muted">此版本尚无验证记录。</p>
        )}
        <small>
          轮询只刷新选中的版本及其原验证 run；test passed 但 cleanup
          blocked/running 时不能发布。
        </small>
      </div>
      <div className="admin-card">
        <h3>发布与别名</h3>
        <button
          className="primary-button"
          disabled={!canPublish || busy}
          onClick={() => void publish()}
        >
          按当前entityVersion发布
        </button>
        {selectedSummary?.status === "published" ? (
          <>
            <label>
              别名
              <input
                value={aliasName}
                onChange={(event) => setAliasName(event.target.value)}
              />
            </label>
            <p>
              当前值：
              {aliases.find((item) => item.alias === aliasName)?.versionId ??
                "此别名尚不存在"}{" "}
              · CAS version{" "}
              {aliases.find((item) => item.alias === aliasName)?.version ?? 0}
            </p>
            <button
              className="secondary-button"
              disabled={!canWrite || busy || !aliasesLoaded}
              onClick={() => void moveAlias()}
            >
              确认更新别名到所选版本
            </button>
          </>
        ) : null}
        <p className="muted">
          发布和别名更新均为显式操作；发布使用目录最新entityVersion，别名先读取当前version再CAS。
        </p>
      </div>
    </section>
  );
}
