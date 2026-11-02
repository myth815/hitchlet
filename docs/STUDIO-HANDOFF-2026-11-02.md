# Hitchlet Studio 接续说明（2026-11-02）

## 当前决定与边界

用户最终决定在 Mac Studio 集中开发 Hitchlet，以便后续对接 Windows。MBP 停止开发，源工程、源交接包和原会话均保留；本说明不授权删除或归档它们。

Hitchlet 是独立、业务无关的通用计算环境供给平台。Docker/Portainer 优先；Vesta 与影音整理是潜在消费者。本轮不实现媒体消费者业务或 Vesta 适配。保持已有账本、容量、镜像、授权、回收、Ticket 与 Claim 合同和模块化单体架构。

本轮只使用临时账本、localhost Simulator 和自有测试资源。不得操作实际 Portainer、NAS/媒体、付费模型、真实凭据配置、VPN、电源/WOL、VM/云；不得重试被拒绝的 InstallService/defragsvc 扩权。

## 原始成果来源与保全

- 工程是独立 clone，origin 为 `https://github.com/myth815/hitchlet.git`，不是 worktree，也不位于消费者工程内。源基线为 main 的 `135128e8a2e8a913991a943d21459ee38701410a`。
- MBP 源交接包为 `hitchlet-studio-source-handoff-20261102.tar.gz`，Library ID `libfile_726c78ee76f4819180e28cc1926e4438`；包 SHA-256 为 `6793035158dc4419545d899e34fa160c7494b4172337dbe100f1099cf37cb66e`。包内 SHA256SUMS 四项在迁入时全部通过，本轮再次核验整包 SHA-256 一致。
- 7 个 GUI 文件和 `docs/AUDIT-USABILITY-2026-11-02.md` 已原样迁入。本轮切换开发分支前后，8 个文件均与源 MANIFEST.json 的 SHA-256 一致；提交 `4625b836e56e72b9841e1e90a16f4cf2fce5aacd` 保存这 8 个原始最终文件，逐文件读取提交内容后再次核验 8/8 一致。本轮新实现叠加在该提交之上，原始版本可从 Git 历史核验。
- 迁入 GUI 包含紧凑导航、生命周期/下一步、期限显示、初始/加载/空/失败/离线状态和窄屏布局。MBP 历史 48 项 GUI 测试与 localhost Simulator 浏览器流程通过；这不是 Studio 或真实 Docker/媒体证据。

## 云端原始成果已恢复核验

先前云环境故障、成果尚未取得的等待状态已经解除。已正常 fetch `origin/codex/hitchlet-cloud-usability`，本机核验确切提交 `701988637b6d3b225bdc04d6e4261d5a54c16abf`，其唯一父提交为上述源基线。写集恰为 22 个控制器、SDK 和测试文件，与本地 7 个 GUI 文件及审计文档不重叠。安全切换到同名本地开发分支时保留全部迁入改动，没有 reset、stash、重写云端实现或改动 main。

云原始提交范围为：停用 consumer 仍可管理本人旧票但禁止新申请与越权、保留凭据撤销；consumer 轮转且内部 FIFO；真实排队原因/统计；SDK 兼容可选响应扩展而严格检查必需字段和已知值；union 字段与续租回执修复；四处测试临时目录移植。

云端历史验证为 controller 125、SDK 38、storage 24、auth 6，以及相关 types/build。运行平台为云 Linux、临时 SQLite、Simulator/合成 Host。本轮复用该历史证据，没有把这些数字声称为 Studio 重跑结果。

备用 Library 包为 `libfile_e5968a8b2b688191a876537d8a32650d`，协调提供包 SHA-256 `d22f7dbec85dfc31f23d4a6a79606fe90bcf0e9a547e45b6d16296c48a374489`、patch SHA-256 `35d2581afff512297abd9f4ff8fa8cab3fa45a27314d2081639a2d3a782f6d3f`。本轮使用 Git 原提交接力，没有另行下载或声称本机核验备用包。

## 本轮 GUI 补齐与有限主审

- SSH 接用卡和复制文本包含服务端返回的 host-key 指纹；SSH 指纹缺失时明确说明无法据此验证主机身份，RDP 标为不适用。访问材料沿用页面内存、隐藏/切换详情/归还时清除以及 60 秒自动隐藏机制。
- consumer Ticket 详情显示待裁决续租的候选 Lease 版本、候选截止（尚未生效）、最后确认截止和裁决期限。待裁决期间下一步提示等待原裁决，禁止再提交 Claim/续租；不把 HTTP 202 或候选期限当作延期成功。
- 新实现仅改 `apps/gui/src/App.tsx` 和 `apps/gui/src/main.test.tsx`，保持 `gui → sdk → contracts`，未改写后端或 SDK。
- 按工程约定由 Luna/high 完成限定实现，主智能体对新 GUI diff、公开合同、SDK 续租语义和对应测试做一次有限主审。主审纠正了新增用例未把 Ticket 放入列表的 fixture 问题，并核对已 Claim/首次 Claim pending 状态、复制指纹及访问材料清除。最终无未解决的阻断问题；未循环旧后端 review。

## Studio 实际验证与清理

主机为 Mac Studio / Apple M5 Max / 64 GB / arm64，Node `v24.21.0`、pnpm `10.28.2`。按现有锁文件安装本 clone 的依赖，没有新增依赖、全局安装或更改宿主配置。

实际执行并通过：

- contracts、SDK、controller、GUI 构建；更新后的 GUI 生产构建。
- 上述 4 个相关包的 TypeScript `tsc --noEmit` 检查。
- 迁入原版本 7 个 GUI 测试文件共 48 项；叠加新改动后 7 个文件共 50 项。新增覆盖 pending 的已 Claim/首次 Claim 状态、候选和最后确认期限、缺失指纹提示；既有流程补充指纹复制及归还后清除断言。
- 真实 localhost SDK/HTTP 联合检查：授权目录/预检、幂等申请、ready、Claim、模拟接用材料、确认续租。暂停测试夹具的续租裁决后，HTTP 202 pending 维持原 Lease 截止；恢复裁决后，原提案确认，版本和截止与原候选一致。
- Chrome 浏览器连接同一真实控制器和 GUI，实际验证申请/预检、Claim、手动续租后的期限更新、`SSH 主机指纹：SIMULATOR_ONLY`、双确认归还、服务端确认 released/清理完成，以及访问材料消失和退出测试会话。另一次真实 pending 在浏览器显示候选版本/期限、最后确认期限和禁用续租按钮；该提案在人工暂停裁决期间超过真实裁决截止，恢复后按原合同终止为 lease_expired 并完成清理，页面没有把候选期限承诺为延期。

联合验收使用工程已有 `buildApp`、真实 SDK、SQLite、领域/应用服务和 `PersistentSimulator`，测试夹具以真实墙钟驱动、仅暂停/恢复续租裁决来观察 pending。服务仅监听 `127.0.0.1:3000`，使用全新临时目录及现有 `init-simulator` 测试身份；不使用用户原数据库或真实凭据。该夹具不等于生产 server 的后台循环时序验收。

最终账本核验：两张 Ticket 均 released / cleanup complete，两份 allocation 均 desired absent / observed absent / cleanup complete，两份容量 claim 均 released；Simulator 资源对象剩余 0。服务已停止，临时账本、Simulator 目录和一次性测试身份文件已删除；前次夹具启动产生的自有临时目录也已清理。没有真实 Portainer 分配/销毁、SSH 连接、NAS/媒体修改或实际离线租约强制执行。

格式及 Git diff 检查在最终提交前执行。用户已授权验证后 commit/push `codex/hitchlet-cloud-usability`，不授权 main、force、merge 或部署；最终远端 HEAD 和工作树回执由提交推送后的会话结果记录。

## 后续范围与 Codex 会话

审计 `AUDIT-USABILITY-2026-11-02.md` 是保全的历史审计；其中后端/SDK缺口已由云原提交接续，GUI 指纹/pending 缺口由本轮补齐。旧 media worker、自动续租消费策略和媒体/Vesta 接入不在本轮实现范围，消费者仓库及其未提交改动没有迁入，不能声称媒体业务已可用。

侧栏 Hitchlet 项目尚未创建，不能因此阻断仓库开发。原生 `com.openai.codex` 路径曾被安全拒绝，不能重试或修改应用数据库/私有配置。当前为正常 create_thread 创建的本地 projectless 会话《Hitchlet Studio 开发接续》，threadId `01a19ae0-f34c-78f0-86ce-5ba02c9eaf26`、hostId `local`，尚无 Hitchlet projectId。会话默认 cwd 与独立 Hitchlet clone 的工程 cwd 不同；所有工程命令必须显式以该 clone 为 workdir，不能冒称会话已绑定侧栏项目。

原需求会话为 MBP `01a152e2-6a1e-73f0-b764-8ad4268d2aeb`《梳理 OpenClaw 视频和音乐流程》。MBP 原工程和会话继续保留，后续集中在 Studio 开发。
