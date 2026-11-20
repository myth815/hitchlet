# 恢复合同退修

本轮仅以 909b200 为底修复已指出的拒绝裁决、管理端无关阻断、首错投影、可选预检与两项 SDK 构建/准备预算。没有新审批、迁移、角色或服务。所有验证均为本地合成 HTTP/Engine、临时 SQLite 与浏览器 DOM，不是实机或全仓验收。

| 触发/位置                                                       | 权威事实与具体差异                                                                                                     | 处理及回归                                                                                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| acquire 逻辑拒绝；TicketService / SQLiteTicketStore             | 仅未看到 Ticket 不能否定同键在途创建。拒绝记录和 Ticket 创建事务争用同一主键，获胜的一方决定原键结果；创建输了完整回滚 | 新增可选 error.operationOutcome=rejected，真实 SDK 只识别 acquire POST 的正式标记；拒绝/创建先赢、已创建、改正文、丢失回包和读回失败、拒绝记录写失败均覆盖                                          |
| 管理总览失败、8 项未知；ManagementConsole / management-prepared | 授权、对象 CAS 和原键恢复已由服务端负责。总览不是撤销其它 Ticket 或重试其它 operation 的权威事实；数量也不证明冲突     | 删除全局总览/数量禁写。未决准备请求只拦同 method/path/version/body 的新键，保留原键恢复；一次性不可重放命令保留原对象意图，不清理他项记录；8 项未知与总览失败下另一原操作重试、不同 Ticket 撤销回归 |
| 普通票 operation 历史首错；management DTO / GUI                 | 原 journal 保存首错，当前 succeeded/unknown 等状态不能替代它                                                           | 既有授权 operations/timeline 增加可选固定阶段/类别/HTTP/原 operation 引用与时间/尝试数；失败、随后成功及实际 Provider→SQLite→正式 SDK 回归。不投影 URL、正文、凭据、Runtime 原始异常                |
| 可选 preview 进行中；AuthorizedAcquire                          | 提交仍经过同一服务端权威裁决。慢 preview 不提供额外授权事实，却把表单锁死                                              | 仅预检按钮防重；编辑和提交可用，过时响应不覆盖新输入。权限、目录选择、断线/恢复、正在实际写入的限制保留                                                                                             |
| claim/renew 发送前固定 15 秒；tickets SDK                       | 读票/保存原命令花时不证明服务端期限已过；服务端用实际租约版本与期限裁决                                                | 移除发送前整体倒计时和持久化竞速。14/16 秒读票及额外 16 秒保存仍以原键/版本发送。发送后的 HTTP/原 renewal 轮询等待仍有界，服务端 decisionDeadline、版本冲突、取消等待和未知原键恢复回归保留         |
| SDK/contracts revision 标签；provenance / prepare-sdk-pair      | 调用方标签不验证 Git 内容；实际输入、输出哈希、版本和 contracts 内容依赖才证明配对                                     | 指纹排除标签，取消标签相等阻断，分别记录标签；不同标签且相同内容通过，源/产物/依赖/版本改变仍拒绝                                                                                                   |

消费者请求、proof 1.0/1.1、冻结 profile 与真实清理规则不变。TurboCli 可从此次正式 SDK 的 ComputeClientError.operationOutcome 判定 Controller 已经持久拒绝原 acquire key；null 不代表拒绝。普通 HTTP 422、查无列表和网络错误不能据此换键重发。无数据库迁移。

本轮覆盖 contracts/errors、SDK transport/tickets、Controller acquire/原 operation 管理投影、GUI 管理恢复/预检以及本地 SDK 配对脚本。未重审其他 Provider、Hyper-V/Tart、Host Agent、电源/恢复、系统维护、安装部署、真实网络/存储/镜像执行和消费者业务；完整源树供后续独审使用。
