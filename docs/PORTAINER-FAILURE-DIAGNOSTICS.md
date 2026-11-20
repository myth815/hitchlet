# Portainer 执行失败的最小诊断

本候选只增加脱敏取证，不改变镜像验证、调度、重入或清理裁决。没有操作现场、请求真实租约或更改网络/安全配置。以下验证使用假 Engine、真实临时 SQLite 和正常应用/SDK 路径。

## 原丢失点与既有取证

`PortainerExecutionProvider.request` 原先对失败 HTTP 仅抛 `Portainer Docker request failed (status)`，没有动作阶段；`OperationWorker.run` 捕获所有错误后只 `defer(...,"execution_error")`。`deferOperation` 保存 operation_pending 和这个通用诊断，原异常不再进入持久记录。旧记录不能在事后恢复已经丢弃的响应正文或原因。

已有创建 journal 可先区分“尚未发出 container 创建意图”和“创建结果 unknown”：按 validation 关联 allocation/provision operation，只取 createEffects 的 key、kind、state、requestedAtMs、observedAtMs。没有 container 意图时不能断言镜像、权限或某地址出错；它只说明流程尚未进入该 journal。若已有受权的 Engine/Portainer 历史请求日志，可按同一时间核对 distribution、image inspect/pull、container create/start 的方法和状态。不要为取证重发创建、清除 unknown、输出原请求/凭据或临时扩大数据库权限。

## 现有读取接口

新增的固定词表错误仅由 Provider JSON 请求边界构造。Worker 在原操作的 CAS 记账内保存**首个**受支持错误，并在同一事务投影到镜像验证的 checks；后续 pending、重试错误、deadline 或回收不覆盖首因。

继续使用 `GET /v1/image-validations/{id}` 或 `client.admin.validation(id)`，原管理员权限与已有 checks 字典不变：

```ts
checks: {
  firstExecutionFailure: {
    provider: "portainer",
    stage: "manifest", // 或 image_inspect/container_create/container_start/docker_request
    category: "connection_refused", // 或 name_resolution_failed/timeout/http_error/transport_error/invalid_response
    statusCode: 500, // 仅实际收到 HTTP 响应时
    operationId, // 当前持久 operation 的现有 ID
    observedAtMs, attempt,
    operation: "provision", // 或 cleanup
  },
}
```

它是历史首错，不替代当前 state/testOutcome/cleanupStatus。临时失败随后恢复、清理并发布成功时，这条历史仍可读。普通 Ticket 的记录保留在原 operation.result_json，本轮不增加 Ticket DTO 或新查询接口。TC 的 acquire、ready inventory、proof、归还协议均无需变化。

只返回固定阶段、短类、实际状态码、时间/次数；不保存 URL、端口、镜像/Registry 引用、响应正文、header、Env、argv、凭据、Error.message/cause 或 stack。上游正文仅在请求失败时用于选择有限短类，随即丢弃；未知内容只标 http_error。fetch 网络错误同样只取固定类，不把实际原因字符串转存。不明异常仅补已知provision/cleanup阶段、unclassified_error和operation引用，不存原异常或编造HTTP状态；专用流式transport仍不冒称有精确内部阶段。

## 重入与清理不变

仍是原 operation_pending / execution_error 状态机及退避、attempt 和 deadline。诊断不是终止或免检信号。HTTP 500 不能证明创建没有发生，beforeCreate journal 的 unknown 不因短类而变为不存在；未闭合副作用仍保留容量。已观察的对象沿原归还流程删除、读回 absent 后核销。没有新的通过门槛，也不把诊断字段作为现场继续验证的前置。

本地回归覆盖 manifest 500/connection refused 后在原验证 ID 重入，成功清理并发布；第二次 503 与 deadline 后保留首错并查实回收；create 请求结果 unknown 不释放 Claims；start 失败实际对象可清理并读取 1.1 proof。正常 SSH、单/双成员、A/B、原过滤路径与原清理用例复用。本轮在 fdf6ba2 上归位这部分诊断；Runtime、节点观察和 GUI 的增量另见 [退修说明](REVIEW-DIAGNOSTICS.md)。无数据库迁移；不改变原状态机。
