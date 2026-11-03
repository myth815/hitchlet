# 下一阶段：复用 macOS / Linux ARM 已验闭环

## 已完成与当前运行状态

`a809d49` 已完成 Studio Tart 2.41.1 / Tahoe macOS ARM 的真实资格、正常镜像验证发布和一张 Vesta CLI Ticket：固定 `6eeaf784` 的指定测试 pass 1 / fail 0；SSH 指纹、confirmed 续租、结果 hash、原生 absent / Claim 0 均有证据。见 [实机记录](TART-STUDIO-CLI-ACCEPTANCE-2026-11-03.md)。临时栈和认证已清理，工具/模板/缓存保留，不是当前常驻可租服务。

Ubuntu 24.04.5 Linux ARM 也已完成固定初始化与真实资格/发布/单票 CLI，见 [Linux 实机记录](TART-LINUX-ARM-ACCEPTANCE-2026-11-03.md)。同一固定 CLI 用例 pass 1 / fail 0，原票恢复归还后 native absent / Claim 0；临时栈已关闭。两种 OS 分别为独立临时验收，没有部署常驻混合目录。

租客按环境类型、guest OS、CPU 架构、资源和逻辑版本提出要求，默认由平台选择实现和节点；实际放置从公开回执读取。无能力与暂时容量不足分开。Docker 原有消费者保持兼容；旧 `0039abe` 服务不自动具备新请求字段。

`bd6a6b0` 已改进公开示例的显式资源/租期参数、实际交付投影、取消终态与未知结果恢复，以 localhost Simulator 定向回归；随后本批按明确授权完成 Linux 初始化和实机。可重复操作见 [VM CLI 配方](VM-CLI-TEST-RECIPE.md)。Vesta 的源码/测试矩阵、命令及业务结果仍由消费者组织，不加入 Hitchlet 调度器。

最新跨消费者现状、已完成的小修和需具体安排的事项统一见 [消费者接入现状](CONSUMER-READINESS.md)。新 Go Docker 租客已完成一张纯合成票并正常归还，见 [Go 验收](DOCKER-GO-ACCEPTANCE-2026-11-04.md)；旧 0039 基础包加 d0128a8 窄修的兼容部署不等于最新完整版本部署。

## 直接后续

1. 消费者复用配方，从当前授权 catalog 取 IDs，固定源码和短任务预算；先 confirmed 续租、按指纹接用，保存回读结果后正常归还或明确取消。旧 token/测试 IDs 不当持久服务入口。长任务续租监督由消费者实现，不用无限调大 SSH timeout。
2. Linux 基础初始化已完成，不重复施工或重跑全部实机。按具体消费者选下一条现有测试；需要常驻服务或同一部署的多模板目录时，先核实际注册/共享预算与模板资格接线，避免直接拼两份临时栈结果宣称上线。其他 Linux 发行版、VM 挂载和 GUI 桌面仍按真实需求安排，不作为普通 CLI 前置。
3. 需要下一张真实票时，只启动已明确范围的专属服务；新的镜像下载、guest 准备和临时认证按该次具体范围处理，不修改宿主 DHCP / firewall / VPN，也不增加 Softnet 总闸。

## 影音与后置平台

影音线已确认正常 catalog/preview、SSH/SFTP、持久存储、confirmed renew、release / waitUntilReleased 足够。AI 可按任务组合成熟 CLI，平台不吸收旧 OpenClaw 流程。媒体源码修正后需新的真实制品身份；registry、NAS、服务凭据和业务数据按实际任务处理，不借合成目录扩大授权。本批不运行媒体或改现有服务。

Windows x86_64 / Hyper-V 后置；WSL Linux 不等于 Windows 原生。其他 Linux 发行版、完整 Vesta 应用/GUI矩阵、VM 平台挂载、Softnet 强隔离、长期部署和 Controller 离线严格到期强停均未因 macOS 单票而完成。每批一个实际交付和明确边界即可收口，不先做快照池或通用编排框架。

已实现原Studio启动入口的--check/--resume复用行为与当前consumer catalog交接，见 [可重复启动](STUDIO-REPEATABLE-START.md)。Hyper-V的实际组件状态及唯一系统前置见 [Windows核查](HYPERV-PREPARATION-2026-11-04.md)，未擅自启用。

Vesta新版本`5e6dba54f`的governance text三项已在真实Ubuntu ARM VM完成，见[新单元格](VESTA-GOVERNANCE-VM-2026-11-04.md)。原票回收、Claim0、临时服务/认证清理均完成；不用继续等选测试或重跑旧用例。后续以实际新消费者需求与部署收口为准。

Hyper-V原生生命周期内核源码已完成，见[内核边界与验证](HYPERV-NATIVE-KERNEL.md)：原ID恢复、未知不重导入、精确VM/磁盘回收及跨allocation独立推进已有受控证据；内部[认证Runtime server/client](HYPERV-RUNTIME-TRANSPORT.md)已有受控接线；内部[ExecutionPort/guest握手](HYPERV-PROVIDER.md)已补受控实现；Windows启动组合、原生guest SSH和正式管理发布未完成，不向消费者宣称Windows可租。
