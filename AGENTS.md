# Hitchlet 开发约定

## 范围与执行

- Docker 正式交付 M2 通过 Portainer 接入。2026-11-02 用户更新：review 修复与完整复审已收口，当前推进 Tart 本机驱动、同账本生命周期、可信 Runtime/固定 guest 初始化/SSH、正常管理发布与租客 VM 选择，以受控夹具/合成账本验证；原生网络计划/Softnet 控制读回回收及正式 server 组合已有受控源码。2026-11-03 已按具体授权完成 Studio Tart 2.41.1 / Tahoe macOS ARM / 默认 NAT 的真实资格、发布和单票 CLI 测试，见 `docs/TART-STUDIO-CLI-ACCEPTANCE-2026-11-03.md`；临时栈已停止、临时认证已清理，未提供常驻公共租用。Ubuntu 24.04.5 Linux ARM 的固定初始化、正常资格/发布和单票 CLI 实机闭环也已完成，见 `docs/TART-LINUX-ARM-ACCEPTANCE-2026-11-03.md`；临时服务与认证已清理。Softnet、其他 Linux 发行版、Windows / Hyper-V 尚未实机验收。后续真实安装、镜像/许可、认证或网络安全变更仍需明确具体范围；恢复边界见 `docs/TART-NETWORK.md` 和 `docs/TART-DRIVER.md`。2026-11-04用户持续推进范围已允许Hyper-V源码：内部原生生命周期内核及47项相关受控回归已完成，见docs/HYPERV-NATIVE-KERNEL.md；内部Runtime server/client受控接线已补，见docs/HYPERV-RUNTIME-TRANSPORT.md；内部ExecutionPort与guest握手已补受控实现，见docs/HYPERV-PROVIDER.md；固定SSH probe与草稿登记已补，见docs/HYPERV-READINESS-AND-DRAFTS.md；正常Runtime入口与namespace绑定已有本地受控接线，见docs/HYPERV-RUNTIME-ENTRY.md；Windows宿主现已按2026-11-04具体授权启用Hyper-V并正常重启；尚无真实guest模板或可租Hyper-V节点。本批补齐PowerShell Direct固定guest初始化源码、完整导出模板摘要、正常管理发现/资格/发布与共享Ticket/claim/access/续租/回收接线，见docs/HYPERV-MANAGEMENT-AND-GUEST.md；均为本地受控验证，未部署Runtime/创建VM或声称Windows guest已验。宿主网络及新增长期认证仍须具体处理。云扩容仍后置。
- 按 `docs/IMPLEMENTATION.md` 的固定批次推进。2026-10-20 用户更新后续模型规则：先用 GPT-6 Luna、high 思考预算、正常速度；明确不能胜任后可切换 GPT-6.1 Sol，无需再逐模块请求授权。主智能体审核并实际验证后再进入依赖批次。
- 2026-10-20 用户仅授权批次5的“共用 tenant/validation 持久执行、验证回收取证与发布闭环”改用 GPT-6.1 Sol；这不是其他模块的模型授权，其他实现仍遵循 Luna 策略。
- 2026-10-20 用户另行授权仅 D20（Host 观测、注册认证与心跳持久化）改用 GPT-6.1 Sol，完成后仍须主审；D21、D22a 及其他后续模块不在本次例外中。
- 2026-10-20 用户再次单独授权仅 D21（人机共用、整机容量策略、依赖视图与 GUI）改用 GPT-6.1 Sol，完成后仍须主审和实测；D22a 及其他后续模块不在该例外中。
- 2026-10-20 用户另行授权仅 D22a（电源策略、持久 dry-run 与恢复责任推演）改用 GPT-6.1 Sol，完成后仍须主审和测试；不扩展到 D22b 实际电源或 D23 及后续模块。
- 2026-10-20 用户另行授权仅 D23（备份恢复、低磁盘保护、数据保留、控制凭据轮换和授权持久存储）改用 GPT-6.1 Sol，完成后仍须主审与实测；不扩展到 D24、D25 或后置 VM/电源模块。
- 2026-10-20 用户随后明确“先high，不行再切换sol，不需要再授权”，取代此前逐模块另行授权的限制。D24 已完成 Luna/high 能力判断并明确无法完整交付，因此可直接由 Sol 接续；同一规则适用于本轮 M2 的后续固定模块，不扩大到尚未请求的 VM、云或真实电源范围。
- 子智能体只完成分配的范围，不继续委派，不无限拆任务。Luna/high 能力不足时停止该次实现并向主智能体报告；主智能体可按新授权切换 Sol，仍须独立主审，不以模型切换缩减交付范围。
- 子智能体与主智能体沟通只使用 collaboration 工具；不得向用户的其他聊天发送消息或创建用户聊天。

- 2026-10-20 用户另行明确恢复并扩展本轮到固定 D22b：实现正常关机＋WOL闭环、原生 opt-in executor、逐机资格与真实 Windows 实测，完成后恢复/清理测试并正常关机。该模块已完成 Luna/high 能力判断，可由 Sol 接续；主智能体负责真实电源及独立审核，子智能体不执行真实电源/外部网络、不提交推送。此次授权不含 sleep、智能插座/强制切电、VM、云。D22a 沙盘仍不构成实际许可。

2026-11-05 增量：Windows11 Pro23H2 amd64 的真实 Hyper-V 资格、正常验证发布与单业务Ticket的SSH/confirmed续租/输出保存/归还查实已完成；临时栈及认证已清理，模板关机保留。固定Vesta CLI三个governance text用例均失败，不能称消费者跨平台通过；见 `docs/HYPERV-WINDOWS-ACCEPTANCE-2026-11-05.md`。此实机结论取代上文历史“尚无guest模板/未部署/未实机”状态，但不扩展到Hyper-V Linux、激活、常驻服务或完整跨平台矩阵。

2026-11-05 Docker 服务增量：新 Ubuntu ARM 8 vCPU / 16 GiB / 100 GB 模板内 Docker 29.9.3 / Compose 5.7.0 已真实资格、验证发布；单票 Vesta/Prism 服务启停、就绪及重启数据保留通过，见 `docs/TART-DOCKER-SERVICES-ACCEPTANCE-2026-11-05.md`。这是 Tart VM 内消费者 Docker 能力；未扩大 Docker backend 隔离结论。临时票、服务和认证已回收，模板关机保留。

## 实际使用与安全边界

2026-11-03 用户明确：家庭受信任 Tart 任务默认 NAT，按需访问网络，不承诺强网络隔离或强制关闭 IPv6；Softnet 为显式可选能力，Docker 既有行为不放宽。独立环境、身份、额度、租约和查实回收保留。不要把可选机制或假设风险叠加成所有任务的默认门槛；保留的检查需对应具体问题。此前全局 Tart 启动 guard 移除被拒且未执行；用户随后明确批准仅移除该无条件拒绝，本次单次重试已执行，不增加替代总闸。真实工具/VM/认证/宿主设置不由源码授权自动启用。当前源码及边界见 docs/TART-NETWORK.md 和 docs/PRACTICAL-BOUNDARIES-2026-11-03.md。

## 架构要求

用户明确要求架构优雅。这里的具体含义是依赖清晰、接口稳定、职责集中和维护成本低，不以层数或文件数量衡量。

- 保持模块化单体：控制器一个常驻服务、一个本地 SQLite 账本。当前只抽取真正共享的 `contracts` 与 `sdk` 包。
- 依赖方向是 `gui → sdk → contracts`，`controller → contracts`。共享运行时 schema 与公开 DTO 归 contracts；SDK 不定义另一套服务端协议。
- controller 内将纯领域规则、应用用例、存储和 Provider 适配分开。领域规则不导入 Fastify、SQLite 驱动或厂商 SDK；HTTP 层不直接编排 SQL 和后端副作用。
- 仅在实际替换、测试或职责边界需要时定义端口。不要为每个函数增加 interface/service/repository，也不引入通用框架或服务定位器。
- 使用普通 `src → dist` 构建布局和标准包导出。运行产物不依赖设计文档目录或 TypeScript 源码即时转译。
- 配置在入口解析；应用构造可测试；业务代码通过明确参数获得依赖，避免全局可变容器和隐式初始化。
- 设计合同与实现保持一致。迁移权威类型来源时明确更新引用与检查，不长期维护两套手写字段定义。

## 实现与验证

- 使用 TypeScript strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes。外部输入用运行时 schema 验证，不能用类型断言替代校验。
- 保留 Ticket 冻结请求、版本裁决、幂等恢复、资源原子预留，以及删除查实前不释放容量等关键行为。
- 做与风险相称的测试：领域/数据库不变量、API/SDK 契约、恢复故障和 GUI 真实流程。避免只复述实现的测试，以及无实际需求的安全层。
- Node 24、构建、格式、类型和测试均须实际执行。Docker 能力必须有真实 Docker 证据，Simulator 不能代替。
- 不提交真实凭据、本机个人路径、数据库、工作数据、缓存或测试日志。不能因未经验证的接口或测试替身而宣称节点能力已支持。
