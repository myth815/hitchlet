# 设计交付校验记录

日期：2026-10-19。对象为本目录v1.3设计、类型骨架和数据库草案。本轮对方案、接口、SQLite和开发依赖整体复核，直接修订一致性、遗漏及过度设计问题。下方保留此前修订的追溯记录。

## 已完成的检查

| 对象 | 方法 | 结果 |
| --- | --- | --- |
| contracts.ts及分模块接口 | TypeScript 6.0.3；strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、noEmit；仅ES2022标准库 | 完整语义检查通过，不依赖DOM或Node类型，无输出文件 |
| README申请与SDK范例 | JSON以AcquireRequest检查；usage.examples.ts编译检查正常接用、续租、保存准备请求及恢复调用 | 通过，示例未实际调用网络 |
| 编译期回归 | contracts/contracts.typecheck.ts | 47项类型断言、2项预期私有导出错误及使用示例通过；包括固定TTL、存储协议、预留空合同与create必备合同 |
| 注释与依赖边界 | AST检查JSDoc、模块导入及公开导出 | 201项类型声明及属性/方法具JSDoc；模块无环、全为type-only；公开DTO仅依赖common |
| schema.sql | 使用本机SQLite 3.51.0在临时目录创建新数据库 | 41张STRICT表成功创建 |
| 数据约束与示例事务 | 执行verify-schema.cjs | 86项通过；本轮新增保留量单扣、延迟绑定、受控历史删除、终态续租、固定请求与物理快照来源检查 |
| 文档结构 | 检查代码围栏、21个编号章节、JSON代码块及本目录文件引用 | 通过 |
| 设计一致性 | 正文、TypeScript、SQLite分别修订后交叉审阅，再复核新增修订 | 本轮审阅未发现剩余阻断开发级问题；Docker的M0–M2不依赖Hyper-V/Tart的D30+工作包 |
| 关键枚举 | 对比TypeScript联合与SQLite CHECK | Ticket、Lease、镜像、清理、Provider、资源种类、存储协议、电源阶段共8组一致 |
| 开发依赖 | 检查27个工作包依赖 | 无环；D25依赖闭包不包含VM工作包 |

## v1.3整体复核与直接修订

| 问题 | 影响 | 已完成修订 |
| --- | --- | --- |
| Allocation在预留时强制绑定已现场验证的合同 | 离线节点尚未唤醒，无法取得真实路径证据，闭环被卡住 | 先预留并唤醒，现场验证后从null绑定一次；create仍强制完整合同，绑定复核状态/控制版本 |
| 临时授权和解析合同永久禁止删除 | 与历史保留期冲突，终态数据无法回收 | 活跃Grant/被引用合同仍禁止删除；终态、无引用且过保留期后允许维护用例清理整个子图 |
| 容量示例混合总量与已扣保留量 | 实现可能再次扣减系统/人类预算 | 统一capacity为原始总量，reservedForPlatform合并保留，SQL与示例均只扣一次 |
| Consumer授权/配额及存储协议缺少明确类型 | 开发仍须猜测JSON结构和挂载实现 | 补ConsumerAuthorization/Quota、创建更新端口、StorageProtocol；受理固定节点授权交集 |
| 后续配额可能改变旧票最大TTL | 已接受租期可能随配置漂移 | AcceptedLeaseRequest固定maximumTtlSeconds，续租按旧合同和renewUntil裁决 |
| 续租终态记录仍可改写，取消缺少原因约束 | 与接口的判别联合、历史回执不可变要求不一致 | SQLite约束拒绝/取消原因，终态UPDATE禁止；请求身份和资源预算也禁止改写 |
| HTTP列表形状和事件ID说明不匹配 | GUI可能把摘要当详情，把自增序号当UUID | 列表/详情分别使用TicketSummary/TicketView；新增ResourceEvent/EventCursor，物理Snapshot只允许host Agent |
| 过多预先拆包，内部模型与管理响应边界含糊 | 增加维护成本，可能直接序列化内部对象 | 首发仅contracts/sdk两个共享包；管理响应由路由schema投影，纯模块不强制routes/repository |

补充明确了控制库与离线守卫之间不具备原子提交保证，以及访问材料的幂等重放不得把明文秘密写入safe_response_json。它们不引入新服务或分布式提交协议。未增加表，现有41张表保留；Docker生产闭环、逐机可选电源、VM后置的范围不变。

本轮抽查的外部依据与原设计一致：[SQLite WAL修复说明](https://www.sqlite.org/wal.html)、[Docker iptables处理顺序](https://docs.docker.com/engine/network/firewall-iptables/)、[Tart官方快速入门](https://tart.run/quick-start/)。这些资料校验不替代实际设备验证。

## v1.2接口审阅与处理

| 发现 | 修订 | 依据 |
| --- | --- | --- |
| 所有类型聚集在单个大文件，公开与内部边界不明显 | 按common/consumer/domain/services/provider/agent分层，public显式导出白名单 | 消费者无需导入执行端和持久模型；总索引保留便于浏览 |
| TicketView通过Omit内部实体构造 | Ticket、Lease、入口和镜像均采用明确公开视图 | 内部新增字段不会默认进入外部API |
| 申请重复填写request与limit，精确镜像重复填父ID | 资源数量只填一次；精确选择只填versionId；受理后生成完整合同 | 简化常见调用，同时保留受理后的不可变、完整预算 |
| SDK被迫处理Actor、版本和底层操作 | ComputeClient封装普通调用；服务端统一QueryContext/CommandContext | 认证、业务参数和执行上下文分别放在对应层次 |
| SDK隐藏版本后，同键重试可能重读出不同版本 | PreparedTicketCommand、onPrepared、resume保存和重放原请求 | 跨进程恢复不能只凭一个幂等键重新计算请求体 |
| 状态允许矛盾字段，执行命令可以接到无关结果 | 判别联合约束归属、续租、运行时与网络规则；Agent结果按动作关联 | 提前拒绝结构错误，运行时继续验证外部事实和权限 |
| getAccess混合技术就绪与消费者领取材料 | Provider改为checkReady；消费者getAccess保留 | 让方法名称与职责一致，避免调用方混用 |
| 版本字段映射不完整 | 镜像entityVersion区分字符串版本；发布/block要求CAS；Consumer补updated_at_ms | 接口字段有明确持久映射，不伪造更新时间或用字符串版本做CAS |

详细默认值、设计取舍与迁移说明见[接口说明](contracts/README.md)。本轮只修改设计包，没有实现或部署SDK/服务。

## 九项修订的闭环

| 原问题 / 缺口 | 最终设计与接口 | 模型 / 检查落点 |
| --- | --- | --- |
| 运行时身份未固定 | RuntimeIdentity、认证发现、不可变连接revision；所有资源操作核对原生身份；新Engine的404不是旧资源删除证据 | 身份唯一约束、连接与Allocation引用；改址/错误身份/CAS示例 |
| 草稿验证和发布依赖循环 | ImageValidationRun＋validation Allocation，无消费者Lease，独立deadline，测试与清理均通过才发布；D11a→D12→D11b | 验证归属、独占实例、终态清理约束及示例 |
| Operation缺少实体版本 | Operation.version用于worker领取、回执与重试CAS，与controlVersion分开 | operations.version及过期writer拒绝检查 |
| 消费者无法恢复未决续租结果 | LeaseRenewal、202＋Location、owner专属GET；同幂等键返回同一记录最新状态 | 单Lease唯一pending、owner查询、确认结果事务 |
| 首次接用未检查claimBy | 受理与最终确认都检查claimBy/原expiresAt/decisionDeadline；迟到ACK不追认 | 截止后申请和晚到ACK均拒绝；初次ready候选版本与期限一致 |
| 关机后无法证明off导致唤醒断链 | 自身已受理停机＋保护间隔得到off_expected；不伪造observed off；逐机验证安全WOL | PowerPhase、回执/周期/期限字段与预期关机唤醒示例 |
| 缺少主动撤销入口 | scoped operator/admin revoke，generation/version/reason，取消pending续租并统一回收 | 终止事务及迟到ACK失效检查 |
| 存储/网络授权没有冻结 | 受理固定FrozenProfileSelection，选Node后固定ResolvedProvisionContract；显式持久撤销覆盖旧修订 | 不可变revision/接受合同/解析合同、Node归属、撤销记录 |
| 网络隔离只有声明 | D10b受限网络组件，独立bridge、INPUT/FORWARD、IPv6验证或禁用，动态管理面拒绝基线 | 网络策略资源、基线版本、端口粒度拒绝规则；实际执行和连通性留给硬件验收 |

第二轮额外修正了首次连接登记前尚无runtime ID的发现流程、NAS同IP管理口与数据口的区分、验证实例阻止空闲关机、LocalLeaseGuard完整候选/期限字段，以及初次ready使用expected/proposed Lease版本。续租明细另设有限保留期，并计入SQLite容量估算。

## 重复运行

在本目录执行，依赖Node.js和PATH中的sqlite3：

```sh
node verify-schema.cjs
```

脚本仅在系统临时目录创建数据库和文本报告，不连接真实Portainer、Windows或Mac。临时目录路径在输出中显示。它验证局部约束和示例串行事务；不会将示例事务误称为完整调度器。

项目安装TypeScript后，可用标准命令检查接口骨架：

```sh
tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target ES2022 --module ESNext --lib ES2022 contracts.ts contracts/contracts.typecheck.ts contracts/usage.examples.ts
```

本次语义检查使用本机已有的TypeScript编译器API完成，没有为设计文档安装新依赖。

## 验证边界

本次没有实现或运行控制服务、HTTP API、GUI、Provider或Agent。尚未完成并发worker、完整状态机、真实资源限制、网络可达、离线租约、人的会话和电源动作验收；这些属于README中的开发任务与实机门槛。

本机SQLite 3.51.0用于DDL与约束检查，不作为生产依赖选择。生产要求实际驱动内嵌SQLite使用3.51.3或更新修复版本，或明确验证的修复回移版本；同时验证本地文件系统、WAL、备份恢复和单控制端约束。

当前开发终点为Docker正式可用，Hyper-V/Tart仅完成设计与类型扩展点，按需后置。
