# Hitchlet 实施与验收记录

实现基线：[设计 v1.3](design/README.md)。当前目标保持 M2（Docker 正式交付）；Hyper-V、Tart 和云扩容不在本轮实现范围。模拟器通过不代表真实 Docker 或宿主通过。

本轮状态：批次1–4已通过主审与独立复验，M0 模拟闭环和 Docker 接入准备完成。接续批次5（D10b、D12、D11b、D13）；M1、M2 未完成。登记和只读探测不代表 Docker 隔离、实际租用或真实机器通过。

## 工作方式与固定批次

开发由 GPT-6 Luna 子智能体承担，初始思考预算 low，使用正常速度。主智能体检查差异、接口一致性和测试结果，再允许进入依赖它的下一批。必要时可提高 Luna 的思考预算；如果仍不能胜任，停止并向用户报告。子智能体不继续委派，不增加无限细分的任务树。

| 批次              | 设计任务             | 确定产物                                                            | 审核门槛                                                                  | 当前状态         |
| ----------------- | -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------- |
| 1 基础工程        | D00                  | pnpm 工程、API/GUI 启动、配置、日志、构建测试、Docker 部署骨架      | 安装、类型检查、测试和构建实际通过；缺失配置有明确错误                    | 已审核通过       |
| 2 领域与账本      | D01–D03              | 运行时合同、SQLite 迁移/worker、状态机、配额与原子资源预留          | 合同一致；并发末份容量不超售；冻结请求、事务与版本约束通过                | 已审核通过       |
| 3 模拟闭环        | D04–D05              | 持久操作与恢复、Simulator、租约 API/SDK、基础 GUI                   | 重启恢复、创建回执丢失、删除失败、续租竞态、归属鉴权与浏览器闭环；完成 M0 | 已审核通过（M0） |
| 4 Docker 接入准备 | D10、D11a            | Portainer 身份与修订、节点能力、草稿镜像目录和验证调度              | 错误 Engine 拒绝；草稿不能被消费者租用；固定制品和授权修订                | 已审核通过       |
| 5 Docker 租用闭环 | D10b、D12、D11b、D13 | 最小 Runtime Agent 网络执行、独立容器生命周期、验证后发布、恢复回收 | 实际 Docker 网络/限额/存储隔离与失败清理通过；完成 M1                     | 未开始           |
| 6 宿主与节能策略  | D20–D22a             | Host 观测、人机共用、依赖与保留量、电源 dry-run                     | 未知或有人登录阻止关机；竞态处理；未实测能力不启用                        | 未开始           |
| 7 运维与交付界面  | D23–D24              | 备份恢复、升级、凭据轮换、完整 GUI/SDK 与接入手册                   | 真实恢复演练、权限/存储回归、浏览器 E2E 与干净环境安装                    | 未开始           |
| 8 正式验收        | D25；D22b 逐机可选   | 实际节点能力矩阵与发布证据                                          | 对照设计 Docker DoD 逐项取证；未验证机器保持试用/禁用或手动电源           | 未开始           |

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
