# Hitchlet 实施与验收记录

实现基线：[设计 v1.3](design/README.md)。当前目标保持 M2（Docker 正式交付）；Hyper-V、Tart 和云扩容不在本轮实现范围。模拟器通过不代表真实 Docker 或宿主通过。

本轮状态：批次1–6 已通过主审与独立复验，M0 和 M1 Docker 实验/试用闭环完成，D22a公共电源预演已放行。批次5的共享 tenant/validation 持久执行、验证回收及发布，以及 D20、D21、D22a、D23 分别按用户单独限定使用 GPT-6.1 Sol，其余实现遵循 Luna 策略。正式交付 M2 已完成，本轮范围进度100%；D23–D25均通过独立检查与真实环境验收。承诺仅覆盖已实测的部署组合，逐节点矩阵见[Docker交付验收](DOCKER-ACCEPTANCE.md)。真实电源逐机启用和VM保持后置。

## 工作方式与固定批次

开发按用户2026-10-20更新规则：后续固定模块先由 GPT-6 Luna/high、正常速度承担；明确不能胜任后可切换 GPT-6.1 Sol，无需再次逐模块请求授权。主智能体检查差异、接口一致性并实际验证，再允许进入依赖批次；不缩减范围，不继续委派，不增加无限细分的任务树。此前low/high与逐模块授权过程作为历史记录保留。

| 批次              | 设计任务             | 确定产物                                                            | 审核门槛                                                                  | 当前状态           |
| ----------------- | -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------ |
| 1 基础工程        | D00                  | pnpm 工程、API/GUI 启动、配置、日志、构建测试、Docker 部署骨架      | 安装、类型检查、测试和构建实际通过；缺失配置有明确错误                    | 已审核通过         |
| 2 领域与账本      | D01–D03              | 运行时合同、SQLite 迁移/worker、状态机、配额与原子资源预留          | 合同一致；并发末份容量不超售；冻结请求、事务与版本约束通过                | 已审核通过         |
| 3 模拟闭环        | D04–D05              | 持久操作与恢复、Simulator、租约 API/SDK、基础 GUI                   | 重启恢复、创建回执丢失、删除失败、续租竞态、归属鉴权与浏览器闭环；完成 M0 | 已审核通过（M0）   |
| 4 Docker 接入准备 | D10、D11a            | Portainer 身份与修订、节点能力、草稿镜像目录和验证调度              | 错误 Engine 拒绝；草稿不能被消费者租用；固定制品和授权修订                | 已审核通过         |
| 5 Docker 租用闭环 | D10b、D12、D11b、D13 | 最小 Runtime Agent 网络执行、独立容器生命周期、验证后发布、恢复回收 | 实际 Docker 网络/限额/存储隔离与失败清理通过；完成 M1                     | 已审核通过（M1）   |
| 6 宿主与节能策略  | D20–D22a             | Host 观测、人机共用、依赖与保留量、电源 dry-run                     | 未知或有人登录阻止关机；竞态处理；未实测能力不启用                        | 已审核通过         |
| 7 运维与交付界面  | D23–D24              | 备份恢复、升级、凭据轮换、完整 GUI/SDK 与接入手册                   | 真实恢复演练、权限/存储回归、浏览器 E2E 与干净环境安装                    | D23、D24已审核通过 |
| 8 正式验收        | D25；D22b 逐机可选   | 实际节点能力矩阵与发布证据                                          | 对照设计 Docker DoD 逐项取证；未验证机器保持试用/禁用或手动电源           | 已审核通过（M2）   |

每批可分配少量具有明确文件边界的工作，例如领域与存储、HTTP 与 SDK、GUI；不把这些实现分工演变成新的层级计划。依赖未通过审核不跨批开发。故障修复在原批次内完成。

## 验收记录要求

每批记录代码版本或差异范围、实际执行命令、结果与限制。测试只声明其覆盖的范围：mock/Simulator 不证明 Portainer、iptables、挂载、人的会话或真实电源能力。实际节点连接、可用实验环境和镜像制品在 Docker 批次开始前核实；尚未取得的外部证据列为未完成，不把它们从完成条件中删除。

## 批次 1

- 当前基线：`3244aa0`，仅有设计包，没有运行实现。
- 设计包已有检查：TypeScript 严格类型检查；SQLite 86 项约束/示例事务检查。它们不是实现验收。
- 开发执行：GPT-6 Luna / low；2026-10-19 经主智能体审查通过。

独立复验使用不含 node_modules、dist 和 .git 的临时副本，运行时 Node 24.22.0、pnpm 10.28.2：

| 检查                                     | 实际结果                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`         | 从干净副本安装成功，锁文件无漂移                                                                                           |
| `pnpm test`，在 typecheck/build 之前执行 | 12 项通过：contracts 2、controller 5、SDK 3、GUI 2                                                                         |
| `pnpm typecheck`                         | 全工作区严格类型检查通过                                                                                                   |
| `pnpm format:check`                      | 通过                                                                                                                       |
| `pnpm build`                             | 通过，包含 GUI 生产静态产物和共享包 JavaScript 导出                                                                        |
| `pnpm dev`                               | 子智能体实测 API 和 GUI 启动，正常退出                                                                                     |
| Docker 构建与 Compose                    | 子智能体完成构建和实际启动；主智能体独立确认镜像运行时为 Node 24.22.0                                                      |
| 隔离运行镜像，不开放端口                 | 主智能体验证健康 JSON、GUI HTML 与 JavaScript 资源、SPA 回退、API JSON 404、非 root 与数据目录可写；正常停止并清理测试容器 |
| `pnpm audit --prod`                      | 最终生产依赖未发现已知漏洞；构建工具不随控制器运行镜像发布                                                                 |

审查修复包括系统环境变量误报、静态回退方法、GUI 重复请求、SDK 响应校验、共享协议归属、标准构建目录与干净启动顺序。当前没有数据库、Ticket 或后端租用功能；12 项测试不证明 M0/M1/M2。设计包的 86 项 SQL 检查仍独立保留。

## 批次 2

基线提交：`27005aa`（第一批，已同步公开仓库）。D01 公开合同与 D02 存储基础由两名 Luna / low 在明确文件边界内开发，现已通过主审；D03 调度和状态机接续实现，整批仍在开发中。

D01/D02 基础的主审进展（2026-10-19）：

- 公开 DTO 已迁至 contracts；common/consumer 的声明 AST 与基线相同，公开白名单保留原 68 项并明确增加管理撤销请求 `RevokeRequest`。授权/配额归一化在 controller 纯领域层，不随公共协议包导出。
- 主审复现并修复严格 schema 交集拒绝合法续租响应的问题，增加 Ticket、四种续租状态和四种访问认证的正向与负向样例。含盘符和 NUL 的子路径已拒绝。
- Node 24.22.0 下全工作区类型、格式、27 项实现测试以及原设计的类型示例和 86 项 SQL 检查通过。SQLite worker 独立 7 项检查通过；实际内嵌版本为 3.53.4。
- 主审另验证 BLOB、CTE 批读取、并发关闭、关闭后拒绝新请求、含空格目录和迁移记录权威性。
- 首次原生驱动镜像构建未通过；Debian 源在当前构建网络不可达，已改为官方完整 Node 构建阶段和 slim 运行阶段，并补齐 SDK 构建前置步骤，最终镜像构建成功。
- 主智能体在最终镜像中独立确认非 root、SQLite 3.53.4、41 张表、关闭重开后大整数事件 ID 精确保留，以及健康 API、GUI 与 JavaScript 资源、API JSON 404；测试容器已正常停止并清理。D01/D02 基础门槛放行。

上述结果只覆盖合同与存储基础，未完成调度、HTTP 幂等/错误中间件、路由 OpenAPI、模拟器及租用服务；这些仍需在 D03–D05 实现并关闭对应设计任务。

D01/D02 基础已提交为 `a363d8e` 并同步公开仓库。D03 的首个 Luna / low 子智能体报告无法完整实现并发预留与持久边界，已停止；保持原范围，以 Luna / medium 重试一次后仍报告无法完整实现与验证。本次按用户“Luna 不能胜任就停止汇报”的要求停止，没有继续拆分、换模型或由主智能体接手实现。

2026-10-19 用户授权“适当增加预算并继续”：保持原批次和 D03 完整范围，改用 Luna / high 实际实现与测试，不进一步细拆，不换模型。D03 经主审修正与独立复验，批次2门槛现已通过。

2026-10-19 用户补充电源条件：当前机器均支持 WOL，并有小米插座 3 与通电自启作故障兜底。已只读核对项目历史记录及现有控制工具；通用设计补入第13.1节、内部 PowerPolicy/SmartPlugBinding 与 D22a/D22b。保持原8批和 Docker 优先，不在 D03 实现或实际执行电源动作；历史设备标识和凭据不进入公开仓库。

D03 当前差异覆盖纯 Ticket/租期/容量规则、持久目录解析与 AcceptedAcquireRequest 冻结、消费者范围幂等、节点/制品/已验证能力筛选、SQLite 原子预留与版本/配额/池预算重检，以及一次性 provision contract 绑定和取消竞态。SQLite 适配集中于 controller 的 `SQLiteTicketStore`；应用层负责校验、冻结、筛选与编排。`local_only` 受理和预留均排除 cloud 来源机器；Node 的 `supportedAccess` 与 Artifact recipe 的 `accessProtocols` 都必须匹配请求。CPU、内存、网络执行要求 verified；要求临时盘硬限制时 `scratchHardLimit` 也必须 verified；GPU/加速器未支持时明确拒绝。子池仅在基础 infrastructure Allocation 仍运行且已提交父 Claim 覆盖子池总预算时可预留。离线候选仅在持久 PowerPolicy、能力、最新观测及匹配的停机操作/回执/安全唤醒证据满足条件时可预留；D03 不执行唤醒或 Provider 操作。

Node 24.22.0 / pnpm 10.28.2 最终检查：`pnpm typecheck` 通过；`pnpm test` 通过（contracts 8、controller 44、SDK 3、GUI 2，共 57）；`pnpm build` 通过并复制当时的初始 `docs/design/schema.sql`；`pnpm format:check` 与 `git diff --check` 通过。D05 后运行 migration 权威改为 `apps/controller/src/storage/migrations/`，`docs/design/schema.sql` 是当前完整 schema 快照。Controller 测试使用真实迁移 SQLite worker 与固定时钟，覆盖末份容量/并发幂等/两类消费者配额竞态、draining 排队、verified 硬能力与过期时间、加速器拒绝、local/cloud 边界、连接协议交集、root-child 预算和已停止父分配、reserve 事务回滚、unknown/quarantined claim、离线有证据预留后健康上线绑定、取消/换绑与版本 fencing。以上是 D03 实现测试，不证明 HTTP/鉴权/OpenAPI、Simulator、Provider/VM 或真实机器电源能力；M0/M1/M2 仍未完成。

主审独立复现最初5项反向验收失败，退回同一 Luna / high 修正；同时关闭本地范围、连接协议和父分配有效性缺口。最终由主智能体独立执行上述全部门禁，57项通过，原设计类型示例和86项SQL检查亦通过。D03放行的是尚未暴露HTTP的应用/账本模块；后续 D04 将预留与持久执行意图原子关联，并在调用执行端前写入意图。D04主审证据见下。

## 批次 3：D04 实现证据（已审核）

D04 仅覆盖持久执行、恢复、清理和显式 Simulator；未进入 D05。预留事务一并写入 provision Operation intent；固定首次终止原因、撤销待决续租并增加 controlVersion，同事务写 cleanup intent。应用编排与 SQLiteOperationStore 分开；执行端口携带固定 artifact、资源及完整冻结网络/storage 授权语义。Simulator 的资源文件和逐操作 journal 位于控制账本以外的独立目录；每项外部对象写入后立即记录 SQLite receipt。启动时先增加 controller epoch、对账与恢复，再开启定时扫描。超时及 worker lease 过期后先 inspect，不作为外部动作已结束的证明。

Node 24.22.0 / pnpm 10.28.2 最终复验：`pnpm typecheck`、`pnpm test`（contracts 8、SDK 3、controller 62、GUI 2，共 75）、`pnpm build`、`pnpm format:check` 通过；原设计 TypeScript contracts/examples 检查与 `node docs/design/verify-schema.cjs` 通过（86 项，41 张表）。实现未新增 schema 表或迁移；运行测试使用真实 SQLite worker、固定时钟并重建 controller/Simulator。

Controller D04 测试覆盖 queued→reserved→provisioning→ready→终止清理、创建回执丢失及逐对象 receipt 丢失恢复、部分创建伴生资源逐项回收、删除失败保留容量并续接、错误 runtime identity/不完整 inventory 保持 unknown、取消或 deadline 边界下迟到创建/ready 不复活、worker lease 过期与旧 CAS、最终清理 DB 事务失败、两票隔离及 NAS reference 仅解绑。显式 Simulator 测试验证 `portainer` 和缺省 `unconfigured` Node 均不被模拟执行，要求硬 scratch 时完整 `ResourceContract` 传入执行端并校验实际 `EffectiveResources`；耗尽 cleanup 后低频 inspect 保留 Claim，带原因的内部 retry 可恢复。另以显式 Simulator 配置运行 `pnpm dev`：实际修改源码触发编译并重启 controller，loopback `/healthz` 两次返回 200；Ctrl-C 后重新打开同一 SQLite 数据目录成功（controller epoch=3），证明锁已释放。该 smoke 不证明 API 租用端点。

D04已通过主审。主智能体独立复现模拟模式隔离、完整资源合同和重试耗尽后的查实缺口，退回同一Luna修正后复验通过；真实挂起旧create、取消与清理后再放行旧调用的用例，同时核对SQLite与外部目录，无迟到重建。最终独立运行75项测试、类型/构建/格式/设计检查，并实测编译后watch重启、health 200、SIGINT exit=0及同库重开（epoch=2）；测试源码注释已恢复。本批不实现严格离线租约执行、续租/API、HTTP/auth、真实 Provider、Docker/iptables、NAS 实际挂载、VM/Host 或电源控制；Simulator 的离线租约守卫明确为 unsupported。D05未完成，M0/M1/M2仍未完成。

## 批次 3：D05 API、SDK 与 GUI（已审核，M0）

开发由 Luna / high 在既定 API、SDK、GUI 边界内完成，主智能体审核、故障注入与独立复验后放行。保持模块化单体和 GUI → SDK → contracts 的依赖；HTTP 不写 SQL，应用编排与持久投影、身份、续租和幂等存储分开。未增加真实 Provider、VM 或宿主电源执行。

交付包括 Ticket acquire/list/get、renew/getRenewal、release/cancel/revoke、access、授权镜像查询、owner-filtered JSON events/SSE、ETag、共享 schema 驱动 OpenAPI，以及 cookie session 登录/恢复/退出。operator 撤销先按 image/node 授权核对，再读取跨 owner 票据或重放，留下原因审计；不存在与越权均为404。预期请求错误、版本与配额冲突使用共享错误信封；非法 JSON 为400，语义输入为422，内部持久合同损坏仍为500。

终止命令在同一事务提交 Ticket、清理意图、事件、审计和幂等完成标记；提交后丢响应可按原键恢复，不把任意终止态当作本请求成功。相同键并发续租返回同一持久提案；不同键竞争 pending 提案为409。confirmed receipt 不随后续终止改写。deadline 等值拒绝，到期终止保留 Claim，查实清理后才释放容量；Simulator 不伪造离线守卫 ACK。

初始化命令显式创建空 Simulator 安装，拒绝重置已有账本，分别一次性显示 sample consumer 与初始 admin bearer。服务恢复账本后开启调度、续租裁决、到期与清理。只有绑定当前 installation 且身份和连接均确认为 Simulator 的 fixture 才刷新模拟观测及能力有效期，跨120秒/1小时仍可继续试用；真实或未配置 Node 不被刷新。默认执行模式 disabled。运行步骤和本地 GUI 静态目录见 [M0 手册](runbook.md)。

SQLite 迁移001保留已公开 D04 的原始字节；新增迁移002，以明确外键把 GUI session 关联来源 credential。升级保留 Consumer、Ticket、Event 和迁移账本，旧来源为空的 session 失效。运行迁移权威位于 controller/src/storage/migrations；设计 schema.sql 是当前 v2 完整快照。会话为 HttpOnly/SameSite cookie，写入要求 CSRF；来源 bearer 吊销/过期或 Consumer 停用也使会话失效。SSE 会重新验证身份，logout 与服务关闭均能终止流。

中文响应式 GUI 实现授权镜像、Ticket 列表/详情/分页、显式申请/接用/续租/领取访问材料/取消/确认归还，以及原请求恢复。打开详情与轮询不会自动接用或延期；退出也不归还票据。写入前由 SDK onPrepared 保存原命令；每个 consumer 在当前 tab 的 sessionStorage 保留最多8个未决命令，满额拒绝新发送，不驱逐旧记录；SDK 共享 schema 验证后原键原体恢复。token 不保存；访问材料仅在内存短暂显示，退出、详情变化或终止时清除。Simulator 和离线租约不受支持均明确显示。

最终独立复验（2026-10-20，Node 24.22.0 / pnpm 10.28.2）：

| 检查                                     | 结果与边界                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全工作区严格类型、构建、格式与 diff 检查 | 通过                                                                                                                                                                                                                                                                |
| 实现测试                                 | contracts 8、SDK 19、controller 80、GUI 8，共115项通过；controller 使用真实 SQLite worker，GUI DOM 测试通过 SDK 注入 HTTP                                                                                                                                           |
| 原设计检查                               | TypeScript 接口/示例通过；SQLite 86项/41张表通过                                                                                                                                                                                                                    |
| 迁移与身份                               | v1→v2 保留旧数据及大于2^53 Event ID；旧 session 失效；owner、operator scope、CSRF、credential 吊销、viewer scopes、登录限速通过                                                                                                                                     |
| HTTP 与持久故障                          | 静态 GUI 启用时401/400/422/500均为共享信封；相同键异体409；终止提交后丢响应恢复；相同键并发续租；期限、权限和损坏合同通过                                                                                                                                           |
| 实际进程与 SDK                           | 初始化/拒绝重置、HTTP申请→ready、renew 202后控制器重启、原提案恢复与回执不变、模拟访问、释放查实及同库重开全部通过                                                                                                                                                  |
| 实际浏览器                               | cookie登录与刷新、申请→ready、手动claim/renew、模拟access、双确认归还→released、退出不归还通过；暂停临时控制器、发送申请后离开页面，再恢复原键仅有1张Ticket；390px实际iframe中的列表/详情布局通过                                                                   |
| Linux打包                                | 使用本地缓存的同版本官方 Node bookworm 完整基础镜像构建并运行，非root、Node24.22、SQLite3.53.4、两版迁移、GUI/JS资源、401信封、Simulator ready→released及正常退出通过；容器无外部网络、无宿主数据挂载                                                               |
| 标准slim镜像构建                         | 初次因 Docker Hub 元数据 HEAD 超时未进入编译；随后在独立 Colima 实验环境，以已提交的 `a8cff28` 源码和原始 Dockerfile 构建成功。标准 slim 镜像中独立复验非 root、Node24.22、SQLite3.53.4、两版迁移、GUI资源、错误信封、Simulator ready→released 和正常退出，全部通过 |

主审实际浏览器暴露并关闭了默认 window.fetch 接收者绑定、静态插件提前编译造成错误处理中间件失效，以及 Simulator 观测过期的运行缺口。GUI 访问材料在终止后清除、等待与账号切换取消、恢复记录满额不驱逐也已回归。临时浏览器、服务、容器、测试目录和测试凭据均已清理，个人机器标识和真实秘密未进入仓库。

M0 放行仅代表可恢复模拟租用闭环。M1、M2 仍需 Portainer、真实网络隔离/限额/挂载、Host 观测和正式验收证据；既有 WSL 业务未迁移。电源补充仍留在 D22a/D22b，当前未发送 WOL、关机或插座控制命令。批次4按原计划接续 D10 和 D11a，不提前开发 VM。

## 批次 4：首次主审记录

D10/D11a 由同一 Luna / high 在固定批次内开发。首次交付后，主智能体独立执行 Node 24 全仓类型检查、构建与122项实现测试（contracts 8、SDK 19、controller 87、GUI 8），全部通过。测试通过不等于本批放行。

真实接入证据来自独立的 Linux arm64 Colima 实验环境，始终显式选择实验 Docker context，未切换或操作现有默认工作负载。专用 Portainer 服务身份使用 X-API-Key、自定义 CA 验证 HTTPS，读回 Portainer CE 2.45.2、Docker 29.5.2 / API 1.54 / 最低1.40、真实 Engine ID 和硬件容量。通过临时控制器及独立 SQLite，实测管理员初始化与拒绝重复初始化、加密秘密 CLI、认证发现、同 Engine 去重、连接修订 CAS、禁用 Node、profile 修订 CAS、草稿隐藏和验证阻塞。以上均未创建租客容器、发布镜像、实际预热或执行电源动作；不构成 M1/M2。

主审另行注入反例，发现缓存重复申请产生多条 Operation，以及内部验证在机器禁用、要求硬临时盘但能力不支持、预检查后节点转为 draining 时仍可占用容量。另需修正应用/存储职责、失败发现操作的可恢复接口、多架构草稿与版本管理、消费者与管理员读取协议，以及管理 schema/OpenAPI 一致性。已统一退回原子智能体修订；批次4保持开发与主审中，不提前进入真实容器生命周期。

## 批次 4：修订后放行

2026-10-20 经同一 Luna / high 修订、主智能体复验后，D10/D11a 放行。远程探测、原操作重试及验证的授权解析/合同冻结由应用用例编排；连接、机器节点、profile、镜像目录及验证事务各有内聚 SQLite 适配器。HTTP 使用单一运行时 schema 校验输入和安全 DTO，并由同一 schema 生成管理 OpenAPI；草稿管理读取与消费者版本读取分开，不改变现有 SDK 协议。未增加迁移或数据库表，初始迁移校验值未变。

交付包括空安装管理员初始化、版本化 AES-GCM 秘密存储及 stdin CLI、只读 Portainer 发现与可查询/按原 ID 重试的 Operation 收据、Engine 身份去重、同 Engine 不可变连接修订与显式 CAS 激活、禁用 Node 与保守预算/外部底座 Hold、profile 修订与授权 CAS、逻辑镜像及后续草稿版本、多架构固定制品合同、内部验证模型与原子容量预留、受控缓存计划。草稿只登记固定 digest、平台和技术合同声明；真实 manifest/平台查验、拉取、验证执行、清理及发布仍由批次5取证，不能把管理员声明视为已验证能力。

| 最终主审检查                      | 结果                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node24 全仓类型、构建、格式、diff | 通过                                                                                                                                                                |
| 实现测试                          | contracts 8、SDK 19、controller 87、GUI 8，共122项通过；SSE 在获准的 loopback 环境实测通过                                                                          |
| 原设计合同与 SQLite               | TypeScript 接口/示例通过；86项 SQL 检查、41张表通过                                                                                                                 |
| 真实 Portainer 管理 HTTP          | 初始化、加密秘密 CLI、CA/TLS/X-API-Key、真实 Engine 去重、操作查询、连接/profile CAS、禁用 Node、草稿隐藏、blocked validation、缓存计划去重和安全 JSON/OpenAPI 通过 |
| 准入与并发反例                    | 合法验证及同版本后续验证可预留；机器禁用、硬 scratch 不支持、存储能力未验证、提交前 draining 均不分配；容量竞争不超售；授权、profile、连接和实体版本在预留事务复核  |
| 缓存冲突与引用竞态                | 同动作复用原 Operation；相反动作409；GC提交前新增验证引用时不生成删除计划；pin/引用在事务内检查。执行器删除前仍必须再次查实                                         |
| M0 实际进程回归                   | 原键申请、待决续租后重启、回执不变、模拟访问、归还查实与同库重开全部通过                                                                                            |

反例已加入仓库回归测试，并由主智能体使用独立脚本复现和复验。实验凭据未进入仓库；临时控制器与账本已清理。独立 Portainer/Colima 实验环境保留供下一批真实 Docker 验收，未操作默认 Docker 工作负载或现有 WSL 业务。本批缓存仍是 planned/unknown，验证仍未运行，镜像仍未发布；Node 默认禁用且离线租约/自动电源不受支持。M1、M2仍未完成，按固定批次继续，不提前实现 VM。

## 批次 5：能力门槛停止记录

2026-10-20 本批由两个固定范围的 Luna / high 子智能体实现：D10b 网络执行，以及 D12/D11b/D13 的 Portainer 生命周期、内部验证与发布。没有继续委派或改变 Docker 优先、VM 后置的范围。后者明确报告无法按验收标准完成共用 tenant/validation 持久操作执行器及其验证、回收、报告与发布事务；按用户“Luna 不能胜任，停下来汇报”的约定，两者均停止开发。主智能体没有替换模型、接管该大范围改造或把半成品标记为完成。

稳定的已提交、已推送基线仍为 `16bd4fc`。本批的源码、部署配方、依赖与测试留在未提交工作树，供后续审查；没有发布未验证镜像版本，也没有升级 M1/M2 状态。恢复开发时应先完成下述同一核心模块，再做依赖功能，不新增阶段或继续细分任务树。

核心缺口是 OperationWorker/SQLiteOperationStore 仍以 Ticket 为执行主体，依赖 ticket_id、AcceptedAcquireRequest 与 tenant 完成事务，并使用固定对象数量。内部 validation allocation 没有 Ticket/Lease，因而尚不能复用执行、重启恢复、严格截止、清理查实和容量释放。必须以明确的 tenant/validation 判别主体构建冻结计划，共用 Provider 副作用与资源日志，让验证先运行、再清理查实、最后生成不可变报告；发布事务再核对全部必需制品报告、清理结果、技术合同与当前版本指纹。不得用假 Ticket、假 Lease、手工 SQL 或仅管理员声明绕过这个闭环。缓存 Operation 的真实执行和执行时引用复查亦待验收。

主智能体已经实际验证的局部证据：独立 TLS Registry 的 tag/不可变单平台 manifest 内容摘要、精确摘要拉取及 linux/arm64 平台一致；固定 Node 24 Debian SSH 配方的两实例不同主机密钥、公钥认证、普通 workspace 用户、Node 24 和工作目录可写，均通过，测试租客容器与临时网络已回收。这些仅证明配方和实验制品，不证明 Ticket 或镜像发布闭环。

主审发现并退回修复的问题包括：Docker 数组响应误处理、网络删除与 Agent remove 的先后依赖、同节点多个 allocation 的子网冲突、停止容器的端口证据、SSH 返回流量和 userland-proxy 路径、规则回读规范化、命令副作用前日志、镜像内共用主机密钥、SSH 配方 capabilities，以及 ssh2 的 ESM/私钥格式/公钥 wire-format。子智能体已落盘对应修订，但这些修订没有获得整批放行。Agent 初版镜像实际构建成功后，主审实测发现其 Debian Docker CLI 20 无法读取 Docker 29 的防火墙字段；最终改为官方 CLI 29 的源码版本尚未重新构建或执行真实网络验收。

最终交接的聚焦检查由子智能体报告：Agent 15 项测试、类型与构建，controller 响应绑定 1 项，以及访问密钥/admin/app 的聚焦检查通过。它们不替代主智能体的最终全仓复验。真实来源允许/拒绝、INPUT/FORWARD、已有流撤销、IPv6、Docker/Agent 重启、响应丢失及删除失败后的回收恢复均尚未验收。实验 VM 停止并保留实验数据，默认 Docker 环境和原 WSL 业务未操作；电源补充已在设计第13.1节与 D22a/D22b 中，未发送 WOL、关机或小米插座控制命令。

## 批次 5：仅核心闭环的模型例外

2026-10-20 用户回复“仅该部分允许换用”，仅授权上述共用 tenant/validation 持久执行、验证回收取证与发布闭环使用 GPT-6.1 Sol。该模块交给一个固定范围子智能体，不继续委派；主智能体保持独立审查和真实 Docker 验收。网络执行、其他后续模块仍遵循原 Luna 策略，不把本次例外推广至整项目；不缩减 M2、Docker 优先或 VM 后置的原目标。停止记录保留为历史，当前批次仍未放行。

### 恢复后的独立验收进展（尚未放行）

- 核心闭环已完成 tenant/validation 判别主体、同一持久执行器、不可变测试证据、查实清理后报告及发布 CAS；取消/超时不改变原合同和创建截止。创建前按固定原生对象写入未决副作用意图，控制器崩溃后空 inventory 不作为远端请求结束的证明。未知创建不重发、不释放 Claim；迟到对象按完整归属收编后清理。
- 创建和 ready 实时核对冻结连接修订的 Engine 与 Docker/Portainer 版本；发布前实时 probe 并由原事务重核全部依赖。版本变化不妨碍同一 Engine 上的回收。跨进程 SIGKILL/新 epoch、迟到对象、旧账本缺日志及版本漂移均有真实 SQLite 回归。
- 独立实验 VM 的最终网络复验通过：允许与拒绝来源、租客到宿主管理口、同 IP 数据端口允许和管理端口拒绝、未授权目的地、同 bridge 对等隔离、bridge/容器内核 IPv6 关闭、已建立流撤销、Agent 重启、Docker 守护进程重启后租客保持停止及规则先恢复、旧 controlVersion 409、撤权与重复 remove。最终原生资源和专属规则均已回收。发现并修复了 Docker CLI 版本、br_netfilter 前提、bridge 开关及 IPv6 内核状态不能只凭 Engine 配置推断的问题；Agent 不修改全局防火墙或加载内核模块。
- 实际 cgroup 读回、CPU throttling 和内存超限 OOM 通过；scratch 硬限制、持久挂载、执行端离线租期及自动电源仍明确不支持。没有因测试通过把未验证能力启用。
- 空安装经真实 CLI/HTTP 完成初始化、加密秘密导入、Portainer 发现、Machine/禁用 Node/网络 profile/固定 digest 草稿登记及 Agent 身份配置，没有手工 SQL 补权限或伪造租客。第一轮真实草稿验证已运行、清理完成、生成报告并发布，普通 Docker Ticket 已 ready。随后发现旧 M0 的健康 schema、访问和租期模式接线，以及 Node 观测刷新遗漏，交回原 Luna 修订；首轮实例已通过正式归还 API 清理，Claim 为0。此记录不代替最终双票据连接、续租和恢复验收。
- 主智能体独立执行最新全仓236项测试通过（contracts 11、Agent 26、SDK 22、controller 162、GUI 15），格式与差异空白检查通过。原迁移001/002/003未改；003保护意图与验证证据，004将旧托管原生资源标识迁移为内部 UUID，并保留原生 provider_id、父子引用与不可变报告。设计 schema v4 快照已同步，41张表与86项 SQL 检查通过。

- 双 Ticket 实测发现相同选择合同误用相同 manifest_id，以及部分回收状态把原生 Docker ID 作为公开实体 UUID 的问题，已修订并加入回归；创建/ready 的长操作有有界租约续期，重试耗尽只允许查实已有对象，不重建。最小 Node/验证 GUI 和缓存执行/查询已实现并有自动化检查，真实浏览器与缓存实际验收尚待完成。
- 最新失败验证任务已通过原控制器恢复与超时回收流程完成清理，未手改 SQL 或直接删除原生对象，Claim 为0。已将 Node 观测刷新与耗时执行拆为两个可关闭、各自 single-flight 的循环；HTTP 可在 recovering 时提供状态，恢复门槛仍阻止新租用。有限批量按实际尝试时间公平选择，失败探测不延长成功观测时间或能力有效期。

仍需完成真实完整租用/恢复复验、D13 持续漂移检查、最小管理 GUI 的浏览器复验、缓存实际执行与查询，再对照整批门槛放行。后续 Host/人机共用、存储授权与运维交付维持原批次6–8，没有提前转入 VM。

### 双 Ticket 真实闭环复验（整批仍未放行）

主审从独立空账本经 CLI/HTTP 注册，在同一受控 Linux arm64 Engine 上验证：验证前发布被拒绝；草稿验证通过、资源回收完成后生成报告；发布和 alias CAS；两个普通 Ticket 同时保有独立容器、不同 SSH 主机/客户端密钥和独立 workspace 卷；交叉密钥认证被拒绝；首次接用前访问被拒绝；真实接用、续租和 SSH 工作目录读写通过；控制器重启后租约和原 SSH 密钥继续有效；逐个正式归还后 SSH 失效，全部 Claim 为0，按安装标签查询的原生容器、网络与卷均为空。全程未手改 SQL，也未触碰默认 Docker context 或原业务。

M0 独立实际进程回归亦通过原键恢复、pending 续租重启、不可变回执、模拟访问、归还查实及 SQLite 同库重开。缓存实际验收已验证现存镜像采纳与活动引用阻止 GC，暴露并修订精确镜像 inspect 的404处理；重启后的缓存 epoch 接管仍在修订和复验中。管理 GUI 实际显示了真实 Node、已发布版本、验证成功/清理完成历史及 Ticket 阶段；浏览器发现的旧健康结果误显示正常已修订，完整交互复验尚待完成。M1/M2 状态不变。

## 批次 5：修订后放行（M1）

2026-10-20 主智能体完成整批独立复验，放行固定范围 D10b、D12、D11b、D13。恢复过程与失败记录保留为历史；本段和文首状态为当前结论。实现维持 GUI→SDK→contracts、HTTP→application→cohesive storage/Provider 的依赖，共用 tenant/validation 执行器，不用虚假 Ticket、手工 SQL 或替身证明真实 Docker。

| 验收对象       | 证据与结论                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 最终工程门禁   | Node 24.22.0、pnpm 10.28.2：全仓243测试通过（contracts 11、Agent 26、SDK 22、controller 168、GUI 16）；最后 GUI 竞态修订后主审单独重跑16项通过；类型、构建、格式与diff检查通过 |
| 设计与迁移     | 41张表、86项SQL检查及strict TypeScript合同/示例通过；001/002/003未改，004内部UUID迁移有真实SQLite回归                                                                          |
| 真实租用       | 空账本初始化、验证→清理→报告→发布、双实例SSH/工作区/密钥隔离、claim/renew、控制器重启与原访问保持、正式归还后入口失效；Claim及安装归属容器/网络/卷归零                         |
| 实际漂移       | 外部停止与删除租客容器均被识别为resource_lost，查实回收且不重建；两个用例结束Claim为0                                                                                          |
| 缓存执行与恢复 | 实际采纳预装固定摘要、活动租客阻止GC、归还后精确摘要删除、目录仍published；未知GC跨epoch恢复完成，无容量证据的新pull被拒绝；未手改围栏或账本                                   |
| 管理GUI        | 真实浏览器登录、Node投影、显式资源选择安排验证；原run无需手选/刷新自动到passed+cleanup complete；之后发布和别名CAS成功；断连显示unknown、重连恢复                              |
| 模拟器回归     | 独立实际进程验证原键/待决续租重启/不可变回执/模拟访问/归还查实/同库重开                                                                                                        |
| 交付材料       | Agent及固定Node SSH配方部署说明、管理/实验运行手册已同步；181个候选文件真实凭据扫描0命中                                                                                       |

实际GUI验收期间有一次30秒关闭超时；同一关闭路径的loopback复现及后续两次真实控制器正常关闭均通过，未发现可重复的产品缺陷，未凭猜测增加关闭机制。关闭会等待有界的在途工作，后续运维阶段仍需将停止宽限与实际长拉取上界对齐。静态GUI须先构建再启动服务，不以原地替换运行目录作为在线升级方案。

M1仅支持经过人工实际取证的`constant_online_manual_inventory`实验Node：本轮实际环境为Linux arm64、Portainer CE 2.45.2、Docker 29.5.2，独立实验Engine与保守静态预算。没有声称其他机器/架构已经验证。共享内核不等于VM；NAS持久授权挂载、硬scratch限额、Host可信人类会话、严格执行端离线截止与自动电源仍未交付，相关硬要求继续拒绝。新镜像拉取容量证据待D23接线，当前不得将缺证据失败改为强制拉取。WOL/小米插座未执行，默认Docker工作负载与原WSL业务未操作。

下一批为原定 D20–D22a：Host观测、人机共用、依赖/保留量及电源dry-run；M2不因M1放行而缩减，Hyper-V/Tart仍后置。

## 批次6：D20 开始

M1稳定提交`05199e8`已推送。D20按默认Luna/low启动；子智能体只完成Host schema与判定草稿后明确报告完整任务超出当前预算，未进入D21，也未将草稿标记完成。按用户预先授权提高思考预算，原D20完整范围交给Luna/high继续；没有扩大Sol例外、增加阶段或继续委派。注册/认证、boot/sequence/撤销栅栏、快照接收与过期unknown、原生宿主只读采样和服务部署均仍需审核，D20未放行。

主智能体只读采样当前物理macOS的IOConsoleUsers，得到一个已登录且在console的交互会话；锁屏字段未返回，不能据此推断未锁屏。默认sandbox采样失败，正常宿主权限下成功，因而权限失败必须保留unknown。此局部证据不证明无人枚举完整性、Host Agent端到端、Windows/Linux支持或自动电源安全，未执行任何电源动作。

### D20 high 能力门槛停止

同一固定范围的Luna/high亦明确报告无法完成D20，实际只修正Host观测合同草稿和反例（contracts 16项/类型检查通过）。Agent注册认证、心跳持久化、boot/sequence事务栅栏、machine_snapshots写入、独立Host Agent/原生采样及安装服务仍未实现。按用户“Luna不能胜任，停下来向我汇报”的约定停止推进；主智能体不接管实现，也不把仅适用于批次5核心验证闭环的Sol例外扩大到D20。D20草稿及本记录保持未提交，M1稳定基线仍为已推送的05199e8，M2未完成，等待用户决定后续执行方式。

### D20 单模块模型例外授权

2026-10-20 用户明确回复“仅 D20 允许改用 Sol”。仅将原 D20 Host观测、注册认证与心跳持久化的完整范围交由 GPT-6.1 Sol继续；保留同一任务边界、既有草稿和原停止记录，不再委派或细分。完成后由主智能体独立审核、实际取证；D21/D22a及后续模块仍用原Luna策略。D20当前未完成，M1稳定基线05199e8不变，M2目标不缩减。

### D20 Sol 实现冻结（待主审）

2026-10-20 按用户仅 D20 的例外授权，由同一 GPT-6.1 Sol 子智能体完成固定范围，未再委派、未进入 D21/D22a、未 commit/push。实现以 `packages/contracts/src/host-agent.ts` / `host-observation.ts` 为运行时字段权威；HTTP 只校验/鉴权并调用用例。`HostAgents` 负责一次性令牌签发和应用投影，`HostAgentStore` 在真实 SQLite 事务内复核身份、installation/Machine、凭据、controller/session epoch、历史 boot、sequence、时间和 CAS。共享认证错误移入既有 application/errors，HTTP 继续 re-export 同一 class。

身份登记只允许 full admin；五分钟单次配对绑定本地 Host UUID、Machine、installation、OS/架构。Host 凭据独立于 consumer 和 D10b Runtime 网络凭据，只在 enrollment 响应输出一次，SQLite 仅存 SHA-256；摘要不含令牌/哈希。撤销会立即失效凭据/待配对/boot，显式 CAS 重配可恢复过期/遗失配对码、enroll 响应丢失及本地保存失败；pair/revoke 留 actor/request/reason 审计。启动 session CAS、历史 boot 表和所有模式共用的 controller 启动 epoch 拒绝旧进程/旧控制端；Host 可凭自己的身份读取当前 epoch，在控制器重启后恢复。

迁移仅新增必要不可变 `005-host-observations.sql`：扩展 agents 的配对与 session 字段、agent_boots 历史栅栏，以及 machine_snapshots 的完整已认证心跳/摘要/session 字段。001–004 保持原字节；设计 SQL 快照同步。旧账本升级和新账本一致性测试同步到 version=5、42 张表；原资源 UUID 升级测试显式还原 v3 结构后再升级，避免把带 v5 结构的账本伪装成 v3。

`apps/runtime-agent/dist/host-main.js` 是原 package 内独立的原生物理 Host 入口；原 `main.js` Docker 网络角色保留。Host 不导入 Docker Engine/firewall，不需要 socket，也不创建额外控制服务/数据库。固定原生命令/PowerShell WTS 脚本通过 shell=false 调用；配对/采样/出站 HTTPS、credential 落盘和 systemd/LaunchDaemon/Windows Task Scheduler 开机监督见 `apps/runtime-agent/HOST.md`。Windows 脚本用 Node fs 跨平台复制到 dist。

会话字段缺失、权限失败、未知 Class、guest 上下文和过期都不能产生无人证明；断开的 RDP/SSH、锁屏、快速切换及服务账号的交互登录保留保护。Mac IOConsoleUsers 只提供正向会话证据，空 who 不提升完整性；缺锁字段保持 unknown。完整会话枚举与未知资源/未纳管工作量分别裁决：资源失败保留 null，`unmanagedActivityHold=null`、整体 partial，不填 0 或 false。Windows WMI/Linux 虚拟化探测是 guest 负证据，物理部署依赖管理员在原生宿主配对；不宣称密码学硬件认证。最新快照过 30 秒、撤销或 controller epoch 变化后为 fresh=false / unknown；重复心跳不刷新收到时间，单调高 sequence 也不能回写更老 observedAt。长网络中断会跳过过期 pending 的 sequence 后重新采样；HTTPS 有完整请求总截止并拒绝跨 origin/redirect。

开发自验（Node 24.22.0 / pnpm 10.28.2）：

- `pnpm typecheck`、`pnpm build`、`pnpm format:check`、`git diff --check` 通过；`pnpm exec tsc -p docs/design/tsconfig.json` 通过。设计类型检查已显式用 Bundler 解析共享 schema 的既有 zod 依赖，不复制 Host 字段维持旧 Classic 命令。
- `node docs/design/verify-schema.cjs` 86 项通过、42 张表。它仍仅证明设计 SQL/示例事务，不替代实现测试。
- contracts 16 项、D20 controller Host 7 项、runtime-agent 37 项单独执行通过；其中 D20 新增 23 项测试（会话合同 5、真实 SQLite/HTTP 7、OS fixtures/出站生命周期/真实临时 HTTPS 11）。SQLite 覆盖持久重开、旧凭据/旧 epoch/历史 boot、并发启动/并发快照、撤销提交竞态、重复幂等不延龄、乱序/时间回退、配对过期与身份/OS/架构绑定。HTTPS 测试验证证书、拒绝重定向/跨 origin、持续滴流也触发总截止。
- 全量 `pnpm test` 两次被既有 SDK 日期 fixture 阻断：client.test.ts 的 decisionDeadline 固定为 2026-10-20T00:01Z，却未注入时钟，真实时间已越过；串行复验 controller 174/175 通过，既有 SSE 关闭测试单次 read 读到缓冲数据而 done=false。两者已报告主审，不能据此声称全量已通过；本子任务未修改 SDK 或 SSE 实现。

本次 OS 测试是固定原生命令输出 fixtures、失败/权限/guest 反例；Mac fixture 来自主审提供的脱敏 ioreg/plutil 样本，锁字段缺失。子智能体没有运行真实机器/Docker/电源操作，未安装开机服务，也未实测 Windows/Linux、无人 Mac 枚举完整性或锁屏/切换全过程。主审的真实物理 Mac 端到端和独立回归尚待记录；D20 此处仅为实现冻结，未自行放行。严格离线 guard 始终 false/unsupported，没有 ACK；D21 策略/GUI、D22a dry-run/任何电源行为均不在差异中。M1 稳定基线仍为 05199e8，M2 未完成。

### D20 主审与物理 Mac 验收

2026-10-20 主智能体独立审核 D20 的应用、SQLite 事务、出站 HTTPS 客户端、原生采样和部署边界后放行。物理 macOS arm64 上使用独立空账本、真实初始化 CLI、loopback TLS 反向代理及官方 Host CLI/服务进程完成验收；未安装系统常驻服务，未执行关机、WOL、插座或 Docker 操作。

- 完整配对回执可直接 enrollment，私有 binding 落盘且不输出凭据；本机 ioreg/plutil/who/sysctl 真实采样得到已登录会话。缺失锁字段保持 unknown，未管理活动仍为 null，offline=false。
- 重启 Host 后旧 boot 心跳被拒且不刷新 lastSeen；消费者凭据不能冒充 Host。停止 Host 等待超过30秒后，快照 fresh=false、人类状态 unknown。
- 观察模式控制器重启同样增加 controller epoch；仍运行的 Host 凭自己的身份恢复新 boot 并继续观测，无需管理凭据。撤销立即阻断旧凭据，显式 CAS 重新配对恢复，管理摘要不含凭据。
- 全仓 266 项测试通过（contracts 16、Agent 37、SDK 22、controller 175、GUI 16）；类型、构建、格式、差异检查、设计严格类型与86项 SQL 检查通过，当前42张表。既有 M0 实际进程的 pending 续租重启、原幂等回执、访问、归还查实及 SQLite 重开也通过，确认共用启动 epoch 未破坏原闭环。
- 旧 SDK 日期 fixture 的时钟和 SSE 关闭后缓冲读取假设由 Luna 修正，仅改测试：固定注入 now，并有界读取至 EOF。未改变生产租期或 SSE 语义。
- 真实实验凭据及新 Host 凭据扫描无匹配；001–004迁移保持原字节。Windows/Linux 原生部署、无人/锁屏/切换全过程及开机服务权限仍须逐机验收；当前不据此启用自动电源或宣称完整无人的 macOS 观测。

本次放行仅覆盖 D20。接续 D21/D22a 保持原 Luna 策略和固定任务边界；M2 尚未完成，Hyper-V/Tart 仍后置。

### D21 low 检查点与预算调整

2026-10-20 D21 按默认 Luna/low 启动，已形成管理合同/机器投影/API/SDK/GUI 草稿，随后明确报告无法在当前预算闭合固定完整范围并停止。主要未完成项为唯一的准入规则、tenant/validation 事务重检、整机未释放 Claim 的有人预算聚合，以及依赖/Hold解释和GUI策略编辑；后续草稿未通过最终检查，不能据此标记 D21 完成。

按用户既有“可适当提高思考预算”的授权，将同一完整 D21 交 Luna/high 接续审核和实现，不增加任务分层、不扩大 Sol 例外。主审继续以 c77da9c 的已推送 D20 为稳定基线，D21 草稿保持未提交。

### D21 high 能力门槛停止

同一完整范围的 Luna/high 审阅草稿后也明确报告无法闭合并停止，未把草稿标为实现冻结通过。候选筛选与实际 reserve 的人类策略不一致，未在写入事务固定并重验 Host 观测及根预算；策略更新条件、validation guard、依赖/Hold 和 GUI 策略编辑仍未完成。当前差异不能作为 D21、批次6或M2完成证据。

按用户既定停止约定，主智能体不接管实现，也不将“仅 D20 允许 Sol”的单模块授权扩展到 D21。D21 草稿和停止记录留在本地未提交，已推送稳定基线为 c77da9c（D20），整体 M2 估算约65%；未执行任何真实电源动作。等待用户决定 D21 的后续执行方式。

### D21 单模块模型例外授权

2026-10-20 用户明确回复“仅 D21 允许改用 Sol”。仅将同一完整 D21 人机共用、整机容量策略、依赖视图与 GUI 交 GPT-6.1 Sol 接续，实现完成后由主智能体独立审核和实测。保留 low/high 停止记录和固定任务范围，不继续委派或细分，不扩大到 D22a 及后续模块。当前 D21 尚未完成，M2 目标保持不变，Docker 优先、VM 后置。

### D21 主审首轮（尚未放行）

主智能体独立运行首轮完整290项测试通过，未排除loopback TLS/SSE。物理Mac在独立空账本经真实CLI/TLS配对观测，管理API/SDK验证策略预演无写入、旧版本CAS拒绝、超预算策略拒绝、人的保留包含在根池系统保留仅扣一次，以及配置3600秒也不能延长Host协议30秒有效期。真实浏览器完成策略预演/保存到version3，零人类CPU保留值保留，系统总保留未重复扣减；停止控制器后显示历史/当前unknown并禁用保存。

专用Docker实验Engine先查实旧Claim、未完成租客/验证及安装所有原生对象均为0，再复验CPU配额/throttling、内存OOM及INPUT/FORWARD、来源/管理口/同bridge隔离、IPv6、既有连接撤销、Agent与Engine重启、重复删除查实。旧私有网络脚本固定epoch=1被正确拒绝，维护为读取Agent持久代次后复验通过，未降低生产栅栏；默认Docker context未操作。

主审发现并交回同一D21 Sol修订：partial证据中的未管理状态从null改善为false不应反而拒绝有界准入；缺失/过期Host不应标为complete_host；普通心跳不应使管理员来不及阅读预演就静默作废保存。上述回修需独立复验，后续真实物理Host+Docker租用/验证/回收和最终GUI验收仍待完成。此处不作为D21或M2完成证据；未执行真实电源动作。

### D21 Sol 实现冻结（待主审）

2026-10-20 按用户仅 D21 的例外授权完成本固定范围，源码与全仓 dist 已冻结；未继续委派、未 commit/push、未操作实际机器、Docker 或电源，也未读取/使用私有实验凭据。本段仅记录交接，不修改文首放行状态；独立实机与 GUI 证据由主审追加。

`domain/human-use.ts` 集中人员、新鲜度、压力、保留量和物理/子池准入规则；`storage/human-use-guard.ts` 集中完整 Machine 输入的确定性读取及事务内精确比较。tenant 和内部 validation 写入共用这一守卫，覆盖不增加 Machine.version 的 Host 心跳、controller/agent 栅栏、策略、Node/pool、所有未释放 Claim、底座和 Hold 变化。Claim 只在既有查实回收路径释放；降低上限可以保存并阻止新增，不改变已有 Claim 或入口。根池系统保留包含人的最低保留，只扣一次；父底座占物理预算，子池不得再次加到根池，必须有运行底座的 committed 背书且兄弟池不超同一背书。仅保留活跃 Claim 所需及仍被子池引用的 Allocation 输入，避免把已回收历史全部加入每次准入。

`SQLiteMachineNodeStore` 提供实际 Machine→root pool→Node→infrastructure Allocation→child pool→Node→tenant/validation 的结构化依赖视图、开机保护 Hold、预算与策略预演/CAS。contracts/admin 是 HumanUsePolicy 与管理 DTO/schema 权威，设计同名类型改为 re-export；HTTP 只鉴权、schema 和调用用例，SDK 与 GUI 使用同一公开合同，不投影凭据、原始会话主体或内部源地址。管理入口为 machines 列表/current dry-run、策略 proposed dry-run/PUT，以及带 Node version 和理由的 admission-mode PUT；切换模式不伪造能力验证，后台健康观察支持两种模式且不续期能力证明。

正式 observed_host 使用 min(policy TTL, Host协议30秒)，拒绝人员未知、过期/失败观测、缺资源、过压、能力过期与明确 unmanagedActivityHold=true。保留 D20 原生 partial/null 事实：显式 within_reserved_budget 下，新鲜可信正向有人（即便会话枚举不完整）或已完整确认无人、已知低压力可走 bounded_partial_host，始终使用 attended 上限并展示未知工作量；不能授权电源。manual inventory 是独立人工冻结预算试用，旧 M1 可由既有根池投影静态策略，不宣称已验证人机共用。infrastructure/manual/unmanaged_work Hold 保留开机保护与解释；maintenance/recovery 同时阻止新增，Portainer 服务清单不被当成可删除对象或自动超预算结论。

D21 实际新预留限定 on + healthy；旧 expected-off/WOL 证据测试输入保留，现断言常开试用在 unknown 时 queued，人工在线后才预留/绑定。未来安全 wake 合同和 M2 目标未缩减，D22a/b 在可信观测、最终复核、逐机能力与互斥闭环完成后再接入；本次不实现自动电源、VM、cloud 或 offline guard。GUI 每5秒 single-flight 刷新机器，断连标成历史/未知，编辑草稿不被轮询覆盖；版本/观测变化使旧预演失效，保存仍由服务端事务复核。

冻结检查在 Node 24.22.0 / pnpm 10.28.2 完成：pnpm typecheck、pnpm build、全仓 prettier check、git diff --check 通过；设计 strict TypeScript 和 SQLite schema 42表/86 checks 通过；迁移001–005与HEAD字节不变，无新增迁移。本地 contracts16、SDK22、GUI19通过；controller23个测试文件通过，195 passed / 1 skipped（仅 sandbox listen EPERM 的既有 loopback SSE 实测需主审执行）。本次新增 domain15、SQLite/API/SDK联调4、validation2、GUI3共24项；runtime-agent既有测试本地35通过，2个HTTPS loopback因同一EPERM未执行。未经排除的全仓290项和实际物理Mac/真实Docker/浏览器闭环仍待主审，本记录不把 fixtures 当成真实平台或电源能力证据。

### D21 主审两项观测分类回修冻结

2026-10-20 主审先独立完成未排除全仓290项、物理Mac API/SDK/TTL和专用网络 epoch 检查，随后提出两项静态反例。本次只修复这两项：partial 的 unmanagedActivityHold 从 null 改善为 false 后仍可在已知人员、已知低压力、显式 within_reserved_budget 下走 attended 有界路径；true 继续拒绝，新鲜 complete/false 保持 complete_host。缺失、过期、撤销、失败或不足的 Host 观测改为 unavailable_host，公开schema/SDK推导/OpenAPI和GUI标签同步，避免将不可用证据标成完整可信。partial/false 的解释也不再误称未管理活动未知。

针对反例的 domain22及SQLite/API/SDK4共26项通过，MachinePanel4项通过；全仓 typecheck、build、修改文件格式和 diff 检查通过。比前次冻结新增8项反例（整仓预期298项，尚待主审未排除复验）。源码/dist再次冻结，未更改实际机器配置；真实Docker和当前GUI服务的独立验收仍由主审继续。

### D21 预演可读性与断连文案回修冻结

主审真实浏览器发现每秒 Host 心跳、每5秒GUI刷新会使正常阅读中的预算预演静默失效。本次将预算预演的失效输入收窄为身份/权限、连接、Machine版本/容量/保留量/实际占用、Hold及Node版本/模式；普通心跳时间或压力变化不再清空可保存预算预演。准入解释明确标成预演时的历史观测，保存仍由服务端重新读取并在事务内比较当前身份、策略和预算，不使用前端预演作为准入许可。权限与连接状态分开传递；仅真正只读角色显示权限文案，管理员断连只显示已有连接中断/历史/未知原因并禁用编辑。

回归改为实际的“编辑→预演→心跳刷新→阅读→保存”流程，并保留占用变化、撤权、断连失效与真实只读文案检查。两处域分类与此次GUI回修合并后的冻结检查：domain22+SQLite/API/SDK4共26项、GUI全21项通过；全仓typecheck及最后GUI strict类型、全仓build、全仓格式和diff检查通过。较主审290项基线新增9项反例，未排除全仓预期299项待主审复验。源码/dist再次冻结，未操作当前GUI进程、实机或实际配置，等待主审继续真实Docker与浏览器验收。

### D21 SQLite枚举收口冻结

主审真实流程结束后，仅收紧管理DTO和对应内部类型：Machine与Node admission 使用现有SQLite enabled/draining/disabled，Node observedHealth 使用healthy/degraded/unknown/lost；MachineDependency与Node列表共用同一运行时枚举，不提前输出数据库不存在的retired。合法状态不变，没有扩展运行时或修改实测逻辑。先按主审时序完成不写dist的contracts/controller noEmit检查与枚举反例，获准后再统一构建。

最终全仓typecheck、build、format及diff检查通过；contracts全17项、domain/SQLite/API/SDK聚焦26项通过。新增1项枚举反例后全仓预期300项待主审必要复验，源码/dist再次冻结；未操作实机、进程或配置，主审继续独立GUI与最终发布检查。

### D21 Host过期与撤销状态分类冻结

主审真实Node GUI发现controller重启时active Agent的旧epoch快照被误标为revoked。本次仅将明确agents.status=disabled与失效快照分开投影：disabled保留revoked；Agent仍active但controller/session/boot围栏或时间不再可信时显示stale，assurance仍为unavailable_host。新boot按原D20流程清除旧快照后显示missing，收到可信新心跳才恢复。身份/新鲜度校验与所有准入拒绝规则未改，不将等待Host恢复误导为需要轮换凭据。

新增真实SQLite加API反例验证controller epoch递增（Agent仍active）→stale且旧准入围栏失败、新boot等待快照→missing、新心跳恢复、显式撤销→revoked，均核对准入与assurance。先完成不写dist的noEmit和针对测试，获主审停止临时GUI的通知后统一重建。domain22+SQLite/API/SDK5共27项通过，全仓typecheck/build/format及diff检查通过；新增1项后全仓预期301项由主审必要复验。源码/dist再次冻结，未操作实机、进程或配置，其余真实流程证据和逻辑保持不变。

### D21 主审放行与真实 Docker 验收

2026-10-20 主智能体完成独立复验，D21 放行。Node24 下全仓302项测试通过（contracts17、Runtime Agent37、SDK22、controller205、GUI21），没有跳过 loopback HTTPS/SSE；typecheck、build、format、diff检查、设计 strict 类型和86项 SQL 检查通过。仍为42张表，迁移001–005字节不变。真实凭据及Host身份扫描206个候选文件，未发现匹配。

- 物理Mac从空账本经正式CLI、TLS配对及原生命令采样，验证有人且partial的真实观测、未知未管理活动、策略预演无写入、保存/CAS、超预算拒绝及30秒新鲜度上限。真实GUI完成编辑、预演、跨多轮心跳阅读再保存，0值保留且人类保留未重复计费；旧epoch快照显示stale而非误报撤销，断连显示历史/当前未知并禁用保存。
- 专用Docker实验Engine的真实草稿验证、测试、查实回收、报告与发布成功；正式SDK领取SSH Ticket并实际运行Node。切换到真实Host观测模式后，下调有人上限保留既有Claim与SSH，新Ticket排队；恢复预算后原Ticket继续。控制器重启保留租约与SSH，Host恢复新epoch；停止Host超过30秒即阻止新分配，恢复Host后同一排队Ticket继续，最终全部正常归还。
- 实际CPU限额/throttling、内存OOM，以及INPUT/FORWARD、管理地址/同bridge隔离、IPv6、既有连接撤销、Agent/Engine重启、重复删除查实均复验通过。始终显式选择专用实验Docker context，未操作默认业务环境。结束后SQLite独立重开，未释放Claim、未回收验证、未释放Ticket及安装所有租客原生容器/网络/卷均为0。
- 最终GUI关闭实测暴露既有SSE竞态：认证尚未返回时服务开始关闭，旧实现会在preClose后建立新长连接。原范围由Luna修复关闭标志与迟到503的Connection: close；主审确定性loopback复现从200/无法及时退出变为503/正常退出，新增回归等待app.close完成后才中止客户端。真实Portainer控制器保持GUI连接时SIGTERM正常结束，后台循环、SQLite和进程均关闭；未以全局强断连接掩盖问题。

以上不证明完整无人Mac观测、Windows/Linux逐机Host部署、NAS挂载或任何真实电源能力。未执行WOL、关机或智能插座动作；严格离线租约执行仍未启用。M2尚未完成，接续D22a（Luna默认low，必要时提高预算），Sol例外不延伸到后续模块；Docker优先、VM后置。

### D22a low/high 能力门槛停止

D21 已提交并推送为 `ff8b494`。后续 D22a 保持第13/13.1节固定完整范围：公共电源策略与独立插座绑定、持久 dry-run、连续空闲/排空/最终复核、epoch/互斥、安全唤醒推断，以及已断电等待与重启后的恢复供电责任推演。实际关机、WOL、插座适配和逐机启用仍为 D22b，不把沙盘结果写成真实Host回执或可执行许可。

Luna/low 审读后明确报告无法完成整个模块且未改文件；按用户已授权的适当预算提升，以同一范围交 Luna/high 重试。high 同样在审读后报告不能保证完整实现与验证，未修改源码或文档。两者均未继续委派、未产生部分实现、未操作真实Docker/机器电源或读取私有凭据。

按用户“Luna不能胜任，停下来汇报”的要求，主智能体停止 D22a 实现，不接管或自行换Sol。仅D21的模型授权没有扩展到D22a；等待用户决定是否另行授权。M2整体估算仍约70%，D23、D24、D25尚未开始。

### D22a 单模块模型例外授权

2026-10-20 用户明确回复“仅 D22a 允许改用 Sol”。保持同一固定模块和既有low/high停止记录，交GPT-6.1 Sol接续，完成后由主智能体独立审核测试。该授权不覆盖D22b实际电源控制、D23或后续模块；不执行真实关机、WOL或插座断电，Docker优先、VM后置。

### D22a 实现冻结，待主审

2026-10-20，GPT-6.1 Sol 按单模块授权实现公共电源配置、能力结论、独立插座绑定、持久隔离预演及恢复供电义务；没有继续委派，没有提交或推送。`contracts/src/power.ts` 是运行时 schema 权威，设计同名类型 re-export；纯领域决策、应用编排、SQLite 完整输入 CAS、HTTP/OpenAPI、SDK 与 GUI 已衔接。管理能力只能保存 unsupported/unverified 结论，不能通过配置或报告 ID 宣称 verified。真实执行始终 disabled，默认策略禁用且固定 dryRun=true。睡眠配置仅保留后置语义，D22a 拒绝启动睡眠预演，不混用关机冷启动。

预演复用 `operations.kind=power.dry-run`、events/audit，只持久虚拟 drain/epoch/accepted/off/wake 和恢复义务；不写真实 Machine 准入、电源、epoch 或 agent_receipts，也不阻塞真实 Ticket/validation 的 D21 on+healthy 准入。关机路径包含连续空闲、观测中断重置、最终5秒复核、单机互斥、旧策略/epoch/新登录失效、自己的 accepted 后心跳停止及至少120秒保护、expected/confirmed 区别、有界 WOL 和过期 cycle 禁止重开窗口。合成 verified 能力仅用于领域测试，不能成为实际许可。

插座只接受精确设备 ID/MAC、固定 endpoint/secret 版本引用，GUI 用四个结构化字段，无 token 输入。切电意图先保留恢复责任；off 未知先 inspect，确认后原600秒期限不重置，已 off 不再切电。冻结绑定/秘密版本不因策略禁用、epoch/控制器重启或原请求取消而丢失；未完成预演拒绝改绑/删除。启动恢复与5秒后台有界检查可在无 GUI 时推进到期虚拟恢复，关闭应用会等待并清理该检查；供电读回 on 后按当前认证新 boot、恢复后的新鲜完整观测和健康依赖只读确认。正常空闲预演仅在 GUI 面板打开或显式 evaluate 时采样，关闭超过有效观测期会重置连续空闲。

迁移006只增加 JSON 设备身份全局唯一索引和 Machine 未决电源意图唯一索引，不增加表；001–005 原字节不变，schema 快照同步。已有重复绑定或冲突电源意图会使006迁移拒绝启动，必须先查明身份/责任，不能自动丢弃恢复记录。已验证 v5→v6 保留策略、绑定、预演阶段/版本/原恢复期限及 SQLite integrity；历史 v3 原生资源身份升级测试的降级 fixture 同步删除006索引，避免伪造 v3 库残留新索引。

Node24.22.0 / pnpm10.28.2 执行证据：`pnpm -r --no-bail test` 共338项，334通过、2个 controller SSE 测试因 sandbox loopback listen EPERM 失败、2个 Runtime Host HTTPS 测试因同一 listen EPERM 未运行（contracts19、SDK24、GUI24全通过；controller232通过/2受限，Runtime35通过/2受限）。D22a 新增36项均通过：contracts2、SDK2、GUI3、controller29（领域20、SQLite/API/SDK/迁移/重启9）。没有以排除 loopback 的命令宣称全仓全绿，主审需在可监听环境独立运行全部测试与真实进程 API/SDK/GUI。全仓 typecheck/build/format、diff 检查及设计 strict 类型与86项 SQL 兼容检查已执行；SQL 检查不证明生产驱动或真实电源。当前42张表。

本记录仅为实现冻结，未自行放行 D22a。实际 prepared token、正常关机/WOL/小米插座适配、网络/秘密解析及逐机启用仍为 D22b；未读取私有实验凭据，未执行任何真实电源或 Docker 操作。M2 未完成，D23及 VM 后续范围未开始。

### D22a 主审放行

主智能体独立审核领域/SQLite/API/SDK/GUI及设计一致性后，于2026-10-20放行D22a。反例审查已修复新boot确认先被旧条件取消、恢复供电后只读就绪验证错误依赖旧off许可、旧停机cycle过期后重开wake窗口、恢复推进依赖浏览器，以及绑定表单要求手填可推导字段等问题；没有增加实际执行路径。

- Node24下未排除全仓338项全部通过：contracts19、Runtime Agent37、SDK24、controller234、GUI24；包含先前受sandbox监听权限限制的4项。全仓typecheck、build、format、diff、设计strict类型和86项SQL检查独立通过。仍为42表，001–005迁移无改动，006只增加唯一索引。
- 独立空账本使用正式Simulator初始化CLI、真实控制器进程和正式SDK完成：默认禁用、无写策略预演、CAS、拒绝dryRun=false、匿名/消费者权限拒绝、MAC规范化、同机预演互斥、未知Host不能受理关机、off未知先inspect、cancel保留恢复义务、正常重启保留原期限与冻结绑定。预演处于虚拟off_wait时，真实Simulator Ticket仍成功ready并查实归还；前后真实Machine准入/电源/epoch、Agent回执和未释放Claim一致。此处明确是Simulator执行，未拿它代替真实Docker或硬件电源证明。
- 真实浏览器完成结构化绑定查看、空闲策略预演并保存到新版本、模拟原请求取消；虚拟off_wait及原恢复期限保持不变，未完成预演期间改绑/清除禁用。停止控制器后所有编辑和推进禁用并明确标历史；保持GUI连接时控制器正常SIGTERM退出，后台恢复检查与SQLite均关闭。
- 独立源文件扫描217个候选文件，真实既有实验凭据与Host身份零匹配。临时控制器与浏览器均已关闭；预演只在隔离测试账本保留，不存在真实供电动作或供电责任。

放行只覆盖D22a公共配置和持久隔离预演，不承诺真实prepared token、睡眠、关机/WOL或智能插座恢复；这些仍需D22b及逐机证据。M2估算约75%，D23、D24、D25仍待完成，下一模块回到Luna默认策略，不能沿用D22a的Sol例外。

### D23 Luna low/high 能力门槛停止

D22a已按独立授权完成，D23回到Luna策略。Luna/low审读后明确报告无法完整实现本模块，未修改文件；按用户既有授权提高预算，使用同一模型和完整D23范围以Luna/high重试，没有改用Sol、委派或拆分模块。

high核对设计第14/16节、D23及Docker DoD，并检查存储worker/协议、迁移入口、管理API、凭据与秘密存储、ImageCache和Portainer Provider。当前SQLite worker只暴露run/get/all/batch/close，没有在线备份命令；存储README明确备份/恢复未实现。迁移失败会阻止worker启动，但没有运行期维护态/升级前备份流程。数据库历史子图没有保留期清理用例；server仍以恒undefined image-store容量阻止预热。Portainer Provider明确拒绝持久挂载，直到宿主Agent能提供源路径证据。由此无法在本次预算内交付并验证用户规定的完整端到端D23：一致性备份与隔离恢复/控制权重取、留存清理与低水位仍可回收、旧凭据及旧控制端栅栏、授权持久挂载只读/销毁保护、迁移失败维护态和image-store容量事实。仅实现部分备份或清理会留下恢复准入与数据安全缺口，不能作为D23交付。

因此Luna/high停止在方案与证据边界审读阶段，没有修改源码或迁移、没有运行测试、没有操作真实Docker/NAS/服务/机器或读取私有凭据，也未提交/推送。001–006迁移、schema和D22a验收历史均未改动；D23未实现、未验收，不得转移其关键义务到D24/D25。主审可依据该边界决定后续授权或范围处理；本记录不放行模块。

### D23 单模块模型例外授权

2026-10-20 用户明确回复“仅 D23 允许改用 Sol”。保持同一固定模块和low/high停止记录，交GPT-6.1 Sol接续，完成后由主智能体独立审核与实测；不扩展到D24、D25或后置VM/电源模块，不缩减备份恢复与持久数据保护的交付义务。

### D23 Sol 实现冻结交接（2026-10-20，待主审与真实验收，不放行）

D23 固定范围已完成代码实现并冻结，接主智能体独立审核、真实 API/SDK/GUI、Docker/NAS 与隔离恢复演练。未提交/推送，不变更既有 D00–D22a 放行结论，不提前进入 D24/D25，不宣称真实存储或恢复验收通过。

- 运行合同由 contracts 统一：维护健康/诊断、备份及凭据 DTO，固定 Runtime 存储事实和停服恢复接管协议；SDK 强类型复用，HTTP 仅鉴权/校验/调用用例。SQLite/本地文件运维在 storage 适配器，应用层编排恢复与外部证据。
- 迁移007只增加一行维护状态表及新增准入/预热门禁；001–006 对 HEAD 逐文件 SHA-256 相同。低/满/未知数据库卷停止新增和预热，SQLite 写失败有内存闭锁；保留续租、对账、回收和有限日志/历史清理。真实 Node 缺失/失败/过期 Runtime 磁盘事实也阻止无挂载请求；Allocation INSERT 和实际创建许可在短事务内复检。
- SQLite worker 串行化 online backup API 与 SQL/close，校验 integrity/FK、生成独立文件并 fsync；日/周保留与有界日志轮转。升级先备份，失败保留维护标记。成功备份同 key 重放先于低盘新写门禁；已完成文件而 SQL 回执中断也可只读取回。暂停新准入仍自动日备份，低盘/恢复状态不自动备份。
- 停服 CLI 仅恢复到独立空目录，保留故障库；加密 secret 与外部只读主密钥独立恢复，诊断不包含密钥。旧消费者/GUI/Host 凭据撤销；旧 Provider 所有历史 revision 均需认证拒绝，同 Engine 新 revision 激活，Runtime 旧 bearer 必须 HTTP401/403，新认证 inventory 与 epoch 仅共同建立控制权。旧端所有账户凭据（包括备份之后生成者）须由独立管理员撤销并停用其部署，账本不能枚举未记录的外部凭据。
- 恢复先对账、未知继续占用/禁用 Node；有效 ready 租约、原实体、Claim 与截止可保留，未强制清空所有票据。无 Lease 的内部 validation 可在认证 inventory 后继续隔离，不借恢复审批发布或释放。完成资源重现算未知。审批记录真实 actor/request，保持暂停，最后另行 resume；配置/能力复验与 Host 重新配对遵循原管理 API。
- 固定 local/NFS/SMB profile/revision/source/secret 约束，Runtime 读取实际挂载及 DockerRootDir，比较 Agent/host mount root 相对映射，拒绝错误 bind、overlay 空目录、越界/符号链接和租客可改名祖先。证据取宿主稳定 mount/dev/inode，Agent 自身 namespace mount ID 改变不破坏合同。实际宿主 remount/源替换拒绝沿用。持久引用永不 destroy；支持 /workspace/persistent 子路径、独立只读/可写授权，不沿 NAS 递归清理。Agent 不执行 mount/shell；所需预挂载和 namespace 部署边界见 README/runbook。
- 留存按30/180/7天分层，删除事务内针对候选有限 IDs 重查固定 JSON/FK 依赖；不拼全库 JSON 快照。owned 资源变 present、新引用、未决命令/回执、镜像报告与当前恢复义务阻止历史子图退出。Agent 高频已完成回执有期限，unknown 与 active/revoked fence 保留。镜像容量 guard 使用真实 Runtime 文件系统事实；低水位只做有引用/在用检查的精确缓存 GC，不调用 prune。

验证使用 Node24 与 pnpm10.28.2，仅临时 SQLite/目录、注入接口及 fixtures。最终 `pnpm typecheck`、`pnpm build`、`pnpm format:check`、`git diff --check` 均通过；设计 strict TypeScript 通过，设计 SQLite 骨架86项、43张表、integrity/FK通过。最终不排除测试的 `pnpm -r --no-bail test`：contracts19、Runtime47、SDK25、controller251、GUI26，共368项通过；controller另2项 SSE 及 Runtime host-client HTTPS suite 的2项因沙箱 `listen EPERM 127.0.0.1` 未完成（前者2失败、后者2跳过并套件报错），全仓命令据实 exit1，交主审在可监听环境重跑，不能记为全绿。

新增34项回归含：16项维护/临时库恢复/迁移失败/真实 SQLITE_FULL/准入与备份重放/旧凭据/恢复租约与 validation 隔离/历史多连接与唯一 Node/JSON 引用及 owned 竞态/低盘精确 GC/暂停日备份/日志；11项固定存储事实及 namespace/权限反例；1项 Agent 回执留存；3项 Provider 容量/持久引用保护；1项 SDK 轮换不重试；2项 GUI 只读权限和一次性凭据内存传递。真实 Docker/NAS 只读写、卸载无回落、销毁保留、旧 Provider/Runtime 凭据失效及保留同 ready 实体的恢复仍由主审专用环境独立完成；fixtures 不当作硬件证明。RPO/RTO仍为待演练目标，offlineLeaseEnforcement 保持 unsupported，VM 与真实电源保持后置。

操作入口与完整顺序见 `docs/runbook.md` 的 D23 节，Agent 部署见 `apps/runtime-agent/README.md`。冻结后子智能体停止源码和 dist 写入/build，等待主审统一反馈。

### D23 备份真实 HTTP 请求体修订冻结（2026-10-20，仍待主审）

主审真实进程 SDK 验收发现 backup POST 设置 JSON Content-Type 却没有 body，Fastify 在调用维护用例前返回400。此轮仅修该 D23 集成错误：contracts 新增严格空对象 BackupCreateSchema，SDK 明确发送 `{}`，HTTP 校验及 OpenAPI 同步要求空 JSON 对象，runbook同步。未修改通用 HttpTransport、其他业务动作或资源生命周期。

新增真实 SDK 默认 fetch→loopback Fastify→临时 SQLite 备份回归，验证创建、同 key 重放、未知字段422与 OpenAPI requestBody 一致；不使用 app.inject 或 fake fetch 替代真实 HTTP。该回归在沙箱内先如实遇到 listen EPERM，经允许仅将隔离临时库测试移出沙箱后通过；全部 maintenance17项、SDK25项通过。此轮全仓 typecheck/build/format及 git diff --check通过；未因小修重复硬件操作或宣称新一轮全仓/真实 Docker 验收。日志位于 `/private/tmp/hitchlet-d23-backup-fix-{type,build,format,sdk,http}.log`。未commit/push，重新冻结源码与dist，等待主审复跑。

### D23 Runtime 存储身份入口修订冻结（2026-10-20，待主审镜像复验）

主审在官方 Dockerfile 容器中查明 main 将完整部署配置作为 RuntimeStorageFacts.identity，结果展开后含额外配置字段而被 strict schema拒绝。此轮仅在 main 入口显式投影 installationId/runtimeIdentityId/nativeEngineId；结果 schema保持严格，不改变协议或宿主 mountSource匹配规则。

新增入口级回归实际导入 main，读取含全部真实配置字段的 JSON，隔离 Engine/iptables/监听器而执行真实 RuntimeStorageFacts和结果schema，验证输出仅有协议字段、额外agentId仍被拒绝；使用临时目录与注入mountinfo，不接触真实Docker/NAS。入口回归1项及存储11项共12项通过，无未处理异常；Runtime Agent typecheck/build、相关Prettier与 git diff --check通过。日志 `/private/tmp/hitchlet-d23-agent-identity-test.log`。未commit/push，重新冻结并停止写入/build，交主审重建官方镜像与部署复验。

### D23 容量事实接收时钟修订冻结（2026-10-20，待主审真实Docker继续验收）

主审真实Agent与控制端存在毫秒级时钟偏差，原客户端将远端sample与本机时钟直接比较，造成有效事实被误拒。本轮仅修容量新鲜度语义：mTLS/bearer与request nonce/身份/完整挂载集合核对后，客户端追加本地 receivedAtMs；原 wire observedAtMs继续保留为远端采样诊断。server把Runtime磁盘及image-cache evidence的准入observedAtMs写为本机receipt，另以sampledAtMs保存远端时间。共享健康schema只新增可选诊断字段；Agent wire仍严格9字段，无需本次重建Agent。数据库既有30秒陈旧/本地未来门禁保持不变，不修改宿主时间，也不引入时钟框架。

HTTP保留默认10秒并增加完整响应总截止（配置限制1–30000ms），持续滴送字节不能绕过截止。新增真实mTLS loopback10项覆盖远端+10ms/+5s/+60s/−60s偏移、nonce/installation/runtime/Engine不符、旧bearer和持续响应超时；容量DB回归仍拒绝陈旧及本地future receipt，远端未来诊断时间不影响合法预留；cache回归覆盖未来sample与正常receipt。相关 controller测试36/36通过，日志 `/private/tmp/hitchlet-d23-receipt-clock-test.log`。contracts/controller类型与构建、SDK构建、GUI类型与构建、相关格式及 git diff --check通过；不重跑全仓长流水线或操作部署中的Agent/Docker/NAS。未commit/push，重新冻结源码/dist，等待主审facts与tenant实测及最终统一全量。

### D23 主审放行（2026-10-20）

主智能体独立审核接口、SQLite不变量、模块边界和实际行为后放行D23。主审修订包含留存全库快照改定向事务引用检查、无租约validation隔离、历史已完成资源重现隔离，以及真实HTTP发现的备份空JSON、Agent完整配置误入身份响应和毫秒级跨机时钟误拒。没有通过放宽strict schema、绕过TLS或修改机器时间通过验收。

- Node24.22.0 / pnpm10.28.2下未排除全仓384项全部通过：contracts19、Runtime Agent50、SDK25、controller264、GUI26，包含真实loopback HTTPS/SSE及新增SDK→HTTP、完整Agent入口和mTLS容量事实回归。typecheck、build、format、diff、设计strict类型和SQLite86项独立通过；43张表，001–006原字节不变，新增007。
- 全新临时账本经正式CLI引导、正常API登记Portainer/Node/草稿与四个独立存储授权；官方Runtime Agent Dockerfile实际构建并部署到专用Linux arm64 Engine（Docker29.5.2、Portainer CE2.45.2）。Agent按真实host mountinfo、dev/inode与DockerRootDir核验固定local/NFS根；mTLS事实、真实容量、越界/未批准根拒绝通过。容量准入用本机receipt时间，远端sample仅诊断；旧/错身份和完整响应超时仍拒绝。
- 实际验证运行使用同一Provider/worker完成存储合同验证、清理取证和发布。真实Ticket经SSH证明local及NFS只读输入无法写、独立输出可写；暂停准入仍可回收，删除全部自有容器/网络/临时卷后外部输出保留。卸载隔离NFS挂载后申请不能进入ready或在底层空目录创建容器，正常取消查实回收后再挂载恢复。
- 一条有效ready租约在线备份后停旧端；在独立空目录恢复SQLite及加密secret、另行注入原主密钥。旧本地token被拒；真实撤销Portainer key、轮换Runtime bearer并保留Agent journal，CLI验证旧凭据401/403、同Engine及完整inventory，再提升控制代次。恢复端在新凭据下完整性复验后保留原container ID、Lease/generation/截止、Claim、SSH及输出；审批仍暂停，恢复端成功归还并仅回收自有资源。原故障SQLite字节保持不变。
- 小型隔离样本从在线备份到完成恢复、核验与回收实测44秒；这不是任意生产数据规模的RTO承诺，日备份RPO≤24小时仍为运维目标。另行通过正常API重新attest Node、显式resume，原已发布镜像和存储授权可申请新Ticket、SSH接用并归还。最后恢复安装重新暂停；账本integrity/FK通过，未释放Claim、未released Ticket、未完成清理Allocation均为0，local/NFS输出仍在。
- 升级Agent真实网络回归覆盖INPUT/FORWARD、入站白名单、同地址数据/管理隔离、IPv6、已建立流撤销、Agent/Docker重启、旧控制代次拒绝和重复remove回执，最终完整通过。首轮128MiB临时探针曾提前退出且未捕获退出状态；增强诊断后的同配置完整复跑通过，不把短时回归当成长稳承诺，D25仍需对照稳定性矩阵验收。
- 真实浏览器使用独立Simulator安装核验系统健康、凭据安全元数据、暂停、暂停中备份、显式resume；停服后历史状态标记且所有维护写操作禁用。凭据轮换由真实API/SDK测试覆盖；GUI不操作测试凭据轮换。截图保存为hitchlet-d23-maintenance.png及hitchlet-d23-offline.png，控制器进程和临时浏览器已关闭。
- 独立扫描238个候选文件，既有及D23新旧实验凭据、SSH私钥、Host身份零匹配；真实私有fixtures、密钥、数据库、输出和日志均不提交。专用Engine无本安装残留自有资源；保留暂停的隔离账本和外部测试输出供后续复核。

实机范围是当前Linux arm64 Docker与预挂载local/NFS4.2隔离测试服务；不代替任意NAS型号、SMB、Windows Docker或其他架构的逐节点能力取证。共享内核、best-effort scratch及offlineLeaseEnforcement=unsupported如实保留；本轮没有真实电源动作。M2整体估算约85%，D24完整GUI/接入运维交付和D25最终验收未完成。后续回到Luna默认策略；D23的Sol授权不扩展到D24/D25，Docker优先、VM及逐机实际电源仍后置。

### D24 Luna low/high 能力门槛停止（2026-10-20）

D23已主审并推送a708857，后续严格回到Luna默认策略。Luna/low审读AGENTS、设计第18/19节、D24、runbook及现有GUI/API/SDK后明确无法在同一完整模块中可靠交付，未改文件；依用户允许提高思考预算，以同一GPT-6 Luna/high对完整D24重试，没有切Sol或拆成无限小任务。

high同样明确无法胜任并停止。实际缺口包括Docker管理总览、后端登记/探测/连接修订激活、Machine/Node登记配置、授权network/storage profile及消费者/政策入口、必要SDK管理写方法、镜像缓存与常见运维入口，以及消费者申请向导的授权网络/存储目录选择。完整交付还需贯通contracts、controller应用/存储/API/OpenAPI、SDK、GUI及接入/故障文档，并执行D24要求的初始化/权限、浏览器E2E和干净M0安装验收。不能以若干表单或文档把主要义务挪给D25后宣称D24完成。

两次尝试均只做能力/范围审读，无源码、迁移、依赖或dist改动；没有测试结果可以新增，不以此前D23的384项通过代替D24验收；没有读取私有fixtures/凭据或操作真实Docker/NAS/服务。主审确认工作树在a708857后保持干净，SDK确实未覆盖这些管理写入口，现有GUI仍明确标注Node仅观测和空storage验证，未放行D24。

按用户“Luna不能胜任就停下来汇报”的要求，主智能体停止D24实现，不接管、不自行换Sol；既有“仅D23”授权不覆盖D24。M2整体估算保持约85%，D24/D25未完成，Docker优先、VM与实际电源后置；等待用户决定是否另行授权模型或调整完整交付范围。此检查点不改变D23已通过的放行结论。

### 后续模型规则更新与 D24 接续（2026-10-20）

用户明确“先high，不行再切换sol，不需要再授权”，取代此前Luna失败后必须逐模块等待授权的规则。后续固定模块先Luna/high，明确不能胜任可切Sol接续，仍由主智能体独立审核与实测，不改变模块范围。D24已具备Luna/high明确停止记录，现在交GPT-6.1 Sol实现同一完整D24；不重跑相同能力评估，不删除此前停止记录。该授权仅改变本轮M2的执行模型，不提前VM、云或真实电源。M2仍约85%，D24未放行。

### D24 实现冻结待独立验收（2026-10-20）

Sol 接续完整 D24，交付 Docker 管理工作台、必要管理 API/SDK、授权申请向导和独立安装/故障文档。GUI 按 Ticket、后端/Node、profile、防护基线、消费者、镜像和维护职责分组件；不把配置堆入原 AdminPanel，也不增加通用表单框架。公开运行时协议和 DTO 统一在 contracts，SDK 复用 schema，HTTP 调用具体应用用例和 SQLite adapter。复用既有授权 JSON、Operation、audit 和 idempotency 表，没有新迁移；001–007 及设计 schema.sql 原字节未改。

- 管理总览按当前 actor 范围统计完整 Ticket 集合，显示容量账本、观测新鲜度、Host/电源事实及问题跳转。Ticket 筛选、分页安全导出、原操作/事件和授权撤销/清理重试保留删除查实与 Claim 不变量。时间线只投影安全字段并显示操作者/理由，不返回原始 intent/result 或访问材料。
- 连接登记、真实探测、原操作恢复、同 runtime 修订激活，Machine 保守预算、Node/runtime 固定 secret refs、network/storage 创建与修订，以及平台管理网段防护基线均有结构化管理入口。CLI 秘密导入、Agent 部署、真实身份与能力报告仍是可信前置；GUI 不能勾选或手填伪造 verified。保护规则放宽需先完成实际清理。
- 消费者/授权/配额和 destroy 政策按事务 CAS 保存；旧凭据 scope 保留或取角色交集，不因普通编辑扩权，最后可用 full-admin 凭据有保护。旧 Ticket 保留冻结合同。凭据一次性输出只在内存，丢失响应查安全元数据并显式撤销/轮换。
- 镜像草稿/制品、真实验证/取消/清理/报告、发布/alias/退役及已有缓存能力贯通 SDK/GUI。消费者从已发布版本和授权 profile 目录选择，按具体架构资源下限展示，挂载仅有允许 subpath/mode/目标，不披露宿主 source 或 secret refs；可行性预检复用真实申请准备与候选约束，明确不预留容量。
- 服务端再次检查 role、scope、授权范围及 cookie CSRF。安全管理请求在发出前保存原 body/key/CAS，结果未知不自动新建；刷新后可按原请求恢复。服务端崩溃窗口保留 unknown，可查原对象/Operation 并记录人工调查依据，不伪造成功，不锁死无关清理和维护。秘密响应不进入通用回执。事件 SDK 保留十进制游标；断线保留历史标记并禁写，有界轮询不重叠，StrictMode 清理后恢复正确。
- README、runbook、api-sdk 和 Compose 对齐干净 M0、生产非 root/本地 SQLite、TLS/cookie、主密钥与 disabled 配置接入再显式启用 Portainer、试租、D23 备份恢复/轮换及常见故障。手工常开底座、shared_kernel、best_effort scratch、offline unsupported 和真实电源 disabled 明示；未提前 VM、云或真实电源。

验证环境为 Node24.19.0 / pnpm10.28.2，使用临时 SQLite/目录、注入 Fastify/Provider，不读取私有实机 fixtures。新增21项回归（contracts3、SDK4、controller10、GUI4）覆盖协议白名单、scope/CAS/CSRF、凭据不扩权、安全目录/多架构、完整计数、未知命令与当前权限重放、保护规则/原清理重试、慢请求/断线/StrictMode。controller 回归直接提取 docs/api-sdk.md 的实际 JS 代码，在正式 init-simulator 临时库及真实应用/worker 上执行 acquire → ready → claim → renew → release，确认 Claim 清零；fetch 仅注入 Fastify，不称为真实 TCP 或 Docker 验收。

最终不排除测试的 `pnpm -r --no-bail test` 共405项：contracts22、SDK29、GUI30全通过；Runtime48通过、2因 host-client loopback EPERM 跳过且套件报错；controller261通过、3因 loopback SSE/备份 HTTP EPERM 失败、10因 runtime-storage-client loopback EPERM 跳过且套件报错。合计390通过、3失败、12跳过，命令 exit1，不能记为全绿。曾发现受限凭据缓存读取缺 images:read 前置检查而返回500，已修正且全量复跑通过该项；其余未通过均为沙箱 listen EPERM。日志 `/private/tmp/hitchlet-d24-full-tests-final.log`。

全仓 typecheck、build、format:check、git diff --check，以及设计 strict TypeScript 和 SQLite86项/43表完整性检查完成后交主审复核；具体日志为 `/private/tmp/hitchlet-d24-{typecheck,build,format}-final.log` 和 `/private/tmp/hitchlet-d24-design-{type,sql}.log`。干净源码安装、正式 Dockerfile 镜像、真实浏览器权限/恢复与真实 Docker/NFS/备份恢复由主审独立执行，当前尚未放行 D24，不能用上述注入回归代替。冻结后停止源码/dist 写入和 build，等待主审同模块反馈修复。

### D24 主审反馈修订：旧记录恢复与范围统计（2026-10-20，待复审）

主审在独立 Node24.22 环境完成未排除405/405、类型/构建/格式/设计86项及001–007字节检查；干净源码锁定安装、CLI M0与真实 HTTP/SDK acquire/claim/release通过。该证据不提前代表真实浏览器或 Docker/NFS 放行。

本轮仅修三个确定问题：Operation 重试及 journal 当前授权按显式 ID 定点读、校验原 CAS、重试并定点返回，不再依赖最近200条列表；旧命令调查按同 consumer/path/key 返回安全元数据，不再从最近100条回执反查，也不将 unknown 改成成功；总览在 SQLite 内按授权聚合 phase/blocked/unknown 数量和初始化计数，不读取完整 Ticket/Operation 文档或逐 Ticket 查询。点授权与聚合共用 SQL 可见性条件，scope每次总览读取一次；保留未放置请求必须显式限定全部授权 Node 的原规则。原 roleScopes 移至纯 domain helper，HTTP、管理和凭据降权/最后管理员守卫共同引用，不再另写5个 scope 常量。无 GUI/安装链、协议或迁移变更。

新增3项真实临时 SQLite/API 回归：201条较新操作之后的原失败 provision 重试、原版本冲突及 Claim 保留；101条较新回执之后的原 unknown 调查且原键仍拒绝重复执行；有限 Node/image 范围与点授权一致，Ticket从2到107条时总览 SQLite调用次数不变，并覆盖授权缓存和私有安装级 unknown计数。管理聚焦13/13通过。Node24.19/pnpm10完整408项中393通过；原loopback EPERM仍导致 controller3失败/10跳过、Runtime2跳过和对应套件报错，命令exit1，不排除或记为全绿。日志 `/private/tmp/hitchlet-d24-review-fix-{management,all-tests}.log`。完成同前门禁后重新冻结，由主审复跑并继续独立验收。

### D24 主审浏览器反馈：App 订阅身份与旧调查入口（2026-10-20，待真实浏览器复验）

主审真实浏览器发现 App 同层 EventUpdates 与 ManagementConsole 使用相同 consumer key，管理员状态更新时可能累积事件组件/SSE并耗尽浏览器连接。本轮只将组件 key 分为 events/management 命名空间；新增 App 级管理员登录回归，使用真实 SDK 与持续 ReadableStream SSE，经四轮15秒健康/管理轮询、事件、管理 tab与列表状态变化，断言始终一个事件提示、一个有效订阅；退出后旧 signal终止，再登录另一consumer只有新订阅。修前回归出现重复key警告及持续重渲染超时，修后通过；不以jsdom代替主审浏览器复验。

同时修复管理 action 的准备回调：已有 pending key 也合并原 method/path。历史缺 path 的记录直接从经过 contracts 校验的已保存原请求派生，调查按钮不依赖最近100回执；调查成功仅结束本地等待并清除其安全准备记录，服务端 unknown语义不变。新增刷新存量缺path、100条新回执不含原key的 GUI 回归，确认可发出正确调查请求、没有重发创建，原有 body/key恢复回归同步检查准备时已保存path。保留前轮三个修订，无后端协议/SQL/安装链变更。

Node24.19/pnpm10下GUI32/32通过，全仓 typecheck/build/format/diff门禁执行。未排除完整410项中395通过；仍仅原loopback EPERM造成controller3失败/10跳过、Runtime2跳过和套件错误，命令exit1。日志 `/private/tmp/hitchlet-d24-app-sse-{gui,all-tests,type,build,format-check}.log`；001–007及设计SQL未改。重新冻结源码/dist并停止build，交主审真实浏览器复验。

### D24 M0 合成连接目录修订（2026-10-20，待主审复验）

主审浏览器确认同层key/SSE修订后管理员Ticket与时间线正常、持续轮询只有一个事件提示；后端登记页暴露官方init-simulator的合成连接不符合真实Portainer证据投影。此轮只在真实连接目录排除同时具有 simulator://local endpoint、simulator environment和executionMode=simulator的完整种子标记；保留数据库中的模拟执行绑定、无revision的真实连接和真实Portainer schema严格校验，不把种子当成已验证Engine，也不要求改SQL。GUI明确合成连接不列入真实Portainer；同步更正已有验证挂载文案和destroy政策名称/关联注释，无新功能。

新增两项回归：实际官方init CLI→临时SQLite→HTTP连接GET200空目录→SDK inventory.connections空目录，并经SDK正常登记disabled/unknown且power disabled的Machine；InventorySetup经实际SDK读取空真实连接目录仍可填写和提交结构化禁用Machine。前者验证真实应用/API，后者使用协议响应fixture，不声称真实浏览器已复验。管理14/14、GUI管理6/6及全部GUI33/33通过。Node24.19/pnpm10未排除全仓412项中397通过，其余仍仅原loopback EPERM：controller3失败/10跳过、Runtime2跳过及对应套件报错，命令exit1。全仓typecheck/build/format/diff通过，001–007与设计schema.sql未改。日志 `/private/tmp/hitchlet-d24-m0-connection-{management,gui,all-tests,type,build,format-check}.log`。源码/dist重新冻结，等待主审同模块复验。

### D24 Node 能力取证回执 hash 合同修订（2026-10-20，待主审真实 HTTP 复验）

主审已独立通过412全仓、最终干净安装/Dockerfile与M0浏览器禁用Machine登记。真实Portainer接入发现新SDK取证回执误将既有64位裸hex capabilityFingerprint约束为OCI digest，服务端已受理启用但SDK报INVALID_RESPONSE。本轮只把该receipt约束对齐原裸hex，并让HTTP取证route以同一权威receipt schema校验输出；不改历史fingerprint、hash(JSON)算法、Node能力或冻结运行合同。审查本轮其他新receipt，其他digest均来自image_artifacts.content_digest或输入OCI digest，仍保留sha256:前缀，无同类hash误用。

新增两种传输的同一真实SQLite/SDK链回归：临时独立主密钥与加密secret refs、持久连接证据、Machine/Node登记、runtime配置、能力取证及原键重放。注入Fastify JSON parser分支通过，回执与数据库及原算法逐字相同，OCI前缀反例拒绝，原键重放只产生一次取证审计；外部探测为fixture，不是硬件证明。另加默认fetch真实loopback HTTP分支，留给主审可监听环境实跑，未拿手写fake receipt替代。

Node24.19/pnpm10未排除完整414项中398通过；新真实HTTP分支同样因listen EPERM未完成，与原3项HTTP/SSE失败及12跳过合计4失败/12跳过、对应套件报错，命令exit1。全仓typecheck/build/format/diff、设计strict和SQLite86项/43表通过；001–007及schema.sql原字节未改。日志 `/private/tmp/hitchlet-d24-capability-receipt-{inject,all-tests,type,build,format-check,design-type,design-sql}.log`。源码/dist重新冻结，交主审复跑HTTP与真实接入；未接触主审已暂停安装，未重试其未知写或创建Ticket。

### D24 独立验收放行（2026-10-20）

主审在最终冻结源码独立执行 Node24.22.0 / pnpm10.28.2 全量检查：contracts22、Runtime50、SDK29、controller280、GUI33，共414/414通过，无失败或跳过。严格类型、完整构建、格式、diff、设计接口和SQLite86项/43表通过；001–007迁移与设计schema.sql未改。真实loopback回归确认裸hex取证回执通过SDK解析及同键恢复。已知真实凭据/Host身份扫描零匹配。

从没有原node_modules/dist/.git的临时源码副本执行frozen-lockfile安装、构建、初始化并用安装后的SDK在真实HTTP完成M0申请/接用/归还。正式Dockerfile也从最终源码构建，在独立持久卷以UID1000运行，GUI与SQLite以及安装后SDK闭环通过；容器安装的M0不当作租客Docker证据。实际浏览器完成消费者目录/预览/申请/claim/renew、管理总览与各页、禁用Machine登记、断线只读及恢复；独立SDK负责实际归还。浏览器暴露的重复SSE key耗尽连接及Simulator合成后端目录422均已修复并复验。

真实Linux arm64隔离Engine上的最终SDK完成授权目录、后端/存储目录、固定制品预热、资格预览、四个local/NFS profiles申请、ready/claim/access/renew、带host-key校验的SSH读取原持久输出，以及release到原生资源查实删除；Ticket详情/操作时间线均通过。安装最终暂停、没有托管容器/网络/卷占用。当前Node仍为constant_online_manual_inventory，不据此宣称正式Host升级。

另独立实测当前精确制品的512MiB/0.5CPU/PID限制、每容器SSH身份与bootstrap撤除、local/NFS只读源和独立输出、容器销毁后输出保留。网络INPUT/FORWARD、未授权进出、IPv6禁用、Agent/Docker重启和陈旧控制代次拒绝完整通过。此前128MiB网络探针提前退出已定位为临时测试TCP服务未处理ECONNRESET，OOMKilled=false；修复私有探针错误处理后保持原资源配置与全部断言通过，没有据此改生产限额。

D24按完整范围放行，M2估算约95%。D25仍需当前恢复账本的可信物理Host观测、人机共用/整机容量、正式准入及逐项验收矩阵；不以限时人工报告、M0或历史批次替代。实际电源、VM及未验证架构/存储协议后置。独立日志仅保存在私有临时目录，不提交本地身份、凭据、NAS路径或数据库。

### D25 实现冻结待主审与实机逐节点验收（2026-10-20）

D25实现将能力报告与正式共享Host准入明确分开：能力报告用有界有效期（默认一小时，可显式设为1小时至30天），心跳不续期；到期后只停止新的能力依赖选择/发布，须同一Engine/架构重新实测。现有`observed_host`节点更新报告保持原模式，不出现Host证据缺失时静默降级到人工试用的窗口。正式提升由现有admission-mode API显式执行，并重新验证当前Node、能力范围/到期、Engine与连接修订、架构、Host快照、策略和Claim；事务内比较观测及身份修订，读后变化则拒绝。新Node仍先走人工常开试用；partial Host仅按`within_reserved_budget`允许的有界attended预算，不把未知人员或未验证能力解释为无人/支持。公开Node DTO未增加字段，SDK与响应严格schema继续一致。

已通过相关controller回归22/22（机器策略/准入、能力报告、持续电源策略），其中包括实际SQLite连接修订读后变更拒绝、撤销Host拒绝正式准入、报告过期投影和正式Node重新取证仍受Host gate。完整workspace typecheck、格式与GUI回归待主审复核。本地环境为Node 22，不满足仓库声明的Node 24引擎版本，最终主审应在项目支持的Node版本重跑。此实现冻结不等于D25验收完成：真实Host重新配对、人机/容量当前账本、正式租用/重启/归还及逐Node矩阵仍由主审依照设计D25记录；未实测仍为unsupported，M2未完成。本轮没有操作真实Docker、NAS、Host服务、电源或浏览器，没有读取私有实机证据，没有更改D24历史证据，也未提交/推送。

### D25 独立验收放行与 M2 完成（2026-10-20）

D25由Luna/high在固定完整范围实现，经主审反馈修订并独立验收，无须切换Sol。最终Node24.22.0 / pnpm10.28.2全仓418/418通过（contracts22、Runtime50、SDK29、controller284、GUI33），无失败或跳过；严格类型、构建、格式、diff和设计接口/SQLite86项43表检查通过。001–007迁移及设计schema.sql原字节未改；新增能力有效期/精确身份仍保存在现有Node JSON，没有并行数据库或发布框架。已知真实凭据及Host身份扫描零匹配。

正式准入复用现有模式API和纯领域规则；能力报告默认为原一小时，可显式1小时至30天，从checkedAt固定计算且不由心跳延期。提升必须通过当前能力/Runtime身份/修订、Host认证和策略，事务内同时比较Machine完整输入与连接身份；报告更新保留原observed_host，避免临时退回人工路径。实际浏览器另发现总览对Node误用Host30秒窗口，最终抽取同一严格120秒Node判断，覆盖45秒有效、120秒/未来/缺失无效的API/SDK与真实SQLite准入反例；Host30秒协议不变。

在D23恢复后的暂停账本重新配对原生物理Mac Host，保持partial、present、unmanaged unknown。明确1000m/1024MiB测试预算，系统保留500m/512MiB含人类保留250m/256MiB，租客总上限500m/512MiB；这不是完整硬件容量。实际进入observed_host/bounded_partial_host，有人block_new阻止新增，两次并发仅一份ready；SSH读取原NAS输出，Host停采超过30秒后阻止新准入但保留原Claim，控制器重启经新epoch恢复同一租约，续租/查实归还后无Claim与托管原生资源。

正向流程测试显式采用100%/100%压力阈值，不宣称生产低压力；最后恢复90%/90%，真实内存占用高于阈值，API/GUI均拒新。OS total/free占用率可能包含缓存，不等于macOS专有memory_pressure信号。最终浏览器确认部分Host、正式mode、能力期限、压力阻止与Node健康投影一致。隔离账本保持paused，Host/controller临时进程已停止，没有安装人的机器开机服务，没有实际电源动作。

最终源码重新在无原node_modules/dist/.git副本安装、构建、初始化并执行真实HTTP SDK M0闭环；正式Dockerfile再构建和实际运行，非rootUID1000、独立持久SQLite卷、GUI及SDK申请归还均通过。M0包装结果与真实租客Docker分开记录。D25另刷新网络/重启/SSH/内核限额/local-NFS只读和持久输出证据；一次Docker重启后传输失败及其查实清理、完整复跑均保留，不把未留错误码的首次失败确定为某种根因。

对应设计第19节DoD与跨模块场景的逐项证据、故障注入边界和未承诺能力见[Docker交付验收](DOCKER-ACCEPTANCE.md)。本轮D00–D25目标完成；常开手动电源是已接受部署方式，VM、云、严格离线停止、其他架构/协议、完整无人枚举和逐机WOL/小米插座实测仍按后置范围管理，不因M2放行自动启用。

全部租约释放及账本完整性复核后，主审还手动停止了三个专用测试基础服务和Colima验收VM，保留数据与证据以释放本机资源。这是实验环境收尾，不表示Hitchlet已经实现VM底座或实际电源自动管理。
