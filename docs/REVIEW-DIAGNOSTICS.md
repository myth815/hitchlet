# fdf6ba2 独审退修：原流程的诊断与可选预检

本轮在 fdf6ba2 上逐项归位6206086的已知诊断源码，没有合其旧分支/父历史，没有改准备期限、重试次数、TTL或资格策略。测试限本地假Engine、临时SQLite、合成mTLS与浏览器DOM；不接现场，不推送。不是全仓独审结论。

## 原因、读取与行动

- `PortainerExecutionProvider.request`：固定 manifest / image_inspect / container_create / container_start / docker_request 阶段、有限短类、实际HTTP状态。Worker在原CAS内留首错，带当前operationId；既有 validation GET 的 checks.firstExecutionFailure 可读。原Ticket仍留原operation.result_json。后续重试、deadline或cleanup不能覆盖首错。不是把HTTP500当没执行；创建journal仍是副作用裁决来源。不明异常只记已知provision/cleanup阶段、unclassified_error和当前operationId，不存异常正文，也不编造HTTP状态。专用流式transport和未知业务断言未冒称都有细分根因。
- Runtime `/v1/{network-actions,storage-facts,workload-facts}`：原409状态不改，增加固定JSON error：provider/runtime、stage、category、原requestId（network用commandId）、原operationId（仅network）与固定行动文本。身份不符→核原绑定；mount改变/权限失败→核已授权facts与窄映射；命令/未知结果→对账原journal。没有复制message/cause/stack、host路径、Engine输出或payload。Controller保留status和诊断；进operation时区分当前operationId与原runtimeOperationId。未知类仍operation_failed，不猜“权限不足”。认证/无效schema仍原401/400，不反射诊断。
- Node自动观察：fdf6ba2已删除“报告过期先unknown再跳过probe”的旁路。本轮从expired+unknown+stale合成状态走真实Admin探测调用恢复healthy；连接拒绝仍degraded且成功观察时间不前移；服务恢复后自动healthy，不手填healthy或延长TTL。失败短类用原audit表记录状态转换，NodeView新增可选observationFailure投影；恢复后为null。同一原因持续失败不每轮追加审计，observedAtMs是该诊断类别上次写入审计的时间，不是最后一次成功观察时间。诊断写入不回滚真实健康观察；审计写失败仍走现有后台错误报告。旧报告、身份/版本/容量匹配与原CAS不被诊断改写。GUI显示类别、HTTP状态和对应核对方向。
- GUI预检：显示SDK实际code/message、请求编号与对应恢复建议；只读网络失败不再当“未知写命令”提示。预检本来不预留，server acquire还会执行相同权威校验，故成功预检、旧unsupported结果都不再作为提交必经门。权限、忙碌、断线/恢复写禁用、schema和服务端必要拒绝保留。提交不代表成功受理；仍由原响应/票据显示结果。

## 门账对照

| 位置/触发                                | 上游事实与可观察差异                                                                                | 处理与证据                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| AuthorizedAcquire form；提交前           | 上游catalog提供授权选择，服务端acquire重新校验并原子预留；成功preview不增加独立保护，失败却阻断提交 | 删除重复前置；真实GUI事件无preview/preview失败/unsupported对照，权限缺失仍不提交；Controller拒绝/容量测试保留      |
| Admin观察；报告日期越界                  | 持久资格不是在线事实，Node未知应继续实际probe；旧旁路会自锁                                         | 原修复保留；本轮expired+unknown+stale→probe恢复、实际拒连→degraded→probe恢复，故障类别可经Node DTO读               |
| Runtime身份/源/网络断言；原409分支       | Controller授权不证明Runtime宿主事实相同，删除会把错误Engine/源或旧命令当成功                        | 保留全部断言，只修空响应；实际localhost mTLS三接口与原401、未知异常脱敏回归                                        |
| operation CAS/journal；失败重入与cleanup | HTTP失败不证明没创建；原owner/control版本、unknown effects及实物回执不可由错误短类替代              | 保留原状态与核销规则；Provider→持久化→正式SDK查询、first-error保持、unknown create保留容量、start失败可取1.1 proof |

没有新检查、role/scope、审批、验收前置或诊断服务。Acquire/ready/claim/proof合同无字段变化，TC不需改请求；管理Node DTO与内部Runtime错误体有上述可选诊断增量，按同一contracts/SDK/Controller/Runtime源码构建。无需数据库迁移。

## 完整离线交接边界

交接包包含base464d3f5、pre-review fdf6ba2与修后提交的精确commit对象及每棵完整tree/blob；base标记shallow，不包含更早历史。可独立fsck、archive和比对所有文件摘要；不是原仓.git目录备份，没有原remotes、hooks、reflogs、凭据、配置、node_modules、数据库或现场回执。更早ancestry由本轮原仓的只读remote核对记录说明，不从浅包冒推全史。
