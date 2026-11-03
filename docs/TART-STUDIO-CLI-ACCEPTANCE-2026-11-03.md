# Tart macOS ARM：CLI 首次真实 VM 验收

2026-11-03，真实闭环完成；临时栈已停止，当前不提供常驻 VM 租用服务。

## 实际环境与固定输入

- Studio：Apple M5 Max / ARM64。专属 TART_HOME，与 Docker / 影音环境分开。
- 官方 Tart 2.41.1；归档 SHA256 `e680a734febccfce7d4e910c1f7f13fc3b00f19a181c945e2d746de3214c32c2`，代码签名验证通过。
- 上游模板 `ghcr.io/cirruslabs/macos-tahoe-base@sha256:4aaa751fa7538902d73c767f27a066fc87e83f183069da4e4b5022863abd4c77`。
- 准备后本地 sealed bundle：`sha256:23c6e564e63bfdca8981377c86c5f857304af2fa986065bbe6eebb2cd7796530`；这与上游 OCI digest 含义不同。
- 实际 guest：macOS 26.6.2 / Darwin 25.6.0 / arm64，4 vCPU、8,589,934,592 bytes RAM；Node 24.21.0、pnpm 10.28.2、Git 2.54.0。
- CLI：`6eeaf78426eb77efbc1a6e28595be5c3adf97743`，tree `0f63cda93f1a555a2af1279905bb9cd28c16acf0`。Git bundle SHA256 `e4e0b36ee0502b681a0f51d9811617ad71997ce90aa96923f21eb08df4091fb1`，guest 再验一致，初始 checkout 干净。
- Hitchlet 基线 `4725149533ab69c3ae9031d06514e56a2a4bfbea` 加本次 bootstrap 窄修；真实 Runtime 使用此次编译产物。Controller / SDK 使用该基线编译产物。

## 真实执行

准备、资格探针、正式镜像验证及租客票顺序运行，全程最多一台活动 VM。默认 NAT；不使用 Softnet，不修改宿主 DHCP / 防火墙，不承诺强网络隔离或禁用 IPv6。

真实资格核验了 guest CPU/内存、每 Allocation 临时公钥初始化、API 指纹绑定的 SSH 认证；在专属 Runtime 重启后查实相同归属，正常停止、销毁并确认 absent。没有使用合成资格报告解锁。正式镜像验证 `d621cce0-39e0-4ae1-b280-99fd0fe188b0` 为 `succeeded / passed / cleanup complete`，随后正常发布。

唯一租客票 `36ba4dd5-7367-4e10-90fe-533b0a9a90f8`：消费者只选逻辑版本、vm / macos / arm64 和资源，无节点或 provider 提示；平台返回实际 Tart 放置。900 秒初租，1200 秒续租 confirmed。SSH 私钥仅在进程内消费，按 API 指纹精确验证。

guest 仅准备现有 launcher 的 frozen filtered dependencies（ignore-scripts）及 YAML 2.8.3，构建 launcher，然后执行固定源码中的唯一测试：

```sh
node --test --test-reporter=tap \
  --test-name-pattern='^public CLI closes native shared build, explicit IO, candidate cwd and literal argv in one request$' \
  tools/cli/test/domain-flow.test.ts
```

TAP 原始文件保留在任务验收证据中，不将测试日志纳入源码仓库。

真实命令退出 0，TAP pass 1 / fail 0。覆盖共享构建一次、显式 IO、candidate cwd、字面 argv、completed / cleanupConfirmed 和临时 context 清除。没有运行其余 CLI / Vesta / GitHub 三平台全套。

## 发现并修复的问题

`apps/runtime-agent/src/drivers/tart.ts` 的 guest program 原先在异步 stdin 回调里读取 `module.exports.runGuestBootstrap`。实际 Node 24 eval 在该回调中 ambient `module.exports` 为 undefined，真实初始化失败；同时回执换行多转义会破坏 JSON 解析。改为调用同一 eval 作用域的 helper，输出真正换行，保持身份、owner、控制版本、有效凭据和真实回收检查。

新增实际 Node 子进程 / eval / stdin 回归，既验证调用又验证完整 JSON 回执。受影响驱动文件 16 项定向回归和 Runtime TypeScript 编译通过；这部分使用假 CLI / 进程夹具，与上述真实 VM 证据分列。

模板准备首次使用硬 stop 后有 guest 写入未持久化；改为 sync + guest 正常关机后重新封存并实际重验。此前失败资格探针均查实销毁。CLI 初次依赖准备因已存在 TypeScript 链接 EEXIST 停止，测试尚未执行；核对链接目标后复用，继续原 Ticket，未修改 CLI 源码、重开票或提高测试超时。

## 结果回传与收尾

TAP、环境 JSON、build / dependency logs、stderr、exit-code 和 manifest 经 SFTP 回传；声明的文件 bytes / SHA256 与 guest manifest 一致，保存后才 release。TAP SHA256：`de3fe92d1efd9890909bf71e10fe7554204432955670a2ddfddfb3f39f19b0a6`。

Ticket 最终 `released / cleanupStatus complete`。原生 Allocation `2ae317fe-0bd0-4b15-ab4d-cf533c72e80a` 为 absent / inventory complete；管理总览 claimed CPU / memory / scratch 均为 0，cleanupBlocked / unknownOperations 均为 0。临时测试节点已禁用；33110 Controller 和 33444 Runtime 均停止且不再监听。

临时 Runtime token 无自动 TTL；通过停止其唯一服务并删除唯一 token 文件使本次通道失效。同期移除 per-run 私钥、明文 admin token、加密 master 和 secret-store 版本，未配置 OS 信任库 / keychain 或自启。停止的 `tahoe-cli-base` 模板与 OCI 缓存保留，不保留租客 VM。默认 Docker 和现有影音服务未变更。

本地完整非秘密证据位于本次 `tart-studio-acceptance/cli-8af475856d2d/evidence` 和 `outputs`；工作任务同时保留 receipt / environment / TAP / manifest 副本。

## 已知边界

这只证明一次 macOS ARM VM + 指定 CLI 单测的真实闭环。Windows 原生 / Hyper-V、Linux guest、完整 Vesta 应用测试、强网络隔离、VM 存储挂载、持续部署及压力场景未验。网络是家庭受信任 NAT；scratch 为 best_effort。本轮使用手工冻结节点预算，没有 HostAgent 压力观测或人员 presence 保证。controller 离线严格到期强停仍不支持，续租回执为 offlineEnforcement not_guaranteed。

后续优先将已验模板准备步骤与固定 CLI 单测入口整理为复用操作，再由 CLI/Vesta 消费端决定下一批具体测试；无需为该真实通过结果增加 Softnet 总闸或宿主网络改动。当前临时服务已关闭，重新开展真实票需按已有范围重新准备临时认证和开启专属服务。
