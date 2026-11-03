# Tart Linux ARM：Studio 单票真实验收

2026-11-03 完成。源码已接入 Linux 固定初始化；一套独立临时栈正常完成真实资格、镜像验证发布和一张租客票。临时栈/认证已经关闭清理，当前不提供常驻 VM 租用服务。

## 固定来源与实际环境

- 复用已签名官方 Tart 2.41.1，不在宿主安装其他工具。
- 上游 `ghcr.io/cirruslabs/ubuntu@sha256:fb693c6ba8df94b4d89fa1d66b5eeb53a2bbcd66f8437d0b635099cd8906282d`，约 3.06 GB 压缩层引用 / 20 GB 逻辑盘。
- 准备后 sealed bundle `sha256:3d6cd94e22b5cfe864ea261428bec3b84b1e83210828fe739f59d6dd436a6b8c`，与上游摘要含义不同。
- 真实 guest：Ubuntu 24.04.5 LTS、kernel 7.0.0-42-generic、aarch64 / Node arm64；4 vCPU、4 GiB VM 配置。Linux MemTotal/Node totalmem 为 4,086,214,656 bytes，扣除内核保留，不冒称 guest 可用内存恰等于分配值。
- Node 24.21.0（官方 archive + SHASUMS256 校验）、pnpm 10.28.2；Git 2.43.0、curl、OpenSSH、GuestAgent 为候选镜像已有工具，没有另装这些包。
- 默认 NAT、单台活动 VM、宿主专属 40 GiB 空间预算。准备/资格/制品验证/租客依次运行；不用 Softnet，不改宿主 DHCP / firewall / VPN。

## 源码变更

`tart-guest-bootstrap.cjs` 共用现有身份/owner/generation/controlVersion/nonce、公钥与 host-key 回执、幂等持久状态和 SSH 配置。macOS 保留 launchd；Linux 在 `/var/lib/hitchlet` 保存状态，创建每 Allocation 的 systemd sshd unit，保持 SFTP 和短期公钥认证。Linux unit 仅在临时 guest 内 enable；不是宿主服务安装，VM 销毁后消失。

原生驱动依据持久 manifest 的实际 guest OS 选择固定 Node 入口：Linux `/usr/local/bin/node`，macOS `/opt/homebrew/bin/node`。Controller 内部注册允许实际已实现的 macOS/Linux Tart 组合，不增加 Linux 专用消费者 API；Windows 仍未实现。既有 macOS 私有状态的 plistPath 读取保持兼容。

Linux 模板关闭自己的默认 ssh.service/ssh.socket，准备 Node/标记并清空模板 machine-id，然后 sync、正常关机、封存。真实克隆再次核 machine-id 与模板不同；资格克隆和租客克隆也不同。没有替换宿主身份或长期登录凭据。

定向验证：guest bootstrap 6、原生驱动 16、执行登记 6，共 28 项通过，包含保留的 macOS、同身份恢复、端口占用/未知不假成功和 Linux unit 路径。Runtime 与 Controller TypeScript 构建通过。它们是受控依赖/假 CLI 与本地 Node 进程回归；以下为独立真实 VM 证据。

## 正常控制面与真实 Ticket

通过 loopback mTLS Runtime 发现、禁用节点登记、实际资源/SSH/恢复回收三项资格，再正常制品 validation/publish，无 SQL 伪造。真实 Runtime 重启后识别同一资格资源并精确回收；validation `e23bebd7-3bac-4b7b-a744-adffd7e09ac8` 为 succeeded / passed / cleanup complete。

唯一租客 Ticket `9d8de978-5064-471a-a0dd-931ff19f310a`：只声明逻辑版本、vm、guestOs=linux、arm64、4000 cpuMillis / 4096 MiB / scratch 0 best_effort；未指定节点、宿主或 provider。回执实际为 Tart / Linux / arm64。Claim 与 1200 秒续租 confirmed，SSH 严格核 API host fingerprint 后认证。offlineEnforcement 如实为 not_guaranteed。

消费者通过 Git bundle 固定 CLI `6eeaf78426eb77efbc1a6e28595be5c3adf97743`，tree `0f63cda93f1a555a2af1279905bb9cd28c16acf0`，源 bundle SHA256 `e4e0b36ee0502b681a0f51d9811617ad71997ce90aa96923f21eb08df4091fb1`；guest 重新核 hash / checkout。只准备所需 frozen filtered dependencies（ignore-scripts）、YAML 2.8.3 与 launcher build，执行已有唯一用例：

`tools/cli/test/domain-flow.test.ts` 的 `public CLI closes native shared build, explicit IO, candidate cwd and literal argv in one request`。

命令退出 0，TAP pass 1 / fail 0；TAP SHA256 `b81663a057be85d631dc79cdea27023f8ef310dffe24bb3d43bb07ec22b0e172`。不是完整 CI / Vesta 应用矩阵。TAP、环境、build/dependency 日志、退出码与 manifest 经 SFTP 保存，逐文件 bytes/SHA 与 guest manifest 一致，原始日志仅保留本地验收证据。

## 传输收尾中断与原票恢复

测试与结果保存已经完成后，临时验收 runner 关闭 SSH 时遇到 SFTP ReadStream 延迟错误而退出；不是平台 prepare 或 CLI 测试失败。归还 onPrepared 检查点因中断留空，未把空文件当有效命令。查原票仍为 ready，重新核结果 hash；依据已冻结 generation=1 和原 runner 确定的同一幂等键，由 SDK 重存同一 release 意图后恢复。没有新键、新票或重跑测试。

临时 runner 已补延迟错误处理和原子写检查点；没有把它扩成平台业务调度器。平台结果和测试驱动结果分列保留，未抹去中断证据。

## 实际回收与保留

原票最终 released / cleanupStatus complete。原生 Allocation `80b082b8-c72c-4078-ab4d-b0c2665cd0e4` absent / inventory complete；管理总览 CPU、内存、scratch Claim 全为 0，cleanupBlocked / unknownOperations 为 0。测试节点禁用，33112 Controller / 33446 Runtime 已停止且不监听。

本次 token 没有自动 TTL；停止唯一 Runtime 并删除其 token、CA/客户端/服务端私钥、明文 admin token、master key 与加密 secret-store 版本，使临时通道失效。没有配置系统信任/keychain或宿主自启。停止的 ubuntu-cli-base 与 OCI 缓存保留，租客与资格 VM 均已删除。结果与源输入保留本次专属目录；没有改变现有 Docker/影音服务、NAS 或真实媒体。

## 剩余边界

已证实一套 Ubuntu Linux ARM 与既有 macOS ARM 的同一公开租用合同；不外推其他 Linux 发行版、amd64、Windows/Hyper-V、GUI测试、平台存储挂载、强网络隔离或长期部署。Host 压力/人员 presence 未观测，本轮按固定手工预算运行，不是整机负载资格。Controller 离线严格到期强停仍未保证。Vesta 测试命令、矩阵与业务结果留在消费者，影音编排不进入平台。
