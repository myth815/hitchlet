# Hyper-V 管理与 Windows guest 初始化接线

2026-11-04。本批是在已有内部 Hyper-V native/runtime/provider 上接通正常管理、发布和租客生命周期的源码交付。**所有新增 guest/VM 证据均为 Studio 上的受控替身，不是 Windows VM 实测。** Windows 宿主已按单独授权启用 Hyper-V、正常重启，Get-VM 可用；没有创建 guest，也没有发布真实可租 Hyper-V 能力。

## 已有通用接口，不要求消费者选择宿主

消费者沿用 `acquire`：`kind=vm`、`guestOs=windows`、`allowedArchitectures=[amd64]`、CPU/内存及已发布镜像版本。宿主 OS 与 guest OS 分开；provider、node、machine 不必由租客指定。内部 `registered` 组合增加 Hyper-V，显式 Docker/Tart 单后端设置不变，仍只匹配已登记、已资格通过的节点。没有新的插件框架。

实际交付继续使用 placement 的 provider/architecture/guestOs、SSH 端点与 API 指纹、现有加密材料存储；claim 和 renew 仍先 pending 再 confirmed。结果不确定复用原 Ticket，不重开票；回收查实前保留 Claim。

本批发现并修复两处真实接线遗漏：

- native VM GUID 是资源 ID，创建意图使用稳定的 allocation 名称。资源回执补 `nativeName` 对应既有 journal 字段，保留 GUID 和 owner；否则创建效果一直 unknown。这里的名称是 journal 关联键，不冒充 Hyper-V 显示名。
- claim/renew 决策与 access 的旧模式筛选未包含 Hyper-V。补齐服务及 renewal 存储筛选，复用既有材料、期限与所有者检查。

## 正常管理接线

- `POST /v1/provider-connections` 接受 `backendKind=hyperv`；SDK `inventory.discoverHyperV`。使用已有 Runtime mTLS/token 的受保护引用读取固定 host facts，不调用 Docker 探针。相同 native namespace 去重。
- 人工库存登记 Windows/amd64 宿主及其独立容量池；注册节点初始 disabled。`PUT /v1/nodes/:id/hyperv-runtime-config` / SDK `configureHyperVRuntime` 绑定原 Runtime 身份和既有 switch 名称。
- 原 capability attestation 入口接受 Hyper-V：精确 namespace、Hyper-V 版本、模板摘要及 resourceLimits/sshBootstrap/cleanupRecovery 三项实际报告。提交时核对节点版本和当前连接修订。正常观察刷新对比当前 host/模板/预算，不延长原资格寿命。
- 草稿、image validation、清理和 publish 沿同一账本执行；新申请要求当前模板可用，清理只要求原精确 Allocation/Operation、身份和有效认证，不因停止新申请或模板消失而丢掉原回收责任。
- 正式 server 已接 `EXECUTION_MODE=hyperv` 和 `registered` 的 Runtime resolver、共享 worker、lease/access、后台观察/恢复与 cleanup lane。源码可用不等于已在 Windows 安装服务。
- 管理 GUI 可读 Hyper-V facts，显示版本/宿主架构/模板数；本批没有新增完整的 Hyper-V 初始化表单，操作入口为正常 API/SDK。

## 模板是完整导出，不只是 vmcx 文件摘要

Runtime `--seal-template descriptor.json` 为一个**停止且自包含的导出**建立本地记录。descriptor 示例（不是已经存在的模板）：

```json
{
  "name": "windows-dev-amd64",
  "exportRoot": "E:\\HitchletTemplates\\windows-dev-amd64",
  "configRelativePath": "Virtual Machines\\template.vmcx",
  "guestOs": "windows",
  "generation": 2
}
```

显式 seal 时流式计算目录内所有普通文件的 SHA/大小，包括 VHDX；逻辑模板名、guest OS/arch/generation 和文件清单共同形成制品摘要。状态落在 Runtime stateDirectory/templates。facts 检查 namespace、根目录身份、清单/文件元数据及配置摘要一致性；文件变化或导出不可用就不报告该模板，不自动重新 seal，不在每次申请时重新读完整虚拟磁盘。

第一版**不解析 VHDX 外部父盘链，也不证明正在运行/保存的 VM 可用作模板**。准备者须使用停止、自包含的完整导出，不能把带外部依赖的配置封装当完整镜像。真实 NTFS identity、导出/导入和模板初次 seal 尚未实测。Linux/amd64 模板类型可表达，但下面的内置初始化渠道仅 Windows/amd64，因此不能凭类型登记 Linux 可租能力。

## 固定 Windows guest 初始化

Runtime 配置可显式提供：

```json
{
  "guestBootstrap": {
    "kind": "powershell_direct_windows_v1",
    "credentialFile": "E:\\HitchletRuntime\\private\\existing-guest-credential.xml"
  }
}
```

引用必须是 Runtime 身份可读取的**既有 DPAPI PSCredential**，本代码不创建它、不输出密码，也不把宿主维护身份交给租客。PowerShell Direct 通过精确 VM GUID 执行打包的固定脚本，JSON stdin 只含公钥、身份和凭据文件引用；最长 30 秒、输出 64 KiB，未知结果按原初始化意图观察恢复。

模板应预先具有指定的本地 workspace 账号、Windows OpenSSH 和停止的专用 `sshd` 服务，服务指向 `C:\ProgramData\Hitchlet\sshd_config`。初始化只写本 VM 的临时授权公钥、独立 SSH host key/配置及持久回执，启动该已有服务并核端口进程/公钥/配置摘要。账号、OpenSSH、服务创建和 guest firewall 准备不隐藏在申请动作中。没有 Node/Python 前置；Windows SSH readiness 使用系统 PowerShell，Linux readiness 使用原生命令。

SSH 原始 key/指纹、账号、VM/nonce/Allocation 身份与 receipt 对齐后才交付。中断或材料变化保持 unknown，不盲重放部分初始化；可由原 owned VM 的清理流程结束，不回收其他 VM。PowerShell 5 参数、实际 ACL/服务启动/SSH 行为未实机验证，不能把假 runner 回执当初始化成功。

## 网络、存储和剩余实际条件

本接线仅使用已有 Hyper-V switch 的可信 NAT：不创建 switch、不改宿主防火墙/路由、没有强网络隔离或 IPv6 关闭承诺，也没有 NAT 网络回收回执门槛。Docker 原有行为不变。VM 独立、身份、容量预留、租约与销毁查实保留；共享存储挂载、required scratch/RDP 不在本适配器首批支持范围。

下一次真实验收需要：选定合法、自包含的 Windows/amd64 模板；准备账号/OpenSSH/上述 guest 身份；把本 Runtime 与已有控制面按正常认证配置部署；在原 switch 验证 Studio 到 guest SSH（远端 Default Switch 使用下述内部转接）。模板下载/许可接受、新持久认证和具体 guest 网络准备尚未实施，不能只因 Hyper-V 已启用就自动执行。

只需先走一张专属票：正常资格/发布 → 按需求申请 → 取实际环境与 SSH → 一条固定消费者测试 → confirmed renew → 保存小结果 → release → GUID/目录缺席与 Claim 归零。Tart macOS/Linux ARM 和 Docker 的既有实机证据继续有效，不重复执行。控制面离线不保证租约严格到期强停，恢复后仍按同一资源身份协调回收。

## 本批验证与复审

Controller 受控管理测试从发现/namespace 去重、disabled 注册、正常资格、观察退化/恢复、验证清理、发布证明到普通租客申请全链执行。租客不指定 node/provider，重放同一幂等申请仅返回原票；实际回执为 Windows/amd64，claim/renew confirmed、读取临时 SSH 材料、release/cleanup complete、Claim0。Runtime/SSH 均为明确标注的替身。

相邻回归覆盖 Hyper-V native/runtime/SSH、真实本机 mTLS 传输、Tart 恢复和注册路由兼容。模板测试证明虚拟磁盘字节变化影响摘要、拒绝链接并不报告坏记录；不冒充 Windows 原生 seal 验证。新增 PowerShell 资产没有传到 Windows 执行或解析，没有重试历史被拒的源文件检查。

最终本地检查：Controller 58 项（含共享租约后台）、Runtime 43 项、GUI 管理 10 项、既有状态入口 10 项全部通过；另选跑现有 Tart VM 两模式及环境选择 5 项，其他 62 项未重复运行。contracts/SDK 标准构建与来源记录、controller/runtime TypeScript、guest 资产复制、GUI TypeScript 均通过。有限复审同时订正了资格提交的连接修订 CAS 与 GUI facts 区分；没有新增真实系统动作。

## 远端 Default Switch SSH 端点（2026-11-04 源码增量）

Hyper-V guest 私网地址不等于 Studio 可达地址。operator 的 `runtimeProfile` 可选配置 `sshRelay`，复用 Windows 已有 SSH 通道：`host`、`port`（默认22）、`username`、`hostKeyFingerprint`，以及 `privateKeySecretRef` / `passwordSecretRef` 二选一的既有受保护引用。源码不读取 home-infrastructure 的私有配置，不创建身份或复制维护凭据；实际配置时须明确选择既有身份与有效认证引用。未设置时保留直接 guest IPv4:22 行为。

控制器在本机 `127.0.0.1` 分配临时端口，通过经过宿主指纹验证的 SSH `direct-tcpip` 转发到**该精确 VM 当前 IPv4:22**。租客公共接口不变：拿普通 host/port/账号、guest 指纹及原短期 guest 材料；原始 SSH 字节透传，guest 指纹校验、账号/OS/架构/可写目录探测仍端到端进行，宿主维护凭据不会交付租客。没有远端监听端口、命令执行、Softnet、交换机、DHCP 或防火墙修改。

这一首版端点供**控制器所在 Studio 本机的消费者**使用；127.0.0.1 不能冒充家庭其他机器可达的公共入口。若消费者移至别处，应另选可达部署方式，不把本机转接地址直接复用。

每个 installation/runtime/allocation/generation 只保留一条在途转接。原 VM/IP/认证引用不变则复用；guest IP 或引用变化会关闭旧连接和监听，重新核 SSH 后刷新端点。控制器重启或 SSH 断连后，由既有完整性观测重建转接；临时端口可能变化，健康证据确认后在同一事务中更新 operation 与 allocation 两份回执。消费者重连须重新调用 getAccess 获取当前端点，不能永久缓存端口。短暂断线保持 unknown，不声称已恢复；不会新建 VM 或替换 guest 密钥。

归还在精确 cleanup 授权解析后关闭本 allocation 转接及所有活动流；随后仍需实际 stop/destroy/absent 才能释放资源 Claim。控制器正常关闭及启动失败也清理内部转接。控制面离线严格到期强停依然 unsupported；本改动不是新增离线强停保证。

本增量只进行了假 SSH/假监听器、provider、SQLite 回执 CAS 及相邻 SSH 测试，没有创建真实隧道、部署节点、创建 VM 或重跑既有 Tart/Docker 实机验收。真实前置仍为合法自包含模板、guest 初始化、Runtime/mTLS 部署和一次 native SSH/租约/回收验收。

本增量有限复审核查了：正常/registered 组合的进程关闭路径、精确 owner 的归还、转发流同步销毁、断连时 forwardOut 竞态、身份/凭据引用轮换、端口更新的 release/controlVersion CAS，以及直接 guest:22 的旧路径兼容。最终 controller 50 项定向检查、contracts admin 6 项通过；contracts/controller 标准构建通过。没有重复全仓测试，也没有把该源码接线报告为真实 Windows 可租。

## 2026-11-05 实机状态更新

Windows amd64真实资格、正常验证/发布、唯一Ticket SSH/confirmed续租/结果保存和查实回收已完成。固定Vesta CLI的3项用例实际失败，临时服务和认证已清理；这取代本文前述历史“尚未实机”的状态，不改变其他未验范围。具体修复、运行版本、模板限制及消费者失败证据见 [Windows实机验收](HYPERV-WINDOWS-ACCEPTANCE-2026-11-05.md)。
