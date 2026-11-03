# 下一阶段：环境能力 → Tart 实机 → Vesta 首个消费者

基线 `cd2ae99` 已推送并核对远端。独立 guest OS、实际 OS 回执、平台选节点、内部实现登记、显式 registered 组合及 unsupported/暂时不可分配语义已实现。Docker 旧消费者保持兼容。Studio 在线部署没有自动更新；既有运行证据不能冒充本次新组合的实机验收。

## 1. 当前可独立完成的验证

扩展既有受控账本测试：同一公开镜像版本同时登记 Linux container 与 macOS ARM64 VM 制品；消费者只给类型和 guest OS，不给后端/Node/Machine；同一组 Ticket/worker 服务选择对应实现。VM 经恢复回收后，停用的 Tart 连接不影响容器申请；两种资源各自回收到 Claim 0。

这两种网络模式的测试使用假 Tart runtime/SSH 和 PersistentSimulator 容器，验证合同与路由，绝不算真实 Docker+Tart 混合运行。复用原生命周期、故障恢复和独立 cleanup 用例，不另建测试平台。

新增 Docker Engine 继续走 Portainer 发现、Node 登记、镜像制品验证和授权目录，无须让租客选宿主。未来新 VM 后端需要自己的 ExecutionPort、真实能力/模板/访问取证以及内部身份登记；不实现动态插件加载器。

## 2. Tart macOS ARM64 首张实机票

当前只读核查确认宿主 Darwin ARM64；PATH、常见 Homebrew 可执行入口和 Applications 入口没有找到已安装 Tart。专用验收根未创建。卷当时可用约 255 GiB；这不是空间预留承诺。当前执行沙箱读取 CPU/内存总量返回 EPERM，实际运行前需用正常只读宿主信息核对，不能凭计划预算推定可用资源。

沿用 [已有实机方案](TART-STUDIO-ACCEPTANCE-PLAN.md) 的固定来源与候选版本，下载前复核实际摘要与许可：Tart 2.41.1；macOS Tahoe base 的已记录 OCI digest；约 26.4 GB 压缩层；单 VM 4 vCPU / 8 GiB / 50 GB，宿主空间预算 100 GiB。它们是已记录候选，不是已安装模板或最新版本声明。

实际执行前需要明确的范围只有：

1. 获取/使用上述工具与 macOS 镜像，确认对应许可；只放专用验收根，不接管日常 TART_HOME。
2. 准备一个 macOS ARM64 模板：GuestAgent、Node 24、已有 admin 账户的 guest 内 sudo 和准备标记；停止后按既有封存命令生成真实本地 bundle digest。上游 OCI digest 不冒充准备后模板摘要。
3. 原生 macOS Runtime 使用现有 HTTPS+mTLS 协议。若没有可复用的专属身份，则需仅本次测试的短期 Runtime token/证书以及票据 SSH 材料；限定 loopback 监听、专用保护目录和验收期限，回收后撤销/删除，不复制生产身份。当前没有创建这些材料。
4. 在专用测试账本按正常管理流程发现、登记 Node、提交真实三项基础资格及镜像 validation/publish，然后最多一张合成 Ticket 验申请、SSH 指纹与认证、规格、confirmed 续租、恢复、保存输出、归还和实际缺席/Claim 0。

默认 NAT；不安装 Softnet，不修改 DHCP、宿主防火墙、VPN、家庭路由或公网端口，不要求隔离家庭 LAN。NAT 不提供强网络隔离。工具、模板、认证和 VM 运行均未在本轮执行；需要具体授权的动作不以源码通过代替。

## 3. Vesta 首个 VM 消费

Tart 基础实机闭环通过后，从一个 macOS ARM64 CLI/smoke 开始。Vesta 当前是多个独立仓库/分支工作区，不能自行选择或混合它们的 revision。

Vesta 线提供：待测仓库与固定 commit/必要 patch 摘要、Node/包管理器/构建工具配方、一条有界命令、业务通过标准、需回传的日志/报告/小制品。先用 SSH/SFTP 传固定源码包，避免为 guest 配新的长期 GitHub 登录。依赖优先封进模板或明确准备，不让每张测试票都安装整套环境。

Hitchlet 提供：环境/OS/架构/资源匹配、Ticket、短期 SSH 交付、续租/恢复、资源回收。Vesta 负责执行命令、判断测试结果、组织矩阵与业务重跑。回执同时记录实际 OS/arch、源码 commit、工具版本、退出码与产物 hash；保存后再归还。

不把 VM 启动成功当作 GUI 登录/桌面自动化可用。GUI、签名、公证、真实外部账号及长任务另按测试目标确定，不提前加入基本 CLI 租用门槛。

## 4. 后置项与收口标准

- Linux ARM64：先补 Tart Linux 初始化/访问配方，再按该 OS 实机验收，当前不可租。
- 家庭 x86_64 Windows：随后实现 Hyper-V 的 Windows guest 最小创建、初始化、访问、恢复、销毁；Linux amd64 另验。WSL Linux 不算 Windows 原生。
- macOS/Windows/Linux 是 guest OS，ARM64/amd64 是 CPU 维度；不承诺跨架构模拟，也不要求一次做全矩阵。
- 影音业务由其消费者线推进，不加入 Hitchlet 或 Vesta 测试编排。旧音乐/电影工具能力不等于当前远端编排已恢复。
- 每阶段一条真实可用闭环和明确证据即可收口；离线强到期硬停、快照池、自动扩容和长期生产部署不作为本轮前置。
