# Hyper-V Runtime 接线与 guest 初始化边界

2026-11-04，源码/受控验证阶段。没有连接 Windows、启用 Hyper-V、启动 VM、创建服务身份或修改宿主网络。本批不是 Windows 可租环境交付。

## 已接入的内部通道

- `createHyperVRuntimeServer` 将现有内核接到 `/v1/hyperv/actions` 和 `/v1/hyperv/facts`。动作是 reconcile、inspect、stop、destroy及固定公钥输入的bootstrap.apply；不暴露任意 PowerShell/native command 或租客管理接口。初始化与内部provider见[接续批次](HYPERV-PROVIDER.md)。
- `HyperVRuntimeHttpClient` 使用已有 `RuntimeAgentHttpTransport`；继续由它加载版本化认证、验证 HTTPS/mTLS、传 Bearer 并限制响应/超时。没有新增网络、身份或证书体系。
- Tart 和 Hyper-V 共用原 Tart server 的有限 HTTP 实现：证书和令牌检查、256 KiB 请求体、最长 240 秒动作 deadline、每 allocation 排队、短暂持久 epoch 更新。慢创建不占全局原生动作锁；排队后再次检查 deadline/epoch。
- 内部合同在 `contracts/internal`，驱动原有导出保留为同一 schema 的别名。guest OS 与 amd64 独立，宿主本地模板/switch 只在内部请求中；公开消费者不增加后端、宿主或 Windows 路径参数。
- 回执绑定 nonce、installation/runtime 和完整 allocation 命令身份（含 generation/operation/controlVersion）。nonce 是请求响应关联，**不是持久重放缓存**；动作幂等仍由内核冻结规格、intent、owner/版本及 released tombstone 提供。未知动作结果继续查询同一 allocation，不新建替代资源。
- epoch 用现有 FileJournal；Windows 跳过该平台不支持的目录 open/fsync，文件 fsync 和 rename 保留。未验证 NTFS/掉电持久性、多个 Runtime 写进程；本批不作这类保证。

## 尚未接入，不能据本批称为可租

server/client 是可测试组合函数，后续已补[可执行启动入口与持久namespace绑定](HYPERV-RUNTIME-ENTRY.md)，本机受控验证，不是在Windows实际监听的部署。内部ExecutionPort后续已接线，正式server/管理发布尚未接入。后续入口已把namespace标记绑定到专属工作根，部署模型仍为单Runtime进程；NTFS/不同端口多写者未验。直接server函数的namespace仍来自调用方，不能单独作为资格证明。

原生 lifecycle 仍只有 vmcx hash，不是完整模板/磁盘制品身份。PowerShell 解析/运行、native import 早期中断取证、VM 资源/网络/SSH、正式管理发布和 Ticket 均未实机验证；详见[内核边界](HYPERV-NATIVE-KERNEL.md)。没有将不可用 host 伪造成可用：facts 可诚实返回 available=false。默认无guest渠道仍为not_implemented；后续内部provider仅在受控引导/SSH证据完整时生成ReadyReceipt/access，不是实机支持。

## 首个 Windows guest 的最小初始化方案

这部分是下一切片的输入/成功标准，**不是已经执行或验证的原生初始化实现**。先满足 Vesta Windows/amd64 一种 guest，不同时实现另一套 Linux/amd64 引导框架。

| 环节 | 最小输入与实际交付要求 |
| --- | --- |
| 模板 | 来源/许可明确、关闭状态、完整配置及磁盘身份；准备好 Windows OpenSSH 和对应业务工具。Node/pnpm/Git 是 Vesta 模板内容，不是所有租客必须安装的 runtime。 |
| 每次 clone | 绑定原生 VM GUID 与既有 allocation/generation/controlVersion；GenerateNewId/动态 MAC 不当作 guest SID、machine-id 或 host-key 已刷新。是否需要 guest 泛化由模板配方决定，不按标签再加通用门槛。 |
| 引导输入 | 同一 allocation 的 nonce、租客账号、该票公钥及指纹；只送公钥，私钥留控制面现有短期授权流程。重试必须读回同一份冻结输入，不能不断生成新身份。 |
| 执行渠道 | 首先核模板已有的受支持初始化入口。Windows PowerShell Direct 是候选，但需要有效 **guest** 凭据；宿主管理 token 不自动提供它。本轮没有这个事实，不调用。若模板没有入口，再具体选择一次性 seed/first-boot 配方；不先安装宿主代理或创建长期 guest 账号。 |
| 初始化回执 | 原生 VM GUID、allocation/nonce、实际 guest Windows 版本/amd64、实际账号、已安装的租客公钥指纹、guest SSH host 公钥/指纹、完成状态；通过所选引导通道与原 VM 绑定取得，不能把模板标签或陌生 IP 上的 banner 当成实际交付。 |
| 可连接 | 现有 switch 的地址读回后，以 API 交付指纹核 SSH、实际系统/架构、账号及工作目录可写和资源配置。家庭受信任网络按已选现有连接使用，不照搬 Docker iptables/Softnet、禁 IPv6 或默认断网门槛。 |
| 租用/归还 | 复用现有 Lease/Claim/Operation；续租 confirmed 才更新到期。业务保存小结果后归还，native VM 及 owned 文件缺席才释放 Claim；服务离线严格到期硬停仍无保证。 |

缺少的实际材料很具体：合法 Windows 模板及完整制品身份、它已有的初始化渠道（若用 PowerShell Direct 则是其既有受保护 guest 认证引用）、已启用的 Hyper-V/可用既有 switch 和专属 E 盘根。未读取/生成这些秘密，没有要求用户现在决定新平台。模板与系统变化留待下一次明确实机范围；独立源码接线不因此等待。

## 本批验证归属

受控 Hyper-V server、controller client、合同和相邻 Tart transport/内核/日志回归通过；含本机临时 mTLS 的真实 HTTP 往返，但后端是受控 driver，不是原生 Hyper-V。测试证书仅在临时目录内创建并回收，没有建立持久服务凭据。

未重复 Docker/Studio ARM/macOS/Linux 已验实机票，未更改正在服务 Go 影音的冻结兼容包。远端 PowerShell Parser 因自动审批拒绝而未执行；本批没有重试、换入口或上传源文件。精确待批动作及原因保留在本机任务交接，待白天统一汇报。

固定guest SSH probe与制品草稿的接续实现、验证和真实未覆盖见[后续批次](HYPERV-READINESS-AND-DRAFTS.md)。实际模板初始化渠道仍未实现。

历史解析拒绝已获一次具体新授权并重试，原维护通道60秒超时、无解析回执；不是再次拒绝或语法通过。未重复未知请求，详见[当前入口与真实边界](HYPERV-RUNTIME-ENTRY.md)。
