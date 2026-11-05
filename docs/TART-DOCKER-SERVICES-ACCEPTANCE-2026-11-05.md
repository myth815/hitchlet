# Ubuntu ARM Docker 服务实机回归

2026-11-05，在 Studio 的独立 Tart 临时栈内完成 Docker Linux 镜像准备，以及 Vesta、Prism 的真实服务启动、就绪、停止、重启和数据保留。平台执行版本为 `b7cf6523e498a6eb39be257c949b2d05717ed875`；本次没有修改产品源码或重跑全仓测试。

## 镜像和平台链路

从已保留的 `ubuntu-cli-base` 克隆新模板 `ubuntu-docker29-services-base`，配置 8 vCPU、16 GiB 内存、100 GB 逻辑磁盘。原模板的磁盘、配置和 NVRAM 的大小、mtime、inode 在结束时保持不变。

新 guest 为 Ubuntu 24.04.5 / arm64、Node 24.21.0。通过 Docker 官方 Ubuntu apt 源安装并固定以下实际版本：

| 组件                | 版本   |
| ------------------- | ------ |
| Docker Engine / CLI | 29.9.3 |
| containerd.io       | 2.4.2  |
| Compose plugin      | 5.7.0  |
| Buildx plugin       | 0.38.1 |

普通 `admin` 用户可直接使用 Docker。仅在新 guest 启用 Docker/containerd；封存前正常停止服务、清除 Docker engine ID 和 machine ID，再正常关机。独立资格 clone 生成了不同的 engine ID，并实际完成镜像 build、Compose HTTP 服务、命名卷 stop/start 保留、容器/网络/卷回收及 Runtime 重启后的原生读回。

- 封存 digest：`sha256:e315ca0a09fa02cd4a30021c56c8187751965be22696eca1d7512a70e9ba330b`。
- 正常验证成功并发布的 image version：`f3da0224-dab0-4f17-9999-221bdc3bc9a0`。
- 单张业务 Ticket：`b58bdb59-e708-460c-8fe2-5a4f09385141`。

业务使用同一 Ticket，按顺序运行 Vesta 和 Prism。每次 SSH 均取得短期材料并验证 API 返回的主机指纹；后台租约监督只使用 confirmed expiry，未通过增加 SSH timeout 或另开 Ticket 延长任务。Vesta 完成后，查实 runner 已退出且没有运行中的容器，才启动 Prism。

这证明的是 **Tart VM 内的消费者 Docker 能力**。网络使用已授权的默认 NAT；不代表 Hitchlet 的 Docker backend 隔离资格、Softnet 或强网络隔离。宿主权限、网络、既有服务和原消费者工作树未修改。

## 两个消费者的实际结果

| 消费者 | 固定源码                                                       | 实际结果                                     |
| ------ | -------------------------------------------------------------- | -------------------------------------------- |
| Vesta  | `d43c63f0cf013ae835d3b898bc0a57f875b7d77e`                     | 11 个步骤通过，23 条记录命令 exit 0          |
| Prism  | `5af7f6092aa079c593e0660e69ff76af7346026a`，使用上述 Vesta CLI | 18 条记录命令 exit 0，设置写入与重启读回通过 |

Vesta 通过公共 `launch dev start --yes` 和 `launch dev stop --json` 完成两次启停。两次启动后，五个服务的 JSON readyz 检查以及 Web、Logto、MinIO、Temporal UI 的 HTTP 检查通过，SyncBus TCP 可达；Postgres、Redis、MinIO、Logto、Temporal、Temporal UI 六个容器健康。重启后容器 ID、卷、环境及服务配置身份保持一致，Postgres 测试表中的随机标识可读回。此数据检查针对测试数据库记录，没有声称覆盖完整业务 schema。

Vesta 最终公共 stop 成功、服务端口关闭、容器全部退出。原始状态中 Logto exit 1、Temporal UI exit 2；没有把“已停止”扩写为“所有容器 exit 0”。Agent Flow bootstrap 报告 `environment-blocked`，本次没有模型调用或模型任务执行结论。

Prism 通过公共 `launch local prepare/start/stop` 完成两次启停；两次启动均通过 `/health/ready` 和 `/health/live`，app/db 健康。测试使用 mock 身份写入个人设置，version 从 0 增至 1、`preferences.responseFormat=list`；重启后读回对象与写入结果完全相等。两次停止均确认 app/db exited、exit 0；三个命名卷在服务停止后保留。没有模型请求。

这里的数据保留指同一租客 VM 内的服务 stop/start。随后整张 Ticket 正常归还、VM 删除；没有宣称这些临时 Docker 卷跨 Ticket 永久保存。

## 结果归档和回收

103 份原始消费者结果在归还前保存，逐份核对 guest 字节数和 SHA-256 一致；Vesta 报告内的 stdout/stderr 摘要亦匹配。共享 ZIP 再次解包核对，原始结果未改写。

| 结果                                                        | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Vesta `report.json`                                         | `de86f6f4c70c5c3c30347c6505f7f2e34842b1dc063500dd630a8d927b9d9d0b` |
| Prism `RESULT.json`                                         | `79570d647165dbf31cef67663169a827b904f024307574a21658e41e7f2be824` |
| `Hitchlet-Docker-Linux-service-logs.zip`（2,353,520 bytes） | `5ecad97ce07423e853d8c97d37b96c8ba64beb16e41c30630dc800818be733e3` |

共享交付另含 `Hitchlet-Docker-Linux-service-evidence.json` 和 `Hitchlet-Docker-Linux-service-SHA256SUMS.txt`。原始工作数据、凭据和数据库不进入仓库。

最终 Ticket 为 `released / cleanup complete`；租客、资格检查和正式镜像验证三个 Allocation 均原生查实 absent。活动容量 claim、unknown operation、cleanup blocked 均为 0。临时节点 disabled，专属 Controller/Runtime 和租约监督已停止，端口 33112/33446 已关闭，14 份新建临时认证文件或加密 secret 已删除。

新 Docker 模板、旧 Ubuntu 模板和既有缓存均关机保留。历史 version/Ticket 不是在线服务入口；再次使用需在已授权范围内恢复独立服务与认证，按当前 catalog 和资格有效性选择环境。此轮只覆盖 Linux arm64 服务链路，不扩展为完整跨平台矩阵。

消费者与平台的日常接用方式见 [VM CLI 配方](VM-CLI-TEST-RECIPE.md)，网络边界见 [Tart 网络说明](TART-NETWORK.md)。
