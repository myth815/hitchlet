# Hyper-V SSH 检查与制品草稿

2026-11-04，接续 `34423f5` 的纯源码批次。没有连接 Windows、执行 PowerShell、启动 VM、修改宿主设置或新增持续凭据；现有 Docker/Tart 实机证据未重跑。

## 已接通

- `probeHyperVSsh` 检查 API 提供的完整 host public key 与指纹、该票私钥对应公钥指纹，再经SSH22执行一个固定guest检查。默认readiness已接进显式Hyper-V provider工厂；原生guest引导回执仍是先决功能证据，不用SSH探针代替初始化。
- Linux用固定id/uname/临时目录可写检查，明确读回Linux/x86_64；Windows用固定Windows PowerShell命令，读取guest的CIM系统/处理器、当前认证账号，并在自身TEMP创建一个随机一字节文件后finally删除。不安装Node/Python，不请求管理员提升，不修改guest或宿主网络/身份/服务。Windows本地账号按该系统大小写语义比较，Linux保持区分大小写。
- Windows命令按[PowerShell官方UTF-16LE EncodedCommand格式](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)构造，内容固定且不插入租客参数/凭据。系统依据[CIM WINNT=18](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/cim-operatingsystem)、[Win32_Processor x64=9和AddressWidth](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processor)，不用本地化的64位字样猜架构。**该命令未在Windows解析/执行**；这些参考不等于目标guest已验证。
- Tart与Hyper-V复用原Tart的SSH连接处理：原始host-key精确比较、私钥身份校验、全流程最多10秒且不超过操作deadline、总输出4KiB、结束关闭连接、晚到错误收敛。Tart原命令、OS/ARM判据和错误语义保留；不是新增命令分发框架，HTTP/租客API不能提供执行命令。
- 正常管理API可登记/读回Hyper-V Windows/Linux amd64制品草稿：`POST /v1/images`，`POST /v1/images/:imageId/versions`与草稿artifact入口共用现有schema/store；`GET /v1/admin/image-versions/:versionId`返回正确provider/guestOs/architecture。artifactRef是内部模板注册名，不把宿主路径暴露给消费者。数据库原本已支持这些值，无迁移。

## 草稿不代表已发布/可租

本批只增加元数据登记与读回，没有实际登记Windows节点、制作模板、伪造资格或通过发布。`ImageSetup`现有GUI配方仍针对Docker，新增Hyper-V草稿走现有管理API，不冒称已有完整VM表单。

原发布链要求同一制品的成功执行/真实ready/查实清理及有效节点、连接和最新live证明。本批未生成这些事实，草稿仍保持draft；Hyper-V不会落到Docker探针并误判发布成功。专属Hyper-V live模板/磁盘证明、管理节点配置/资格、resolver和正式server组合仍未接，不能仅换backend标签完成发布。详见[provider剩余项](HYPERV-PROVIDER.md)。

## 模板初始化还缺什么

初始化握手已有冻结public request、同VM/nonce读回和unknown恢复；实际Windows/Linux引导渠道仍未选定/实现。需要先知道合法完整模板及其现有初始化入口，才能实现对应确定性配方；宿主管理身份不等于guest凭据。没有为填空安装代理、创建长期账号或构建通用seed/VM框架。

后续真实guest还须具备OpenSSH、上述OS本身的基础命令和可写TEMP。Vesta需要的Node/pnpm/Git来自对应业务模板，不应成为所有VM租客的额外平台门槛。模板来源/许可、Hyper-V组件启用/可能重启、宿主网络及被拒源文件传输仍暂停，白天统一确认具体动作。

## 本批实际验证

34项唯一局部用例通过：新SSH9、草稿API/发布不误路由3、合同新增1；其余21为相邻Tart SSH/草稿、现有Hyper-V provider及admin合同回归。草稿测试使用临时SQLite和app.inject，确认Windows/Linux草稿可正常读回且allocation为0、缺资格仍不发布。SSH测试使用受控ssh2事件/公钥材料，不是实际Windows/VM SSH证据。

Contracts/Controller构建和SDK/GUI类型检查通过，编译模块原生Node ESM导入通过。未重启或升级现有影音专属冻结服务，未访问媒体/NAS/Music。原被拒hyperv-local.ps1未改、未传输，解析拒绝未重试。
