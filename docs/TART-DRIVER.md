# Tart 接入：管理接线与受控验证阶段

2026-11-03：家庭受信任任务默认 NAT；Softnet 强隔离按 Profile 显式选择。NAT 的基本资格、无控制 FD 恢复回收和不提供强网络隔离的边界见 [网络模式](TART-NETWORK.md)。原文中的网络策略/回执门槛仅适用于 Softnet；独立环境、身份、资源、SSH 与查实回收共同保留。已按用户明确批准移除无条件 server 启动拒绝，未增加替代总闸，真实 VM 未验。

Tart 复用现有 Controller、SQLite、Ticket、Operation、Lease 和 Claim。当前已补可信 Runtime 通道、固定 guest 初始化、真实 SSH 探针源码，以及正常管理 API/SDK 的发现、注册、资格登记、验证与发布。本批继续补了冻结网络计划、Softnet 控制 FD/策略读回、显式网络回收和正式 server composition 的受控接线。正常入口可显式配置 `EXECUTION_MODE=tart`，默认仍为 `disabled`；**真实 Tart 租用尚未验收**，不能将配置枚举或合成测试当作已有可租 VM。

影音和 Vesta 的业务属于各自租客工程。Linux guest、Windows 原生、Hyper-V、快照池、Orchard 和云扩容均不是本批交付。

## 当前接线与证据

| 层次           | 已有源码                                                                                                                                       | 已验证边界                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 本机驱动       | local template clone/set/run/IP、持久归属、inspect/reconcile、终止 tombstone、停止删除与完整盘点                                               | Studio 上假 CLI/临时文件；未执行 Tart                                             |
| Runtime 入口   | 独立 `dist/tart-main.js`、显式 namespace 初始化、模板封存、mTLS+Bearer、epoch/nonce/deadline                                                   | 临时证书/loopback HTTPS fixture；非真实部署认证                                   |
| guest 初始化   | 固定 GuestAgent exec，macOS arm64/Node 24，按分配身份持久初始化、生成 guest 内 host key、独立 sshd、幂等回执                                   | 受控依赖夹具；未在真实 guest 运行                                                 |
| Controller     | 精确冻结 Operation/Node/revision/native namespace，可信 facts/template 校验，bootstrap RPC 后读回 applied receipt，SSH 指纹及账户/OS/arch 检查 | 同账本生命周期、HTTP client、mock ssh2；没有真实 VM 握手                          |
| 管理发布       | 发现→禁用/unknown 注册→配置→独立资格报告→草稿→持久验证和回收→重新核模板→发布                                                                   | 真实服务/SQLite/worker/provider 配合合成 native 端口；没有 SQL 直接伪造已发布状态 |
| 租客 UI        | 目录可含 `kind: vm`，VM 请求用整 vCPU、virtual_machine、best_effort，无挂载                                                                    | GUI 测试；没有浏览器操作真实 VM                                                   |
| 网络与正式启动 | 冻结 CIDR/访问/拒绝计划，Softnet 编译/控制 FD/策略读回，显式 revoke 后回收，共用 worker/lease 的 server composition                            | 假 CLI/自有子进程/合成账本；无条件启动拒绝已移除，真实 VM/网络尚未验收          |

## Runtime 入口与模板

`HITCHLET_TART_RUNTIME_CONFIG` 指向显式配置文件。字段见 `apps/runtime-agent/src/tart-main.ts`：`enabled: true`、监听地址/端口、installation/runtime identity、官方 app 内 executable、独立 `tartHome`、manifest/registry/journal/namespace 路径，以及已有模型的 token/CA/cert/key 文件引用。新增 `networkEnabled` 默认 false；显式开启还需固定的绝对 `softnetExecutable` 路径。配置不接受任意 guest 命令或 Controller 提供的成功回执；Controller 不再附加无条件启动拒绝。

以下是**完成工具、模板、网络和认证准备后的入口**，本轮未对真实环境执行：

```sh
node apps/runtime-agent/dist/tart-main.js --init
node apps/runtime-agent/dist/tart-main.js --seal-template <localName>
node apps/runtime-agent/dist/tart-main.js
```

`--init` 一次性创建非秘密 native namespace UUID，绑定 installation、配置的 runtime identity 和专用 TART_HOME 的路径/dev/inode；它与账本 runtime identity UUID 不是同一概念。普通启动缺标记或绑定不匹配会拒绝。拒绝日常 `~/.tart`，不覆盖已有身份，一个专用 home/manifest 只由一个管理进程控制。

`--seal-template` 只接受停止的本地模板，流式计算 `config.json`、`disk.img`、`nvram.bin` 的 SHA256，生成 `sealed_local_bundle_v1` 摘要并保存 dev/inode/size/mtimeNs。facts 检查模板与封存状态；不会把 config hash 当完整磁盘 digest，也不会自动封存或每次请求重读整个磁盘。上游 OCI digest 与准备后的本地 bundle digest 不同，后者必须实际生成。

可信 API 为 POST `/v1/tart/facts` 和 `/v1/tart/actions`。动作只有 inspect/reconcile/bootstrap.apply/network.revoke/destroy，绑定完整分配身份、controller epoch、nonce 和动作截止时间。同一 Allocation 顺序执行，排队后重新检查 epoch/deadline；全局 journal 只串行持久 epoch 更新，慢 clone 不占住别票动作。短 CLI/GuestAgent exec/地址轮询均受剩余预算约束，原生常驻 `tart run` 不因单次 RPC 到期被误报 absent。超时或盘点不全保持 unknown，可恢复或回收，不释放未查实的 Claim。

clone 前持久意图，clone 成功后先落实例身份再改规格；重试复用已归属实例。clone 已发生而首次身份写盘前中断仍为 unknown，不能凭同名接管/删除。停止 Controller 或 Runtime 不隐含删除 VM；查实不存在才退款/释放 Claim。Controller 离线硬到期强停仍不支持。

## 固定 guest 和访问契约

recipe 为 `tart-guest-bootstrap-v1`、contractVersion `1`、identityReset `true`，guest_ipv4 + authenticated_ssh + SSH 22。当前固定实现仅 macOS arm64：GuestAgent、现有 `admin` 账户和 guest 内非交互 sudo、`/opt/homebrew/bin/node` 24、准备标记和空闲 22 端口是模板条件；不是自动下载/安装器。Linux 虽保留平台合同和本机驱动声明，尚无对应固定初始化实现，不能据此发布为已验可租。

固定 helper 由 Runtime 通过受控 stdin 发送给自有 VM；不接受租客脚本。它只接收公钥，guest 内生成的 host 私钥留在 guest。独立 sshd 支持租客 shell/exec/SFTP，禁用密码、root 登录与端口转发，不停止或覆盖未知 sshd。公钥目录供 sshd 切换用户后读取，私钥和状态目录保留私有权限。相同身份/nonce 读回同一回执，不重置凭据。

Controller 验证双方公钥指纹、精确回执与身份、冻结规格、网络合同/修订/新鲜度，再以私钥认证执行固定只读 SSH 检查。SSH 源码目前只经 mock ssh2 测试，既有 Docker SSH 实测不算 Tart 证据。

只支持整 vCPU、虚拟机隔离、无加速器/挂载、显式 best-effort scratch。没有硬磁盘配额；不支持的请求拒绝，不能放宽成已实施。

## 管理与发布

沿用 POST `/v1/provider-connections` 的 Tart 输入和既有注册接口；新增 `/v1/nodes/:nodeId/tart-runtime-config`。SDK 为 `client.admin.inventory.discoverTart`、`client.admin.inventory.configureTartRuntime` 等既有管理流程方法（具体实例入口见 SDK 导出）。Tart profile 不要求 Docker endpoint、桥地址或 userland proxy 字段。

认证 facts 证明来源与模板，**不证明能力资格**。注册后仍 disabled/unknown、空能力；池预算不得超过原始宿主 CPU/内存。独立 Tart attestation 需匹配 namespace、版本、平台、模板 digest 和真实验收报告，沿用现有六 scope、report SHA、network revision 与有效期机制，不借用 Docker 版本/iptables 成功标记。测试报告均明确 synthetic，未提交任何真实节点资格。

发布还要求持久验证完成、验证 allocation 查实清理、相关 Claim 归还、CAS 成功，并通过 fresh authenticated facts 重新核模板。封存或人工资格报告单独不能直接发布。已登记资源的回收使用独立 cleanup-only resolver：必须有正在执行的持久清理 Operation、精确 Allocation/owner/generation/controlVersion 与有效认证，才可在连接停用或模板证明失效后观察/归还；新建/启动不使用此权限。实际 Runtime/native identity 仍核验，发布证明不再被混作已归属资源的清理资格。Tart connection revision 的重新提议/轮换尚未提供；当前 discovery 管理初次身份，不承诺生产轮换闭环。管理 GUI 可展示 Tart facts，但尚无 Tart 注册/资格表单，这段使用正常 API/SDK；租客 VM 选择已接入 GUI。

## 持续观察与恢复

公开 health 合同、租客 access 和 GUI 模式已接入 Tart。access 保留原 owner、scope、generation、有效租约及加密材料校验；正常 server 入口已移除无条件拒绝。申请向导清除不兼容的架构选择，保留兼容的显式约束。

Portainer/Tart 共用后台循环中的独立单次 cleanup 通道；同 Allocation 的在途创建、worker lease、token/version/epoch 和身份检查保留。回收通道健康单独计入恢复状态，关闭时等待在途操作。

Tart Node 通过认证 facts、当前 revision、native namespace、版本、模板证明和容量匹配刷新健康时间。人工资格 JSON 与有效期不变，不代替真实网络资格；Host 压力和人员 presence 不由这些 facts 推导，仍保留显式人工库存预算。ready 租客使用既有持久完整性巡检，核对冻结规格、原 bootstrap 回执和当前网络证据。确认漂移走原终止意图；证据不可读保留 unknown/Claim，不创建替代 VM。bootstrap 回执证明初始化时刻，不因观察现有租约而延长或重新初始化。

控制通道收尾及整个 Runtime 重启后仍缺退出证明的边界，见 [网络恢复说明](TART-NETWORK.md)。

## 验证入口与下一步

使用已有 Node 24、pnpm 10.28.2 和依赖，无需安装新包：

```sh
pnpm --filter @hitchlet/contracts exec vitest run test/tart-runtime.test.ts test/tart-transport.test.ts
pnpm --filter @hitchlet/runtime-agent exec vitest run test/tart-network.test.ts test/tart-driver.test.ts test/tart-main.test.ts test/tart-server.test.ts test/tart-guest-bootstrap.test.ts
pnpm --filter @hitchlet/controller exec vitest run test/tart-provider.test.ts test/tart-runtime-client.test.ts test/tart-ssh-readiness.test.ts test/tart-admin-publication.test.ts test/validation-lifecycle.test.ts
```

实际执行结果见当前批交接；测试是受控源码验证，不是安装或 VM 验收。本批网络源码、证据含义与恢复限制见 [Tart 网络接线](TART-NETWORK.md)。真实资格仍需固定工具/模板及资源、SSH、回收验收；只有可选强隔离模式才需要其网络正反验证，不能注入合成成功。具体 Studio 工具、模板、权限和单票预算见 [实机验收方案](TART-STUDIO-ACCEPTANCE-PLAN.md)。
