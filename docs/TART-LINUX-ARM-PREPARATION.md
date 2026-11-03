# Tart Linux ARM：源码与实机准备

状态：只读公开文档/小型镜像元数据及本仓代码；未下载 VM 磁盘、安装、启动 VM、创建认证或改变网络。

## 已有能力与缺口

Tart 的 clone / run / IP / native ownership / inspect / destroy 已按 template guest OS 表达 Linux 或 Darwin；Controller resolver 能核 Linux/arm64 sealed proof，SSH readiness 已能核 Linux/aarch64。公开租客请求已经将 `kind=vm`、`guestOs=linux`、`allowedArchitectures=[arm64]` 分开表达，不需要增加 Linux 专用租客 API。

尚不能在 Hitchlet 正式租用 Linux：

- `apps/controller/src/providers/execution-registry.ts` 的已注册 Tart 实现目前只交付 macOS；这是当前初始化实现边界，不是默认网络安全限制。
- `apps/runtime-agent/src/drivers/tart.ts` 的 bootstrap 固定 `/opt/homebrew/bin/node`。
- `tart-guest-bootstrap.cjs` 只接受 darwin/arm64、macOS 准备标记，管理 guest launchd/sshd；Linux 需要对应固定 Node 路径、状态根和 systemd/OpenSSH 初始化。
- 没有 Linux guest 的三项真实资格、镜像验证发布和租客票证据。不能先移除 OS 判定来让模板“可选”。

最小源码顺序：保留同一 allocation/owner/generation/controlVersion/nonce/public-key 回执合同，增加 Linux 固定初始化配方；用受控依赖验证 Linux sshd 启停、同请求恢复及错误身份拒绝；在 Linux 初始化接线完成后才登记该 OS 为可交付。复用现有 NAT、Claim 和回收，暂不做挂载、快照池或 Hyper-V。

## 官方候选与已读元数据

官方 [Quick Start](https://tart.run/quick-start/) 列出 Ubuntu、Debian、Fedora 的 Linux 镜像。官方 [Linux 模板 playbook](https://github.com/cirruslabs/linux-image-templates/blob/main/playbook.yml) 安装 Linux Guest Agent；[Guest Agent 构建配置](https://github.com/openai/tart-guest-agent/blob/main/.goreleaser.yml) 有 linux_arm64 产物。这说明有可复用的上游路径，不证明本次固定镜像里的实际工具版本、GuestAgent RPC 或 SSH 已可用。

2026-11-03 只读解析 `ghcr.io/cirruslabs/ubuntu:latest` 并核小型配置的 SHA，固定候选为：

- `ghcr.io/cirruslabs/ubuntu@sha256:fb693c6ba8df94b4d89fa1d66b5eeb53a2bbcd66f8437d0b635099cd8906282d`
- OCI config：Linux / arm64；VM config：4 CPU、4 GiB、20,000,000,000 字节逻辑盘。
- 压缩 layer 引用合计 3,057,758,523 字节；去重 blobs 合计 3,005,591,787 字节。
- 本次仅取 manifest 13,932 字节、OCI config 99 字节、VM config 211 字节；没有取 disk layer。guest 发行版具体版本、Node、sudo 和 GuestAgent 状态须运行时核实。

源码模板采用 MIT，Guest Agent 固定版本许可和镜像内软件声明在选定版本时核对；不在本次自动接受新的法律协议。现有已签名 Tart 2.41.1 可作为工具候选，不需要先装另一套虚拟化平台。

## 后续真实运行需要的具体范围

源码配方完成后，再明确批准：下载上述约 3 GB 的固定候选到专用 TART_HOME；准备 guest 内 Node 24 / GuestAgent / OpenSSH 固定路径；最多一台默认 NAT 的 Linux ARM VM，起步 4 vCPU / 4 GiB，20 GB 基础盘（如需扩盘另说明目标），预留专属约 40 GiB 宿主空间；通过正常节点资格与镜像验证发布，跑一张小 CLI 票并查实回收。

临时 loopback Runtime 认证沿既有模型，结束停止服务并清理无自动 TTL 的 token/密钥；本次没有生成。无需 Softnet、宿主 DHCP、防火墙、VPN、长期 GitHub 登录或新的宿主系统服务。若实际模板缺工具，可只在本次 guest 内按固定官方来源补齐，具体下载和许可在执行前列清。

macOS ARM 已通过的结果不替代 Linux；Linux ARM 也不会变成 x86_64 或 Windows 原生资格。
