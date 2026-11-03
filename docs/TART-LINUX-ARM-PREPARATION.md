# Tart Linux ARM：源码与实机准备

状态更新：本阶段已按用户具体授权执行，固定初始化、28 项定向回归、两项构建及真实 Ubuntu Linux ARM 单票 CLI 闭环均完成，见 [真实验收](TART-LINUX-ARM-ACCEPTANCE-2026-11-03.md)。临时服务/认证已关闭清理；模板和缓存保留，未改宿主安全/网络。下方保留来源与准备顺序，不是仍待执行的同一任务。

## 已有能力与缺口

Tart 的 clone / run / IP / native ownership / inspect / destroy 已按 template guest OS 表达 Linux 或 Darwin；Controller resolver 能核 Linux/arm64 sealed proof，SSH readiness 已能核 Linux/aarch64。公开租客请求已经将 `kind=vm`、`guestOs=linux`、`allowedArchitectures=[arm64]` 分开表达，不需要增加 Linux 专用租客 API。

已完成最小 Linux 配方：

- 内部 Tart 登记支持 macOS/Linux，Windows 仍未实现；不是因为网络安全策略拒绝其他 OS。
- 原生驱动根据持久 template OS 选择 Linux `/usr/local/bin/node` 或 macOS `/opt/homebrew/bin/node`。
- 共同 helper 保留原身份/nonce/回执和 SSH 合同；Linux 使用 `/var/lib/hitchlet`、systemd/OpenSSH，macOS 保留 launchd 和旧私有状态兼容。
- Ubuntu 24.04.5 / arm64 已经过真实三项资格、正常镜像验证发布和单票。仍不外推所有 Linux 发行版或长期部署。

## 官方候选与已读元数据

官方 [Quick Start](https://tart.run/quick-start/) 列出 Ubuntu、Debian、Fedora 的 Linux 镜像。官方 [Linux 模板 playbook](https://github.com/cirruslabs/linux-image-templates/blob/main/playbook.yml) 安装 Linux Guest Agent；[Guest Agent 构建配置](https://github.com/openai/tart-guest-agent/blob/main/.goreleaser.yml) 有 linux_arm64 产物。这说明有可复用的上游路径，来源检查本身不证明镜像可用；随后真实运行已确认该固定镜像的 GuestAgent RPC / SSH、Ubuntu 24.04.5、Node 24.21.0、pnpm 10.28.2。GuestAgent 版本字符串本轮未单独采集，整体来源由固定镜像摘要标识。

2026-11-03 只读解析 `ghcr.io/cirruslabs/ubuntu:latest` 并核小型配置的 SHA，固定候选为：

- `ghcr.io/cirruslabs/ubuntu@sha256:fb693c6ba8df94b4d89fa1d66b5eeb53a2bbcd66f8437d0b635099cd8906282d`
- OCI config：Linux / arm64；VM config：4 CPU、4 GiB、20,000,000,000 字节逻辑盘。
- 压缩 layer 引用合计 3,057,758,523 字节；去重 blobs 合计 3,005,591,787 字节。
- 准备阶段仅读 manifest 13,932 字节、OCI config 99 字节、VM config 211 字节，当时未取 disk layer。随后本次已实际下载该固定镜像；实机版本、sudo、GuestAgent、Node 和回收证据见验收记录。

上游模板源码标注 MIT；本次没有出现或执行需要额外接受的新协议动作。后续升级 Guest Agent/镜像仍按固定来源及其实际软件声明核对。现有已签名 Tart 2.41.1 可作为工具候选，不需要先装另一套虚拟化平台。

## 已执行范围与后续复用

已执行固定候选约 3 GB 下载与专用模板准备，4 vCPU / 4 GiB / 20 GB 基础盘、40 GiB 宿主专属预算、默认 NAT，全程最多一个活动 VM。仅 guest 内补官方 Node/pnpm；使用已有 sudo，不改 sudoers。关闭模板默认 SSH 服务，启用每票 guest 自有 SSH unit；没有宿主安全/网络修改。

通过正常资格和发布，跑一张固定 CLI 票并查实回收。loopback Runtime 临时认证已清理，无自动 TTL 的 token 通过停止唯一服务并删除材料失效；没有长期身份、Host 自启或新系统信任。停止的模板/cache 保留，真实租客 VM 不保留。

下一次复用已有工具/封存模板与 [VM CLI 配方](VM-CLI-TEST-RECIPE.md)；不把历史 token、ID 或关闭的 URL 当在线入口。具体新镜像、永久服务/凭据或宿主安全变更仍按相应动作范围处理。Mac 与 Ubuntu 这两次分别为独立临时栈，不声称常驻混合部署已经上线。

Linux ARM 不等于 x86_64 或 Windows 原生资格；Hyper-V 后置。
