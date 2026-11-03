# 下一阶段：复用已验租用接口，准备 Linux ARM

## 已完成与当前运行状态

`a809d49` 已完成 Studio Tart 2.41.1 / Tahoe macOS ARM 的真实资格、正常镜像验证发布和一张 Vesta CLI Ticket：固定 `6eeaf784` 的指定测试 pass 1 / fail 0；SSH 指纹、confirmed 续租、结果 hash、原生 absent / Claim 0 均有证据。见 [实机记录](TART-STUDIO-CLI-ACCEPTANCE-2026-11-03.md)。临时栈和认证已清理，工具/模板/缓存保留，不是当前常驻可租服务。

租客按环境类型、guest OS、CPU 架构、资源和逻辑版本提出要求，默认由平台选择实现和节点；实际放置从公开回执读取。无能力与暂时容量不足分开。Docker 原有消费者保持兼容；旧 `0039abe` 服务不自动具备新请求字段。

本批改进现有公开示例的显式资源/租期参数、实际交付投影、取消终态及未知结果恢复，使用 localhost Simulator 定向回归，没有再次启动 VM。可重复操作见 [VM CLI 配方](VM-CLI-TEST-RECIPE.md)。Vesta 的源码/测试矩阵、命令及业务结果仍由消费者组织，不加入 Hitchlet 调度器。

## 直接后续

1. 消费者复用配方，从当前授权 catalog 取 IDs，固定源码和短任务预算；先 confirmed 续租、按指纹接用，保存回读结果后正常归还或明确取消。旧 token/测试 IDs 不当持久服务入口。长任务续租监督由消费者实现，不用无限调大 SSH timeout。
2. Tart Linux ARM 先完成 Linux 固定初始化（Node 路径、systemd/OpenSSH、原有身份/回执）及受控恢复回归，再登记可交付 OS。候选 manifest、大小和真实运行具体范围见 [Linux 准备](TART-LINUX-ARM-PREPARATION.md)；本次未下载磁盘、安装或运行 Linux VM。
3. 需要下一张真实票时，只启动已明确范围的专属服务；新的镜像下载、guest 准备和临时认证按该次具体范围处理，不修改宿主 DHCP / firewall / VPN，也不增加 Softnet 总闸。

## 影音与后置平台

影音线已确认正常 catalog/preview、SSH/SFTP、持久存储、confirmed renew、release / waitUntilReleased 足够。AI 可按任务组合成熟 CLI，平台不吸收旧 OpenClaw 流程。媒体源码修正后需新的真实制品身份；registry、NAS、服务凭据和业务数据按实际任务处理，不借合成目录扩大授权。本批不运行媒体或改现有服务。

Windows x86_64 / Hyper-V 后置；WSL Linux 不等于 Windows 原生。Linux ARM、完整 Vesta 应用/GUI矩阵、VM 平台挂载、Softnet 强隔离、长期部署和 Controller 离线严格到期强停均未因 macOS 单票而完成。每批一个实际交付和明确边界即可收口，不先做快照池或通用编排框架。
