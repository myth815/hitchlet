# 同租约双成员容器

这是本地源码候选，尚未在真实 Docker、TUN 或 VPN 管理面验收。它保留普通单容器 entrypoint 和 SSH recipe 的原行为；SSH 租客仍自行控制业务并按普通租约归还。

## 登记与申请

使用原镜像草稿、验证、清理和发布流程。主 artifact 是 workload 的固定镜像。草稿新增 `containerGroup`；创建 version/artifact 时该字段位于 `requirements.containerGroup`。两成员共享一个 allocation、lease、generation 和 Docker bridge，不接受消费者提交 Compose、任意命令或特权配置。

```ts
bootstrap: {
  mechanism: "hitchlet-container-group-entrypoint-v1",
  contractVersion: "1",
  identityReset: true,
},
access: {
  accessProtocols: [], ports: [], account: "workspace",
  allowedSourceCidrs: [], discovery: "none", readiness: "container-running",
},
containerGroup: {
  gateway: {
    artifactRef: "example.invalid/gateway@sha256:<64 hex>",
    digest: "sha256:<64 hex>",
    resources: { cpuMillis: 100, memoryMiB: 128, scratchMiB: 0 },
    mountPaths: ["/persist/gateway"],
    stateMountPath: "/var/lib/gateway",
    networkCapability: "tun",
    ipv4Forwarding: true,
    environment: {
      GATEWAY_CONFIG_FILE: "/persist/gateway/gateway.json",
      GATEWAY_KEY_FILE: "/persist/gateway/setup-key",
    },
  },
  links: [
    { from: "gateway", to: "workload", protocol: "tcp", ports: [3000] },
    { from: "workload", to: "gateway", protocol: "tcp", ports: [18080] },
  ],
},
```

`environment` 只登记非秘密启动参数和文件路径。密钥正文由已授权的只读 storage reference 提供。`mountPaths` 必须引用同一申请中已有的只读 mount target，且仅挂给 gateway。继续适用现有存储源资格、子路径及 target 规则；`/persist/gateway` 或 `/persist/turbocli-network` 可用，`/etc` 不可用。gateway 可附一对 `imageVersionId` / `imageArtifactId`，登记时核对目录中的 ref、digest、平台和架构。组合发布验证自身两成员，不引入第二张租约或额外审批。

普通 acquire 不增加字段：选已发布的组合 `image.versionId`，`access.protocol="none"`，`resources` 为 workload 与 gateway 的**合计**额度；保留 work/home 引用，再加 gateway 的只读配置引用。gateway 使用 recipe 的固定份额，workload 使用余下份额，不能超过已预留的总额度。两者各有一个 owned 临时卷；gateway 卷挂到 `stateMountPath`，workload 卷仍挂 `/workspace`。持久引用保持 reference，不是销毁目标。

## 运行与网络

Hitchlet 使用镜像原 entrypoint，创建两个成员；网络按冻结 profile 的模式处理。workload 为 UID/GID 1000；gateway 为 UID 0、drop ALL 后仅加 NET_ADMIN 与 NET_RAW，仅映射 `/dev/net/tun`，不允许 privileged、host 网络、宿主端口或第二网络。`ipv4Forwarding:true` 只设置 gateway 自己网络命名空间的 `net.ipv4.ip_forward=1`，不改宿主。

同桥别名分别是 `workload`、`gateway`。Hitchlet 从实际分配的子网固定成员地址并核对 Engine 读回。在既有 filtered 模式，每条 link 只放行对应成员地址之间的 TCP 目的端口及已建立连接的反向源端口；管理拒绝优先，其他同桥转发仍 DROP。跨 allocation 隔离、既有显式 host/forward egress 语义不变。撤销后不再有成员 link 允许规则，并沿原流程清除连接、核对容器和卷删除及网络规则撤销。

普通 `dockerMode:"bridge"` 不执行额外的宿主防火墙动作，同桥使用 Docker 原生语义，links 作为消费者接线声明；详见 [普通 bridge 租约](DOCKER-BRIDGE-LEASES.md)。

Gateway 的隧道、路由、目的映射、配置及业务报到属于租客。Hitchlet 不解析 VPN 地址或等待其管理面。ready 只证明固定镜像、运行状态、资源限额、挂载、单桥及所选网络模式符合合同；不执行 SSH probe、不生成 SSH 凭据。普通消费者可在 ready 后自动完成原租约签收，业务程序已由 entrypoint 启动，不存在业务控制权授予。`access` 继续返回 `access_not_applicable`。

## 清单与配对

两个 reader 保留完整 receipt、owner、代次、manifest、未知副作用、容量和真实清理对账。对象集合由冻结 recipe 决定，原单成员仍为三个 owned 对象，本 recipe 为两 container、两 volume、一 network_policy。reference 不计入销毁数量。角色、镜像摘要、实际 IPv4、资源份额、卷目标和引用绑定参与 manifest 摘要。

ready inventory 和已有 ready 清单的 cleanup proof 都附：

```ts
containerGroup: {
  members: [{
    name: "workload" | "gateway",
    containerId, artifactDigest, ipv4,
    resources: { cpuMillis, memoryMiB, scratchMiB },
    // gateway 可带登记时核对过的 imageVersionId、imageArtifactId
    stateVolume: { id, target, ownership: "owned" },
    mountBindings: [{ grantId, revisionId, target, mode }],
  }],
  links: [{ from, to, protocol: "tcp", ports }],
}
```

不返回 host source、环境变量、argv 或密钥。Controller、Runtime、contracts 和 SDK 应从同一提交构建配对。没有 group 的旧规则摘要保持不变；旧 Runtime 不理解新增成员字段，不能用于此 recipe。无需数据库迁移。部署应由原实施方另行按具体范围进行；本候选没有部署或防火墙操作。

未 ready 的失败清理使用 [未 ready 清理证明](PRE-READY-CLEANUP-PROOF.md) 的独立终态分支，只证明实际创建的对象，不补造完整成员清单。

本地测试使用合成 Portainer、Runtime、sysfs、iptables 和数据包，实际经过普通 Provider、临时 SQLite、创建日志、两个 reader、租约签收及清理。覆盖双线并存与单线归还、响应丢失恢复、启动失败回收、清单篡改、精确 TCP 正反例、管理拒绝优先及撤销。真实镜像入口、TUN 数据道、VPN 控制面、隧道前端与出站业务、真实 A/B 隔离和归还仍须现场配对验收。
