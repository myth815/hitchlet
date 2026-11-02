# Studio 内存判据与中断恢复（2026-11-02）

本轮在 `d4d30ad` 的真实单票验收后，复用同一 Studio 专属 Colima/Engine、保护身份、镜像和网络/存储。只新增一张 60 秒合成租客票，一次一票；没有新建栈、凭据、系统服务或扩大宿主权限。以下时间均为 UTC。

## 既有修复与边界

前轮三项修复保持：workspace UID/GID 1000 与受信存储合同一致；SSH readiness 处理提前关闭和关闭阶段继续出现的 error，保留精确 host-key 校验；Docker 29 单平台 manifest 缺失 Platforms 的兼容仍要求精确 registry digest 和 ready 前本地平台核验。复用此前 19+22 项定向测试及真实 SSH/续租/回收证据，没有重跑旧全套。

前轮 99.8% 是测试 Machine 的显式人机策略，未更改产品默认，也未修复 raw used ratio 被当作压力的问题。`manualInventoryPolicy` 的 CPU/memory 回退仍为 90%；`observed_host` 读取各 Machine 的显式 HumanUsePolicy，不能称所有生产机器统一使用某个默认。

Host 仍为 present + partial、sessionsComplete=false、unmanagedActivityHold=null。partial 只在认证、新鲜、已知人员状态、已测压力低于阈值且显式 within_reserved_budget 时使用 attended 上限。未知 unmanaged 活动继续披露、Hold 保留；不提供无人保证或电源许可。

Portainer ReadyReceipt 仍为 `offlineLeaseEnforcement=unsupported`；Claim/renew 回执仍为 `offlineEnforcement=not_guaranteed`、`guardAcknowledgementId=null`。Runtime Agent 持久执行网络/存储命令，当前没有持久租约截止强停守卫。控制器负责 generation/CAS、claimBy/expiresAt/总寿命检查、到期裁决及查实回收，本轮没有将在线成功改称离线保证。

## 内存判据与兼容

原始 Node `memoryUsedBytes`、`memoryTotalBytes` 原样保留作诊断。新可选字段记录原生可用量、来源及 `memoryPressurePercent = 100 - memoryAvailablePercent`。这是**基于可用量的压力估计**，不是 Linux PSI 或 Activity Monitor 的综合压力。

| OS      | 原生只读来源                                      | 边界                                |
| ------- | ------------------------------------------------- | ----------------------------------- |
| macOS   | 固定 `memory_pressure -Q` 的系统可用百分比        | 不伪造可用字节数                    |
| Linux   | `/proc/meminfo` 的 MemAvailable / MemTotal        | 内核可回收/可用量估计               |
| Windows | 现有 PowerShell 观察脚本中的 GlobalMemoryStatusEx | 只接受有效物理 available/total 返回 |

schema 要求压力与可用百分比合计 100；字节来源还要求 available<=total、百分比与字节比值在 1e-6 容差内一致。缺失、越界、异常或来源失败不退回 raw used ratio。准入和原生电源守卫统一使用新值；阈值、会话及未管理活动约束没有放宽。

新 controller 可解析旧 Host 心跳，但缺少新测量时压力为 null，阻断 observed_host 准入。管理员 DTO 保留旧 `memoryPercent` 供旧 SDK 诊断；新 SDK 读取旧 controller 时把缺失压力字段归为 null。GUI 显示“内存压力估计（100% − 系统报告可用量）”、来源和未知状态，不使用 raw ratio。必须先升级 controller，再部署发送新增字段的 Host；旧严格 controller 会拒绝新字段。读取旧 Host 不等于缺测量时继续准入。

Studio 原生采样 `09:23:10.397Z`：raw used 为 `65507655680/68719476736`（95.33%），原生可用量 77%、压力估计 23%，与独立一次 `memory_pressure -Q` 一致。实际认证心跳/dry-run 随后 raw-used 约 97.03%，压力估计仍为 23%。通过正常 CAS 管理 API 将测试 Machine 的显式内存阈值从 99.8% 改回 90%，取得 fresh/present/partial、bounded_partial_host 和允许 attended 准入；随后真实新票成功 ready/Claim。没有施加宿主高 CPU 或耗尽内存。

macOS 采集、心跳、SDK/dry-run 到真实准入已实测。Linux/Windows 本轮仅有合成 parser/schema 回归，没有新增物理 Linux/Windows 证据，没有操作 Windows 服务或电源。

## 原票跨截止与恢复

开始前只读核验旧票全部 released、活动 claim=0。Engine 仍为 `98531c12-2a3b-4ed6-82c3-08abfb8120a4`，固定 SSH digest 仍为 `sha256:5cf584cab167af0b6a3dc2271809657d4c6368270f356e1a079031493f321a86`；没有重做旧资格/镜像验证。

新票 `2c693f7b-58d4-4033-aa05-6cb378eee252`，唯一新增 Allocation `adcb9d88-abfa-43f1-a6b2-894dc028b602`，generation 1。申请、Claim、Access 的 Prepared 命令在发送前写入保护文件，始终使用原 Ticket 和资源身份。

| 阶段                            | 实际结果                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 严格能力预检                    | requiredCapabilities=offlineLeaseEnforcement 返回 eligibleNodeIds=[]、capabilities_unavailable；未为此创建票或分配 |
| 正常申请                        | 同镜像/Node/网络/存储，500 CPU millis / 512 MiB，60 秒租期，queued→ready                                           |
| Claim                           | `09:23:44.465Z`，确认截止 `09:24:44.255Z`；not_guaranteed/null ACK                                                 |
| SSH/输出                        | 按 API host-key 指纹认证；18 字节输入 hash 正确；写入合成 reliability-result.txt                                   |
| 控制器停止                      | 只停止本栈原生 supervisor，保留 Docker 和 Agent；跨真实截止，未修改时钟                                            |
| 截止后                          | `09:24:45.535Z` 容器仍 running、SSH 仍可认证读取合成输出，证实离线强停不受保证                                     |
| 停机账本                        | `09:25:29Z` 干净关闭后的只读快照仍 ready/active、同一 committed claim，未提前释放                                  |
| 恢复 controller、Agent 保持停止 | 原票 releasing/blocked；容器停止，但网络未查实回收，仍占 500 CPU millis / 512 MiB                                  |
| 恢复同一 Agent                  | 原票因 lease_expired→released/cleanup complete；至 `09:26:13.969Z` 三个对象逐个 inspect 确认 absent，claim=0       |

本轮输出 SHA-256 为 `a1ab7a264fa41e0f90d877a6f451854aff9b2e6e95d4a9b7143181231797b47b`，回收后不变；前轮 `result.json` 的 `d2deb797...75d57` 也未变。访问私钥已删除，合成持久输出保留。

没有发现新的到期/回收合同缺口，因此未增加离线租约平台或伪造 ACK。这些结果仅覆盖上述控制器中断、Agent 不可达、同身份恢复路径，不涵盖宿主断电、VM 崩溃或网络分区的全部组合，不支持 strict offline stop。

## 检查、清理与后续

按工程约定由 Luna/high 限定实现，主智能体独立审读原生来源、schema、准入、电源和 SDK/GUI 连接后实测。有限 review 修正了公开字段兼容及字节/百分比矛盾，反馈已关闭。

本轮受影响测试共 247 项通过：contracts 的 admin/host-observation 9 项、SDK admin 5 项、Runtime Agent host-probes/host-power 119 项、controller human-use/machine-policy/power-domain/power/power-execution/host-agents 六文件 107 项、GUI MachinePanel 7 项。contracts/controller/runtime-agent/GUI 类型检查，以及 contracts/SDK/Runtime Agent/controller/GUI 构建通过；提交前检查最终格式和 Git diff。未重跑旧 50 GUI 或全仓套件。

最终 API：released=2、cleanupBlocked=0、unknownOperations=0、资源占用全 0。controller 正常关闭后再只读核账：两张租客票、两个 tenant Allocation，加上前轮一个 validation Allocation，全部回收；三份 claim 均 released，活动 claim=0。Docker 清单只剩三个管理容器、两个管理数据卷及默认网络，无租客/探针对象。

专属原生进程、三个管理容器及 `hitchlet-studio-acceptance` profile 已停止；既有 default profile 保持 Running。保留专属 VM、镜像、保护配置/账本、原 Prepared/journal 和合成输出。[恢复入口](../scripts/studio-acceptance-resume.mjs) 读取现有保护状态，不自动创建 VM、凭据或票。新算法不延长原资格有效期（至 `2026-11-03T08:30:24.563Z`）。

保护报告为 native-memory-pressure、reliability-lifecycle、reliability-offline-ledger、reliability-management-overview、reliability-timeline、reliability-final-ledger、reliability-retention 的 JSON 文件；分享版只含结果白名单和 SHA，不含秘密、数据库或原始配置。

通用消费者的最小后续是维护一个基于现有 SDK 的可重复示例：保存 Prepared、验证指纹、仅接受 confirmed 续租、保存持久结果后明确归还、中断后查询原票。部署需保持自身 Host/隔离资格新鲜；新 Linux/Windows 采集另取实机证据。严格离线强停须单独确定持久执行端合同与验收，当前消费者须接受 not_guaranteed 或放弃该 Node。媒体/Vesta 业务处理归消费者，不加入 Hitchlet 平台。

原生语义依据：[Apple memory_pressure](https://github.com/apple-oss-distributions/system_cmds/blob/main/memory_pressure/memory_pressure.c)、[Linux MemAvailable](https://www.kernel.org/doc/html/latest/filesystems/proc.html)、[Microsoft GlobalMemoryStatusEx](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-globalmemorystatusex)。本机结论来自上述实际报告，不由文档或模拟替代。
