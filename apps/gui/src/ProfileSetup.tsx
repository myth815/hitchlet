import React from "react";
import { NetworkProtection } from "./NetworkProtection.js";
import {
  ChoiceList,
  Observation,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";

const lines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
/** Explicit network/storage fields; no arbitrary JSON, host execution or secret values. */
export function ProfileSetup({
  client,
  disabled,
  action,
  principal,
}: ManagementUI) {
  const load = React.useCallback(async () => {
      const [networks, storage, consumers] = await Promise.all([
        client.admin.networkProfiles(),
        client.admin.inventory.storageProfiles(),
        client.admin.management.consumers(),
      ]);
      return { networks, storage, consumers };
    }, [client]),
    snapshot = useManagementRead(load);
  const [kind, setKind] = React.useState<"network" | "storage">("network"),
    [selected, setSelected] = React.useState(""),
    [editVersion, setEditVersion] = React.useState<number | null>(null),
    [name, setName] = React.useState(""),
    [consumers, setConsumers] = React.useState<string[]>([]),
    [ingress, setIngress] = React.useState(""),
    [egress, setEgress] = React.useState<
      { cidr: string; protocol: "tcp" | "udp"; ports: string }[]
    >([]),
    [protocol, setProtocol] = React.useState<"local" | "nfs" | "smb">("local"),
    [sourceRef, setSource] = React.useState(""),
    [subpaths, setSubpaths] = React.useState("workspace"),
    [readWrite, setReadWrite] = React.useState(false),
    [secretRef, setSecret] = React.useState("");
  const profiles =
      kind === "network" ? snapshot.data?.networks : snapshot.data?.storage,
    profile = profiles?.find((p) => p.id === selected);
  const select = (id: string) => {
    setSelected(id);
    const p = profiles?.find((p) => p.id === id);
    setEditVersion(p?.version ?? null);
    if (!p) return;
    setName(p.name);
    const config = p.config;
    if (!config) return;
    if (kind === "network") {
      const sources = config.allowedIngressSourceCidrs;
      if (Array.isArray(sources))
        setIngress(
          sources.filter((s): s is string => typeof s === "string").join("\n"),
        );
      const rules = config.allowedEgress;
      if (Array.isArray(rules))
        setEgress(
          rules.flatMap((r) =>
            r &&
            typeof r === "object" &&
            "cidr" in r &&
            typeof r.cidr === "string" &&
            "protocol" in r &&
            (r.protocol === "tcp" || r.protocol === "udp") &&
            "ports" in r &&
            Array.isArray(r.ports)
              ? [
                  {
                    cidr: r.cidr,
                    protocol: r.protocol,
                    ports: r.ports.join(","),
                  },
                ]
              : [],
          ),
        );
    } else {
      setProtocol(
        p.protocol === "nfs" || p.protocol === "smb" ? p.protocol : "local",
      );
      setSource(typeof config.sourceRef === "string" ? config.sourceRef : "");
      setSubpaths(
        Array.isArray(config.allowedSubpaths)
          ? config.allowedSubpaths.join("\n")
          : "",
      );
      setReadWrite(
        Array.isArray(config.allowedModes) &&
          config.allowedModes.includes("read_write"),
      );
      setSecret(p.secretVersionRef ?? "");
    }
  };
  const save = async (key: string) => {
    const policy = {
        allowedEgress: egress.map((r) => ({
          cidr: r.cidr,
          protocol: r.protocol,
          ports: lines(r.ports).map(Number),
        })),
        allowedIngressSourceCidrs: lines(ingress),
        ipv6: "disabled" as const,
      },
      config = {
        sourceRef,
        allowedSubpaths: lines(subpaths),
        allowedModes: readWrite
          ? ["read_only" as const, "read_write" as const]
          : ["read_only" as const],
      };
    if (kind === "network")
      return profile
        ? client.admin.inventory.reviseNetwork(
            profile.id,
            { policy },
            editVersion ?? profile.version,
            key,
          )
        : client.admin.inventory.createNetwork(
            { name, policy, authorizedConsumerIds: consumers },
            key,
          );
    return profile
      ? client.admin.inventory.reviseStorage(
          profile.id,
          { protocol, config, secretVersionRef: secretRef || null },
          editVersion ?? profile.version,
          key,
        )
      : client.admin.inventory.createStorage(
          {
            name,
            protocol,
            config,
            secretVersionRef: secretRef || null,
            authorizedConsumerIds: consumers,
          },
          key,
        );
  };
  return (
    <section aria-label="配置授权Profile">
      <h3>网络与授权持久存储</h3>
      <NetworkProtection
        client={client}
        disabled={disabled}
        action={action}
        principal={principal}
      />
      <Observation at={snapshot.at} error={snapshot.error} />
      <button onClick={() => void snapshot.refresh()}>刷新修订与授权</button>
      <p>
        新修订只影响新申请；旧 Ticket
        固定原修订、子路径与模式。修改后需要针对新修订重新取得真实隔离证据；普通消费者目录不会看到
        sourceRef 或秘密引用。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(`${kind} profile保存 ${selected || name}`, save).then(
            (ok) => {
              if (ok) void snapshot.refresh();
            },
          );
        }}
      >
        <label>
          Profile 类型
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setSelected("");
            }}
          >
            <option value="network">网络</option>
            <option value="storage">持久存储</option>
          </select>
        </label>
        <label>
          逻辑 Profile
          <select value={selected} onChange={(e) => select(e.target.value)}>
            <option value="">创建新的授权 Profile</option>
            {profiles?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · revision {p.revision} · v{p.version}
              </option>
            ))}
          </select>
        </label>
        {profile ? (
          <p>
            编辑基于 v{editVersion ?? profile.version}；当前服务端 v
            {profile.version}。
            <button type="button" onClick={() => select(profile.id)}>
              放弃字段编辑并读取当前修订
            </button>
          </p>
        ) : null}
        <fieldset disabled={disabled || !!snapshot.error}>
          <label>
            名称
            <input
              value={name}
              disabled={!!profile}
              required
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </label>
          {!profile ? (
            <ChoiceList
              label="创建时授予消费者（后续在消费者页CAS编辑）"
              choices={
                snapshot.data?.consumers.map((c) => ({
                  id: c.id,
                  name: c.name,
                })) ?? []
              }
              value={consumers}
              onChange={setConsumers}
            />
          ) : null}
          {kind === "network" ? (
            <>
              <label>
                允许入口来源 CIDR（每行或逗号分隔）
                <textarea
                  value={ingress}
                  onChange={(e) => setIngress(e.target.value)}
                  placeholder="192.0.2.0/24"
                />
              </label>
              <p>
                IPv6 使用
                disabled；规则默认拒绝，明确列出需要的出站目的地址和数据端口，平台管理保护基线始终优先。
              </p>
              {egress.map((r, i) => (
                <div className="admin-grid" key={i}>
                  <label>
                    目标 CIDR
                    <input
                      required
                      value={r.cidr}
                      onChange={(e) =>
                        setEgress(
                          egress.map((r, j) =>
                            j === i ? { ...r, cidr: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    协议
                    <select
                      value={r.protocol}
                      onChange={(e) =>
                        setEgress(
                          egress.map((r, j) =>
                            j === i
                              ? {
                                  ...r,
                                  protocol: e.target.value as "tcp" | "udp",
                                }
                              : r,
                          ),
                        )
                      }
                    >
                      <option>tcp</option>
                      <option>udp</option>
                    </select>
                  </label>
                  <label>
                    固定端口（逗号分隔）
                    <input
                      required
                      value={r.ports}
                      onChange={(e) =>
                        setEgress(
                          egress.map((r, j) =>
                            j === i ? { ...r, ports: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setEgress(egress.filter((_, j) => j !== i))}
                  >
                    移除此规则
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setEgress([
                    ...egress,
                    { cidr: "", protocol: "tcp", ports: "" },
                  ])
                }
              >
                增加出站规则
              </button>
            </>
          ) : (
            <>
              <label>
                存储协议
                <select
                  value={protocol}
                  onChange={(e) =>
                    setProtocol(e.target.value as typeof protocol)
                  }
                >
                  <option>local</option>
                  <option>nfs</option>
                  <option>smb</option>
                </select>
              </label>
              <label>
                管理员批准 sourceRef（已由可信部署配置的根；不对消费者公开）
                <input
                  value={sourceRef}
                  required
                  onChange={(e) => setSource(e.target.value)}
                />
              </label>
              <label>
                允许相对子路径（每行一项）
                <textarea
                  value={subpaths}
                  required
                  onChange={(e) => setSubpaths(e.target.value)}
                  placeholder="projects/team-a"
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={readWrite}
                  onChange={(e) => setReadWrite(e.target.checked)}
                />
                除 read_only 外允许 read_write
              </label>
              <label>
                固定 secret版本引用（无认证则留空）
                <input
                  pattern="secret:[a-f0-9]{32}"
                  value={secretRef}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <p>
                只批准已由 Runtime Agent 配置和实际测试的根；不能借 Profile 开放
                Docker socket、系统目录或任意宿主
                shell。清理解绑引用，持久数据不随租客删除。
              </p>
            </>
          )}
          <button disabled={!profile && !consumers.length}>
            {profile
              ? `按编辑基准 v${editVersion ?? profile.version} 创建并激活不可变修订`
              : "创建并授予选定消费者"}
          </button>
        </fieldset>
      </form>
      <div className="admin-grid">
        {[
          ...(snapshot.data?.networks ?? []),
          ...(snapshot.data?.storage ?? []),
        ].map((p) => (
          <article className="admin-card" key={p.id}>
            <b>
              {p.name} · {p.kind} · {p.status}
            </b>
            <small>
              {p.id} · 固定 revision {p.currentRevisionId ?? "无"} /{" "}
              {p.revision ?? "无"} · v{p.version}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
