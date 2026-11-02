# Tart 接入：源码与合成验证阶段

当前已实现内部 Tart 本机驱动、初始化/SSH 材料合同和 Controller 服务层的 `TartExecutionProvider`，并接入现有 Ticket、Operation、Lease 与 Claim。它们复用同一个 SQLite 账本，不另建 VM 调度平台。

**尚未注册生产 server 的 Tart 执行模式，也未开放正常管理 API 的 Tart 制品发布。** 真实 Agent 控制通道、guest 初始化实现、网络资格和 SSH 探针组合尚未验收；代码可注入合成端口测试，不能据此宣布已有真实 VM 可租。影音业务与 Vesta 适配不在 Hitchlet 内实现。

## 当前实现

| 层次                | 已有源码行为                                                                                          | 证据边界                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 内部合同            | 固定分配身份/动作栅栏、local 模板、OS+arch、bootstrap request/receipt、presence 与 bootstrap 状态分离 | 严格 schema；仅客户端公钥和回执公开材料，无私钥/口令字段 |
| Runtime driver      | clone/set/run/IP、inspect/reconcile、停止删除与完整盘点、持久归属和终止 tombstone                     | Studio macOS arm64 上假 CLI；没有执行真实 Tart           |
| Controller provider | 冻结模板/平台/规格、持久创建意图、同实例恢复、初始化回执读回、网络修订和 SSH 指纹/认证证据校验        | guest/network/SSH 都是注入端口，当前实际验收使用合成实现 |
| 同账本生命周期      | VM 申请、预留、ready、claim/access、renew、release、unknown 保留 Claim、查实不存在后归还              | 服务层整合测试；不是生产 server/GUI 的真实 VM 流程       |

本机驱动为 `apps/runtime-agent/src/drivers/tart.ts`，仅接受 macOS arm64 宿主、本地停止且一致的 `darwin`/`linux` arm64 模板。显式专用 `TART_HOME` 和独立 manifest 目录不得指向日常 `~/.tart`；关闭自动缓存清理。不下载 OCI 镜像，不安装 Tart，不使用 overwrite、快照池、Orchard 或任意脚本执行。

主要方法：`inspect(identity)`、`reconcile(request)`、`recordBootstrapReceipt(identity, request, receipt)`、`destroy(identity)`。初始化回执入口只负责校验与落盘，不执行 guest 初始化，也不证明网络/SSH 合格。前台 `tart run` 单独监管；关闭驱动不隐含归还或删除，只报告最近观察到的自有运行对象。一个专用 home/manifest 同时只支持一个管理进程，跨进程执行权与真实服务部署仍待接入。

clone 前持久意图，clone 返回后立即记实例身份，再配置 CPU/内存。已记账实例的回执丢失可恢复，资源配置中断不抹掉所有权。无资源的先到终止也持久 tombstone，阻止迟到创建复活。clone 已发生但首次实例身份记账前中断仍为 unknown，不能凭同名接管或删除，当前仍需要受控对账。模板目录身份与 `config.json` 摘要不等于完整 VM 磁盘制品 digest，也不证明工具环境或供应链。

## 固定初始化与访问合同

当前 recipe 为 `tart-guest-bootstrap-v1`、`contractVersion: "1"`、`identityReset: true`；SSH discovery 为 `guest_ipv4`，readiness 为 `authenticated_ssh`，端口 22。guest hook 必须以同一分配身份和 nonce 幂等应用或读取原回执，恢复不能重置新凭据或产生第二个 VM。

request 绑定 identity、nonce、account、客户端公钥/指纹及网络回执引用/到期；applied receipt 还返回 guest host 公钥/指纹和观测时间。Controller 验证双方指纹、身份、冻结 OS/arch、资源读回、网络合同 hash/修订/新鲜度及 SSH 认证，然后才产生 ReadyReceipt。获得 IP、clone 成功或 guest 自报均不是 ready。

本批 Tart 只支持整 vCPU、明确虚拟机隔离、SSH、无挂载/加速器，以及显式 best-effort scratch 预算。硬磁盘配额不支持，不可宣称已实施。已知不支持的合同在预览/准入时拒绝。原 Docker 合同与 hash 布局保持不变；Hyper-V 不会因类型存在而被当作 Tart 执行。

## 验证入口与剩余工作

使用仓库已有 Node 24、pnpm 10.28.2 和依赖：

```sh
pnpm --filter @hitchlet/contracts exec vitest run test/tart-runtime.test.ts
pnpm --filter @hitchlet/runtime-agent exec vitest run test/tart-driver.test.ts
pnpm --filter @hitchlet/controller exec vitest run test/tart-provider.test.ts test/tickets.test.ts
```

上述测试只使用临时账本、受控假 CLI、合成 VM/guest/network/SSH 端口；没有配置真实身份、创建 VM、访问媒体库或改变网络。实际通过数和提交证据以本批交接回执为准。非目标宿主不会被假 CLI 测试误标为 Tart 宿主支持。

下一步先固定实际 Tart 版本和一张不可变模板，完成可信 Runtime 身份/控制通道、模板内固定初始化、网络正反探针、真实 SSH 与磁盘/VM 回收取证，再接管理发布和正常 server 组合。先完成一种客体单票，再扩另一种。Controller 离线硬到期停止仍不支持，本批没有增加该保证。跨仓 SDK 分发、Windows 原生、Hyper-V 和租客业务保持各自后续范围。

CLI/布局依据 [官方 Quick Start](https://tart.run/quick-start/) 和 [官方命令源码](https://github.com/openai/tart/tree/main/Sources/tart/Commands) 核对；源码合成测试不证明本机已安装版本兼容性。

## Studio 真实验收前提：只读核对

本轮仅核对已有状态，没有安装或启用软件：Studio 报告 macOS 27.0.1（26A434）、18 核 CPU、64 GiB 内存、硬件虚拟化标志为 1；项目所在本地卷可用空间约 263 GiB。Homebrew 已存在，但 `brew list --versions tart`、PATH、常见安装路径以及默认 `~/.tart` 都未找到 Tart/模板。这些静态硬件规格可用于规划一张有限测试票；实际可用内存、现有负载以及此 macOS 版本与 Tart 的兼容性仍须在真实验收前核对。

[官方 release](https://github.com/openai/tart/releases/tag/2.41.1) 当前标为 2.41.1；[Cirrus Homebrew 配方](https://github.com/cirruslabs/homebrew-cli/blob/master/tart.rb) 查询时仍为 2.32.1 并依赖 Softnet。不能直接将未固定的 brew 安装等同于本驱动测试目标。真实验收前需固定实际版本、官方文件来源与校验值；本次没有下载二进制、调用新软件或接受新许可。[官方许可说明](https://tart.run/licensing/)将个人工作站使用列为免授权费场景；实际采用版本的条款仍需在安装范围确定后核对，不在本轮购买或配置商业授权。

最小真实闭环仍缺：一张不可变版本的受控 arm64 模板、模板内固定初始化入口、每票短期 SSH 材料和可信指纹交付、具体 VM 网络正反探针与来源范围、以及同一 Runtime 身份的可信控制通道。默认 NAT/IP 发现、来宾自报或合成回执均不能替代这些证明。模板 digest、初始化共享目录及网络路径尚未实际验证，不猜测值、不配置账号或安全策略。应先以一张 macOS 或 Linux 模板完成单票，再扩另一种客体；不引入 Orchard、快照池或额外编排平台。
