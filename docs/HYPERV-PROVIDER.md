# Hyper-V：内部 provider 与 guest 初始化握手

2026-11-04，接续 `bf60e75` 的本地源码批次。没有远端 Windows 动作、真实 VM、系统/网络变更、新持久认证或重试被拒源码传输。这里的“通过”均指受控端口；不能据此租到 Windows VM。

## 本批可复用的源码

- `HyperVExecutionProvider` 实现既有 ExecutionPort：先记创建 intent，读回原生 GUID/资源后登记 owned VM，再由 ready 阶段初始化 guest 和核 SSH；归还走独立 cleanup resolver、停止/删除和二次 absent 读回。沿用 Ticket/Operation/Lease/Claim 语义，不新增业务队列。
- `registerHyperVExecutionProvider` 在现有 dispatcher 注入该 adapter；内部 execution registry 识别 hyperv/VM、Windows或Linux/amd64组合。默认 server 的 `registered` 仍只组合现有 Docker/Tart，管理节点登记/发布 API 及生产 Hyper-V resolver/启动入口尚未接入，没有自动广告新能力或新增无条件启动开关。
- 适配目前明确支持整 vCPU、静态内存、best-effort scratch、SSH22、既有受信任网络；不实现平台挂载、RDP、加速器、强网络隔离或禁IPv6。内部网络回执为 hyperv_nat/verificationRequired=false/ipv6=not_enforced；宿主实际 switch/NAT 能力仍须后续只读核实，不能用该字符串证明真实拓扑。
- guest 初始化请求只含冻结 allocation/VM GUID/nonce、OS/架构、账号及该票公钥/指纹；没有接受私钥、口令或任意命令。初始化前先持久 intent，再通过显式模板渠道 read-before-apply；unknown 不重施动作，已应用但丢回执从同 VM/nonce读回，不生成新票或新身份。
- `HyperVGuestBootstrapPort` 只是模板初始化渠道端口。**Windows/Linux 实际初始化渠道和guest脚本尚未实现/选定**；默认无渠道仍返回 not_implemented。只有注入渠道回执、原生读回和 SSH 实际系统/amd64、账号、指纹与工作目录可写均匹配才形成 ReadyReceipt；测试中由受控依赖提供这些证据，不是实机。
- 初始化回执随同 owned manifest 保存，旧 manifest 的 optional 字段兼容；清理后不允许旧创建/引导请求复活。guest observedAt是诊断时间，动作由本地 deadline 约束，不以跨机时钟零偏差增设门槛。
- 正式 observe 用已有 access material 做 SSH/指纹与 native 读回，不创建新密钥；明确停止报 lost，连接不明保 unknown。清理不因发布停用或模板证明不可用而被新建资格挡住，真实认证/owner/命令身份仍由独立 resolver 与 Runtime 校验。VM已删但owned文件未清时可继续原回收；未查实缺席不返回CleanupReceipt。

## 仍缺哪些实际接线

1. [Runtime配置/namespace与专属根绑定及正常入口](HYPERV-RUNTIME-ENTRY.md)已有本地受控接线，Windows真实部署/NTFS仍未验；基于当前凭据/持久cleanup Operation的真实 resolver未接。没有偷偷使用已有维护口令作为租客认证。
2. 选定完整模板/磁盘制品身份和已有引导入口，再实现一个 Windows/amd64 模板配方/真实SSH验收；[Windows/Linux固定SSH probe源码与草稿登记](HYPERV-READINESS-AND-DRAFTS.md)已补。PowerShell Direct需要guest认证，宿主管理员token不等于guest身份；没有该事实时不尝试。Linux/amd64是合同维度与受控用例，不冒称已有x64镜像。
3. 制品草稿登记/读回已补；正式管理节点、资格/发布与当前冻结网络合同到operation-plan的映射未完成。`hyperv_nat`目前只是内部 provider 支持的执行计划，未在管理 API 或生产账本中创建新profile；不把受控对象称为完整管理链路。
4. 原生PowerShell解析/执行、早期Import未完成状态、NTFS/掉电和真实单票验证仍未完成。组件启用、可能重启、模板许可和宿主网络等动作尚未执行。Windows源码解析的既有拒绝不受这批代码修改解除。

## 验证与业务边界

定向覆盖冻结初始化、回执丢失恢复、不明不重施、错误VM/nonce/密钥拒绝、Windows/Linux独立维度、创建/ready/观测/停止/销毁、部分回收、旧发布不可用仍可清理、注册不改变默认组合，以及相邻Tart兼容。Runtime/Controller/Contracts按正常制品构建；没有重复Docker/Tart实机测试。

Vesta仍负责固定源码、执行测试和小结果；影音仍只消费Docker，不进入此provider。controller离线严格到期硬停、跨平台完整应用矩阵和常驻部署不由本批完成。下一步先取得准确的Windows模板/引导渠道与系统前置事实，再接真实资格；不为保持活跃而新增通用VM框架或额外默认安全门槛。
