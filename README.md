# Hitchlet

**搭个便车：凭票上车，用完下车。**

*Hop on spare compute. Leave it ready for the next rider.*

Hitchlet 将闲置计算资源变成可申请、可归还的临时环境。Agent、开发工具或人工使用者申请一张 Ticket；系统分配隔离环境、维护租约，并在归还或到期后回收资源。

它是业务无关的资源管理系统，不负责执行或理解租客的具体任务。持久数据保存在授权 NAS 或外部存储，临时环境用完即回收。

## 当前状态

**M2 Docker 正式交付已通过独立验收，承诺限于已验证的部署组合。** 已实现 Portainer 接入、镜像验证后发布、独立容器与 SSH 凭据、Ticket 全生命周期、恢复回收、授权持久存储、备份恢复、完整管理 API、TypeScript SDK 与中文 GUI。418项实现测试通过；干净安装、正式 Dockerfile、实际浏览器及真实 Docker/NFS 闭环均已验证。实际 Mac Host 已通过可信观测进入正式准入，部分观测仅在显式批准的有人预算内接单，未知、压力和过期证据会阻止新增。逐节点证据与限制见[交付验收](docs/DOCKER-ACCEPTANCE.md)和[实施记录](docs/IMPLEMENTATION.md)。

首个交付目标是 **Docker，通过 Portainer 接入**。Hyper-V 与 Tart 只保留扩展设计，按实际需求后置，不作为 Docker 版本发布的前提。

## 能力

- **凭票使用**：申请、排队、资源预留、准备、接用、续租和归还，异常状态可恢复。
- **独立环境**：每次申请隔离的容器，未来扩展到虚拟机；回收完成才释放资源额度。
- **镜像目录**：管理不可变镜像版本、兼容能力、验证与发布状态。
- **人机共用**：尊重人的登录状态、保留资源和维护策略；只有经过验证的机器才启用自动节能与网络唤醒。
- **看得见的调度**：GUI 展示机器、节点、Ticket、操作进度与等待原因。

## 技术方向

| 部分 | 选择 |
| --- | --- |
| 自研服务、代理与 SDK | TypeScript / Node.js |
| 控制数据库 | 本地 SQLite，单控制实例 |
| GUI | React / Vite，与 API 同源发布 |
| 首个后端 | Portainer → Docker Engine |
| 后续按需接入 | Windows Hyper-V、Apple Silicon 上的 Tart |

## 从这里开始

- [完整设计与分阶段开发计划](docs/design/README.md)
- [从空目录安装、Docker 接入与运维手册](docs/runbook.md)
- [实际管理 API、SDK 与错误恢复](docs/api-sdk.md)
- [TypeScript 接口说明](docs/design/contracts/README.md)
- [消费者公开接口](docs/design/contracts/public.ts)
- [SDK 调用示例](docs/design/contracts/usage.examples.ts)
- [SQLite 数据模型](docs/design/schema.sql)
- [设计验证记录与验证边界](docs/design/VERIFICATION.md)

运行模型约束检查需要 Node.js 和 `sqlite3` 命令：

```sh
node docs/design/verify-schema.cjs
```

脚本只在系统临时目录中创建测试数据库，不连接真实计算节点。当前 86 项检查验证数据库约束与示例事务，不代表实际后端、并发调度或电源控制已通过验收。

## 本地运行

需要 Node.js 24 LTS 与 pnpm 10；不依赖 OpenClaw 或其他宿主项目。按 [运行手册](docs/runbook.md)从空目录安装依赖、显式初始化 Simulator 并领取测试凭据，再启动 API 与 GUI。开发 GUI 使用 `http://localhost:5173`；构建后可由控制器同源发布。Compose 默认禁用执行器并要求 HTTPS 代理以使用安全会话；真实 Docker 使用已配置密钥的 `compose.portainer.yaml` 覆盖，详细顺序见手册。管理工作台提供总览、授权 Ticket/操作、后端/Node、profiles、消费者/配额、镜像登记/缓存和既有维护入口。每台新机器仍需按 D25 逐节点取证；本轮未给人的电脑安装开机服务或开启实际电源自动化。

## 参与开发

先阅读设计中的模块边界、开发任务及验收条件。优先推进 Docker 最小闭环，避免提前引入 VM、云计费、多控制端高可用等尚无实际需求的实现。

欢迎通过 Issues 讨论问题和改进，通过 Pull Requests 提交变更。

## License

[MIT](LICENSE)
