# Windows x64 Hyper-V 实机验收（2026-11-05）

## 结论

Hitchlet 已在家庭 Windows x64 Hyper-V 上通过真实资源租约闭环：正常发现/注册、资格、镜像验证及发布，消费者声明 `kind=vm`、`guestOs=windows`、`allowedArchitectures=[amd64]`、4 CPU / 8192 MiB，平台选择节点；领取、SSH、confirmed 续租、保存输出、归还及原生缺席/Claim0 均已核实。

固定 Vesta CLI 的三个 `governance text` 用例**全部失败**，不能称 Windows CLI 多平台验收完成。失败是现有消费者在 Windows 下拒绝自己的独立 Git fixture 根目录；环境、TAP 和逐文件摘要已保存，未修改固定消费者源码或重跑成通过。

这是单模板、单业务票的隔离实测，未建立常驻 Windows 公共租用服务；Docker、Tart 和影音服务没有切换。

## 真实环境及制品

- 宿主：DESKTOP-R9DS3H1，Hyper-V 2.0.0.0；沿用已有 Default Switch 与维护 SSH，无新增交换机、DHCP、宿主防火墙或权限设置。
- guest：Windows 11 Pro 23H2 / 10.0.22631，amd64，Generation2；4 vCPU、固定8192 MiB、80 GiB动态 VHDX。`scratchMiB=0 / best_effort` 表示未额外申请临时盘，不把系统盘大小冒充硬 scratch 配额。
- 租客为普通 `workspace` 用户，OpenSSH、Node v24.21.0；租客没有宿主维护凭据或管理员权限。宿主经 PowerShell Direct 使用受保护的模板 bootstrap 引用。
- ISO 来自用户的已完成下载；转移前后完整 SHA256：`953f9ecd3307a92fb5daf12e3fe05603fe63181f6abc0b08b42e632e09510e39`。Microsoft setup 签名有效；未获得该历史 ISO 的独立官方全文件 hash，不以传输 hash 代替官方出处认证。
- 停止、自包含模板 `windows11-pro-node24-amd64`，完整导出摘要 `sha256:1c83caf0a7344f268de7556cd9aa6d723deb04873c96cd8ec411522a8a206458`。无外部父盘；原准备 VM 和导出保留。
- 模板未做 Sysprep，未声明新的 Windows SID/主机名。每 allocation 有独立原生 VM GUID 和 SSH 主机/客户密钥。未执行激活，下载/安装不等于具有长期激活许可。
- Runtime 原包基线 `edc5991498d458953ede4e7bd63f53a73158ca6c`，825 文件逐一核验，归档 SHA256 `0422243d590c6bb2d8ddd1d0c7d64b5d6ac2f49b69156ef30f6fa97651dbbd95`。实机故障修复后，PS guest 资产及 bootstrap 诊断 JS 均有逐文件补丁摘要与旧字节备份，不再称部署包“未修改的 edc5991”。

## 正常平台闭环证据

| 步骤            | 实际结果                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| qualification   | 原生4 CPU/8192 MiB、guest x64与实际CPU/内存、普通用户生产 SSH probe、可写及输出hash通过；qualification VM正常删除             |
| 发布            | version `753bca19-0370-415d-896e-acdc30fd73eb`；validation `f8f45578-1376-4849-8dc1-c460578ce316` passed / cleanup complete   |
| 唯一业务 Ticket | `be2691a9-5fff-4a7e-ba7e-0aeab750e704`；请求不指定 node/provider；实际 placement 为 hyperv / windows / amd64                  |
| 身份/访问       | claim成功；API主机指纹与SSH精确匹配；短期客户材料只在进程内使用，未回传宿主维护认证                                           |
| 续租            | confirmed，确认 expiry `2026-11-05T04:08:50.494Z`，offlineEnforcement=`not_guaranteed`                                        |
| 控制面恢复      | 修复期间重启专属控制面；原Ticket/VM保持，完整性观测重建临时SSH端口；重新取原access命令得到新端点，未新建业务VM                |
| 输出/归还       | SSH执行日志、环境、TAP等7个小文件在release前逐文件匹配guest manifest；归还后本地保存结果仍在                                  |
| 原生清理        | VM `4db0f267-eabe-442a-b9bf-33fb138bcbee` 缺席，owned工作目录为空；全部本轮validation/tenant manifest为released且对应VM均缺席 |
| 账本            | 一张业务票released / cleanup complete；2条历史Claim均released，live Claim0；active/unknown/cleanupBlocked0                    |

guest 实测报告4逻辑CPU、8,588,775,424 bytes可用物理内存、Node v24.21.0、Git for Windows2.56.0.windows.4。MinGit来自官方Git-for-Windows release，包SHA256 `e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877`；工具与固定测试依赖仅安装在本票workspace，随VM回收，未改宿主全局环境。

## 本次修复

1. **公开健康及access入口**：health schema和HTTP access模式列表均漏Hyper-V。补入hyperv；access仍执行原owner、lease、generation和材料检查。Tart/Hyper-V加密材料HTTP回归均通过。
2. **PowerShell5.1原子写入**：`.NET File.Replace` 的 `$null` 被绑定为空路径，改显式 `[NullString]::Value`；仍原子替换。原故障与最小Windows复现均有证据。
3. **OpenSSH LocalSystem启动**：bootstrap账号生成的主机私钥属主使服务1067退出。设本次私有文件的属主为Builtin Administrators，维持原SYSTEM/Admin ACL；没有给租客新增权限。实测仅更正属主即可使服务正常启动。
4. **普通用户就绪探测**：WMI/CIM `0x80041003` 被不必要地当作guest不合格。改用无WMI权限需求的.NET OS/architecture API，保留Windows/x64、账号和可写检查，不要求Node/Python或提权；在实际guest中生产probe通过。
5. **零临时盘额度**：合同允许scratch配额0，但申请与预留两处使用严格正数校验。改为非负，回归证明0请求可申请/预留、正scratch请求仍被0额度拒绝。
6. **bootstrap错误可诊断**：unknown仍保持unknown，仅附固定的失败阶段/类别；不把原始远端错误或凭据内容暴露给租客，原请求恢复不重复导入/初始化。

本轮定向验证：health3项、SSH readiness10项、Tart/Hyper-V access2项、零scratch申请/预留1项、Runtime bootstrap相关9项通过；controller/contracts/runtime相关标准构建及严格类型检查通过。没有重跑全仓测试。

## Vesta CLI 失败与接续

- 固定 commit `5e6dba54f3fcd2f52f2c66fda6a6d2dd86946c3d`，tree `680034fe2f5b8b796ea36ae0c425238bcc711afb`。
- 输入为111个固定源码文件的子集归档，逐字节核验；不是完整Git checkout。test文件SHA `2c68314f9fd9c9b5245e28f32c30a7b8d591204392cb9d1a26e558c8afe0a72e`，lock SHA `b9b07e49fb2c81e30fcedd55fc814f6544d3132179347bf247ab5b30c331f271`。
- 既有测试自行创建真实、独立Git fixture，真实CLI执行；3项全部失败。共同诊断为 `--workspace must be the independent repository root.`，第二项随后因缺预期报告触发TypeError。
- 固定源码 `tools/cli/src/governance/git.ts:48` 直接比较Git `--show-toplevel` 与workspace字符串。Windows分隔符/规范路径不一致是最小修正方向，属于Vesta CLI；本轮未修改消费者源码。应由CLI线先修正并定向回归，再选择一轮明确的新消费者验收，而非反复重跑此固定失败版本。
- TAP SHA256 `12123caca23957c62977cfc6570b0396fdd662ef513b60b4e213b575c5a41573`。

## 收尾、证据及限制

本次专属控制面、Windows Runtime和SSH转接均已停止；无自动TTL的临时token已随服务停止和token/key删除失效，Studio加密master及本轮secret versions已清理。测试节点已disabled。原ISO、关机准备VM、停止的完整导出模板、Runtime工具及宿主DPAPI模板bootstrap引用保留；没有安装Windows自启或改变原影音/Studio服务。

非秘密原始证据保存在本次任务工作目录 `work/hyperv-real-acceptance-20261105/`：`STATUS.json` / `active-run.json`，其run目录下 `evidence/qualification-report.json`、`validation-latest.json`、`ticket-terminal.json`、`ticket-output-confirmation.json`、`cli-vm-test-result.json`、`final-tenant-native-inspection.json`、`final-ledger-readonly.json`、`final-stack-cleanup.json` 及 `outputs/test.tap`。凭据、数据库和本地工作日志不提交到仓库。

仍未覆盖：Hyper-V Linux guest、并发/高负载、RDP、guest持久外部挂载、克隆SID通用化、常驻部署、Windows激活、完整Vesta跨平台矩阵。SSH临时relay仅供控制器所在Studio本机消费者；远端消费者不能直接使用loopback地址。控制面离线仍不保证严格到期强停，恢复协调回收的边界保持不变。
