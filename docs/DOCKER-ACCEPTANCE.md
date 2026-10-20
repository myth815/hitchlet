# Docker 交付验收与节点承诺

2026-10-20，D25 独立验收记录。代码基线为 D24 `8b0fc72` 加本次 D25 差异；最终放行状态与检查数量见 [实施记录](IMPLEMENTATION.md)。本文区分实机结果、故障注入和后置能力，不代表所有登记机器都已通过认证。

## 已验证的部署组合

| 项目         | 本次范围                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 物理 Host    | 原生 macOS 26.6.2、Apple Silicon arm64；独立出站 HTTPS Host observer                                                                                                                       |
| Docker 底座  | 外部人工维护、常开的 Colima Ubuntu 24.04.4 Linux VM；不由 Hitchlet 管理该 VM 生命周期                                                                                                      |
| 运行时       | Docker 29.5.2、Portainer CE 2.45.2、Linux arm64；同一不可变 Engine 身份与已验证连接修订                                                                                                    |
| 正式准入     | `observed_host`，实际保障为 `bounded_partial_host`；人员正向证据为 present，未管理活动保持 unknown                                                                                         |
| 容量         | 管理员明确划定的测试根池预算 1000m CPU / 1024 MiB，非整机硬件总量；系统保留500m/512 MiB，含人类保留250m/256 MiB；attended/unattended 租客总上限均500m/512 MiB                              |
| 通用制品     | [Node 24 SSH v1 配方](../docker/node-ssh-v1/README.md)，arm64；本次验证 digest `sha256:6d5a82abc46642be2af8cf2438737bd4c7444a7665a69c596b98ad8cd3d7b1d3`，经草稿验证、查实清理和发布后租用 |
| 存储         | 四个明确授权 profile：local/NFS4.2 各一份只读输入、独立可写输出；预挂载根与实际来源通过认证 Runtime facts 核对                                                                             |
| 入口与资源   | 每个 Allocation 的 SSH 凭据和 host key 独立；实际 CPU 500m、内存512 MiB、PID128限制；共享内核、scratch best_effort                                                                         |
| 能力证据     | 同一 Engine、架构、网络/存储修订的六项隔离报告与四项存储范围；本次显式86400秒，从检查时间计算，不由心跳续期                                                                                |
| 最终保留状态 | 测试账本暂停、全部 Ticket 已释放、未释放 Claim 为零、无托管容器/网络/卷；原生 Host 与临时控制服务已停止                                                                                    |

底座服务和预挂载测试 NAS 属于管理员维护范围。上述操作只在隔离测试 Engine 执行，没有迁移既有媒体业务或触碰默认 Docker。私有身份、地址、配对材料、数据库、原始日志和 NAS 路径不随公开仓库发布；本地完整证据保留安装/Node/连接/制品/profile修订及报告对应关系。

这里的 digest 是本次制品的验收值，不是公开镜像仓库地址。配方给出构建与身份重置步骤，不保证可变基础标签和软件源永远生成相同字节；自行构建应重新核对实际平台、固定所得 digest，并重新验证后发布。

## 独立实机结果

- **人机共用与容量**：当前物理 Mac Host 重新配对、原生采样、认证心跳后提升正式准入。`block_new` 在实际有人时阻止新增；`within_reserved_budget` 下两次并发申请只产生一个 ready 环境，另一个排队并可取消。根池系统保留没有重复扣减。
- **压力与观测失效**：正向完整流程的测试策略显式设置100% CPU/内存阈值，不将它当作生产推荐值或低压力证明；随后恢复90%/90%，实际高内存占用令正式节点拒绝新增。停止 Host 直到观测超过30秒，同样阻止新增，原租客仍保持占用。Mac 内存指标来自 OS total/free 的占用率，不能等同于专有 memory_pressure 信号。
- **完整租约与恢复**：真实 SDK 申请→ready→claim→SSH读取原持久数据→renew→release；控制器重启后 Host 通过新 controller/session epoch 恢复，仍是原租约与原环境；查实回收后容量归零。GUI显示实际部分观测、未知活动、能力期限及压力拒绝原因。
- **入口与网络**：实际 INPUT/FORWARD、管理目的地址、同IP管理/数据端口、未授权入站/出站、同桥隔离、既有连接撤销和 IPv6 禁用均实测。Docker 重启后租客保持停止，先恢复规则再启动；Agent 重启、陈旧指令拒绝与重复删除查实通过。
- **存储与身份**：相同固定制品的两个独立容器有不同 SSH host key；bootstrap材料撤除，普通用户登录；实际 cgroup 限额读回。local/NFS只读输入返回EROFS，可写输出在容器删除后仍存在。D23另已验证NAS挂载丢失时不会回落到空本地目录或误删外部数据。
- **安装与恢复演练**：D24干净源码冻结依赖安装、构建、官方初始化和真实HTTP SDK闭环通过；正式 Dockerfile 非root运行和持久SQLite卷通过。D23已演练隔离备份恢复、旧Provider/Runtime凭据失效、原ready实体/截止/Claim保留，以及恢复后新租用归还。小型测试账本恢复演练44秒不是生产RTO承诺；日备份RPO≤24小时是运维目标。

网络新鲜度复验曾在Docker重启后出现一次Runtime Agent传输失败，当时租客保持停止；随后按私有计划查实原生删除。原探针未保存底层错误码，不能确定根因。补充错误码/耗时诊断及同一command ID有界恢复后，完整复跑通过，未再次触发重试。此失败保留在私有记录，不被删除或解释成“从未断线”。控制面断线后的未知状态和回收恢复属于产品合同。

## 跨模块验收对应关系

下列“故障注入”使用真实临时 SQLite、应用/Provider执行端口或固定原生输出反例；它证明对应逻辑，不代表进行过真实整机关机。

| 设计验收场景                             | 证据与边界                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 最后一份容量、父子池、配额与不可重复扣减 | D25真实保守根池并发；[admission](../apps/controller/test/admission.test.ts)、[machine-policy](../apps/controller/test/machine-policy.test.ts)覆盖多消费者、子池与事务竞态                                                                        |
| 创建后丢响应、跨进程恢复、取消与归还失败 | [d05-review](../apps/controller/test/d05-review.test.ts)、[validation-lifecycle](../apps/controller/test/validation-lifecycle.test.ts)、[portainer-cleanup](../apps/controller/test/portainer-cleanup.test.ts)故障注入；D23/D25真实恢复/归还查实 |
| claim截止、到期/续租、撤销与迟到ACK      | [app](../apps/controller/test/app.test.ts)、[tickets](../apps/controller/test/tickets.test.ts)与[跨进程生命周期](../apps/controller/test/validation-lifecycle.test.ts)事务/HTTP回归；真实SDK claim/renew/release                                 |
| 身份漂移、连接修订与冻结profile/秘密     | [admin](../apps/controller/test/admin.test.ts)、[provider-probe](../apps/controller/test/provider-probe.test.ts)、[secret-store](../apps/controller/test/secret-store.test.ts)反例；D23真实旧Provider/Agent凭据拒绝                              |
| 草稿验证、清理后发布、镜像缓存与引用保护 | [validation-lifecycle](../apps/controller/test/validation-lifecycle.test.ts)、[image-cache-worker](../apps/controller/test/image-cache-worker.test.ts)回归；D23/D24实际固定制品发布、预热与租用                                                  |
| 网络、管理保护与执行端重启               | D24/D25上述实际探针；[Runtime worker](../apps/runtime-agent/test/worker.test.ts)与[firewall](../apps/runtime-agent/test/firewall.test.ts)反例                                                                                                    |
| 控制端退出、事件流丢失与客户端关闭       | 跨进程恢复、SSE/SDK/GUI回归；D24浏览器断线只读，D25保留实际租客跨控制器重启；关闭浏览器不归还                                                                                                                                                    |
| Host身份、boot/epoch、人的登录与枚举失败 | D25实际原生present/partial、停止观测、重启恢复；[host-agents](../apps/controller/test/host-agents.test.ts)、[host-probes](../apps/runtime-agent/test/host-probes.test.ts)覆盖旧boot、撤销、锁屏/RDP/枚举失败等反例；没有伪造完整无人证明         |
| 底座依赖、未知工作量与自动电源           | 外部常开底座Hold和有界预算实测；[power-domain](../apps/controller/test/power-domain.test.ts)、[power](../apps/controller/test/power.test.ts)为dry-run/竞态证明。真实关机、WOL与插座操作后置D22b                                                  |
| 漂移对象与未知对象清理边界               | Provider/cleanup回归及此前真实异常回收；只处理具有对应安装/运行时/Allocation/generation身份的托管对象，不清理外来容器                                                                                                                            |
| 数据卷低/满、迁移、历史保留和备份恢复    | [storage](../apps/controller/test/storage.test.ts)、[maintenance](../apps/controller/test/maintenance.test.ts)含真实SQLITE_FULL/独立恢复；D23实际控制权接管与保留租约                                                                            |
| 持久数据与业务无关                       | local/NFS授权边界、NAS失联、销毁保留的实机证明；通用Node SSH镜像和独立API/SDK/GUI不依赖OpenClaw或媒体业务字段                                                                                                                                    |

## M2 整体复核补充（2026-10-20）

在 D25 放行后，整体复核补齐了以下合同与实现缺口；此前批次记录保留其当时结果。

- 镜像发布在异步 Runtime 探测完成后，于提交事务重新检查能力/验证证据期限与网络/存储修订吊销；探测期间过期或吊销均不能发布。
- 固定 Profile 修订具备历史查询、影响预览、CAS 永久吊销和 SDK/GUI 入口；永久 fence、Ticket/validation 终止意图与幂等回执原子落账。旧 ready 回执不能恢复授权，未查实清理前不释放 Claim；尚未实现的 VM/底座依赖明确阻止执行。
- 人机策略与准入模式可恢复原管理命令；HTTP 与 SDK 共用 contracts 白名单，当前授权与 CSRF 检查先于历史回执。
- 清理只向 Provider 提交自有资源作为删除目标；持久引用仅解绑。实机暴露的无谓 reference 删除拒绝已修复，Simulator 同步停止时解绑本地引用元数据。
- 替换会剥离 Ed25519 公钥前导零的第三方生成路径，使用 Node 原生密钥及保留完整字节的 OpenSSH 封装，持久化前校验；固定前导零反例及独立签名校验通过，1000 组实际生成样本全部可解析。既有访问材料不静默改写。

最终 Node 24 全仓 **437/437**（contracts22、Runtime50、SDK29、controller302、GUI34）通过，严格类型、构建、格式、设计接口与 SQLite **86项/43表**检查通过；001–007 与设计 DDL 无改动。

本次另在同一隔离 Engine 新建一次性存储修订，实际 SSH 写入持久输出后同时吊销 ready/queued 票据。Runtime Agent 断联时 ready 票据保持 releasing 与 Claim，queued 票据直接释放；重启控制器并恢复 Agent 后，在 paused 状态查实原生回收、容量归零，本地新输出与原有 NAS 输出仍在。原键重复返回同一回执，恢复准入后新申请仍不能使用该已吊销修订。人机策略和准入模式分别通过真实 HTTP 丢响应后恢复原回执；GUI 实际查询历史并完成只读影响预览。

复验开始时，外部 Docker 底座 VM 重启丢失了预先加载的 `br_netfilter`，执行器拒绝启动租客并保留 Claim。恢复模块后，通过原 cleanup 的显式 SDK 重试完成查实回收；没有改账本或释放未查实容量。运行手册补充宿主重启后的模块/NAS检查及 Ubuntu 持久加载示例。这不代表 Hitchlet 已接管 VM 或自动加载宿主内核模块。

最终代码再次从空目录冻结依赖安装、构建与真实 HTTP/安装 SDK M0 闭环通过；正式 Dockerfile 非 root UID1000、持久 SQLite 卷、内置 GUI 与 SDK 闭环通过。M0 包装测试与上述真实租客 Docker 证据分别记录。架构继续保持 TypeScript 模块化单体、单个 SQLite 账本、Docker 优先，VM/云/实际电源后置。

## 尚未承诺

没有验证的 amd64、Windows Docker、其他NAS型号或SMB、完整无人会话枚举、物理主机断电后的无人启动、OS服务开机监督、严格离线到期停止、临时盘硬限额、自动关机/WOL/小米插座3，以及Hyper-V/Tart/云节点，均不能由本次矩阵推导为支持。

真实共享宿主会因人员、压力、过期观测或能力报告到期而暂停新增；“正式节点”不代表永久可用，也不绕过当前策略。运行部署按[运行手册](runbook.md)独立安装、配对并逐机取证；本轮交付源码与验收结果，没有给人的电脑安装常驻开机服务或开启实际电源自动化。

全部租约释放及账本完整性复核后，主审还手动停止了三个专用测试基础服务和Colima验收VM，保留数据与证据以释放本机资源。这是实验环境收尾，不表示Hitchlet已经实现VM底座或实际电源自动管理。
