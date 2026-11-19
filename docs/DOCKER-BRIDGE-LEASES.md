# 普通 Docker bridge 租约

这是从既有双成员候选接续的本地源码改动；当前验证使用假 Engine、合成 Runtime 和临时 SQLite，没有操作现场、真实防火墙或 VPN。普通 bridge 与显式过滤路径分别按冻结合同运行，既有 SSH/媒体消费者及 VM 路径保持原义。

## 正常接线

通过现有 network profile 登记/版本接口配置：

```ts
config: {
  dockerMode: "bridge",
  allowedEgress: [],
  allowedIngressSourceCidrs: [],
  ipv6: "disabled",
}
```

SDK 的 network profile revision 对应字段仍是 `policy`。普通 acquire 不增字段：选择此 profile 的 `networkProfileId`、已发布的 entrypoint 单成员或双成员镜像，以及 `access:{protocol:"none"}`。profile 授权、资源配额和原子预留、镜像、挂载资格、owner/lease/generation 和回收对账继续适用。无入站端点不生成 SSH 凭据、不发布宿主端口。

每个 allocation 创建自己的 Docker bridge；容器只附这一个桥。Docker 原生路由/NAT 提供出站，Center/Git 的可达性取决于现有宿主和目的端配置，Hitchlet 不安装、读取或撤销额外的宿主 INPUT / DOCKER-USER 策略，也不改宿主 sysctl。`ipv6:"disabled"` 在此表示 Docker 网络的 EnableIPv6=false，不声称完成独立 IPv6 防火墙隔离。

双成员使用原 gateway recipe、固定成员地址、同桥别名和实际清单。NetBird 单端口预览、网关 listener 和目的映射属于消费者配置；Hitchlet 不解析隧道或等待网关业务报到。此模式的 `containerGroup.links` 是网关接线声明，**不承诺同桥逐端口 ACL**；同租约两成员可按原生桥语义互通。不同租约分别拥有桥、成员及临时卷。真实 A/B 数据包隔离、出站及预览仍须现场验证，本地对象与地址对账不能替代。

## 冻结与查实回收

accepted/resolved contract 固定 `mode:"isolated_bridge"`、`enforcement:"docker_bridge"`、`verificationRequired:false`。之后更新 profile 不改变旧票。Provider 核对真实 Engine 身份、对象 owner、桥名称/驱动/子网、成员唯一网络附件、镜像/配方/挂载和运行状态；不把 VM 策略资格或 Runtime 网络动作作为本模式的交付步骤。Node 保留原登记、连接身份、有效期与健康刷新流程；能力报告按所选不可变 profile revision 接受相关证据，见 [能力证据](DOCKER-CAPABILITY-EVIDENCE.md)。

归还停止并删除该租约的实际容器，核对桥无附件后删除桥，读回对象 absent 后才核销容量。持久 reference 只脱挂，不销毁。网络对象继续使用现有 `kind:"network_policy"` 标识其 owned bridge，回执 `networkRules:"not_applicable"`；这表示没有额外 Hitchlet 策略，不是跳过网络对象删除。

ready inventory、SDK 方法和 cleanup proof 的 DTO 形状不变。已有 ready 票用 1.0；未 ready 票用 [1.1 的实际创建/清理证明](PRE-READY-CLEANUP-PROOF.md)。reader 按冻结 enforcement 核验网络回执：bridge 要求 `not_applicable`；原 filtered ready 路径仍要求 `removed`，其 pre-ready 路径仍允许 `removed/never_installed`。未知副作用、身份或清理不完整仍不能出终态证明。

## 显式策略与组件配对

`dockerMode:"filtered"` 或省略该字段，保留原 `docker_iptables`、profile revision 资格、管理拒绝优先、Runtime install/readback/revoke/remove 和规则摘要语义；Tart/Hyper-V 网络路径不变。bridge profile 不接受细粒度 ingress/egress 列表，避免配置看似生效而实际忽略。SSH recipe 不使用 bridge 模式；仍可选择旧 profile。

Runtime 启动保留 Engine 身份检查，DOCKER-USER 的链检查延后到明确的网络策略动作；显式策略安装/撤销仍由原 IptablesFirewall 检查链并读回规则。普通存储检查和 bridge 租约不因此读取宿主规则。无需数据库迁移、无需改变 Runtime 配置格式或实际网络设置；Controller/contracts/SDK 及 Runtime 从本候选配对构建，旧 Runtime 的启动前置行为不代表此路径。

消费者只需选择 bridge profile，并允许既有 proof enum 的 `not_applicable` 网络回执；若只接受 `removed`，需按此冻结模式调整。原请求体、普通签收/续租/归还 API 和 1.0/1.1 对象对账保持不变。

普通 bridge 的能力报告不要求未使用的宿主防火墙、IPv6 过滤或 SSH 探针；不能因此把这些能力标为 verified。实际桥、成员配方、挂载和清理仍经正式创建/读回验证。
