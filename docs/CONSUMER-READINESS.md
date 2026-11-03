# 消费者接入现状与推进顺序

2026-11-04（Asia/Shanghai）。本页连接已有验收和部署条件，不把历史健康、类型声明或模拟结果当作当前在线服务。

## 已证明的单元格

| 消费者所需环境                | 实现和证据                                                              | 当前可用范围                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| container / Linux / arm64     | Studio 专属 Colima / Portainer；通用 Node、旧媒体与新 Go 合成闭环       | 最近收口时保留 loopback foreground 服务；操作前从当前健康、身份和 catalog 核实。未安装自启。         |
| vm / macOS / arm64            | Tart 2.41.1 / Tahoe；固定 Vesta CLI `6eeaf784` 的一个既有用例真实通过   | 模板/cache 保留；临时控制面、Runtime 和认证已关闭清理。不是常驻可租服务。                            |
| vm / Linux / arm64            | Tart 2.41.1 / Ubuntu 24.04.5；同一固定 CLI 用例真实通过                 | 模板/cache 保留，临时服务与认证已清理。两种 OS 使用独立临时栈，没有同一部署的混合 catalog 实机证据。 |
| container / Linux / amd64     | Portainer 适配及请求架构字段存在；不能从 ARM Engine 验收外推            | 家庭 Windows 承载 WSL Linux 的 smoke 不等于完整 Hitchlet Ticket 资格；当前无本轮等价闭环。           |
| vm / Windows 或 Linux / amd64 | Hyper-V 尚未注册到执行实现；Windows Host 观测、协议类型不是 VM provider | 不可据当前类型或 WSL smoke 宣称可租；Tart ARM 不能提供 x86_64 guest。                                |

Docker 的 guest OS 当前为 Linux，宿主 macOS 或 Windows 不改变容器 guest OS。消费者声明 kind、guestOs、architecture 和资源；默认不填 Machine/Node/provider。新接口区分 unsupported 与暂时容量不足。旧 0039 Docker 服务不接受新增 guestOs 字段，必须使用配对 SDK/contracts。

## 两类消费者的边界

**Vesta：** 使用 [VM CLI 配方](VM-CLI-TEST-RECIPE.md)，由 Vesta 固定自己的代码、选现有测试、组织矩阵和判断业务成功；Hitchlet 提供环境、访问、租约及回收。当前证据只覆盖同一旧 commit 的一个 CLI 用例，不等于 Vesta 最新代码、应用/浏览器、Windows 或完整 CI 已通过。下一次由 Vesta 给出一个明确测试和预算，复用保留模板即可；不要为保持 active 重跑旧单元格。CLI env / Hitchlet 专用封装未因这两次测试自动实现。

**新影音 Go：** 正常发布的固定 Linux ARM64 镜像、通用 SSH 和既有持久存储已通过唯一纯合成业务票，见 [Go 验收](DOCKER-GO-ACCEPTANCE-2026-11-04.md)。租客不需要 Node/Python；宿主 Controller/SDK 采用 Node 与 guest 工作负载语言无关。SDK 的参考 adapter 现在只探测 id/UID/GID，不执行媒体或 Vesta 业务。成熟 CLI、任务输入和结果质量留消费者。

旧成人影音线继续使用自己的业务流程和环境；本轮不切换、停止或改它。真实业务输入、NAS 与外部 API 不借合成 profile 获得访问。

## 已可直接推进与需要具体安排的事项

1. **源码与参考接入已收口：** 保持语言无关 SSH 入口、原 Ticket/command 恢复、最后 confirmed expiry 和真实清理；最新参考 adapter 有受控回归，未再次启动真实栈。旧 SDK 示例 nodeVersion 字段是示例摘要，已移除；需要工具版本的消费者自行在选定镜像内检查。
2. **Vesta 下一格：** 由 Vesta 指定新的固定代码/已有测试。若仅重复现有短 CLI 场景，可按既有授权范围准备；若要 GUI、浏览器、平台挂载或新系统镜像，应明确该项动作和预算。无需新平台业务 API。
3. **可重复部署：** 现有 Docker foreground 不是持久服务，Tart 两个模板也不是在线混合目录。下一批先确定是否需要同一安装的 Docker + 两个 Tart 节点/模板目录，以及具体启动方式和共享宿主预算。可先整理配置与可回退制品；安装/加载用户 LaunchAgent、新长期凭据或家庭网络监听必须有相应具体范围，不因“继续开发”自动执行。默认仍只 loopback，不要求改 DHCP/firewall 或启 Softnet。
4. **真实影音输入：** 现有播放器 Music 挂载对业务账户的 errno13 不能靠换路径、协议或身份绕过。由业务选择具体已授权只读输入与独立可写目标/state，先把挂载身份和实际 Engine 映射说清；平台沿现有 storage profile 交付即可。是否连接外部 API/服务凭据由实际任务决定，无需恢复旧编排链或先放开全网。尚未实施新挂载或读取真实输入。
5. **Windows x64 / Hyper-V：** 按既定优先级后续实现。先核准确 Windows 节点、Hyper-V 可用性和负载、可用 guest OS/架构/模板；再做一个现有 provider 契约的创建→初始化/SSH→恢复→销毁/absent 垂直实现。仍缺真实 provider、模板与 guest 初始化和资格，不是只差一个测试。管理员/服务权限、安装、Windows 镜像来源/许可、新持久身份或网络设置若实际必需，逐项给具体动作，不申请笼统一揽子提权。

## 持续边界

- Controller 离线严格到期强停仍不保证；消费者按最后 confirmed expiry 停止使用，pending 不延长期限。unknown 不假装回收或释放 Claim。
- Tart 默认 NAT 不承诺强网络隔离，Softnet 是显式可选能力；Docker 既有网络行为不变。
- 共用宿主容量、真实 Runtime 身份、资源归属与最终 absent 属于平台；媒体识别、质量判断、批处理和 Vesta 测试结果属于消费者。
- 未验证项按实际下一任务推进，不作为所有消费者的新增默认门槛。

## 2026-11-04 后续落地

已增加 [可重复启动与消费者接力入口](STUDIO-REPEATABLE-START.md)，实际在线check/reuse没有重启服务；原服务仍是明确标识的0039+d0128a8兼容包。Windows已完成准确节点与组件只读核对，见 [Hyper-V最小路线](HYPERV-PREPARATION-2026-11-04.md)：功能Disabled、vmms/Get-VM不可用；系统功能启用和可能重启未执行，不妨碍上述源码交付。
