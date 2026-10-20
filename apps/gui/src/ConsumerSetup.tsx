import React from "react";
import type { ConsumerInput, ConsumerView } from "@hitchlet/sdk";
import {
  ChoiceList,
  ResourceFields,
  Observation,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";

const empty: ConsumerInput = {
  name: "",
  kind: "service",
  role: "consumer",
  status: "active",
  authorization: {
    imageIds: [],
    nodeIds: [],
    networkProfileIds: [],
    storageProfileIds: [],
  },
  quota: {
    maxQueuedTickets: 10,
    maxActiveTickets: 1,
    maxLeaseTtlSeconds: 900,
    maxLifetimeSeconds: 3600,
    maxResources: { cpuMillis: 1000, memoryMiB: 1024, scratchMiB: 2048 },
    defaultExpiryPolicyId: "",
  },
};
/** Consumer grants share the existing authorization JSON and transactional CAS; quotas never rewrite an accepted contract. */
export function ConsumerSetup({
  client,
  disabled,
  action,
  onCredentialIssued,
}: ManagementUI & { onCredentialIssued: (token: string) => void }) {
  const load = React.useCallback(async () => {
      const [consumers, policies, nodes, versions, networks, storage] =
        await Promise.all([
          client.admin.management.consumers(),
          client.admin.management.policies(),
          client.admin.nodes(),
          client.admin.imageVersions(),
          client.admin.networkProfiles(),
          client.admin.inventory.storageProfiles(),
        ]);
      return { consumers, policies, nodes, versions, networks, storage };
    }, [client]),
    snapshot = useManagementRead(load);
  const [selected, setSelected] = React.useState<ConsumerView | null>(null),
    [form, setForm] = React.useState<ConsumerInput>(empty),
    [policyName, setPolicyName] = React.useState(""),
    [policyId, setPolicyId] = React.useState("");
  const select = (id: string) => {
    const found = snapshot.data?.consumers.find((c) => c.id === id);
    setSelected(found ?? null);
    if (found) {
      const { id: _, version: __, updatedAtMs: ___, ...input } = found;
      setForm(input);
    } else
      setForm({
        ...empty,
        quota: {
          ...empty.quota,
          defaultExpiryPolicyId: snapshot.data?.policies[0]?.id ?? "",
        },
      });
  };
  React.useEffect(() => {
    if (!form.quota.defaultExpiryPolicyId && snapshot.data?.policies[0])
      setForm((f) => ({
        ...f,
        quota: {
          ...f.quota,
          defaultExpiryPolicyId: snapshot.data!.policies[0]!.id,
        },
      }));
  }, [snapshot.data, form.quota.defaultExpiryPolicyId]);
  const images = [
    ...new Map(
      snapshot.data?.versions.map((v) => [
        v.imageId,
        { id: v.imageId, name: v.imageName },
      ]) ?? [],
    ).values(),
  ];
  const blocked = disabled || !!snapshot.error;
  return (
    <section aria-label="消费者政策管理">
      <h3>消费者、权限与配额</h3>
      <Observation at={snapshot.at} error={snapshot.error} />
      <button onClick={() => void snapshot.refresh()}>刷新当前版本</button>
      <p>
        viewer 仅查看授权范围；consumer 管理自己的 Ticket；operator
        在授权镜像/Node范围撤销和重试；只有完整 admin
        凭据可管理身份和全局配置。浏览器按钮之外，服务端每次重新授权并校验
        CSRF。TTL/总寿命由下方配额决定，到期政策当前仅 destroy。
      </p>
      <label>
        编辑目标
        <select
          value={selected?.id ?? ""}
          onChange={(e) => select(e.target.value)}
        >
          <option value="">创建新 Consumer</option>
          {snapshot.data?.consumers.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name} · {c.role} · {c.status} · v{c.version}
            </option>
          ))}
        </select>
      </label>
      {selected ? (
        <p>
          编辑基于 v{selected.version}；最近目录版本{" "}
          {snapshot.data?.consumers.find((c) => c.id === selected.id)
            ?.version ?? "未知"}
          。
          <button onClick={() => select(selected.id)}>
            放弃编辑并读取当前消费者
          </button>
        </p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(
            `消费者保存 ${selected?.id ?? form.name}`,
            async (key) => {
              const result = selected
                ? await client.admin.management.updateConsumer(
                    selected.id,
                    { ...form, expectedVersion: selected.version },
                    key,
                  )
                : await client.admin.management.createConsumer(form, key);
              setSelected(result);
              await snapshot.refresh();
            },
          );
        }}
      >
        <fieldset disabled={blocked}>
          <div className="admin-grid">
            <label>
              名称
              <input
                value={form.name}
                required
                maxLength={120}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label>
              类型
              <select
                value={form.kind}
                onChange={(e) =>
                  setForm({ ...form, kind: e.target.value as typeof form.kind })
                }
              >
                <option>human</option>
                <option>service</option>
                <option>agent</option>
              </select>
            </label>
            <label>
              角色
              <select
                value={form.role}
                onChange={(e) =>
                  setForm({ ...form, role: e.target.value as typeof form.role })
                }
              >
                {["viewer", "consumer", "operator", "admin"].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              状态
              <select
                value={form.status}
                onChange={(e) =>
                  setForm({
                    ...form,
                    status: e.target.value as typeof form.status,
                  })
                }
              >
                <option>active</option>
                <option>disabled</option>
              </select>
            </label>
          </div>
          {(
            [
              ["imageIds", "镜像授权", images],
              [
                "nodeIds",
                "Node授权",
                snapshot.data?.nodes.map((n) => ({ id: n.id, name: n.name })) ??
                  [],
              ],
              ["networkProfileIds", "网络授权", snapshot.data?.networks ?? []],
              ["storageProfileIds", "存储授权", snapshot.data?.storage ?? []],
            ] as const
          ).map(([key, label, choices]) => (
            <div key={key}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.authorization[key] === "all"}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      authorization: {
                        ...form.authorization,
                        [key]: e.target.checked ? "all" : [],
                      },
                    })
                  }
                />
                {label}：显式允许所有当前及未来对象
              </label>
              {form.authorization[key] !== "all" ? (
                <ChoiceList
                  label={label}
                  choices={choices}
                  value={form.authorization[key]}
                  onChange={(ids) =>
                    setForm({
                      ...form,
                      authorization: { ...form.authorization, [key]: ids },
                    })
                  }
                />
              ) : null}
            </div>
          ))}
          <ResourceFields
            label="并发累计上限"
            value={form.quota.maxResources}
            onChange={(maxResources) =>
              setForm({ ...form, quota: { ...form.quota, maxResources } })
            }
          />
          <div className="admin-grid">
            {(
              [
                ["maxQueuedTickets", "最大排队票数"],
                ["maxActiveTickets", "最大活动票数"],
                ["maxLeaseTtlSeconds", "单次 TTL 秒"],
                ["maxLifetimeSeconds", "最大总寿命秒"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={form.quota[key]}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      quota: { ...form.quota, [key]: Number(e.target.value) },
                    })
                  }
                />
              </label>
            ))}
            <label>
              destroy 到期政策
              <select
                required
                value={form.quota.defaultExpiryPolicyId}
                onChange={(e) =>
                  setForm({
                    ...form,
                    quota: {
                      ...form.quota,
                      defaultExpiryPolicyId: e.target.value,
                    },
                  })
                }
              >
                <option value="">选择政策</option>
                {snapshot.data?.policies.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} · destroy · v{p.version}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p>
            保存仅影响新准入和后续预留配额重检；已受理 Ticket
            的资源/租期/profile
            不被改写。停用会立即拒绝该身份后续认证并撤销会话；活动 Ticket
            继续按冻结合同到期/清理，需要立即终止时由授权 operator/admin
            撤销。角色编辑只收窄现有 token
            scopes，不自动扩大；新权限须显式签发新凭据。最后一个可用完整管理员不可降权/停用。
          </p>
          <button>
            {selected ? `按 v${selected.version} 保存` : "创建消费者"}
          </button>
        </fieldset>
      </form>
      {selected ? (
        <div className="admin-card">
          <h4>单独签发凭据</h4>
          <p>
            目标 {selected.name} · {selected.id}。新 token
            仅在页面内存显示一次。响应丢失后先到系统凭据元数据页确认并轮换，不自动重复签发。
          </p>
          <button
            disabled={blocked || selected.status !== "active"}
            onClick={() =>
              void action(`签发凭据 ${selected.id}`, async (key) => {
                const issued = await client.admin.management.issueCredential(
                  selected.id,
                  key,
                );
                onCredentialIssued(issued.token);
              })
            }
          >
            为该身份显式签发角色权限 token
          </button>
        </div>
      ) : null}
      <form
        className="admin-card"
        onSubmit={(e) => {
          e.preventDefault();
          const policy = snapshot.data?.policies.find((p) => p.id === policyId);
          void action(`destroy政策名称 ${policyId || policyName}`, (key) =>
            policy
              ? client.admin.management.updatePolicy(
                  policy.id,
                  policyName,
                  policy.version,
                  key,
                )
              : client.admin.management.createPolicy(policyName, key),
          ).then((ok) => {
            if (ok) void snapshot.refresh();
          });
        }}
      >
        <h4>destroy 政策名称与关联</h4>
        <label>
          政策
          <select
            value={policyId}
            onChange={(e) => {
              setPolicyId(e.target.value);
              setPolicyName(
                snapshot.data?.policies.find((p) => p.id === e.target.value)
                  ?.name ?? "",
              );
            }}
          >
            <option value="">创建名称</option>
            {snapshot.data?.policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · v{p.version}
              </option>
            ))}
          </select>
        </label>
        <fieldset disabled={blocked}>
          <label>
            名称
            <input
              value={policyName}
              required
              onChange={(e) => setPolicyName(e.target.value)}
            />
          </label>
          <p>
            此项仅命名和选择 destroy
            政策，不改变已有环境到期行为。TTL与总寿命由消费者配额控制，不支持暂停/保留到期环境。
          </p>
          <button>保存政策名称</button>
        </fieldset>
      </form>
    </section>
  );
}
