# Tart 本机驱动：源码与夹具阶段

用户已选择优先支持 Tart。当前只交付 Runtime Agent 内独立的 `src/drivers/tart.ts` 和受控假 CLI 测试；它尚未注册到 Controller、Node 能力发布、Ticket 申请或 GUI。SDK/CLI 的公共 VM 租用能力仍未交付，不能把本驱动返回的运行/IP 观测当作租客 `ReadyEvidence`。

## 当前边界

驱动固定通过绝对可执行文件和参数数组调用本机 CLI，使用显式专用 `TART_HOME` 和独立的持久 manifest 目录；关闭 Tart 自动缓存清理。仅接受专用 home 内已经准备好的本地模板名，不下载 OCI 镜像，不安装 Tart，不使用 overwrite、快照池或通用脚本执行。

本机执行模型限定 macOS/arm64，客体配置只识别 `darwin`/`linux` 与 `arm64`。这不代表两类客体已经过实际硬件验证。模板记录包含目录身份和配置摘要；配置摘要不是整份 VM 磁盘的制品 digest，也不证明镜像来源、工具环境或磁盘内容保持不变。

计划以 allocation、generation、owner 及 CPU/内存规格绑定持久记录。clone 前记录意图，完成后记录本地实例身份；恢复时核对实际 home、目录、MAC、OS/架构与资源配置。同名对象不等于自有。遗留的无实例身份 clone 意图保持 unknown，不能自动再建或删除；clone 已发生但身份记账前中断的情况仍需后续受控对账，当前模块不能自动完成这类遗留回收。

固定本机生命周期为 clone、set、run、IP 观测、stop、delete。前台 `tart run` 单独监管，不套用短命命令的超时。销毁前后核对归属与状态，CLI 清单和目录清单不一致时保持 unknown；只有查实不存在才返回 absent。CLI 失败会抛出固定脱敏错误并保留已有 manifest；调用方须继续追踪，不能把异常当作无副作用。关闭驱动不隐含释放、删除 VM 或退还 Claim，只报告最近一次观察到的自有运行对象，报告本身不是最新完整库存。

使用方必须确保一个专用 home 和 manifest 目录同时只由一个管理进程持有。本阶段没有跨进程执行权租约，也没有控制端 epoch/controlVersion 的远程协议；它不是可直接启用的宿主服务。不要将它指向日常 `~/.tart` 或用户现有 VM 目录。

## 可重复验证入口

使用仓库已有 Node 24 和 pnpm 10.28.2 依赖：

```sh
pnpm --filter @hitchlet/runtime-agent exec vitest run test/tart-driver.test.ts
pnpm --filter @hitchlet/runtime-agent typecheck
pnpm --filter @hitchlet/runtime-agent build
```

测试只在临时目录运行受控假可执行文件和 Node 子进程，不调用真实 Tart、不创建 VM、不联网。目标平台 fixture 与非目标平台拒绝/跳过行为以测试结果为准；不把一次 Studio 运行称为 Windows/Linux 宿主验证。

CLI 参数和磁盘布局依据 [官方 Quick Start](https://tart.run/quick-start/)、[Clone](https://github.com/openai/tart/blob/main/Sources/tart/Commands/Clone.swift)、[Set](https://github.com/openai/tart/blob/main/Sources/tart/Commands/Set.swift)、[Run](https://github.com/openai/tart/blob/main/Sources/tart/Commands/Run.swift)、[List](https://github.com/openai/tart/blob/main/Sources/tart/Commands/List.swift) 和 [VMStorageLocal](https://github.com/openai/tart/blob/main/Sources/tart/VMStorageLocal.swift) 核对。它们不是本机已安装版本的兼容性证明；真实部署需锁定实际版本再核验。

## 下一步最小闭环

1. 通过本机版本和受控模板实测，核对无人交互启动、宿主重启后的可恢复性、磁盘独立与资源读回。当前执行器 PATH 和常见安装路径未发现 Tart；本轮没有安装或接受新许可。
2. 选择一个明确的 macOS 或 Linux arm64 模板及不可变制品版本，定义每票身份初始化、短期 SSH 材料与指纹交付、输出保存方式。模板应先固定为停止且一致的受控模板，并验证其版本与磁盘内容。模板默认密码不能替代该合同。先完成一种客体，再扩第二种。
3. 实现 VM 专属的最小网络/初始化证据，接入现有账本、Claim、租约和恢复。当前 Docker 的 `docker_iptables`/bridge 证据不能直接复用为 VM 合格证明；默认 NAT、获得 IP 或 clone 成功均不足以发布可租用能力。
4. 正式单票申请到连接、续租、归还并查实磁盘/VM 回收后，才发布对应 OS+arch 能力并开放公共入口。租客代码版本、业务与结果质量由消费者管理，Hitchlet 只交付通用环境与生命周期。

本批不安装 Tart、不下载镜像、不生成认证材料或修改网络/安全设置；真实验收前必须把这些动作的具体范围说清。Hyper-V、Windows 原生、影音消费者和 Vesta 集成不在本批。Controller 离线硬到期停止仍不支持，本驱动没有改变该边界。
