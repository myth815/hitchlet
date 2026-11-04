# 精确 SMB 挂载根选择

消费者沿原 storage 请求使用 `authorizedSubpath: "."` 选择管理员明确批准的 SMB 源根本身。只有该 profile 的 `protocol=smb`、`allowedSubpaths` 明确含 `"."`，并允许请求的 mode 时才接受；消费者对 profile 的既有授权、冻结修订、节点存储修订资格均继续生效。普通相对子路径保持原行为；`./child`、`child/.`、`..`、空路径或绝对路径没有被放开。local/NFS 根选择不在本批范围。

这是选择同一已批准目录，不是扩大到其父目录。Runtime 沿现有 realpath、无符号链接、真实 CIFS 类型、mountSource、宿主/Agent 映射和稳定父目录检查取证；源根仍须是目录。可写的批准根本身是 bind 的叶目录，不因它可写而拒绝；若选择其子目录，既有祖先可写检查仍执行，没有增加例外。

## Music 接入方案

保留现有整个 Music 的只读挂载、单专辑试跑和合成输出。新输入 profile 仅选择原 RO 根的 `My Music`，挂 `/input:ro`。

正式输出使用 Music 共享中 `Library-v2/自动整理` 的独立精确 RW 挂载，不把整个 Music 改成 RW。将实际挂载点本身登记为新的 SMB sourceRef，profile 仅允许 `"."` 和 read_write，租客映射到 `/workspace/data/library`。业务以该目录为目标，不要求平台处理音乐命名、模型、播放器索引或业务排队。该目录可否由现有播放器递归索引由影音线回读确认。

Runtime 的 static storageRoots、实际 mountinfo 和 Docker daemon 源路径必须一致；不能把 CIFS 伪装 local，或用 noperm/假模式规避原检查。新目录/挂载/根配置/正常 profile/grant 与节点修订绑定在空闲窗口实施，所有既有根和授权以追加方式保留。原 rprivate bind 不自动传播新挂载，根配置也只在启动时读，因此可能需要一次协调 Runtime 重启。控制器/SDK/contracts/Runtime 必须配套支持该根标记；不能向旧严格 SDK 发送 dot 后把本地校验失败说成业务失败。

## 本批证据边界

权威源码已做合同7、Runtime存储15、租客/验证入口7项定向检查及 contracts/SDK/controller/runtime 构建。模拟 CIFS 夹具验证精确根、父目录保护、协议和宿主映射，SQLite验证正常授权/冻结入口；不是新 NAS 写入或真实业务验收。正式部署、真实 SMB 根写入和持久性证据在联调回执另记，不复用这些测试冒充实机。
