# TypeScript 接口使用与设计审阅

版本：1.3。这里是可供实现的合同与编译期示例，尚未包含HTTP客户端、控制服务或Provider实现。

## 从哪个入口开始

| 使用者 | 入口 | 职责 |
| --- | --- | --- |
| 消费者、SDK、租客 GUI | [public.ts](public.ts) | 公开输入、响应、`ComputeClient`；不导出内部实体和执行命令 |
| 查看请求与响应定义 | [consumer.ts](consumer.ts) | 精简申请、完整接受合同、显式响应白名单、管理员请求、SDK 方法 |
| 控制端应用用例 | [services.ts](services.ts) | 认证、幂等、版本前提和事务编排 |
| 控制端持久模型 | [domain.ts](domain.ts) | Machine、Node、Ticket、Allocation、Lease、镜像与授权记录 |
| 后端适配器 | [provider.ts](provider.ts) | 精确创建、技术就绪、观测、撤权、停止与清理 |
| 执行端代理 | [agent.ts](agent.ts) | 命令与结果映射、截止守卫、网络规则、电源协议 |
| 共享值和单位 | [common.ts](common.ts) | 时间、资源数量、状态、分页和错误信封 |

[../contracts.ts](../contracts.ts) 保留为内部总索引。新消费者只从 `public.ts` 导入，避免误用包含管理地址、真实路径和秘密定位符的类型。所有模块依赖均为 `import type`；公开模块只依赖共享值类型，不反向依赖持久模型。

运行时公开 DTO 的权威定义位于 `@hitchlet/contracts`：其 `public.ts` 维护包导出白名单，`schemas.ts` 提供 Zod 校验和 Draft 2020-12 JSON Schema 生成。本文的 `common.ts`、`consumer.ts` 与 `public.ts` 是指向该包源码的 type-only re-export；领域、Provider 和 Agent 设计仍留在本文档，且不进入运行包导出。

管理GUI的Machine/Node/Consumer等视图由对应管理路由的response schema生成，按角色投影；不能直接把services返回的内部对象当HTTP响应。这里列核心用例端口，不为每个管理列表手工维护第二套字段定义。

## 一次申请只填写一次资源

```ts
import type { AcquireRequest } from './public';

const request: AcquireRequest = {
  image: { versionId: '00000000-0000-4000-8000-000000000101' },
  resources: { cpuMillis: 2000, memoryMiB: 4096, scratchMiB: 20480 },
  networkProfileId: '00000000-0000-4000-8000-000000000201',
};
```

精确版本 ID 全局唯一，无须再填 imageId。按别名选择时使用 `{ imageId, alias }`。两种形式不能混填。网络配置仍必填，因为它承载授权边界，不能由服务端猜测。

| 省略字段 | 接受时的行为 |
| --- | --- |
| kind | container；请求 VM 必须显式填写 vm |
| allowedArchitectures / allowedProviders | 固定本次授权目录中全部兼容取值；没有取值则拒绝 |
| allowedMachineIds / allowedNodeIds | 不附加该项限制；显式填写必须非空，空数组报错 |
| locality / siteIds | local_only；省略或空站点数组代表所有获准本地站点 |
| resources.scratchEnforcement | best_effort；required 需要实测硬配额 |
| resources.isolation | container 为 shared_kernel；vm 为 virtual_machine；冲突组合拒绝 |
| resources.accelerators | 空数组 |
| storage / labels / requiredLabels / requiredCapabilities | 分别为空数组或空对象 |
| access | ssh；若镜像不支持则拒绝，不自动切到其他协议 |
| lease | TTL 900 秒、最大寿命 86400 秒、排队 1800 秒、准备 1200 秒；策略可收紧，不能超过授权上限 |

`AcquireRequest` 是输入；`AcceptedAcquireRequest` 是受理时固定的结果。后者包含完整默认值、精确版本和等额的内部 `request/limit`，用于审计、恢复和展示。消费者无需填写重复预算，Provider 也不自行推断默认值。

AcceptedLeaseRequest额外固定maximumTtlSeconds。后续调整消费者配额不能让旧票的续租上限漂移；新请求超限返回422，省略的默认值可以按受理时授权收紧。ConsumerAuthorization和ConsumerQuota由管理员显式设置，创建时不存在隐式全权限。目录权限、节点已验证能力和票据固定授权各有一份来源，不在Profile中再复制一套ACL。

AcceptedAcquireRequest.allowedNodeIds保存原请求与消费者节点范围的交集；省略只对应受理时的all授权。空交集直接拒绝，后续不通过读取已放宽的Consumer配置扩大旧票的放置范围。

幂等查找先于别名解析和默认值计算。`request_hash` 对规范化的原始输入做摘要；同键重试不因目录或默认策略变化而生成新合同。`tickets.request_json` 保存已接受的完整安全请求，`accepted_contract_json` 保存内部 `FrozenProfileSelection`。这两份快照职责不同，均不能在重启后重新按 latest 计算。

## 客户端与服务端分别封装

消费者使用 `ComputeClient.tickets` 和 `ComputeClient.images`，认证在创建客户端时注入。接口中不出现 Actor、controllerEpoch、Provider 或数据库对象。完整使用顺序见 [usage.examples.ts](usage.examples.ts)。

`acquire` 返回 Ticket 与实际使用的幂等键，便于保存后恢复。`waitUntilReady` 返回保证具有有效租约字段和放置结果的 `ReadyTicketView`。`claim` 是首次接用；`renew` 是后续续租，两者只有确认成功才返回 `RenewReceipt`。`release` 仍必须显式传入 `{ reclaimable: true }`，不由 SDK 替消费者决定临时数据是否可删除。

SDK 的 claim/renew 在发起动作前读取当前 generation 和 Lease.version，随后只提交一次逻辑写入。遇到 202 只查询原续租记录；遇到版本冲突不能自动改用新版本再提案。网络重试沿用同一个幂等键。响应不确定时抛带 `recovery` 引用的 `ComputeClientError`，调用方可查询原记录或同键恢复。SDK 不会因为等待超时、浏览器关闭或取消本地轮询而自动取消 Ticket。

同一个幂等键不能配上重读后的不同版本。SDK 先生成不可变 `PreparedTicketCommand`，之后的自动重试复用它。需要跨进程恢复的调用方通过 `ClientWriteOptions.onPrepared` 在首次网络发送前保存该对象；保存失败则不发送。恢复时调用 `tickets.resume(savedCommand)`，原样使用已保存的请求体、generation、版本与幂等键，不重新查默认值或重算续租参数。未知结果错误也附带该对象；其中没有认证 Token，恢复仍须当前身份通过服务端授权。

只保存一个幂等键不足以在新进程中重建被 SDK 隐藏的续租版本。普通调用无需使用此恢复接口；要求进程崩溃后准确续接的 Agent 应持久化准备请求。SDK 可保存当前进程内的准备请求缓存，但不能把它当作跨进程保证。同键已完成请求先返回历史结果，再由调用方读取当前 Ticket 判断环境是否仍有效。

控制端 `TicketService` 保留低层 `RenewOutcome`，可以表达 200/202/409。所有应用用例统一使用 `QueryContext` 或 `CommandContext`：前者包含可信身份与请求追踪，后者再包含幂等键。由 HTTP 层构造上下文，不从 JSON 请求体接收 Actor。函数只剩“上下文、目标 ID、业务输入”三个角色，避免重复传入 Actor 与元信息。

等待默认值明确区分用途：waitUntilReady 为60分钟，waitUntilReleased为5分钟，可由timeoutMilliseconds覆盖；取消函数只停止当前等待。claim/renew默认最多等待15秒获取原提案的最终结果，超过则抛带准备请求和renewal引用的未知结果错误，不新提案、不承诺延期。

实体 CAS 条件只在对应请求字段中出现一次。PATCH/PUT 的 If-Match 由路由转换为 `expectedVersion`；如果兼容路由同时接受 body 版本与 Header，必须要求一致，不得任取其一。`expectedLeaseVersion`、`expectedTicketVersion` 和 `expectedProfileVersion`保留具体名称，避免误用另一个对象的版本。

镜像目录的version是字符串版本名，不能拿来做CAS。内部ImageVersion另有entityVersion；发布和阻止使用分别携带expectedEntityVersion，避免管理员基于旧页面操作已经更新过的草稿。

ResourceEvent补齐事件信封；id是SQLite递增序号的十进制字符串EventCursor，和实体UUID不同。列表用TicketSummary，详情用TicketView。MachineSnapshot承载物理宿主的启动ID、序列、会话、压力和完整性；Runtime Agent不得提交物理会话快照。

## 状态与执行边界

| 原有易误用点 | 接口处理 | 保留的运行时检查 |
| --- | --- | --- |
| TicketView 继承内部 Ticket | 显式白名单；Lease、入口和镜像也有独立公开视图 | 序列化器显式投影，禁止展开内部对象 |
| confirmed 但 receipt 为 null | RenewalDecision 判别联合 | 状态转换、截止和事务 CAS |
| validation 同时带 ticketId | AllocationOwner 判别联合；非 tenant 的 Lease 固定 null | 数据库 FK、权限和实际归属 |
| Docker 配 Tart 原生身份 | RuntimeDescriptor 按 provider 判别 | 认证探测与原生 ID 匹配 |
| any 协议配局部端口 | NetworkDenyRule 判别联合，显式端口列表非空 | CIDR、端口范围、内核规则与连通测试 |
| create 使用空 runtime ID | AllocationOperationContext 及对应传输身份收紧 | 身份证据、连接修订、控制版本和期限 |
| Provider.getAccess 实际在做就绪检查 | 改名 checkReady；领取公开材料由 TicketService.getAccess 完成 | 就绪证据、owner 和有效租约 |
| 同一停止目标重复保存多个容器 ID | LocalStopTarget 直接复用 OwnedResourceRef | Agent 持久映射内部 runtime ID 到原生 ID并校验 |
| Agent 回执可返回任何动作结果 | 请求/结果映射及泛型 AgentCommandResult | 接收端按保存的原命令校验 JSON，而不信任泛型或对端自报 |
| 激活连接重复提供修订与证据 ID | 输入只保留 revisionId；服务读取修订固定的证据 | 同运行时、权限、版本和证据有效性 |

预留与现场解析也分两步：Allocation在唤醒前可以没有resolvedProvisionContractId，现场检查通过后只允许从null绑定一次。Provider.create仍要求非空ResolvedProvisionContract；这避免为了满足类型而在节点离线时伪造路径证据。绑定事务必须复核状态、控制版本和授权，取消后的迟到检查结果不能继续创建。

SQLite中“不可变”约束保护保留期间的历史，不阻止合法到期清理。已released票据的StorageGrant可按保留规则删除；仍被引用的ResolvedProvisionContract不可删，解除全部引用后才可清理。续租终态不可改写，拒绝/取消必须有原因码。维护用例检查所有引用和终态后清理整个历史子图，不通过删一行Allocation来复用旧Ticket。

`ResourceProvider` 接收已经授权的内部计划，只实施资源动作和记录事实，不决定业务是否成功。`checkReady` 与业务执行分开，`stop` 与最终删除分开，`unknown` 与 `absent` 分开；这些分离是恢复和容量正确性所需，没有合并成一个布尔 success。

Agent 的 `accepted/running` 回执必须没有 output。`succeeded` 表示受控动作执行结束，真正的外部结果仍由 output 中的 `outcome/presence/state` 裁决，其中可以是 unknown，不能凭回执 phase 释放资源。失败/拒绝回执带脱敏错误与可能副作用。传输层从 commandId 找回原命令后，才按对应映射解析结果。分配级 VM 命令与网络计划也必须携带分配级身份，不能仅凭通用上下文发危险动作。

所有未知状态、跨表约束、授权、真实资源身份、时间大小与数值范围仍由运行时 schema、数据库事务及真实执行端验证。这里保留普通字符串 ID，而没有为每种 ID 增加一套品牌类型和强制转换工具；公开 JSON 仍然易用，重要的关联由服务和 FK 检查。类型层主要拦截结构错误，不伪装成已经验证了外部事实。

## 从 v1.1 迁移

这仍是实现前的设计修订，尚无已部署客户端需要在线兼容。后续实现应直接以v1.3合同编写运行时schema并生成OpenAPI/SDK，不能将新旧输入同时宽松接受。

1. 消费者把资源的 `request/limit` 合并成一组 `resources`；精确版本选择删除重复 imageId。
2. 公开响应按 TicketSummary/TicketView、LeaseView、ConsumerAccessEndpoint 显式组装。
3. 服务实现用 QueryContext/CommandContext 替代分散的 Actor/WriteRequestMetadata；只保留一个 CAS 条件源。
4. Provider 和 VM Agent 的就绪动作从 getAccess 更名为 checkReady；HTTP 领取接口路径不变。
5. 状态枚举和表数量不变；Consumer补齐updatedAt对应的updated_at_ms列，ImageVersion的entityVersion映射既有entity_version。repo增加明确投影，request_json按上述完整接受请求固定；序列化映射不是直接JSON.stringify内部对象。

v1.3没有增加表或常驻服务。首发工程只需contracts和sdk两个共享包，纯领域、数据库和Provider代码先放在control内；接口文件分层不要求拆成更多npm包。Docker仍先实现，VM只保留后置合同，现有Docker专属网络执行协议也不视为VM已实现。接口文件的存在不代表运行能力已经交付。

D22a 电源管理协议的唯一运行时权威为 `packages/contracts/src/power.ts`，仅从 admin 子入口导出；`domain.ts` 的 PowerPolicy/FaultRecoveryPolicy/SmartPlugBinding/PowerCapabilities 为同一来源的 type-only re-export。D22a 固定 dryRun=true，能力/绑定管理不能写 verified，合成回执不进入真实 Agent 账本。本文的 ShutdownPermit/ShutdownAcceptedReceipt 与 MachinePowerStatus 仍为 D22b 的真实执行设计，不是 D22a API。实际边界、路由和恢复语义见设计第13节的 D22a说明。

## 检查方式

使用TypeScript strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、noEmit检查总入口、[contracts.typecheck.ts](contracts.typecheck.ts)和使用示例。类型回归覆盖公开边界、固定租期、互斥状态、执行上下文及Agent结果映射；SQLite校验覆盖容量、延迟绑定、历史清理和终态约束。当前准确检查数见[验证记录](../VERIFICATION.md)，不以静态通过替代运行时或实机验收。

在设计包根目录、已安装 TypeScript 的环境中执行：

```sh
tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target ES2022 --module ESNext --lib ES2022 contracts.ts contracts/contracts.typecheck.ts contracts/usage.examples.ts
```
