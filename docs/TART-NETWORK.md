# Tart 网络模式与验证边界

本批实现冻结网络合同到 Softnet 的执行计划、可信 Runtime 策略读回、归还前网络回收，以及现有 Controller worker/Ticket/Lease/Claim 的 composition。真实 Tart server 仍由启动 guard 关闭，Runtime `networkEnabled` 默认 false。源码与受控测试不代表已安装、已具备管理员权限、真实网络合格或可供消费者租用。

## 默认受信任 NAT（2026-11-03）

用户明确选择家庭受信任任务默认 NAT：网络 Profile 的 `policy.tartMode` 省略或为 `trusted_nat` 时，新 Tart 票据/镜像验证冻结 `trusted_nat/tart_nat`、`verificationRequired=false`、`ipv6=not_enforced`。允许使用宿主可达的互联网和家庭网络；没有来源/出口白名单、管理面或租客间网络隔离保证，Profile 的 Docker/Softnet 规则不会在 NAT 下执行。SSH 身份、独立 VM、资源额度、幂等、租约和查实回收保持。

NAT 用普通 `tart run --no-graphics`，不启动 Softnet，不申请其 root/SUID，不改宿主 DHCP。观察明确返回 `backend=nat/status=not_enforced`，不是伪造 policy_match；同票 bootstrap 保留模式/身份引用。归还按精确 manifest/native VM 身份停止，再查实停止、删除和不存在；不需要 Softnet 控制 FD 或网络回收回执，Runtime 重建后仍可观察并回收原 VM。停止失败、错误归属或不完整盘点不释放 Claim。

基本 Node 资格只需真实 resourceLimits、sshBootstrap、cleanupRecovery 三项；`networkPolicyEnforcement=unsupported`，不以免检冒充强隔离已验证。网络 Profile 仍是授权和固定模式的目录，不需逐个 Profile 的强隔离资格。`policy.tartMode=isolated` 显式选择下文 Softnet 路径，仍要求六项证据；旧冻结票据不迁移，Docker 行为不变。

**当前全局 Tart server 启动禁令仍保留**：删除该 guard 的操作被自动审批拒绝且未执行，故本批源码不等于正式入口可运行。真实 Tart/NAT/SSH/回收尚未实机验证。本节之后的默认拒绝、控制 FD 与 Softnet 回执要求只适用于可选强隔离模式。

## 合同与执行

`TartNetworkPlan` 由既有 `resolved.network` 加入口来源和 SSH 端口组成，以专用 canonical SHA256 绑定。既有账本/ReadyReceipt 的网络 hash 布局保持不变，专用 plan hash 不混作通用 network hash。允许来源是字面 IPv4 CIDR 的交集，不猜 `@host` 或 127.0.0.1；当前只支持 guest SSH 22 和 `ipv6: disabled`，不支持的合同明确拒绝。

这里的“宿主 SSH 22”指 Studio 租客客户端/Controller 主动连接 guest:22，不允许 guest 主动访问宿主:22；Runtime 管理通道是 localhost HTTPS。DHCP/ARP 是原生网络层基础设施，`allowedEgress=[]` 只表示不允许租客主动 IP 出口，SSH 对应返回流量仍受状态规则管理。首轮无 egress 的真实方案不能证明允许 egress 的正例已实测。

Softnet 0.25.0 使用服务端口优先的规则匹配，不能靠一条宽泛管理 deny 保证优先于更具体 allow。编译器对每个 egress 协议/端口从 allow CIDR 减去匹配的管理 deny，并生成默认拒绝规则；支持明确许可的 `/0` 服务，不额外收窄合同。规则数量和命令参数有界，非法/无法支持的计划失败。源码参考固定 [Softnet 规则实现](https://github.com/openai/softnet/blob/0.25.0/lib/proxy/rules.rs)，未运行该工具。

本机驱动只有在有 adapter、计划合法且持久归属匹配时才调用 `tart run`。启动参数直接携带完整限制与控制 FD，成功读回前不提供租客 ready；不会先用普通 NAT 暴露 VM 再补规则。Tart 从限定的专用目录解析已配置的 Softnet，不改宿主 PATH，不以 `sudo` 预检或自动配置权限。

## 每票取证

Tart 2.41.1 的 [`--net-softnet-control-fd`](https://github.com/openai/tart/blob/2.41.1/Sources/tart/Network/Softnet.swift) 使用已连接 Unix stream。Runtime 持有本次 child 的 fd3，调用固定 JSON-RPC `softnet.policy.get/set`；不扫描或接管任意进程。短请求最多 5 秒并受外层 action 剩余 deadline 约束。通道断联、响应无效、读回不匹配均保持 unknown。

`policy_match` 绑定 allocation/generation/operation/controlVersion、plan/revision/hash，以及实际 VM 名称、目录 dev/inode、MAC、受管 Tart child PID/start time 和本进程仍持有的控制通道。PID 或 UUID 单独不能证明归属；不要求 VM 存在 Linux network namespace。策略完整读回与 hash 是本票安装证据，**不是流量隔离实测**；网络效果资格继续由既有真实 Node 验收报告和准入承担，不新增每票全网探针平台。Softnet `ruleCount` 为编译后诊断数，不强制等于输入数组长度。

Controller 对新鲜观察时间检查，bootstrap 的 network expiry 仍绑定原冻结 operation deadline。不同观察时间不会生成不同初始化请求；同票恢复复用原 nonce/公钥/回执。源码的 SSH probe 未因网络接线改成任意端口或任意远程命令。

## 归还、恢复与已知限制

正常归还先读回 deny-all，再停止自有 VM，保存 `removed`。通道调用失败时，若仍持有与 manifest 的 PID/start、策略 hash、VM dev/inode/MAC 匹配的原受管 child，可正常停止本 VM；只有该 child 正常退出、完整盘点明确为 stopped、停止后 native VM 身份仍匹配，才保存独立 `process_exited` 回执。后者没有 deny-policy hash/readback，不声称规则已经读回。两条路径均须再查实删除才能释放 Claim。未尝试启动的对象可记录 `not_started`；目录消失本身不证明网络进程消失。强杀、异常退出、未跟踪 child、停止失败或不完整观察保留 unknown/Claim。

Softnet 控制 EOF 只会关闭管理通道，不能单凭 EOF 宣称后端已退出；正常 Tart 停止的子进程等待行为仍须实机验证。同一 cleanup fence 的持久 `removed/process_exited` 回执须核对网络合同、VM/进程身份和完整停止盘点后才能幂等重放；`not_started` 与 tombstone 也保留归属检查。整个 Runtime 重启后若没有原 child 句柄或持久退出回执，仍保持 unknown/Claim，不凭 PID 接管。没有新增持久控制 broker、系统服务或 native 进程接管权限。

新增的清理权限仅适用于已登记 Allocation 且有持久 cleanup Operation 的路径：

- Worker 传递原创建 OperationId 和当前 cleanup OperationId/token/version；专用 resolver 核对正在执行的清理任务、lease、installation、owner、generation/controlVersion、同一 Runtime 与 revision、desired_state=absent。清理计划保留原创建 OperationId，但权限由新 controlVersion 的 cleanup Operation 证明，不能套用原创建版本等式。
- 只有这条清理路径允许 provider connection 停用或模板发布证明失效；仍用有效秘密引用和原 mTLS 通道读取可信 facts，核对实际 native namespace/宿主身份。凭据撤回、身份不匹配或跨 owner 仍拒绝。它返回仅绑定本票身份的 inspect/revokeNetwork/destroy 包装，没有创建、启动或 bootstrap 方法。
- 清理测试可在内部注入合成 RuntimeAgentJsonTransport；生产 composition 不暴露该覆盖配置，仍默认使用现有 RuntimeAgentHttpTransport、秘密加载与 mTLS。缺失凭据和通信认证错误继续向上失败，不回退到匿名通道。
- 新建与 readiness 继续使用原 enabled/current connection、模板证明及网络资格要求，并拒绝清理授权。Node admission 停用、provider connection 停用、模板发布资格和运行时身份变化分别处理；没有开放任意 observe 路径。

仍有明确的启用前边界：

- server composition 已接入有界 Tart Node 观察和既有 ready 完整性巡检。匹配的认证 facts 只刷新健康时间，不延长人工资格或证明 Host 压力、人员 presence。资格失效、模板/身份变化与观察不可达按实际状态处理。这些持续运行和故障路径仍未实机验证，不承诺长期生产接单。

Controller 离线严格到期硬停仍不支持。Linux guest、动态网络修订、真实后端故障、媒体/Vesta 作业和长期生产运行未由本批证明；Tart 的真实执行 guard 保持关闭。

## 受控验证入口

```sh
pnpm --filter @hitchlet/contracts test
pnpm --filter @hitchlet/runtime-agent exec vitest run test/tart-network.test.ts test/tart-driver.test.ts test/tart-main.test.ts test/tart-server.test.ts test/tart-guest-bootstrap.test.ts
pnpm --filter @hitchlet/controller exec vitest run test/tart-provider.test.ts test/tart-runtime-client.test.ts test/config.test.ts
pnpm --filter @hitchlet/controller exec vitest run test/tickets.test.ts test/validation-lifecycle.test.ts -t Tart
```

使用假 CLI、受管临时子进程/Unix stream、loopback HTTPS、合成端口与临时 SQLite。Controller composition 默认是正常 resolver/mTLS/SSH，测试只替换 Runtime 与 SSH 窄端口，仍走真实 Tart provider 和 worker。实机步骤、许可、单票预算与 owned DHCP 回滚见 [Studio 方案](TART-STUDIO-ACCEPTANCE-PLAN.md)。
