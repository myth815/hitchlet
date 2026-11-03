# Studio Tart 单票实机验收方案（未执行）

目标是一个 macOS arm64 租客 VM 的申请→连接→续租→保存输出→归还/查实回收。本文是可审批范围，不是成功报告。2026-11-02 本轮只读核查、官方 release/registry 元数据查询和受控源码测试，没有安装工具、下载 VM layer、创建真实认证或改变网络。

## 已核事实与还缺的源码

Studio：macOS 27.0.1 (26A434)、arm64、18 核、64 GiB、硬件虚拟化标志 1；本地卷可用约 262 GiB。Tart 未在 PATH、常见 app/brew 路径或 brew 已装列表中发现，默认 `~/.tart` 也不存在。只读查询时 33510/33511 未监听；最终启动前应复查。静态容量不是实时负载保证，真实 Tart 与该宿主版本的兼容性尚未验证。

已具备独立 Runtime 入口、可信通道、guest helper、SSH probe 和管理发布源码。本批已补网络计划/Softnet 控制 FD/策略读回/回收与 Controller composition 的受控源码，细节见 [网络接线](TART-NETWORK.md)。当前 `EXECUTION_MODE=tart` 启动 guard 保留，源码已接入 observation 后台刷新；真实工具、来源映射、正反流量、停止回收及受控部署仍未验收。丢失原控制 FD 后不会自动接管，这项恢复边界仍需实机确认，不能写成只等安装批准。

首轮推荐仅 Studio 上的租客客户端/Controller 主动连接 guest:22；这是租客 SSH 入口，不允许 guest 主动连接宿主:22，也不是 Runtime 管理通道。Runtime 管理仍为 localhost HTTPS 33511。VM 不主动访问外网/管理服务/peer，ipv6 disabled。现有公共合同只有字面 CIDR，本批直接编译这些 CIDR，不使用 `@host` 动态别名。实机前应观察 Studio 客户端连接 guest 时的真实来源，冻结对应 IPv4 `/32` 并核对来源保真；变化则拒绝而不扩大范围。没有观测前不填写 127.0.0.1 或猜网段，不需要新增公开 source 类型。

## 必须保留的合同与 Docker 实现差异

[现有设计 §14.1–14.2 网络策略](design/README.md) 的要求是结果：默认拒绝、只有授权来源可访问声明入口、只允许 profile 明示 egress、平台管理拒绝优先、IPv6 等价执行或关闭验证、按 allocation 持久归属与恢复、规则在租客网络暴露前生效。来源地址要保真并与冻结允许范围对应，不能将 NAT/proxy 后的其他来源默认为已授权。Tart 的 `isolated_vm` 只证明独立 guest kernel，不自动包含这些网络保证；SSH 公钥认证也不等于来源 CIDR 限制。

Docker 的专用 bridge、iptables INPUT/FORWARD/DOCKER-USER、conntrack、Docker/Portainer 版本、userland proxy 和容器网卡名字是实现方法，**不应成为 Tart 前置条件**。六 scope 的旧名称可在现有报告格式中解释为相应实际效果，不能要求 VM 伪造 Docker 链或报告 Docker 版本。VM CPU/内存按实际配置与 guest/宿主观测验证，无需硬套 cgroup 计量；磁盘只有 best-effort，不宣称硬配额。

Softnet 是当前官方工具链中可控制方向/来源/目的地/端口的最小候选，不是 Hitchlet 合同指定依赖。普通 Tart NAT 可以提供 IP/SSH 连通，但未证明上述来源和 egress 边界；因此不能直接替代。首轮 host→guest:22、无主动 egress、IPv6 disabled 已足够，无需 NAS allow、共享文件夹或全网探针。仍需验证非允许路径不可达和恢复顺序，不把“macOS VM”当作隔离取证。VM 的可信身份应绑定实际 Tart 后端、本票 VM/MAC/目录与自有控制通道，不要求存在 Linux network namespace。首轮 egress=[] 只验证无主动出口，不声称已经实测允许 egress 的正例。

当前源码会在 run 前校验冻结网络计划与 adapter，并携带限制启动；策略读回绑定本票 VM/进程/控制 FD。它不等于实际流量资格。丢失原 FD 后不自动接管；连接停用或模板证明失效后的精确已登记资源清理已有专用源码路径，要求持久 cleanup Operation、有效认证和 native 身份匹配；这不授予新建/启动权限。server 有 Tart observation 后台刷新；启动恢复与租约/清理快车道并行，初始恢复未完成前不会预留新租户任务。Tart execution guard 仍关闭。这些边界须在启用前明确，本批没有用合成资格删除启动 guard。

## 固定工具与镜像候选

| 项目           | 官方候选与校验                                                                                                                                                                           | 实际状态                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Tart 2.41.1    | [release](https://github.com/openai/tart/releases/tag/2.41.1)，`tart.tar.gz` 22,959,557 bytes；SHA256 `e680a734febccfce7d4e910c1f7f13fc3b00f19a181c945e2d746de3214c32c2`                 | 只查元数据，未下载/运行                                                               |
| Softnet 0.25.0 | [release](https://github.com/openai/softnet/releases/tag/0.25.0)，`softnet.tar.gz` 6,152,707 bytes；SHA256 `5a2e8ef779f0a2169b88d273ee806c0d64321ec7714c0dc99bf217523ae9b008`            | 只查元数据，未授权 root                                                               |
| macOS base     | [官方 Quickstart](https://tart.run/quick-start/) 所列 `ghcr.io/cirruslabs/macos-tahoe-base`；固定 OCI manifest `sha256:4aaa751fa7538902d73c767f27a066fc87e83f183069da4e4b5022863abd4c77` | 只读 manifest 校验一致；96 layers 共 26,392,647,081 compressed bytes，下载 layer 为 0 |
| guest Node     | [Node 24.21.0 官方包](https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz)，SHA256 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`                     | 仅在 guest 缺 Node 24 时准备；未下载                                                  |

Tart 必须运行原 app 内 `tart.app/Contents/MacOS/tart`，保留签名和附带 profile；不提取独立 binary。查询时 Cirrus brew 配方仍指向较旧版本，不能用未固定 `brew install/upgrade` 替代。上游 VM 的虚拟盘注解为 50,000,000,000 bytes；实际 guest OS/arch、GuestAgent、sudo、工具和可启动性仍需实测。准备后的本地 sealed bundle digest 当前未知，不得拿 OCI digest 代替。

这两个固定工具版本各自 [Tart LICENSE](https://github.com/openai/tart/blob/2.41.1/LICENSE)、[Softnet LICENSE](https://github.com/openai/softnet/blob/0.25.0/LICENSE) 是 FSL-1.1-ALv2，应按对应版本条款核对内部开发试用；旧网页 Fair Source/核心数说明不能替代实际 LICENSE。本次没有接受许可或购买授权。macOS guest 还受 [Apple Tahoe SLA §2B(iii)](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf) 约束；该条对满足条件的自有 Apple 宿主上的开发/测试等虚拟实例限定数量，方案最多一台运行 VM，不登录 Apple Account/iCloud/App Store。

## 资源、路径与认证

建议专用根 `$HOME/Library/Application Support/Hitchlet/tart-studio-acceptance`，其下分开 `tools`、`controller`、`runtime`、`tart-home`、`manifests`、`template-registry`、`reports`、`outputs`、`certs`；私有目录 0700，秘密文件 0600。manifest/journal 不放在可删除的 VM bundle 内，不使用日常 `~/.tart`、现有 Docker/Vesta/home-services 目录或用户账本。

单 VM：4 vCPU、8 GiB 内存、50 GB 虚拟 base disk、1 GiB best-effort scratch 请求；宿主工作空间预算 100 GiB（cache、停止模板、COW clone 和输出）。硬 scratch 配额不承诺，不做压力测试。最多一张 tenant Ticket、一个 tenant allocation；模板准备和资格 validation 如需临时 VM，顺序运行、各自明确归属和清理，不能把它们隐藏成租客票内副作用。资格验证所需 peer 证据未取得则不能填写 passed；不为凑报告额外启动第二台 VM。

Controller 仅 `127.0.0.1:33510`，Runtime HTTPS 仅 `127.0.0.1:33511`，guest SSH 22，不开放公网端口。优先复用已授权专用测试认证流程；若需要为 Tart 独立生成本机 CA、client/server 证书和 bearer token，批准范围应是本次测试专用、证书最多 24 小时、私有文件保存、结束撤销/删除，不复制现有生产秘密。每票租客 SSH key 沿用现有平台 access-material 流程；guest host 私钥留 guest，不发送默认密码或管理私钥。

模板仅在自有 guest 内准备：现有 admin+非交互 sudo、GuestAgent、Node 24 固定路径、准备 marker、关闭模板默认 SSH 以空出 22；不停止未知服务，不修改宿主 sshd。guest helper 为每票独立 sshd 创建归属清楚的 LaunchDaemon，随整个 VM 销毁回收。模板停止后明确封存，记录新的本地 digest，再走正常资格/验证/发布。

## Softnet 的具体权限边界（待批准，未执行）

候选为官方 Softnet 0.25.0。它的 [入口源码](https://github.com/openai/softnet/blob/0.25.0/src/main.rs) 要求 root，支持 SUID 或已有非交互 sudo；本方案不新增长期 sudoers/NOPASSWD。若采用临时 SUID，应限定校验后的专用 binary，root-owned、普通用户不可写，验收后去除 SUID 并移除测试工具；不让整个 Runtime Agent 以 root 运行。这一动作需要单独明确批准。

另有真实宿主影响：Softnet 启动会设置 `com.apple.InternetSharing.default.plist` 的整个 `bootpd` 字典，包含 DHCP 租期 600 秒和忽略 client identifier。它并非仅修改 VM 内设置；当前该文件只读核查为不存在。必须先记录实际原状态与本次写后状态，结束时只撤销可证明属于本次的变更。按原值/本次写值/当前值逐键比较，当前仍等于本次写值时才恢复；并发合法变更保留，存在冲突或删除归属不明时报告，不能整字典覆盖或盲删文件。不得改宿主 VPN、pf/firewall、路由或业务网络。若此全局 DHCP 副作用不能接受，应停止该候选，选择其他后端；默认 Tart NAT 无法自动替代隔离保证。

首轮规则目标：Studio 客户端主动访问 guest TCP 22 可达并允许对应返回包；其他新入站及 VM 主动 egress 默认拒绝，明确覆盖平台管理地址和 peer。Tart/Softnet 规则的方向、状态和来源保真仍须实机正反验证；仅命令退出 0 不够。控制 FD、规则归属、进程退出和网络回收证据必须绑定本次 allocation。本批 driver 已有携带冻结策略的 Softnet 启动源码，默认未启用；未取得真实资格不能正式发布。

## 执行顺序与终态

1. 固定上述网络方案与宿主权限范围，先核清已列的恢复/观测限制，再复查工具/容量/原服务与配置摘要；批准前不运行新工具。
2. 下载校验固定工具与 base、准备一张模板、停止封存；记录实际版本、namespace、本地 bundle digest。失败保留归属，不能伪造资格。
3. 启动本次独立控制栈，实际做资源/网络/SSH/恢复/回收资格。六 scope 中未证实项保持未通过，不把 synthetic 报告投递真实节点；验证 allocation 查实清理后再发布。
4. 正常 public SDK/GUI 单 Ticket 申请、claim，核 API 指纹再 SSH；合成 18 字节输入只读验证，guest `/tmp` 独立输出，核实际 vCPU/内存和 VM 身份；续租一次并等 confirmed。以 20 分钟初租、最多延长一次 10 分钟为预算，整体试验上限 2 小时，超时进入归还/对账而非无限重试。
5. 将合成输出复制到本次 `outputs`，本地核 hash 后才 release；查 Ticket 终态、VM/process/disk/network 临时对象 absent、Claim 0。unknown 不当 released、不盲清未知 VM；仍由原 allocation 跟踪恢复。
6. 清除本次临时凭据、撤销短期管理身份、停止测试基础服务，回滚本次宿主 DHCP/临时特权。保留非秘密报告和合成输出；模板/OCI cache 是否保留应在批准中明确，建议首次试验结束先保留停止模板与 cache 便于后续，不保留运行 VM。

不覆盖：Controller 离线严格到期强停、真实影音/Vesta 作业、NAS、Windows 原生/WSL、Linux guest、长期生产部署、商业服务许可判断。当前源码使用上述 Softnet 候选，实机权限及其宿主副作用仍待具体批准；不需要用户选择新的调度架构。
