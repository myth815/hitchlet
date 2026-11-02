# Hitchlet 功能审计与可用性交付建议

2026-11-02。审计基线：`main`，`135128e8a2e8a913991a943d21459ee38701410a`，另保留本次工作区的 7 个 GUI 未提交修改。本文是审计结论与推进建议，不是用户已批准的新规格或实机操作许可。

**建议优先交付“一个常开 Docker 节点承接一个影音计算阶段”的完整使用路径。** 现有资源账本、隔离、发布、租约和回收已有实质实现，值得保留；目前缺的是目标部署组合、媒体工具制品、消费者租约与数据交接，以及可诊断的接入体验。继续扩电源、VM 或零散美化界面，都不能代替这条路径。

本轮只读核对原会话、设计、代码及历史记录，未重跑全套测试、未访问真实部署或媒体。另做了一个纯本地 schema 探针：当前 TicketSummary 接受基线响应，加入一个未来响应字段后拒绝。上轮 48 项 GUI 测试和 Simulator 浏览器闭环是最近的本机证据，不能替代真实 Docker 或影音验收。

## 原始目标与后续收敛

原会话：**梳理 OpenClaw 视频和音乐流程**，thread `01a152e2-6a1e-73f0-b764-8ad4268d2aeb`，host `local`，Claw 项目。已沿正常对话接口读至起点；标题不是最终工程边界。

| 次序 | 用户确认或改向 | 目前应遵循的边界 |
| --- | --- | --- |
| 起点 | 查看现有音乐、视频流程；随后提出固定机器像本地 CVM，按次租用、外存保留、用完归还及节能（turn `01a152ea-f097-7ac3-b054-61ecaad763bc`）。 | 媒体是首个场景；资源生命周期独立于业务成功。 |
| 独立性 | 明确“节点分配管理完全独立、业务无关”（`01a15319-790e-77b3-aa43-c069a0bd6e5b`）。 | Hitchlet 管环境和使用权；消费者管 Job、命令、检查点、结果质量与发布。 |
| 产品模型 | 用户完整描述镜像＋规格＋约束→Ticket→就绪→消费者下车→资源回收，并管理静态设备（`01a1532a-47a6-7a22-b5de-881451345955`）。 | 一票一个隔离主环境；收到归还不等于实际回收完成。 |
| 技术选择 | 改用熟悉的 TypeScript，SQLite 避免独立数据库维护（`01a15344-7ffd-74e0-8572-97f0020c9bef`）。 | 保持模块化单体、单本地账本、共享 contracts 与 SDK；不重选技术栈。 |
| 后端收敛 | 比较过 PVE、ESXi、VMware 后，用户收敛 Portainer＋Hyper-V＋Tart 三类，未来专用机可 Ubuntu 原生 Docker（`01a15377-b775-7953-adf4-75bf8d374cd7`）。 | 早期候选比较不再是当前接入清单。 |
| 首期范围 | 明确 Docker 优先，VM 靠后，因为目前无需求（`01a1537a-7b53-7ea2-b870-9564a6b34abc`）；随后选名 Hitchlet 并建独立仓库。 | Docker 首发无需先完成 VM、受管 Linux VM 底座或云。 |
| 电源扩展 | 曾补入 WOL／插座设想；后单独确认正常关机＋WOL 实现和指定 Windows 实测（`01a1596f-194b-77e3-8c62-b3975e303c69`），本次扩展明确不含插座切电。 | D22a 预演、D22b 原生动作、插座设想不能合并宣称已交付。历史两项守卫许可被拒且未执行，仍不重试。 |
| 当前优先级 | 后续用户明确影音等待资源供给完善，Vesta 将来消费多平台测试资源，Hitchlet 优先推进。 | 先接影音；Vesta 是下一消费者，不能将 Hitchlet 改成 Vesta 子系统。 |

正式设计也允许**常开／手动电源**作为 Docker 部署方式，且明确 VM／云不阻塞 Docker（[设计](design/README.md):861–879）。用户要求“架构优雅”应落实为清晰职责、统一合同和少量可验收工作，不是新增框架或继续拆层。

## 功能审计矩阵

证据标识：**H**＝历史实机验收记录；**S**＝模拟／本机隔离；**C**＝当前代码可定位；**D**＝设计或类型扩展；**U**＝目标部署尚未确认。H 不表示今天仍在线、证据仍有效或新节点已通过。每项影响均针对首批影音，不把未知标成失败。

| 功能与原需求 | 当前入口和实现 | 证据等级与范围 | 冲突、断点及首批影响 |
| --- | --- | --- | --- |
| 消费者 API／SDK／GUI：申请、查询、接用、续租、归还、取消 | [API 路由](../apps/controller/src/app.ts):1339–1550；[SDK](../packages/sdk/src/tickets.ts)；[GUI](../apps/gui/src/App.tsx)。GUI 仅经 SDK，当前已有目录和预检。 | C＋H：[API 手册](api-sdk.md):38–144；[验收](DOCKER-ACCEPTANCE.md):25–31。S：上轮完整浏览器模拟闭环。 | **平台接口存在，影音调用方尚未接入。** GUI 可用性改进不等于消费者程序上线。 |
| 身份／权限：消费者限自己的票，管理角色按范围操作 | [认证](../apps/controller/src/http/auth.ts):77–115；[身份存储](../apps/controller/src/storage/identity-store.ts)；角色、scope、CSRF 与对象范围均存在。 | C＋S；H 记录凭据轮换及旧凭据拒绝。 | **确定冲突**：[设计](design/README.md):158 说停用只阻新申请，旧凭据仍可管理旧票；代码要求 `active`，停用后连归还也认证失败，[API 文档](api-sdk.md):30 又描述此实际行为。首租不必失败，但生产停用／收尾语义须收口，不能只靠管理员兜底。 |
| Ticket 状态机：受理、预留、准备、ready、回收、released 分离 | [tickets](../apps/controller/src/application/tickets.ts)、[operations](../apps/controller/src/application/operations.ts)、[queries](../apps/controller/src/application/queries.ts)。ready 内另用 Lease.claimedAt 区分接用。 | C＋H 真实生命周期；S 上轮看到 queued→ready、claim、renew、released。 | 主体保留。**ready 是技术环境就绪，不代表媒体成功**；released 必须依据查实清理，不因页面关闭或业务成功推导。 |
| 排队／配额／容量：原子预留、不超卖、消费者公平 | [ticket-store](../apps/controller/src/storage/ticket-store.ts):257–323；[reserveNext](../apps/controller/src/application/tickets.ts):392–502。配额／池／Claim 和事务复检存在。 | C＋H：真实保守根池并发、一票 ready 一票排队；测试覆盖层级池与竞态。 | **公平性承诺未实现**：[设计](design/README.md):186 写消费者轮转和多项选点偏好，实际全局 created_at/id FIFO、候选按 Node ID／架构。单消费者可明确接受简化；影音＋Vesta 共用前收口。这不是容量原子性失效。 |
| 镜像／模板：不可变版本、草稿验证、清理后发布、缓存 | [image-validation](../apps/controller/src/application/image-validation.ts)、[publication-store](../apps/controller/src/storage/image-publication-store.ts):47–124、[image-cache](../apps/controller/src/application/image-cache.ts)。发布重检精确报告、修订、期限与清理证据。 | C＋H：固定 Node SSH 制品验证、发布、预热与引用保护；VM 模板仅 D。 | 发布器已有闭环，**无证据支持重写**。目录能力不等于媒体镜像已经制作、验证、发布。 |
| Docker 环境准备／接用：独立身份、限制和真实入口 | [固定配方](../apps/controller/src/domain/docker-recipe.ts):11–23；[Provider](../apps/controller/src/providers/portainer-provider.ts):2073–2090；[配方说明](../docker/node-ssh-v1/README.md)。只接受 Node24、workspace、SSH22 等同一 bootstrap 合同。 | C＋H：独立 SSH 身份、CPU／内存／PID、网络与恢复。 | **首批阻断**：现成媒体镜像与宿主 worker 不能直接租用。可有多个兼容该合同的工具制品，不是只能使用一个 digest；优先复用配方制作媒体租客镜像，别先做通用任意启动框架。 |
| 人工接用连接：GUI 给地址、短期凭据和主机指纹 | [AccessEndpoint](../packages/contracts/src/consumer.ts):581–594 有 hostKeyFingerprint；[GUI 投影](../apps/gui/src/App.tsx):992–1010、复制内容:1183–1187 未保留指纹。 | API／SDK 为 C，H 的真实 SSH 验收与 GUI 是不同层证明。 | **GUI 缺口**：人工使用不能从此页核对 SSH 指纹；应补完整安全连接信息。消费者自动化可使用 API 完整字段；不能据此判 SSH 后端失败。 |
| 租约：有界接用、确认后续期、到期收尾 | [leases](../apps/controller/src/application/leases.ts):214–226；[SDK](../packages/sdk/README.md):23–27。默认 TTL 900 秒、总寿命默认 86400 秒；SDK 不自动续租。 | C＋H 续租／重启；S 上轮续租时间推进。离线按时停止明确不保证。 | **首批阻断在消费者**：媒体可运行数小时，必须在阻塞 SSH 调用之外持续续租、持久保存原请求和最后确认期限。GUI 未呈现 `renewalPending`，虽保留旧确认期限，仍缺明确 pending／拒绝原因投影。 |
| 授权数据：只读输入、持久输出、固定 profile | [tickets](../apps/controller/src/application/tickets.ts):172 起检查模式／子路径；[Runtime storage](../apps/runtime-agent/src/storage.ts):63–110 核对真实来源；[Provider](../apps/controller/src/providers/portainer-provider.ts):134 起把持久来源作为 reference。 | C＋H：特定 local／NFS4.2 只读、输出保留、NAS 丢失不回落空目录。 | **目标路径 U**。当前 SSH 探针只检查 `/workspace` 可写，不逐媒体挂载以租客 UID 验证读取、输出 ACL 和空间。必须按目标 Node／profile／镜像实测；挂载身份正确不等于业务可读写。 |
| 归还：数据收妥后删除临时环境、外存不删 | `release(reclaimable:true)`；[Provider destroy](../apps/controller/src/providers/portainer-provider.ts):1100 起拒绝删除持久引用；GUI 保留双确认。 | C＋H 断联后回收且 NAS 输出保留；S 上轮 released、未释放 Claim=0。 | 主体保留。**消费者须提供真实收妥判断**，平台不验媒体哈希／质量；不要把报告和唯一输出留在要销毁的 workspace。 |
| 异常／重启／断联：原意图恢复、未知占用不释放 | [operations](../apps/controller/src/application/operations.ts):243 起恢复先于调度；[原请求恢复](api-sdk.md):140 起；固定 generation／epoch／ownership。 | C＋H：[验收补充](DOCKER-ACCEPTANCE.md):54–70；S 最近控制器重启恢复原模拟票。 | 保留这些必要保护。**媒体 attempt↔Ticket 关联和业务幂等未交付**；资源恢复不替代重算、续传和正式入库恢复。 |
| 节点健康／能力：真实 Engine、准入、期限和修订 | [admin 观测](../apps/controller/src/application/admin.ts):131–198；[人机准入](../apps/controller/src/domain/human-use.ts):217–227；报告到期不会由心跳自动续期。 | C＋H 特定 Linux arm64＋Colima／Portainer 组合。 | **首批部署 U**：旧验收结束时已停临时服务；无目标节点现行可用证据。能力默认1小时，可显式有界延长；须有重新取证责任，不能靠续心跳伪造长期认证。 |
| 人机共用：保留人的容量，未知不当无人 | [human-use](../apps/controller/src/domain/human-use.ts):125–246；Host observer／认证心跳；有人预算、压力与30秒 Host 新鲜度限制。 | C＋H：Mac partial＋有界 attended 预算；Windows 部分保护另有 H。 | 必须保留。首批可选专用常开节点；若仍用共享 Windows／Mac，必须按其真实观测与预算验收，不能为接入把 unknown 改 absent。 |
| 可观测：解释为何排队、准备、仍占用或不能关机 | [candidateEligible](../apps/controller/src/application/tickets.ts):666–784 返回 boolean；[store](../apps/controller/src/storage/ticket-store.ts):318 统一写通用原因；[查询](../apps/controller/src/application/queries.ts):153–160。 | C：matchingNodeCount 固定0、nextCheckAt=null；已有管理视图但消费者缺排除明细。 | **首发可运维门槛**：API 无法区分 Host／容量／配方／存储／报告期限；GUI 无法凭空补原因。应复用同一资格裁决输出有界 reason code，不另做一套前端判定。 |
| GUI 状态与操作：加载、空态、旧快照和权限 | 当前 7 个未提交 GUI 文件已压缩宣传区、分离工作区／管理、呈现下一步、期限与断线禁写。管理票据有完整过滤和时间线。 | S：48 项 GUI 测试、实际浏览器模拟闭环、390px、断线恢复；无本轮真实登录／资源证明。 | 继续保留。消费者列表 DTO 本来不含到期／放置摘要，列表只能开详情；完整原因、指纹、pending 等仍需合同和投影收口，不能宣称已完成整个设计 GUI。 |
| 部署／维护：独立安装、持久账本、备份恢复 | [runbook](runbook.md)、[维护](../apps/controller/src/application/maintenance.ts)、Runtime／Host 说明；独立密钥、暂停准入、低磁盘、保留和轮换已有实现。 | C＋H：干净安装、非root Dockerfile、隔离恢复；小库44秒不是生产RTO。 | **交付 U**：尚无已确认常驻服务／监控／备份责任人的目标部署。注册不自动等于准入；预挂载、内核模块、Runtime 配对、Host 观测均有前置。不能把一次私有验收脚本当日常运维产品。 |
| Docker 与后置后端：同一资源合同，不强求所有OS可互换 | [设计](design/README.md):419–498、861–867；实际 Provider 只有 Portainer 与 Simulator。 | Docker 为 C＋H；Hyper-V／Tart／受管 Linux VM 底座为 D；云自动购买／计费未做。 | 后置不是 Docker 缺陷。首批不要求实现；Vesta Windows／macOS 原生测试必须以后独立后端／模板／硬件验收，不能用 Linux Docker 代替。 |
| 电源：人的保护下正常关机／WOL，插座另论 | [预演合同](design/README.md):541–586；[原生配置](POWER-NATIVE.md):3–11；[execution](../apps/controller/src/application/power-execution.ts):88–149；默认无机器许可、自动关闭。 | D22a C＋S；D22b C＋部分 H（失联／崩溃／登录取消）；完整产品WOL→新boot资格 U。插座执行未做。 | **不阻常开首发**。保留但退出当前关键路径；不删除防护、不自动启用、不重试历史被拒守卫扩展。 |
| 跨仓 SDK 交付／版本兼容 | [SDK package](../packages/sdk/package.json):2–18 为 private、workspace contracts；[schema](../packages/contracts/src/schemas.ts):263–303 strict；[SDK read](../packages/sdk/src/tickets.ts):60 直接解析。 | C＋本轮纯本地探针：新增未来响应字段后拒绝。未发现 git release tags。 | **确定声明冲突**：[设计](design/README.md):972 称新增可选字段兼容。需固定 SDK／contracts／服务端成套版本及兼容策略、给出跨仓可安装制品；可以 tarball／固定源码版本，不必现在发布 npm。严格写入校验不应因此放松。 |

## 影音消费者的实际接入断点

这些是现有代码事实，不是新增业务需求：

- 音乐 [music_worker.py](../../DockerComposeGitea/WorkNas/openclaw/worker/music-worker/music_worker.py):25–42、419–447 在宿主调用 Docker，工具容器只读源、可写 staging/jobs、无网络；视频 [video_worker.py](../../DockerComposeGitea/WorkNas/openclaw/worker/video-worker/video_worker.py):738–768 同样依赖宿主 Docker。现有 skill 经 OpenClaw 固定 Node 的 system.run 调用宿主入口，定向检索未发现 Ticket／HitchletClient 接入。**缺的是消费者适配，不能把“节点已部署旧worker”当作租客镜像已适配。**
- [通用配方 Dockerfile](../docker/node-ssh-v1/Dockerfile):1–16 只有 Node24、SSH、CA 和 workspace 用户。现成 [MediaToolbox 构建输入](../../DockerComposeGitea/HomeNas/MediaToolbox/Dockerfile):35–60 可复用 FFmpeg／FLAC／Python 等工具；应让工具直接在兼容 bootstrap 的租客镜像内执行，而不是给租客宿主 Docker socket。
- 现有音乐 Stage 最长等待14400秒、回传14400秒；视频 MakeMKV remux 等待可达43200秒。它们是代码超时，不是测出的推荐租期。消费者必须另有持久租约监督，不能由一次 SSH 阻塞调用或聊天回合维持生命期。CPU／内存和大临时盘预算须实测，历史500m／512MiB验收不能外推。
- 音乐 [push_stage](../../DockerComposeGitea/WorkNas/openclaw/worker/music-worker/music_worker.py):604–654 会校验隔离区回执为 `quarantined`；视频也分离源与回传。迁移要明确“只读源→临时缓存／工具→独立持久隔离输出”的路径及报告归宿，保留质量、哈希和正式发布门禁。源与正式库不能为了试租变成通用可写根。
- [新节点恢复记录](../../DockerComposeGitea/WorkNas/openclaw/worker/music-worker/NEW-WINDOWS-NODE-RESTORE-20261017.md):12–18 记录过 rootless 容器 UID 与宿主0700目录不匹配。Hitchlet 的 workspace 身份、目标节点 UID/GID／ACL 和外存 profile 必须组合验证，不从旧宿主成功推导新租客能写。
- 视频 [ISO 提取](../../DockerComposeGitea/WorkNas/openclaw/worker/video-worker/video_worker.py):463–508 需要 loop、SYS_ADMIN 和额外安全配置，超出当前租客配方。**这仅阻断 ISO 路径，不是所有影音都必须特权。** 建议首批选一条 FLAC／普通文件或不需 ISO 提取的已有阶段；具体样例与质量标准仍由消费者确定。
- 现有业务已有“旧 attempt／缓存／报告不盲重跑”的保护（music_worker:318–319、403–404；movie_inspect_disc_once:188–238）。迁移需持久关联业务 attempt、Ticket、原请求和输出证据，分别处理资源恢复、业务重算、回传续接。

资源供给完善不会自动解除所有影音停滞。原会话起点就有音乐质量／模型分片阻塞和视频版本选择／特定批次限制；[Portable 恢复记录](../../DockerComposeGitea/WorkNas/openclaw/worker/video-worker/PORTABLE-NODE-RESTORE.md):93–104 还明确一次成功盘检 `stage_performed=false`。身份确认、曲序／轨道选择、模型判断、正式 Commit 与播放器验收仍属于消费者。不能说影音从未跑过，也不能说历史媒体盘检等于 Hitchlet 影音闭环已通过。

## 为什么工程显得乱，以及应保留什么

1. **完成口径多于一个。** M2 的范围是一个已验证 Docker 组合，不是原始跨后端、节能和业务接入愿景全部完成；上层“M2完成／606测试”容易遮住未交付的用户路径。以后首页只列当前交付组合、可做／不可做、最后证据与缺口，不再用单一百分比代表可用性。
2. **历史设计和现行合同有真实漂移。** 停用语义、公平调度、响应兼容，以及设计开头“实际电源保留设计”与后面D22b代码交付并存，都需收口。`docs/IMPLEMENTATION.md`保留历史，不应篡改旧阶段结果；当前运行 DTO 仍以 packages/contracts、数据库升级以 migrations 为权威，设计类型／DDL不能作为另一套实现真源。
3. **多种状态本身有必要，缺的是面向使用者的映射。** Ticket、Lease、Operation、cleanup、Node健康与能力报告各自回答不同问题，不能合成一个“成功”。应按同一票据串起“准备到哪里／最后确认到期／为什么阻塞／谁可以处理”；不用平行状态库或前端猜测替代。
4. **电源分支细，核心用户交付薄。** 预演、原生许可、Host observer、Runtime Agent 和资格记录分工有依据，但首批常开Docker不应先经过完整电源资格。精简的是交付关键路径和默认界面，不是移除身份隔离、授权、租约、归还确认、未知资源占用或人类保护。
5. **历史验收有价值，但缺相同消费者连续使用的证明。** 通用SSH、网络、恢复、NAS分别通过不等于媒体工具、UID、数据回传和数小时续租已经一起通过。旧媒体README还存在0.4.1与代码0.4.2等版本漂移，旧／新节点恢复记录也不能拼成一个“当前节点”。以后每次放行固定 Engine／架构／digest／profile／消费者版本和证据边界。

建议保留：单控制器＋SQLite、现有 contracts／SDK、固定可验证的SSH bootstrap、原子Claim与版本栅栏、发布前验证并清理、固定网络／存储授权、持久来源不删除、恢复先于新调度、人机预算。建议整合：设计冲突、排队解释、访问材料／续租投影、部署接入清单和版本交付。建议后置：VM／云／受管底座、ISO特权产品、智能插座、未通过的自动电源；多消费者公平调度在第二消费者正式共用前完成。

## 推荐的最小可用交付定义

**一个指定架构的常开 Linux Docker Engine／Node，一个已验证发布的兼容媒体工具镜像，一个独立消费者身份，一条明确只读输入与隔离持久输出的数据路径，一次实际媒体计算阶段从领票到查实归还的完整记录。** 不要求先跑完整音乐／电影入库流水线，也不要求先完成所有OS。

放行同时满足：

- 消费者能从授权目录选版本、预检并领票；排队有真实原因及处理归属，不出现只会等待的黑盒。
- 环境有独立身份和可核验SSH主机指纹；消费者实际能读指定输入、写自己的输出，权限与资源合同正确。
- 所选阶段运行期间持续续租，重启消费者仍恢复同一Ticket／原意图；pending不冒充延期，失败不静默另开一票。
- 报告及结果在租客外持久保存并由消费者验收；归还后环境、网络、临时卷和凭据查实撤销，Claim归零，源与持久输出保留。
- 明确当前scratch为best_effort、失联到期停止不保证、常开手动供电；指定运维责任人能处理证据过期、低磁盘、挂载丢失及回收阻塞。

## 一条按依赖推进的施工顺序

以下是建议的四个短阶段，不是并行铺开的新框架。每阶段取得可观察结果后再进入依赖阶段。

| 阶段 | 工作与必须收口的事项 | 可观察验收与执行边界 |
| --- | --- | --- |
| 1 合同与诊断收口 | 按原设计区分“阻新申请”与“紧急吊销”，对齐代码／文档；复用资格裁决生成有界排除原因；消除固定0匹配数；补指纹、pending续租和已确认期限投影；固定服务端／SDK版本与响应扩展策略。单消费者阶段明确全局FIFO事实。 | **本机隔离可完成**：临时SQLite/API/SDK/GUI反例覆盖停用后的旧票收尾、不同排队原因、未知写恢复、旧SDK响应兼容、完整连接字段。只跑受影响检查；先不重做调度框架。 |
| 2 一个影音阶段的离线垂直路径 | 与消费者选一条无需ISO特权的阶段；复用媒体工具，形成兼容bootstrap的制品配方；在消费者侧实现外部续租、持久原请求／attempt映射、输出收妥与归还。选定一种数据交接方式，避免同时维护两套全新通道。 | **本机隔离可完成**：Simulator驱动状态与故障、合成文件／已有工具做业务入口验证；消费者进程重启不重复申请，模拟输出与归还语义可审计。实际镜像构建和目标架构工具可运行性需选定构建环境后验证，Simulator不证明它们。 |
| 3 指定真实组合的合成fixture验收 | 部署／恢复常驻控制器、Runtime与必要Host观测；完成精确Engine／网络／存储／制品取证发布；用合成fixture核读写、ACL、资源、接用、续租、断联／重启恢复与回收。 | **需具体真实资源授权**，见下表。仅隔离样例目录和自有资源；输入只读、输出保留、Claim归零。先证明目标组合，不动真实媒体，不迁移共享服务，不开启电源。 |
| 4 一个真实媒体新作业，再日常接入 | 经单独授权选一个全新安全业务attempt，覆盖实际耗时、输入／缓存／输出空间、质量与回传证据；成功或失败均按合同收尾。再纳入既有影音调度，明确支持范围与运维手册。 | **真实媒体需另行授权**。用户能看到完整job↔Ticket证据与留存输出；业务质量通过才由消费者决定下一步。正式入库／播放器发布不是这轮资源验收的隐含动作。 |

阶段1的权限合同与诊断是平台工作；阶段2的业务入口与续租监督是消费者工作；工具镜像由媒体维护者提供构建输入，Hitchlet维护者审核通用启动与租用合同。阶段3由平台／节点运维负责；阶段4由双方联合验收。不要让所有问题都归入Hitchlet核心。

### 真实阶段需要的具体授权

| 对象 | 需明确的选择与许可 |
| --- | --- |
| 运行位置 | 哪个Portainer environment／Engine原生身份、Machine／Node、OS／架构；是否专用或共享、常开策略、允许的CPU／内存／临时盘预算。不能用默认Docker上下文或历史地址猜。 |
| 管理组件 | 控制器部署位置／持久卷／HTTPS、Runtime网络执行组件及必要Host observer的安装与权限、守护和重启范围；专用Consumer的授权和凭据交付方式。不读取现有业务管理token来代替许可。 |
| 制品 | 构建与获取镜像的环境／仓库、精确digest和架构、兼容bootstrap、允许验证／创建／停止／销毁的自有测试实例及缓存范围。 |
| 存储 | 合成fixture或单个真实job的只读输入前缀、每attempt独立的可写隔离输出、目标挂载／UID权限、缓存与空间上限；归还只删除自有临时资源，保留源与输出。不能默认授权正式媒体库写入。 |
| 网络和租期 | 消费者SSH来源、必需数据目的地址／协议／端口、管理面禁止范围；TTL、总寿命、并发及中断后停止业务／恢复／人工处理规则。 |
| 真实媒体 | 明确一个新job／阶段、只读源范围、可写隔离目标与回传动作；下载、移动旧文件、正式Commit／播放器发布、NAS扫描不自动包含。 |

不需要为推进这条路线顺带授权WOL／关机、服务白名单、插座切电、VM、云购买或模型调用。历史被拒的守卫扩展仍未执行，不进入上述阶段。

## Vesta 后续如何消费

Vesta通过同一HTTP API或固定版本SDK申请镜像、资源、OS／架构、存储与网络约束；由Vesta保存测试Job、源码、日志、断言和报告，管理续租及归还。Hitchlet只把 `clientRef` 作为不透明关联值，不导入Vesta任务模型。

第一条影音路径稳定后，再让Vesta做第二消费者的Linux容器试用，验收配额隔离、公平性、凭据范围和跨仓SDK升级。若需求明确涉及Windows或macOS原生测试，才按原设计启动Hyper-V／Tart及对应模板／硬件验证；Linux Docker成功不代表其他OS、多架构或GPU支持。增加消费者不应先要求改平台数据库或增加业务表。

## 本轮执行与保留状态

仅新增本审计文档；7个既有GUI修改保留，不reset／stash／commit／push，不改DF或其他仓库。没有真实Portainer／NAS／媒体／模型／账户登录／电源操作，没有重试既往被拒动作。当前部署是否在线、目标媒体组合是否可用均保持未确认；这不影响本机合同与消费者适配工作先行。
