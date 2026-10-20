# Hitchlet

**搭个便车：凭票上车，用完下车。**

*Hop on spare compute. Leave it ready for the next rider.*

Hitchlet 将闲置计算资源变成可申请、可归还的临时环境。Agent、开发工具或人工使用者申请一张 Ticket；系统分配隔离环境、维护租约，并在归还或到期后回收资源。

它是业务无关的资源管理系统，不负责执行或理解租客的具体任务。持久数据保存在授权 NAS 或外部存储，临时环境用完即回收。

## 当前状态

**M2 Docker 正式交付已通过独立验收，承诺限于已验证的部署组合。** 已实现 Portainer 接入、镜像验证后发布、独立容器与 SSH 凭据、Ticket 全生命周期、恢复回收、授权持久存储、备份恢复、完整管理 API、TypeScript SDK 与中文 GUI。实现测试已通过；干净安装、正式 Dockerfile、实际浏览器及真实 Docker/NFS 闭环均已验证。实际 Mac Host 已通过可信观测进入正式准入，部分观测仅在显式批准的有人预算内接单，未知、压力和过期证据会阻止新增。逐节点证据与限制见[交付验收](docs/DOCKER-ACCEPTANCE.md)和[实施记录](docs/IMPLEMENTATION.md)。

首个交付目标是 **Docker，通过 Portainer 接入**。Hyper-V 与 Tart 只保留扩展设计，按实际需求后置，不作为 Docker 版本发布的前提。

D22b Windows 原生正常关机与 WOL 已通过软件主审，失联、执行者崩溃及登录撤销已实测；完整逐机关机/唤醒资格尚未通过。默认关闭自动电源；安装、守卫与启用条件见[原生电源说明](docs/POWER-NATIVE.md)。

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

## 当前架构与权威索引

控制器保持模块化单体：一个常驻进程、一个本地 SQLite 账本；容量和所有权由账本裁决，Provider回执或GUI观测不能替代删除查实。依赖方向为 `gui → sdk → contracts`、`controller → contracts`。

| 责任 | 当前权威 |
| --- | --- |
| DTO、运行时校验、可恢复管理命令白名单 | `packages/contracts/src`；管理协议在 `admin.ts` / `management.ts`，OpenAPI复用这些schema |
| 浏览器/Node传输、认证与原命令恢复 | `packages/sdk/src`；GUI只通过SDK访问控制器 |
| HTTP认证、CSRF、角色投影与响应 | `apps/controller/src/app.ts`、`http/`；不直接编排SQL或Provider副作用 |
| 用例与恢复编排 | `apps/controller/src/application`；纯规则位于无HTTP/SQLite依赖的 `domain/` |
| 持久事务与版本fence | `apps/controller/src/storage`；实际DDL以 `migrations/001–007` 为准 |
| 原生执行、Runtime/Host协议 | `apps/controller/src/providers`、`apps/runtime-agent`；Docker经Portainer管理，代理只执行批准的动作 |
| 当前部署证据与限制 | [Docker验收](docs/DOCKER-ACCEPTANCE.md)、[运行手册](docs/runbook.md)；[实施记录](docs/IMPLEMENTATION.md)与设计VERIFICATION保留历史批次事实 |

设计目录描述行为和后置扩展；设计内部类型不是SQLite行对象的一对一映射。JSON合同、manifest、证据和结果保存在既有JSON列，关联与关键不变量由SQL列、约束和短事务共同维护。`GET /healthz` 的 `stage: "D05"` 是兼容既有客户端的协议标记，不是当前M2验收状态。

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
