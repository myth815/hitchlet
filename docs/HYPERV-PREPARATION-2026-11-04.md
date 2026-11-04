# Windows x64 / Hyper-V：现状与最小施工路线

## 当前接续状态（2026-11-04 只读核查后更新）

以下更新取代后文 **01:21 历史快照** 中“组件 disabled、尚无管理/provider 接线”等当时结论；后文保留作为操作历史，不作为当前部署指令。

- 用户已批准的宿主 Hyper-V 启用与正常重启已完成。17:36–17:44 北京时间只读快照：DESKTOP-R9DS3H1 / 172.28.66.30，vmms Running、组件 Enabled；实际 i9-11900（8核16线程），约128 GiB RAM、119 GiB空闲、E盘1.43 TiB空闲。容量是当时快照，执行前再核当前负载，不用作未来预留承诺。
- Get-VM 返回0；默认 VHD 目录为空，已知 E:\HitchletTemplates、E:\HitchletRuntime 尚不存在。未找到已确认可用的 Windows/amd64 完整导出；未扫全盘，不能说整台机器绝无 ISO。宿主 Windows 许可不自动等于 guest 克隆使用权。
- 正常注册/资格/发布、PowerShell Direct guest 初始化、同账本租约源码已有受控验证；远端 guest SSH 端点已补内部转接，见[管理与 guest 接线](HYPERV-MANAGEMENT-AND-GUEST.md)。这些都没有部署成真实 Windows 可租节点。现行 Studio Docker 服务仍是独立冻结兼容版，不能直接接受新 VM 合同；不为准备 Hyper-V 热换或打断它。
- 目前不需要继续改宿主 Hyper-V 组件、重启、创建交换机或改 DHCP/firewall。沿用已有 Default Switch 和维护 SSH22。控制器所在 Studio 本机消费者可使用内部 loopback guest 转接，其他机器不能直接复用该地址。

### 剩余最小路径

1. 确定 **一个**具有相应使用权的 Windows/amd64、Gen2、自包含且正常关机的模板导出。Runtime 导入的是完整 vmcx/VHDX 导出，不是 ISO；若只有安装介质，先准备模板是独立一次性工作。Linux/amd64 不能替代本轮 Windows 原生验证，内置 PowerShell Direct 初始化也尚未支持 Linux guest。
2. 模板 guest 中准备普通 workspace 账号、Windows OpenSSH 和当前固定脚本所需的专用 stopped sshd 服务。服务引用 C:\ProgramData\Hitchlet\sshd_config，但封存前不能带入本轮生成的 host key、authorized_keys 或 bootstrap-state；每个 allocation 会生成独立访问材料。guest 中如需允许 SSH，仅限该测试 guest，不借此改 Windows 宿主防火墙。Node24/pnpm/Git 属于 Vesta 测试环境，不是平台 SSH readiness 的前置。
3. Runtime 在 Windows 需要 Node24 和本项目离线包；包内已有 contracts/zod 与固定 PowerShell 资产，不需要 npm install。Node 在维护 PATH 尚未发现不代表整机没有。使用 E盘专属工作/状态目录与原维护身份，模板 guest 管理身份必须单独引用，不能把宿主账号交给租客。新增 guest PSCredential、Runtime mTLS/token 如确需准备，应明确本次用途及结束撤销/保留范围；当前均未创建。
4. Runtime 可只监听 Windows127.0.0.1，通过既有 SSH22 的短期本机端口转发接到 Studio 的临时控制面；证书 SAN/Runtime 身份按实际端点配置。这里是部署方案，尚未创建通道。与 guest 的原始 SSH 转接是两个职责，不把已有宿主维护登录成功当作 Runtime mTLS 或 guest 登录成功。
5. 使用独立临时控制面/账本和匹配 SDK，在原有正常 API 上发现、登记、真实资格与发布；不升级既有 Docker 影音服务、不修改其消费者和存储配置。然后一张 Windows/amd64 票，4vCPU/8GiB/80GiB动态盘、初租900s，必要时一次confirmed续租，运行消费者提供的固定 Windows 兼容用例，保存小结果，归还后核GUID/本票目录缺席与Claim0。

模板就绪后首次资格、发布和测试预留30–60分钟；从零准备模板另估1–2小时，不含下载、安装界面和许可交互。这些仅为安排估计。首次验收阶段顺序运行、最多一台活动guest是本次测试预算，不是产品长期并发限制。

### 当前真正需要决策/授权的执行动作

- **模板来源及一次性准备**：现成合法导出或确切安装介质尚未选定；尚未下载/接受许可，也未创建 VM。不把新的许可接受或交互登录藏在部署里。
- **Windows 专属 Runtime/guest 部署和本次认证**：把候选传到 E盘专属根、准备 Node/模板账号与现有或本次专用认证、临时控制通道，随后真实资格/一票验收。需明确实际文件、账号和临时材料生命周期，不能拿源码授权当已执行部署。历史被拒的远端源码解析/核查仍保持暂停，不改名重试。

已批准的开发和本地制品准备不必等待这些执行动作；GitHub 推送仅等待现有身份恢复，不再重复请求已批准的开发权限。没有必要先安装常驻 Windows 服务、扩大宿主网卡/防火墙配置或恢复旧影音编排。

## 01:21 历史快照（已被上述当前状态部分取代）

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
