import React from "react";
import type {
  AcquireRequest,
  HitchletClient,
  StorageRequest,
  RequiredCapability,
} from "@hitchlet/sdk";
import {
  Observation,
  ResourceFields,
  useManagementRead,
} from "./ManagementUI.js";

/** Consumer wizard uses only server-authorized immutable choices and safe relative mount paths. */
export function AuthorizedAcquire({
  client,
  canOperate,
  busy,
  blocked,
  onAcquire,
}: {
  client: HitchletClient;
  canOperate: boolean;
  busy: boolean;
  blocked: boolean;
  onAcquire: (request: AcquireRequest) => void;
}) {
  const load = React.useCallback(() => client.catalog(), [client]),
    catalog = useManagementRead(load);
  const [versionId, setVersion] = React.useState(""),
    [network, setNetwork] = React.useState(""),
    [resources, setResources] = React.useState({
      cpuMillis: 1000,
      memoryMiB: 1024,
      scratchMiB: 2048,
    }),
    [ttl, setTtl] = React.useState(900),
    [node, setNode] = React.useState(""),
    [architecture, setArchitecture] = React.useState(""),
    [hardScratch, setHardScratch] = React.useState(false),
    [clientRef, setClientRef] = React.useState(""),
    [requiredCapabilities, setCapabilities] = React.useState<
      RequiredCapability[]
    >([]),
    [mounts, setMounts] = React.useState<StorageRequest[]>([]),
    [preview, setPreview] = React.useState<Awaited<
      ReturnType<HitchletClient["preview"]>
    > | null>(null),
    [error, setError] = React.useState(""),
    [previewing, setPreviewing] = React.useState(false);
  const selected = catalog.data?.versions.find((v) => v.id === versionId);
  React.useEffect(() => {
    if (catalog.data) {
      if (!versionId && catalog.data.versions[0]) {
        const v = catalog.data.versions[0];
        setVersion(v.id);
        setResources({
          cpuMillis: Math.max(v.platforms[0]!.minimumResources.cpuMillis, 1),
          memoryMiB: Math.max(v.platforms[0]!.minimumResources.memoryMiB, 1),
          scratchMiB: v.platforms[0]!.minimumResources.scratchMiB,
        });
      }
      if (!network && catalog.data.networks[0])
        setNetwork(catalog.data.networks[0].id);
      setTtl((t) => Math.min(t, catalog.data!.quota.maxLeaseTtlSeconds));
    }
  }, [catalog.data, versionId, network]);
  const request: AcquireRequest = {
    image: { versionId },
    kind: "container",
    networkProfileId: network,
    resources: {
      ...resources,
      scratchEnforcement: hardScratch ? "required" : "best_effort",
      isolation: "shared_kernel",
    },
    lease: { requestedSeconds: ttl },
    storage: mounts,
    locality: "local_only",
    ...(node ? { allowedNodeIds: [node] } : {}),
    ...(architecture
      ? { allowedArchitectures: [architecture as "amd64" | "arm64"] }
      : {}),
    requiredCapabilities,
    ...(clientRef.trim() ? { clientRef: clientRef.trim() } : {}),
  };
  const fingerprint = JSON.stringify(request);
  React.useEffect(() => setPreview(null), [fingerprint]);
  const unavailable =
    !canOperate || busy || blocked || !!catalog.error || !catalog.data;
  const preflight = async () => {
    setPreviewing(true);
    setError("");
    try {
      setPreview(await client.preview(request));
    } catch {
      setError(
        "预检失败：请核对镜像下限、配额、期限、授权引用和安全子路径，刷新目录后再试。",
      );
    } finally {
      setPreviewing(false);
    }
  };
  return (
    <section className="acquire-section">
      <h2>申请计算环境</h2>
      <Observation at={catalog.at} error={catalog.error} />
      <button onClick={() => void catalog.refresh()}>刷新授权目录</button>
      <p>
        Docker CPU 为配额，共享宿主内核；临时盘默认 best_effort。当前 offline
        lease enforcement unsupported，实际电源
        disabled；离线后只能承诺恢复对账后的最终清理。浏览器关闭不会释放环境。
      </p>
      <form
        className="acquire-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (preview) onAcquire(request);
        }}
      >
        <fieldset disabled={unavailable || previewing}>
          <div className="admin-grid">
            <label>
              授权镜像与不可变版本
              <select
                required
                value={versionId}
                onChange={(e) => {
                  setVersion(e.target.value);
                  const version = catalog.data?.versions.find(
                    (v) => v.id === e.target.value,
                  );
                  if (version)
                    setResources({
                      ...version.platforms[0]!.minimumResources,
                      cpuMillis: Math.max(
                        1,
                        version.platforms[0]!.minimumResources.cpuMillis,
                      ),
                      memoryMiB: Math.max(
                        1,
                        version.platforms[0]!.minimumResources.memoryMiB,
                      ),
                    });
                }}
              >
                <option value="">选择已发布版本</option>
                {catalog.data?.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.imageName} / {v.version} · container · Linux ·{" "}
                    {v.architectures.join("/")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              授权网络
              <select
                required
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
              >
                <option value="">选择网络</option>
                {catalog.data?.networks.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} · revision {n.revision}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selected ? (
            <p>
              {selected.platforms
                .map(
                  (p) =>
                    `${p.architecture} 最低 ${p.minimumResources.cpuMillis}m / ${p.minimumResources.memoryMiB} MiB / ${p.minimumResources.scratchMiB} MiB scratch`,
                )
                .join("；")}
              。版本与 profiles 在受理时冻结，不随别名移动改变。
            </p>
          ) : (
            <p>没有匹配版本时请联系管理员发布并授权镜像。</p>
          )}
          <ResourceFields value={resources} onChange={setResources} />
          {catalog.data ? (
            <p>
              消费者并发累计资源上限 {catalog.data.quota.maxResources.cpuMillis}
              m / {catalog.data.quota.maxResources.memoryMiB} MiB /{" "}
              {catalog.data.quota.maxResources.scratchMiB} MiB；活动{" "}
              {catalog.data.quota.maxActiveTickets} 票，排队{" "}
              {catalog.data.quota.maxQueuedTickets} 票；TTL ≤{" "}
              {catalog.data.quota.maxLeaseTtlSeconds} 秒，总寿命 ≤{" "}
              {catalog.data.quota.maxLifetimeSeconds}{" "}
              秒。预检不保证余量，原子预留时再次裁决。
            </p>
          ) : null}
          <label>
            租期秒
            <input
              required
              type="number"
              min="1"
              max={catalog.data?.quota.maxLeaseTtlSeconds}
              value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={hardScratch}
              onChange={(e) => setHardScratch(e.target.checked)}
            />
            要求临时盘硬限额（当前 Docker 未验证能力时会排除）
          </label>
          <details>
            <summary>必要的放置与能力约束</summary>
            <label>
              CPU 架构
              <select
                value={architecture}
                onChange={(e) => setArchitecture(e.target.value)}
              >
                <option value="">版本可用架构</option>
                {selected?.architectures.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label>
              Node / Machine
              <select value={node} onChange={(e) => setNode(e.target.value)}>
                <option value="">所有授权本地节点</option>
                {catalog.data?.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.machineName} / {n.name} · {n.architecture} ·{" "}
                    {n.admission}/{n.health}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                "cpuHardLimit",
                "memoryHardLimit",
                "networkPolicyEnforcement",
                "scratchHardLimit",
                "offlineLeaseEnforcement",
              ] as const
            ).map((cap) => (
              <label className="check-row" key={cap}>
                <input
                  type="checkbox"
                  checked={requiredCapabilities.includes(cap)}
                  onChange={(e) =>
                    setCapabilities(
                      e.target.checked
                        ? [...requiredCapabilities, cap]
                        : requiredCapabilities.filter((c) => c !== cap),
                    )
                  }
                />
                {cap}
              </label>
            ))}
            <p>
              仅本地 Docker；required 能力必须由服务端持有 verified
              证据，不由本页选项认证。严格离线与未实测能力没有候选。
            </p>
          </details>
          <h3>可选授权存储</h3>
          <p>
            从允许引用选择相对子路径、模式和容器目标；不需要知道宿主 source 或
            NAS 凭据。不挂载即可试租。
          </p>
          {mounts.map((mount, index) => {
            const profile = catalog.data?.storage.find(
              (s) => s.id === mount.storageProfileId,
            );
            return (
              <div className="admin-card" key={index}>
                <label>
                  授权存储
                  <select
                    value={mount.storageProfileId}
                    onChange={(e) => {
                      const p = catalog.data?.storage.find(
                        (s) => s.id === e.target.value,
                      );
                      if (p)
                        setMounts(
                          mounts.map((m, i) =>
                            i === index
                              ? {
                                  ...m,
                                  storageProfileId: p.id,
                                  authorizedSubpath: p.allowedSubpaths[0] ?? "",
                                  mode: p.allowedModes[0] ?? "read_only",
                                }
                              : m,
                          ),
                        );
                    }}
                  >
                    {catalog.data?.storage.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · revision {s.revision}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  允许前缀
                  <select
                    value={
                      profile?.allowedSubpaths.find(
                        (p) =>
                          mount.authorizedSubpath === p ||
                          mount.authorizedSubpath.startsWith(`${p}/`),
                      ) ?? ""
                    }
                    onChange={(e) =>
                      setMounts(
                        mounts.map((m, i) =>
                          i === index
                            ? { ...m, authorizedSubpath: e.target.value }
                            : m,
                        ),
                      )
                    }
                  >
                    {profile?.allowedSubpaths.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label>
                  前缀内相对子路径
                  <input
                    required
                    value={mount.authorizedSubpath}
                    onChange={(e) =>
                      setMounts(
                        mounts.map((m, i) =>
                          i === index
                            ? { ...m, authorizedSubpath: e.target.value }
                            : m,
                        ),
                      )
                    }
                    placeholder="projects/team-a/task"
                  />
                </label>
                <label>
                  模式
                  <select
                    value={mount.mode}
                    onChange={(e) =>
                      setMounts(
                        mounts.map((m, i) =>
                          i === index
                            ? {
                                ...m,
                                mode: e.target.value as StorageRequest["mode"],
                              }
                            : m,
                        ),
                      )
                    }
                  >
                    {profile?.allowedModes.map((mode) => (
                      <option key={mode}>{mode}</option>
                    ))}
                  </select>
                </label>
                <label>
                  容器内目标
                  <input
                    required
                    value={mount.mountPath}
                    onChange={(e) =>
                      setMounts(
                        mounts.map((m, i) =>
                          i === index ? { ...m, mountPath: e.target.value } : m,
                        ),
                      )
                    }
                    placeholder="/workspace/data"
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setMounts(mounts.filter((_, i) => i !== index))
                  }
                >
                  移除此挂载
                </button>
              </div>
            );
          })}
          <button
            type="button"
            disabled={!catalog.data?.storage.length}
            onClick={() => {
              const p = catalog.data?.storage[0];
              if (p)
                setMounts([
                  ...mounts,
                  {
                    storageProfileId: p.id,
                    authorizedSubpath: p.allowedSubpaths[0] ?? "",
                    mode: p.allowedModes[0] ?? "read_only",
                    mountPath: `/workspace/data${mounts.length + 1}`,
                  },
                ]);
            }}
          >
            添加授权挂载
          </button>
          <label>
            自己的任务编号 clientRef（可选）
            <input
              value={clientRef}
              maxLength={200}
              onChange={(e) => setClientRef(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!versionId || !network}
            onClick={() => void preflight()}
          >
            {previewing ? "正在预检…" : "可行性预检（不预留）"}
          </button>
          {preview ? (
            <div className="explain-box">
              <b>
                当前满足资格的 Node：{preview.eligibleNodeIds.length}
                ；容量不保证
              </b>
              <p>{preview.reasons.join("；")}</p>
              <p>
                预检服务端时间 {new Date(preview.observedAtMs).toLocaleString()}
                。提交后才创建持久 Ticket；未匹配可继续排队，等待原因见详情。
              </p>
            </div>
          ) : null}
          <button
            className="primary-button"
            disabled={!preview || !versionId || !network}
          >
            保存请求并申请 →
          </button>
        </fieldset>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {!canOperate ? <p>当前身份没有 Ticket 写权限或连接不可用。</p> : null}
    </section>
  );
}
