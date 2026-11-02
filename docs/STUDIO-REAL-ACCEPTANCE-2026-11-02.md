# Studio 独立真实容器验收（2026-11-02）

本阶段完成独立 Colima → Portainer → Runtime Agent → 控制器正常注册、真实资格检查、正式镜像验证与发布，以及一张通用 SSH 租客 Ticket 的完整生命周期。使用生产控制器后台循环、真实 Docker 和 SSH；数据只有合成烟测输入及其输出。前一阶段 Simulator 记录见 [接续说明](STUDIO-HANDOFF-2026-11-02.md)，两阶段证据不混用。

本文件保存首轮验收时点的记录。后续 [运行可靠性阶段](STUDIO-RELIABILITY-2026-11-02.md) 修正内存判据，将测试 Machine 的显式阈值改回 90%，并新增一张有限故障测试票；当前累计票据和清理状态以该后续记录为准。

## 隔离安装和实际配置

Mac Studio / M5 Max / 64 GiB / arm64；宿主 Node 24.21.0、pnpm 10.28.2。新建 `hitchlet-studio-acceptance` Colima profile，Docker context 为 `colima-hitchlet-studio-acceptance`，6 CPU、8 GiB RAM、40 GiB 数据盘、20 GiB 根盘，VZ / Linux arm64。既有 `default` profile 保持运行，未切换全局 Docker context。

所有手动 Docker 操作显式指定这个 context。新 VM 只共享专属受保护状态目录，没有默认 home 共享。专属 profile 保存的额外配置为：

```yaml
docker:
  default-address-pools:
    - base: 172.30.64.0/18
      size: 24
provision:
  - mode: system
    script: |
      modprobe br_netfilter
```

这次只在新 VM 中加载 `br_netfilter`；没有更改宿主 VPN、防火墙或 sysctl。Docker 为 29.5.2，Portainer CE 为 2.45.3。Runtime Agent 使用 host network/pid、drop ALL 后只加 NET_ADMIN、只读根、受限配置/journal/IPv6 sysctl 挂载及 Docker socket；没有 privileged 或 SYS_MODULE。

| 服务                            | 入口              |
| ------------------------------- | ----------------- |
| 原生控制器、GUI                 | `127.0.0.1:33100` |
| 原生 Host 使用的本地 HTTPS 代理 | `127.0.0.1:33101` |
| Runtime Agent（mTLS + bearer）  | `127.0.0.1:33443` |
| registry 3                      | `127.0.0.1:33500` |
| Portainer                       | `127.0.0.1:33900` |

控制器启用 `EXECUTION_MODE=portainer`，不是 Simulator。使用新建本地测试身份、独立 master key 和 30 天本地 CA，TLS 校验保持启用。秘密仅在 Git 外的 0700 目录、0600 文件内；未提交数据库、原始工作数据、测试日志或凭据。

VM 本地输入根 `/srv/hitchlet-studio/input` 只允许 `sample` 子路径、只读挂载；输出根 `/srv/hitchlet-studio/output` 只允许 `validation` 和 `tenant-one`，分别用于验证与唯一租客。根及祖先为 root/0755，输出子目录 UID/GID 1000。Runtime Agent 根据实际 mountinfo 核实源 `/dev/root`，不是 NAS。输入 `b'hitchlet-smoke-v1\n'` 为 18 字节，SHA-256 为 `c67d92a12e4f622af7ce861f5406876e69fd5eed9edbdd0af89e0f0f79137c91`。

网络允许 localhost SSH 来源；租客 egress 仅允许合成目标 `172.29.240.10/32` TCP 18080。管理拒绝清单精确涵盖 localhost 的五个管理端口和合成管理端口 18081。IPv6 禁用。没有公网上的服务暴露。

## 制品、注册和资格

使用官方来源拉取基础镜像，实际记录如下。标签将来可能变化，以下 digest 才是本次输入：

| 制品                               | 本次 digest                                                               |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `node:24-bookworm-slim` index      | `sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c` |
| Node Linux arm64 manifest          | `sha256:e80dee4ed3709cf1f8004e34ecfb90df71b7eac8ba0d7d6222ba238a823d1eea` |
| `portainer/portainer-ce:lts` index | `sha256:3609c307943bca8e5c492f69ddd6965df177208b50678a4cff28391c8dd4e96e` |
| `registry:3` index                 | `sha256:d4032d4cc323c1731c707931ecada07a53076eac38e3b61ae57533f170f2c6c3` |
| 构建后的 Runtime Agent image ID    | `sha256:9d9741bff0fe4c98957a54a0b36833dad37161102b7ac1355c7eedf018eb9f5b` |
| 最终通用 SSH OCI manifest          | `sha256:5cf584cab167af0b6a3dc2271809657d4c6368270f356e1a079031493f321a86` |
| SSH config digest                  | `sha256:b69ea116e30386ac01d462975c17aeabee3f2e8139c6fea31ebe44306c18cc09` |

最终 SSH 制品引用为 `127.0.0.1:33500/hitchlet-node-ssh-v1@sha256:5cf584cab167af0b6a3dc2271809657d4c6368270f356e1a079031493f321a86`，实际 Node 24.22.2。registry 原始 manifest SHA、Docker Content-Digest 和本地固定 RepoDigest 均吻合。旧 UID 1001 构建未发布，不能当作此制品使用。

| 对象                             | 标识                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| installation                     | `19fbbd10-3c74-47aa-83e8-42fc850c4114`                                          |
| Engine                           | `98531c12-2a3b-4ed6-82c3-08abfb8120a4`                                          |
| runtime identity                 | `8727f873-8e33-4663-b681-9a28b22a0783`                                          |
| connection revision              | `f468a9f5-9be7-459f-b6b2-9bdceff0ac1c`                                          |
| Machine / Node                   | `05bcc20a-9e19-42d2-afa9-899aa1ee4c61` / `2ad42e38-9b26-4c87-a596-08b918fbe807` |
| Network revision                 | `aad11591-9a0f-4afd-a2e0-4c70ae6c8df1`                                          |
| Input / output storage revisions | `2ebada0d-dbe7-45db-8d63-10ef36772fa5` / `1cca077e-91c4-407b-9657-cdd7b9f6828d` |
| 最终资格 run                     | `2fa07fda-aaca-4d56-8f91-4e3089e6144e`                                          |
| 镜像 version / artifact          | `5024a62d-8f54-4525-807c-5173c7304c78` / `0a06faef-7457-40cb-8bbe-d56871e927dd` |
| 原预热 operation                 | `6a5b041a-4d70-4f88-9b6a-835a7bbfda29`                                          |
| 正式 validation / allocation     | `bd1851cc-a719-4c87-af40-eb448013e136` / `e86f6227-d6e1-4f87-b134-4601875f0fbb` |

最终资格检查在 08:30:24.563Z 完成，通过后正常提交带报告 SHA 的 attestation。实际覆盖：幂等 create、精确主机 key 的 SSH 认证、workspace UID/GID 1000、只读输入写入拒绝、独立可写输出、CPU throttling 增加、512 MiB OOM（退出 137 且 oom_kill 增加）、无额外 swap、pids.max 512、允许数据端口/拒绝管理及未授权端口、tenant-to-host 拒绝、同桥 peer 拒绝、未授权 loopback 来源拒绝、IPv6 禁用、真实 symlink 越界拒绝、Runtime Agent 重启后 SSH 恢复，以及回收后持久输出保留。

共有 7 次外部资格探针尝试，包含配置排错和失败恢复；它们没有创建租客 Ticket，也不是账本正式 validation。最终逐项复查其 journal 中 20 个自有容器/网络/临时卷均不存在。早期设置失败遗留的一个工作卷在最终复查时发现，核对完整 ownership、确认无容器引用后精确清理。失败构建临时容器也按完整 ID、创建时间和 Dockerfile 命令来源精确清理；没有 prune。

原生 Mac Host 以实际认证观测进入 `observed_host`：fresh、human present、probe partial、sessionsComplete=false、unmanagedActivityHold=null。策略采用 attended 上限 2000 CPU millis / 2048 MiB / 4096 MiB scratch，保留 human/system reserve；没有伪造 complete 或无人状态。Host 协议 memoryPercent 包含缓存，本次阈值 99.8%，最终快照实际值 99.38%；当时另查宿主 memory_pressure 系统空闲约 77%。这不构成内存压力算法已改进的声明。外部 unmanaged Hold 和 partial 观测继续禁止自动电源动作。

原缓存预热最终 succeeded。正式 validation 实际由 Provider 执行，`testOutcome=passed`、`cleanupStatus=complete` 后才通过正常 publish API 发布；没有 SQL 写入资格、验证或发布结果。资格有效期至 `2026-11-03T08:30:24.563Z`，到期应按正常流程重新验证。

## 唯一租客 Ticket 结果

新建仅授权此镜像、Node、网络和两个存储 profile 的 consumer，排队/活动票上限均为 1。正式租客 Ticket 为 `e6b3a1a5-7658-4843-8014-a8952a145f49`，唯一 tenant Allocation 为 `9d30c747-b755-4486-bbe5-310b091a97be`，generation 1。所有时间均为 UTC。

| 步骤         | 实际结果                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Acquire      | 08:46:49 queued，保留原始 Prepared 请求及幂等键                                                                                  |
| Ready        | 08:47:00，Portainer / arm64，最终固定 artifact                                                                                   |
| Claim        | 确认 Lease v3，claimedAt `08:47:00.946Z`                                                                                         |
| Access + SSH | 独立 ephemeral_private_key；按 API SHA256 host-key 指纹校验后真实认证                                                            |
| 工作环境     | workspace UID/GID 1000、Node 24.22.2、可写 workspace                                                                             |
| 输入/输出    | 18 字节输入 SHA 正确；写只读输入被拒绝；tenant-one 输出可写                                                                      |
| 实际限额     | cgroup cpu.max `50000 100000`、memory.max `536870912`、swap.max `0`、pids.max `512`；Docker CPU quota/period 和内存/PID 配置一致 |
| 一次续租     | 原提案 `095a9a84-a08b-4d0a-9d0c-63b3ce98d1d6` 确认 Lease v4；截止从 `09:02:00.083Z` 延至 `09:07:21.413Z`                         |
| 合成结果     | `result.json` 202 字节，SHA-256 `d2deb79766227722698d6b0ec190755a2902f961b6142bdbf5c5f56d31975d57`                               |
| Release      | consumer_release → released / cleanup complete；容器、网络和 workspace 临时卷逐个 inspect 确认 absent；持久结果 SHA 不变         |

Claim 和续租的初始 HTTP 响应均为 202 pending，SDK 跟进原 renewal 到 confirmed 后才取得有效回执；没有把 202 或候选截止当作延期。申请、Claim、Access、续租、归还的 Prepared 请求均在发送前写入保护文件，恢复沿用原请求，没有第二次租客申请。短期 SSH 私钥和已消费 pairing 文件已删除。

真实回执仍为 `offlineEnforcement=not_guaranteed`，不据此承诺控制器断线后的离线租约强制执行。

正常管理 API 最终显示 released=1、cleanupBlocked=0、unknownOperations=0、claimed resources 全为 0。控制器正常停止后以只读快照核验：一张 Ticket；一个 validation Allocation 和一个 tenant Allocation，均 desired/observed absent、cleanup complete；两份容量 claim 均 released，活动 claim 为 0。没有写库造记录。

## 修复、验证与保留状态

真实流程发现并定向修复三项问题：

1. ssh2 握手失败后关闭阶段可能继续发出 error；保留客户端生命周期 error listener、单次 settle、清理 timeout 并处理提前 close，避免控制器进程崩溃，精确 host-key 校验保留。
2. 官方 Node 基础镜像已有 UID/GID 1000 的 node，原 useradd 让 workspace 变成 1001，与受信存储的 1000 合同不符。现在重命名既有账户并在 readiness 分别核 UID/GID；旧制品须重建、新 digest 并重做验证。
3. Docker 29 对单平台 OCI manifest 的 distribution 响应可省略/置空 Platforms。仅对两种明确单 manifest media type 接受缺失平台列表；index/list 仍要求平台列表。精确 registry digest 和 ready 前本地 RepoDigest、Linux、架构、size 检查保留，原预热操作恢复成功。

有限增量 review 未见遗留阻断。实际执行 controller 构建、最终 tsc --noEmit；SSH readiness + Portainer cleanup 19 项，以及 Portainer cache + image-cache worker 22 项通过。恢复入口实际启动后重新取得 fresh 原生 Host、正确 Engine 身份和零占用，随后正常停止；补充的 profile 存在性检查和语法检查通过。没有把历史全套测试数字说成本轮重跑。

最终停止原生控制器、Host、HTTPS 代理、三个管理容器及专属 Colima profile。`default` profile 仍 Running。保留专属 VM、两个管理数据卷、镜像、保护配置、原始回执、journal 和合成持久输出。没有 NAS/媒体、MBP 原栈、其他 VM/云、Windows、宿主电源或生产部署操作。

从 clone 根目录恢复既有安装：

```sh
export HITCHLET_STUDIO_STATE_DIR=/absolute/path/to/retained/private-state
node scripts/studio-acceptance-resume.mjs
```

[恢复入口](../scripts/studio-acceptance-resume.mjs) 只恢复已保留安装；profile 缺失时直接拒绝，启动后再核 Engine ID。读取已存在的保护配置/CA/key，不创建凭据、不重建 VM、不自动申请 Ticket。需要已有构建产物及 PATH 中的 colima/docker。Ctrl-C 停止它自己启动的原生进程；确认租约和回收完成后，可用显式 context 停止三个管理容器，再执行 `colima -p hitchlet-studio-acceptance stop`。恢复服务不会延长既有资格有效期。

保护状态目录的报告索引：`qualification.json`、`probe-reconciliation.json`、`cache-operation.json`、`image-validation.json`、`published-image.json`、`tenant-lifecycle.json`、`tenant-timeline.json`、`host-policy-dry-run.json`、`management-overview.json`、`ledger-final.json`、`failed-build-cleanup.json` 和 `stack-retention.json`。分享版仅包含白名单结果与报告 SHA，不含原始配置和秘密。

官方安装/配置依据：[Colima profiles](https://colima.run/docs/profiles/)、[Colima configuration](https://colima.run/docs/configuration/)、[Portainer Docker 安装](https://docs.portainer.io/start/install-ce/server/docker/linux)、[Node 官方镜像](https://hub.docker.com/_/node/)、[Registry 官方镜像](https://hub.docker.com/_/registry)、[Docker networking](https://docs.docker.com/engine/network/)。上文通过/失败结论来自本机实际证据，不由这些说明页面代替。
