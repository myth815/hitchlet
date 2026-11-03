# Studio Tart NAT 单票实机验收准备（未执行）

用户已明确选择家庭受信任任务默认 NAT，Softnet 可选。不要求为基本 VM 租用取得强隔离网络资格，不修改家庭路由、VPN、宿主防火墙或 DHCP。

## 当前阻塞与实际边界

- 本批仅源码/受控夹具；没有安装 Tart、下载 VM layers、生成真实凭据或启动 VM。
- 已按用户明确批准移除 `EXECUTION_MODE=tart` 的无条件启动拒绝；默认模式仍为 disabled，未启动真实服务或 VM。入口可配置不等于已完成实机租用验收。
- 实机仍需真实工具/模板和基本三项资格。未知、未经验证不作为成功；资格只核实际声明，不要求 NAT 证明 firewall/peer/IPv6 强隔离。
- NAT 可使用宿主可达的网络；不限制 guest 访问家庭 LAN、宿主或其他可达设备。不自动开放公网端口，也不桥接 en0/vlan277 或复用现有业务桥。
- Tart 平台托管挂载尚未实现；不将其说成安全禁令。首轮通过 SSH/SFTP 输入输出；如要验证 NAS，仅使用另行明确的专用合成路径，不扫描媒体库。

## 工具、模板和资源

- Tart 2.41.1 官方 release，保留原 `tart.app/Contents/MacOS/tart` 及签名/profile。此前已核 archive SHA256：`e680a734febccfce7d4e910c1f7f13fc3b00f19a181c945e2d746de3214c32c2`。
- 官方 Quickstart 的 `ghcr.io/cirruslabs/macos-tahoe-base` 候选，已核 OCI manifest `sha256:4aaa751fa7538902d73c767f27a066fc87e83f183069da4e4b5022863abd4c77`，约 26.4 GB 压缩层；未下载。镜像中的 GuestAgent、Node 24 和固定初始化前提须实际核验；准备后封存本地 digest。
- 工具许可按固定版本 FSL-1.1-ALv2、macOS guest 按 Apple 对应 SLA 核对。没有在本轮接受新许可。
- 单 VM 4 vCPU / 8 GiB / 50 GB base disk，scratch 为 best-effort；宿主空间预算 100 GiB。最多一个活动 VM，准备/validation/租客顺序运行，不做整机压力测试。
- 专用根 `$HOME/Library/Application Support/Hitchlet/tart-studio-acceptance`；manifest/journal 放在可删除 VM bundle 之外。不得指向现有 home-services、Vesta 或日常 `~/.tart`。

## 最小验收

1. 在具体安装、镜像/许可和临时认证范围获准后准备模板；不安装 Softnet，不申请其 SUID/root，不改 bootpd。
2. 通过既有管理 API 登记 Runtime/Node，可信身份和 sealed template 匹配；仅提交真实 resourceLimits、sshBootstrap、cleanupRecovery 三项，`networkMode` 默认为 `trusted_nat`，不伪造网络资格。沿用既有本机认证流程；新认证若必要先列范围，不复用生产秘密。
3. 正常 SDK/GUI 一张 Ticket：默认 NAT → ready → claim → 校验 host fingerprint 后 SSH。核独立 VM、账户、CPU/内存、工作区，以及合成输入/输出。
4. 在已批准目标上验证实际需要的网络可达（如少量 HTTPS；NAS 另明确测试路径）。不是要求所有工作负载都离线，也不声称已验证强网络隔离。
5. 续租一次等待 confirmed；受控重建 Runtime，仍观察原 VM，不重复申请；输出复制回专用 outputs 并核 hash 后 release。
6. 停止失败或盘点未知保持原票/Claim；恢复后查实本票 VM 已停止、删除且不存在、Claim 0、输出保留。只清本次资源，保留/停止模板与缓存状态明确记录。

## 可选强隔离

只有显式选择 `policy.tartMode=isolated` 才使用 Softnet。其 root、宿主 DHCP 改写及 rollback 必须单独具体批准；既有六项强隔离证据、策略读回和网络回收合同保留。它不再是完成 NAT 验收的前置。

不覆盖真实影音/Vesta 作业、Windows 原生、Linux guest 初始化、长期部署和 Controller 离线严格到期硬停。
