import React from "react";
import type { ImageDraftInput, DraftArtifactInput } from "@hitchlet/sdk";
import {
  ChoiceList,
  ResourceFields,
  Observation,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";

/** Supported Docker recipe only; the UI cannot inject a shell, Docker create payload or custom provider options. */
export function ImageSetup({ client, disabled, action }: ManagementUI) {
  const load = React.useCallback(async () => {
      const [versions, nodes, consumers, operations] = await Promise.all([
        client.admin.imageVersions(),
        client.admin.nodes(),
        client.admin.management.consumers(),
        client.admin.management.operations(),
      ]);
      return { versions, nodes, consumers, operations };
    }, [client]),
    snapshot = useManagementRead(load);
  const [mode, setMode] = React.useState<"image" | "version" | "artifact">(
      "image",
    ),
    [versionId, setVersionId] = React.useState(""),
    [name, setName] = React.useState(""),
    [description, setDescription] = React.useState(""),
    [version, setVersion] = React.useState(""),
    [architecture, setArchitecture] = React.useState<"amd64" | "arm64">(
      "amd64",
    ),
    [artifactRef, setArtifact] = React.useState(""),
    [minimumResources, setResources] = React.useState({
      cpuMillis: 1000,
      memoryMiB: 1024,
      scratchMiB: 1024,
    }),
    [consumerIds, setConsumers] = React.useState<string[]>([]),
    [sources, setSources] = React.useState(""),
    [reason, setReason] = React.useState(""),
    [nodeId, setNode] = React.useState(""),
    [artifactId, setArtifactId] = React.useState(""),
    [cacheOperationId, setCacheOperation] = React.useState(""),
    [cache, setCache] = React.useState<Awaited<
      ReturnType<typeof client.admin.cacheOperationReceipt>
    > | null>(null);
  const [cacheError, setCacheError] = React.useState("");
  const selected = snapshot.data?.versions.find((v) => v.id === versionId),
    blocked = disabled || !!snapshot.error;
  const bootstrap = {
      mechanism: "hitchlet-node-ssh-v1",
      contractVersion: "1",
      identityReset: true as const,
    },
    access = {
      accessProtocols: ["ssh" as const],
      ports: [22],
      account: "workspace",
      allowedSourceCidrs: sources
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
      discovery: "portainer-published-port",
      readiness: "ssh-public-key-authenticated-fingerprint",
    };
  const digest = artifactRef.slice(artifactRef.lastIndexOf("@") + 1);
  const save = async (key: string) => {
    const artifact: DraftArtifactInput = {
      architecture,
      artifactRef,
      digest,
      minimumResources,
      requirements: { bootstrap, requiredCapabilities: [] },
      access,
    };
    if (mode === "image") {
      const body: ImageDraftInput = {
        name,
        description,
        version,
        architecture,
        artifactRef,
        digest,
        minimumResources,
        bootstrap,
        access,
        authorizedConsumerIds: consumerIds,
      };
      return client.admin.inventory.createDraft(body, key);
    }
    if (!selected) throw new Error("Select an existing image/version");
    return mode === "version"
      ? client.admin.inventory.createVersion(
          selected.imageId,
          { ...artifact, version },
          key,
        )
      : client.admin.inventory.addArtifact(selected.id, artifact, key);
  };
  return (
    <section aria-label="镜像登记与缓存">
      <h3>固定镜像制品与缓存</h3>
      <Observation at={snapshot.at} error={snapshot.error} />
      <button onClick={() => void snapshot.refresh()}>刷新版本与原操作</button>
      <p>
        仅支持实际实现的 Linux Docker SSH recipe。镜像使用 digest 固定，须包含
        Node24/sshd 和仓库
        bootstrap；声明本身不代表验证通过。后续去「验证、机器与系统维护」执行验证、查看清理与报告、发布并移动
        alias。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(
            `登记镜像 ${mode} ${versionId || name} ${version}`,
            save,
          ).then((ok) => {
            if (ok) void snapshot.refresh();
          });
        }}
      >
        <label>
          登记操作
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="image">新镜像与首个草稿</option>
            <option value="version">已有镜像的新草稿版本</option>
            <option value="artifact">草稿增加不可变架构制品</option>
          </select>
        </label>
        {mode !== "image" ? (
          <label>
            已有镜像/版本
            <select
              required
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              <option value="">从目录选择</option>
              {snapshot.data?.versions
                .filter(
                  (v) =>
                    mode !== "artifact" ||
                    ["draft", "validating"].includes(v.status),
                )
                .map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.imageName} / {v.version} · {v.status} · v
                    {v.entityVersion}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <fieldset disabled={blocked}>
          {mode === "image" ? (
            <>
              <label>
                镜像名称
                <input
                  required
                  value={name}
                  maxLength={120}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                说明
                <textarea
                  value={description}
                  maxLength={2000}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <ChoiceList
                label="创建时授权消费者"
                choices={
                  snapshot.data?.consumers.map((c) => ({
                    id: c.id,
                    name: c.name,
                  })) ?? []
                }
                value={consumerIds}
                onChange={setConsumers}
              />
            </>
          ) : null}
          {mode !== "artifact" ? (
            <label>
              不可变版本名称
              <input
                required
                value={version}
                maxLength={120}
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
          ) : null}
          <label>
            架构
            <select
              value={architecture}
              onChange={(e) =>
                setArchitecture(e.target.value as typeof architecture)
              }
            >
              <option>amd64</option>
              <option>arm64</option>
            </select>
          </label>
          <label>
            OCI manifest 固定引用
            <input
              required
              value={artifactRef}
              onChange={(e) => setArtifact(e.target.value)}
              placeholder="registry.example/node-ssh@sha256:…"
              pattern=".+@sha256:[a-f0-9]{64}"
            />
          </label>
          <ResourceFields
            label="镜像最低资源"
            value={minimumResources}
            onChange={setResources}
          />
          <label>
            允许 SSH 来源 CIDR（每行一项）
            <textarea
              value={sources}
              onChange={(e) => setSources(e.target.value)}
              placeholder="192.0.2.0/24"
            />
          </label>
          <p>
            固定初始化 hitchlet-node-ssh-v1 / contract1 / identityReset；SSH
            workspace:22，独立凭据和指纹认证；不开放宿主路径/socket。变更制品后旧报告指纹失效，验证清理失败仍保留容量。
          </p>
          <button disabled={mode === "image" && !consumerIds.length}>
            登记草稿/不可变制品
          </button>
        </fieldset>
      </form>
      <div className="admin-card">
        <h4>发布版本退役</h4>
        <label>
          版本
          <select
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
          >
            <option value="">选择版本</option>
            {snapshot.data?.versions.map((v) => (
              <option value={v.id} key={v.id}>
                {v.imageName}/{v.version} · {v.status} · v{v.entityVersion}
              </option>
            ))}
          </select>
        </label>
        <label>
          理由
          <input
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          disabled={
            blocked || selected?.status !== "published" || !reason.trim()
          }
          onClick={() => {
            if (selected)
              void action(`退役版本 ${selected.id}`, (key) =>
                client.admin.management.retire(
                  selected.id,
                  selected.entityVersion,
                  reason,
                  key,
                ),
              ).then((ok) => {
                if (ok) void snapshot.refresh();
              });
          }}
        >
          按当前entityVersion退役
        </button>
        <p>
          退役阻止新请求；已受理 Ticket
          的冻结制品与期限继续有效，不自动清理活动资源。
        </p>
      </div>
      <div className="admin-card">
        <h4>受控缓存</h4>
        {cacheError ? <p role="alert">{cacheError}</p> : null}
        <label>
          Node
          <select value={nodeId} onChange={(e) => setNode(e.target.value)}>
            <option value="">选择 Node</option>
            {snapshot.data?.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} · {n.observedHealth}
              </option>
            ))}
          </select>
        </label>
        <label>
          精确制品
          <select
            value={artifactId}
            onChange={(e) => setArtifactId(e.target.value)}
          >
            <option value="">选择已登记制品</option>
            {snapshot.data?.versions.flatMap((v) =>
              v.artifacts.map((a) => (
                <option key={a.id} value={a.id}>
                  {v.imageName}/{v.version} · {a.architecture} · {a.digest}
                </option>
              )),
            )}
          </select>
        </label>
        {["prewarm", "evict"].map((kind) => (
          <button
            key={kind}
            disabled={blocked || !nodeId || !artifactId}
            onClick={() =>
              void action(
                `${kind}缓存 ${nodeId} ${artifactId}`,
                async (key) => {
                  const result = await (kind === "prewarm"
                    ? client.admin.inventory.prewarm(nodeId, artifactId, key)
                    : client.admin.inventory.evict(nodeId, artifactId, key));
                  setCacheOperation(result.operationId ?? "");
                  await snapshot.refresh();
                },
              )
            }
          >
            {kind === "prewarm" ? "预热精确制品" : "回收无引用缓存"}
          </button>
        ))}
        <p>
          预热/回收只是持久操作受理；被
          Claim/验证/活动分配引用的缓存不可删除。响应未知时从以下原操作列表查状态，不再拉取/重复创建。
        </p>
        <label>
          原缓存操作
          <select
            value={cacheOperationId}
            onChange={(e) => setCacheOperation(e.target.value)}
          >
            <option value="">选择原操作</option>
            {snapshot.data?.operations
              .filter(
                (o) => o.kind.startsWith("image-cache.") && o.nodeId === nodeId,
              )
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.kind} · {o.state} · {o.id}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={!nodeId || !cacheOperationId}
          onClick={() =>
            void client.admin
              .cacheOperationReceipt(nodeId, cacheOperationId)
              .then((value) => {
                setCache(value);
                setCacheError("");
              })
              .catch(() =>
                setCacheError(
                  "原缓存回执读取失败；当前状态未知，请刷新后检查原操作。",
                ),
              )
          }
        >
          检查原缓存回执
        </button>
        {cache ? (
          <p>
            操作 {cache.operationId} · {cache.state} · 尝试 {cache.attemptCount}{" "}
            · 缓存 {cache.cache?.observedState ?? "无观测"} · size{" "}
            {cache.cache?.sizeMiB ?? "unknown"} MiB ·{" "}
            {cache.diagnostic ?? "无诊断码"}
          </p>
        ) : null}
      </div>
    </section>
  );
}
