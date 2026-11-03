# Hyper-V 原生生命周期内核（源码阶段）

2026-11-04。已实现内部HyperVLocalDriver与固定PowerShell原生适配，尚未注册为公开可租ExecutionPort。Windows实际组件仍Disabled；本批不启用功能、不重启、不创建真实VM、凭据或网络。

## 已实现的能力

- 内部请求独立保存guestOs=windows/linux、architecture=amd64、CPU与固定内存、模板配置引用和既有switch名称。它们是请求/镜像元数据，不冒称已经观测guest系统。没有向租客新增host/provider或宿主路径参数。
- 原生固定动作：facts、prepare、inspect、import、configure、start、stop、remove。Node只调用一个固定ps1文件，用JSON stdin传数据，无shell脚本拼接、提权请求或自动安装。原生脚本不会启用Hyper-V、创建/删除宿主交换机、修改firewall或生成凭据。
- Import-VM使用Copy / GenerateNewId和本allocation目录下明确的配置、VHD、checkpoint与paging位置；配置CPU、静态内存、动态MAC，并连接已选已有switch。不创建新的host switch，不把已有switch自动当成NAT/强隔离证明。
- 每个allocation的身份包含installation/runtime/connection/allocation/generation/purpose，operation/controlVersion作为命令栅栏而非owner键。共用VM身份/资源schema从Tart提取，原Tart名称作为同对象别名保留，wire shape不变。
- 第一次导入前持久保存intent，观测到的native VM GUID随后保存；同一请求和Runtime重建先读原记录/原VM。已完成导入但回执丢失可恢复，不重复Import。模板配置、资源或switch改变不覆盖冻结请求；旧controlVersion不能重新启动已归还generation。
- allocation分别串行，无全局慢创建锁；一个慢Import不会阻止另一个allocation回收。原生命令按已有deadline约束，import最多120秒，其他动作最多15秒，超时/失败不会被伪造成成功。
- stop/remove只操作读回的精确VM对象与记录ID，不按名字或PID接管。原生目录标记、VM Notes、配置/盘路径必须与记录相符。VHD父链也需在owned目录内，避免Remove-VM合并checkpoint时写到外部父盘。
- 删除分别确认VM注册和owned目录缺席。磁盘忙/部分删除时保留owner marker以供重试；仅剩空目录时允许在已记录native ID缺席后完成空目录删除。外部switch为引用，不删除。tombstone防止旧请求复活，重复完整清理只读返回原缺席证明。

## 什么仍未实现或未验证

这是原生生命周期**内核**，不是完整Hitchlet Hyper-V provider。生产server/执行注册没有加入hyperv；不会因为类型或模拟对象而向消费者宣称可租Windows。

- guest初始化与SSH交付、正式ExecutionPort/Operator管理发布接线尚未实现。内部认证HTTP server/client已接线，见[Runtime通道](HYPERV-RUNTIME-TRANSPORT.md)；尚无实际Windows启动组合或实机通道。bootstrapStatus固定为not_implemented，不返回access或ReadyReceipt。
- Native VM新ID/动态MAC不等于Windows SID、Linux machine-id或guest凭据已初始化；这些由后续固定guest配方和真实资格证明。不同guest OS保留独立实现，不套用Tart路径、launchd、ARM或Linux UID。
- 当前仅校验vmcx配置hash，**不是整个VM磁盘制品证明**。公开发布前仍需固定完整模板/磁盘身份、来源/许可和准备过程。没有下载模板或接受许可。
- 若导入在完成Notes归属标记前中断，或者仍可能有未完成的原生导入，保持unknown，不凭暂时查无VM或只有目录就自动重发/删除并释放Claim。后续Runtime接线需补该类native job/操作完成取证；当前不能称所有中断场景已恢复。
- 同一Runtime命名空间按allocation串行；多个独立写进程/掉电后的磁盘持久性、NTFS实际行为、PowerShell语法与cmdlet执行、网络/IP、guest资源/SSH、正式Ticket闭环均未实机验收。
- stop/remove中的TurnOff只针对明确归属的guest VM，可能终止未保存guest工作；未来调用方必须按租客归还/撤销合同执行，不是宿主关机能力。脚本没有ExecutionPolicy Bypass或策略修改。

## 实际验证

- 新Hyper-V内核16项：Windows/Linux amd64元数据、原ID恢复、丢回执不重开、未知导入保持unknown、VM与文件分别清理、owner/ID/盘路径变化拒绝、冻结规格/控制版本、缺失能力与不完整inventory、运行时规格漂移、跨allocation并发和deadline。
- 共用合同/Tart别名3项；受影响Tart驱动16项与guest初始化6项；Controller执行注册/路由6项。合计**47项定向通过**，均为受控依赖/假CLI或本地文件，不是真实Hyper-V证据。
- Contracts、Runtime、Controller TypeScript构建通过，编译后Hyper-V模块本地导入通过；ps1源与dist副本hash一致。未重跑全仓或旧Docker/Tart实机闭环。
- 未执行Windows PowerShell Parser或任何原生Hyper-V动作。未安装本地PowerShell。具体阻塞留本机任务交接；不能将原生脚本视为已在目标Windows执行验证。

## 后续最小接线

1. 内部认证Runtime server/client已接线；补实际Windows启动组合和namespace/专属目录绑定，再沿持久Operation接正式ExecutionPort，保留认证撤销、owner/generation/controlVersion与未知结果语义。
2. 补Windows首guest的固定初始化/短期公钥SSH/实际OS与架构回读，再补Linux；正式provider复用现有Ticket/Lease/Claim，消费者仍按环境需求申请。源码可继续，不以新建长期身份为先决条件。
3. 系统功能启用、可能重启、模板来源/许可、owned E盘根与实际switch按[已核宿主前置](HYPERV-PREPARATION-2026-11-04.md)处理；当前未执行。真实资格、发布和一张Vesta票通过后才注册可租能力，控制面离线硬停仍不承诺。

原生命令语义参照Microsoft的[Import-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/import-vm)、[Remove-VM](https://learn.microsoft.com/en-us/powershell/module/hyper-v/remove-vm)、[Connect-VMNetworkAdapter](https://learn.microsoft.com/en-us/powershell/module/hyper-v/connect-vmnetworkadapter)。Copy/GenerateNewId提供新的VM标识；Remove-VM不删除VHD文件，不能单凭它返回就视作回收完成。
