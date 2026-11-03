# Windows x64 / Hyper-V：现状与最小施工路线

2026-11-04 01:21（Asia/Shanghai）通过现有Windows专用维护封装只读核实。未启用功能、启动服务/VM、改变网络、生成身份或执行电源动作。

## 准确节点与实际前置

- DESKTOP-R9DS3H1 / 172.28.66.30，AMD64，Windows11 Pro for Workstations build26200。
- 16逻辑处理器，物理内存137,282,875,392 bytes；采样空闲物理内存121,330,116 KiB。E盘约2TB，采样空闲1,572,691,476,480 bytes。只是只读快照，不是可预留资源或整机负载资格。
- 现有维护账户myth8的本次有效token为管理员，合法封装/既有凭据和host-key校验可用；没有修改身份或读取回传秘密。通用旧入口myth815认证失败，随后按本库现存Windows专用入口纠正；没有反复试口令、解锁旧私钥或新配凭据。
- 所有查询到的Microsoft-Hyper-V组件（含Hypervisor、Services、Management-PowerShell/Clients）InstallState=2，vmms不存在，Get-VM不可用。
- HypervisorPresent=true不能替代完整Hyper-V管理组件就绪或provider资格。Microsoft将InstallState=2定义为Disabled，见[Win32_OptionalFeature](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-optionalfeature)。本次无法读取Hyper-V VM清单或switch，不能推断没有其他虚拟化/WSL负载。

维护源码、计算节点职责见home-infrastructure的compute/hosts.md与现有Windows专用封装。旧Windows/WSL rootless Docker smoke不是Windows原生VM能力，E盘旧ComputeNode数据也不能直接归入Hitchlet所有权。D/F盘未访问。

## 当前代码到哪一步

公开请求已独立表达kind、guestOs、architecture、资源；统一Ticket/Operation/Lease/Claim与恢复存在。执行注册仅portainer/tart/simulator；现已增加[Hyper-V原生生命周期内核](HYPERV-NATIVE-KERNEL.md)与受控回归；已有内部认证Runtime server/client受控接线，见[通道与初始化边界](HYPERV-RUNTIME-TRANSPORT.md)；仍无Windows实际启动组合、原生guest初始化或正式ExecutionPort管理注册/发布资格接线。Windows Host观测/电源脚本不提供Hyper-V生命周期。

内部ExecutionPort与guest握手现已有受控源码，见[provider边界](HYPERV-PROVIDER.md)。首轮仍走现有ExecutionProvider接口，不增加消费者的hyperv参数或通用插件框架。现有Tart源码是生命周期和身份校验的参考，不能把tart-exec、launchd、Linux UID或ARM模板直接套到Windows。

## 最小实施顺序

1. **先恢复真实前置再承诺可租：** 仅在具体功能变更获准后启用现有内置Hyper-V，不下载别的虚拟化平台；记录RestartNeeded，不擅自重启。Microsoft的[安装说明](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/Install-Hyper-V)与[Enable-WindowsOptionalFeature](https://learn.microsoft.com/en-us/powershell/module/dism/enable-windowsoptionalfeature)说明了管理员功能启用和NoRestart参数。
2. **仅一个已有业务需要的guest：** 首选Vesta实际缺少的Windows/amd64测试单元。确定合法模板来源/许可、关闭且泛化的模板和Node/pnpm/Git/OpenSSH初始化；Linux/amd64可后续复用同一provider，不将两种guest都作为首票前置。
3. **内部driver垂直切片：** 固定PowerShell动作和结构化输入/输出；完整复制/Import-VM -Copy -GenerateNewId，使用平台精确VM ID/owner/generation/controlVersion；控制CPU、固定内存、地址/readiness和短期SSH交付。模板/磁盘仅在明确批准的E盘专属子根，既有ComputeNode不能盲扫或接管。
4. **生命周期闭环：** 创建/启动及命令结果丢失从原VM ID观测恢复；先record持久Operation，再执行stop/delete并查实VM及owned磁盘/检查点缺席，最后释放Claim。Remove-VM成功不等于VHDX已删除。不按名称/PID猜归属，不把unknown写成absent。
5. **最后注册到控制面：** 通过现有内部注册、能力/制品验证和已授权Runtime通道交付；默认家庭可信NAT，不照搬Docker iptables或强隔离机械门。只有真实guest初始化和回收通过才公开该OS/架构可租。Vesta仍只声明需求并返回小测试结果，镜像来源、host选择和磁盘清理由平台管理。

## 必须停在具体确认处的动作（尚未执行）

- 在这台Windows启用内置功能，候选命令为`Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart`；这是改变系统组件，不属于本轮只读授权。若报告需要重启，需另有明确窗口/范围，不自动执行。
- 模板尚未确定。若下载Windows镜像、接受新许可、guest初始化需要新增持久身份/证书，应分别明确来源、大小、用途和期限，不借“无人化推进”自行接受。
- 未枚举到可用switch。功能启用后先只读核既有可用NAT/Default Switch；能复用则复用，不先创建External Switch、改物理网卡、全局firewall或影响WSL/既有负载。
- 工作根仍需落在明确的owned E盘子目录；没有创建目录/VM或改ACL。当前管理员token证明读取已成功，不是后续系统变更的自动批准。

内部生命周期源实现和47项相关回归已独立完成；当前没有宿主后端可用事实，也没有合适guest模板，因此不注册可租“支持”或拿受控回归当实机。下一批应以已有provider契约的单guest垂直切片为界，不先做快照池、强隔离或大型VM编排。
