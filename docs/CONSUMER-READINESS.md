# 消费者接入现状

2026-11-05（Asia/Shanghai）。以下按实际固定版本和环境区分；临时测试入口已关闭，历史 Ticket、token 和镜像 ID 不是在线服务承诺。

| 环境                  | 已有证据                                                                                       | 当前界限                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Docker / Linux ARM    | 既有 Portainer、SSH、持久存储、续租和回收；影音/Go 合成任务                                    | 不扩展为任意宿主或任意 Docker 版本                                  |
| Tart / macOS ARM      | 正常资格、镜像验证发布和固定 Vesta CLI 单元格                                                  | 未声明完整应用矩阵                                                  |
| Tart / Ubuntu ARM     | Vesta、Prism 既定 CLI 流程；Docker 29.9.3 / Compose 5.7.0 下两工程真实启停、就绪、重启数据保留 | 未扩展为 Linux x64 或模型调用通过                                   |
| Hyper-V / Windows x64 | Vesta 选定构建/CLI 检查，Prism 7 构建目标、5 检查场景及任务记录；平台租用/回收                 | 两个 Vesta 取消用例的旧失败保留；不要求原生 Windows 全套 Vesta 应用 |
| Windows 默认开发模板  | guest 管理员真实 SSH、受保护路径写入/删除、正常资格/验证发布                                   | 新模板已关机保留，旧普通用户导出已删除；不是常驻服务                |

[Docker 服务验收](TART-DOCKER-SERVICES-ACCEPTANCE-2026-11-05.md)、[Windows 历史验收及管理员更新](HYPERV-WINDOWS-ACCEPTANCE-2026-11-05.md)保留具体版本和限制。

## 消费者约定

消费者按 catalog 选择镜像版本，声明 kind、guest OS、架构、资源及授权网络；默认由平台选择 Node / Machine / provider。公开回执里的 placement 才是实际放置。普通用户与管理员不是当前独立的申请字段，账号权限由模板提供；默认 VM 开发环境按用户要求提供 guest 管理员能力。直接 Docker 容器仍保持现有非 privileged 合同。

业务源码、测试选择、结果判定和模型访问留在消费者。平台负责独立环境、SSH、confirmed 租约和查实回收；不把构建通过、端口打开或计划生成等同于业务通过。接用方式见 [VM CLI 配方](VM-CLI-TEST-RECIPE.md)。

## Temporal 与 Windows 的正确解释

原 Windows 安装日志只有 `PNPM_NOT_READY` 的通用预编译产物文案，底层 native load 错误未保留。Temporal 1.17.1 的源码包含 Windows x64 目标，不能据该日志判断上游不支持，也不能判定缺管理员权限。此次用户明确的范围是 Windows CLI；Vesta 原生 Windows 全应用和 Temporal worker 不作为 CLI 放行条件。两个取消失败仍独立保留，管理员模板不能替代 Windows 信号语义验证。

## 下一条平台主线

新设备通过前端生成的一次命令完成 Host / Runtime、后端、默认模板、必要重启续接、真实试租和回收，最终进入同一安装的可分配目录。现有底层和局部实机证据可复用，但这个全自动流程尚未实现；不能用人工 API / 脚本执行经历宣称已完成。

具体连接缺口、正式上线顺序和最小新增实测见 [正式交付核查](RELEASE-READINESS-2026-11-05.md)。不重跑已经通过且输入未变的 Vesta / Prism 用例，不新增互联网穿透、云计费或快照池作为门槛。
