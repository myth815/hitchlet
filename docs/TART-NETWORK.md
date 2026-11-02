# Tart 网络源码接线与验证边界

本批实现冻结网络合同到 Softnet 的执行计划、可信 Runtime 策略读回、归还前网络回收，以及现有 Controller worker/Ticket/Lease/Claim 的 composition。真实 Tart server 仍由启动 guard 关闭，Runtime `networkEnabled` 默认 false。源码与受控测试不代表已安装、已具备管理员权限、真实网络合格或可供消费者租用。

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

归还先通过自有通道写入并读回 deny-all，再正常停止自有 VM。只有正常受管 Tart 退出、相应停止观察与网络收尾回执齐全时才记录 removed，随后才删除 VM；未尝试启动的对象可记录 not_started。VM 目录消失本身不证明网络进程消失。强杀、异常退出、FD 丢失或不完整观察保留 unknown/Claim，不能用自行填成功回执解锁。

Softnet 控制 EOF 只会关闭管理通道，不能单凭 EOF 宣称后端已退出；正常 Tart 停止的子进程等待行为仍须实机验证。重启后丢失原控制 FD 不凭 PID 接管；已持久的 removed/not_started 回执与 tombstone 可继续回收。未完成收尾的中断不会被描述为已自动恢复，本批没有实现任意 native 进程的重新接管。

仍有两个明确的启用前边界：

- 现有 resolver 保留 enabled/current connection 和 fresh sealed-template 检查；停用连接或模板证明失效时，自动 cleanup/observe 可能受阻。这些检查尚未拆成只针对已归属资源的清理权限，原逻辑保留，不能据本批声称已解决。
- server composition 共用现有 lease/operation loops，但没有伪造 Tart Host 压力、人员 presence 或自动延长人工资格。自动 Tart observation 刷新尚未接入，已有观测仍会按原新鲜度到期；不承诺长期生产接单。

Controller 离线严格到期硬停仍不支持。Linux guest、动态网络修订、真实后端故障、媒体/Vesta 作业和长期生产运行未由本批证明；Tart 的真实执行 guard 保持关闭。

## 受控验证入口

```sh
pnpm --filter @hitchlet/contracts test
pnpm --filter @hitchlet/runtime-agent exec vitest run test/tart-network.test.ts test/tart-driver.test.ts test/tart-main.test.ts test/tart-server.test.ts test/tart-guest-bootstrap.test.ts
pnpm --filter @hitchlet/controller exec vitest run test/tart-provider.test.ts test/tart-runtime-client.test.ts test/config.test.ts
pnpm --filter @hitchlet/controller exec vitest run test/tickets.test.ts test/validation-lifecycle.test.ts -t Tart
```

使用假 CLI、受管临时子进程/Unix stream、loopback HTTPS、合成端口与临时 SQLite。Controller composition 默认是正常 resolver/mTLS/SSH，测试只替换 Runtime 与 SSH 窄端口，仍走真实 Tart provider 和 worker。实机步骤、许可、单票预算与 owned DHCP 回滚见 [Studio 方案](TART-STUDIO-ACCEPTANCE-PLAN.md)。
