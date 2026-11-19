# Docker 能力证据与实际交付

这是普通 bridge 路径的本地源码增量，未操作真实节点、Engine 或网络。修复的是项目代码对能力报告的泛化前置，不是更改平台、宿主权限或安全设置。显式 filtered、SSH 和 VM 交付保留原要求。

## 登记入口

继续使用 `POST /v1/nodes/{nodeId}/capability-attestations` 和原 SDK `admin.inventory.attestCapabilities`。Node 的 disabled/CAS、Engine/连接 revision、Docker/Portainer 版本、架构、检查时间及有效期要求保持。网络输入仍是实际不可变 `networkProfileRevisionIds`；不增加可覆盖资格的消费者开关。

`report.scopes.resourceLimits` 必须有 passed、真实 summary 和 evidenceRef，表示已核 CPU/内存限额。其余五项改为可省略；没有执行就省略，不能填 passed。仍只接受已有六个名称。配置示例中的所有 evidence 均需由实施方替换为自己实际已取得的结果：

```ts
report: {
  runId, sha256,
  scopes: {
    resourceLimits: {
      status: "passed",
      summary: "实际 CPU/内存限额核验摘要",
      evidenceRef: "已有核验记录的引用",
    },
  },
},
networkProfileRevisionIds: [selectedImmutableBridgeRevisionId],
```

Store 从这些 revision 的真实 policy 判断：全部为 `dockerMode:"bridge"` 时，接受资源证据；任何 filtered（含未写 dockerMode）的 revision 仍须原六项 passed。不凭当前 profile 或新请求自行降低旧票合同。原 storage revision 的四项资格不变。

能力文档只根据已交证据产生标记：只有完整六项报告才标 `networkPolicyEnforcement:"verified"`，且 `verifiedNetworkProfileRevisionIds` 仅列实际登记的 filtered revision；否则该能力为 unsupported、列表为空。`supportedAccess:["ssh"]` 仅在有 sshBootstrap 证据时产生。CPU/内存与保守 capacity、连接、有效期、原报告摘要继续绑定同一个 fingerprint。普通 bridge 不制造强过滤、SSH 或清理恢复的人工通过记录。

## 健康与使用

通用 Docker Node 健康检查使用资源报告、CPU/内存标记、有效期、Engine/连接身份等已有事实；不因为未声明的 filtered/SSH 能力缺失而将普通 Node 降级。若能力文档已经声称 filtered 或 SSH，则对应报告仍须存在，不能靠部分报告续健康。管理投影的 `verified` 表示具备已登记的基础交付能力，不代表该 Node 支持每种网络或 SSH 交付；所选请求仍检查具体能力。

普通镜像验证与 Ticket matching 继续使用所选/冻结 profile：检查 CPU/内存、容量、架构、OS、Node/Host 健康与有效期及实际存储资格。显式 filtered 要有过滤能力和精确 revision 资格；SSH 要有支持该协议的能力。VM 分支没有修改。

真实 Docker bridge 不是靠一行人工报告冒称已验：正式 Provider 创建本 allocation 的 bridge，核对 Engine、owner、驱动、网络模式/附件与成员实际地址，检查 CPU/内存限额、镜像、挂载和运行状态。双成员 gateway 的 TUN 映射、NET_ADMIN/NET_RAW、容器命名空间内 forwarding 和固定配方继续读回；缺失仍失败。不测试无关宿主防火墙或 SSH，不把网关业务报到变成 Hitchlet ready 门。

正式镜像验证仍须该创建路径及实际对象回收均通过才能发布；unknown、副作用不闭合或清理不完整不能作为通过。普通 Ticket 的 lease、ready inventory、1.0/1.1 cleanup proof 与容量核销保持原样，不用手工 cleanupRecovery passed 替代实际回执。

## 本轮相关判断核对

| 位置/本地验证环境                                                   | 上游已有事实、可观察差异与证据                                                                                                                       | 代价与处理                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| contracts/admin capability report；SDK/HTTP                         | 原六项严格必填，资源报告在到 Store 前即被拒；现资源项必填，其余缺省不生成 passed，真实 loopback 与注入 HTTP 的 SDK 回归覆盖                          | 避免普通桥为无关探针补材料；收窄         |
| machine-node-store attestCapabilities；临时 SQLite                  | 已有 Engine/版本/CAS/时间和 revision 绑定；原无条件六项并强写 network/SSH verified，现读 immutable policy 决定必需项并按已交证据产标记               | 不降低 filtered 原六项，不制造通过；收窄 |
| domain/attested-capability、Admin refresh/promotion；合成 Portainer | 真实观测已核 Engine/版本/容量；普通资源报告缺无关项不再被打 degraded；过期、缺资源及能力声明与报告矛盾仍拒绝                                         | 保留身份/资源/时间约束；收窄             |
| admin-store-utils projectCapabilities；正常 Node DTO                | 原投影只把全过滤网络视为 verified；现展示真实基础资源资格，具体网络/SSH 仍由请求判断                                                                 | 避免管理页把可用普通桥显示成未验证；收窄 |
| image-validation；普通验证→临时账本                                 | 0fcaacc 已按所选 profile 分流；本轮用正式部分登记产物跑通验证/清理/发布。缺 CPU/内存、capacity、过期或改选未资格 filtered 均 blocked 且无 allocation | 保留，没有再改一套判定                   |
| Ticket matching/reserve；真实应用与 SQLite                          | 0fcaacc 已按冻结 profile 检查能力；部分登记仍能普通申请，缺实际必需标记或显式 filtered/SSH 不符仍 unsupported                                        | 保留 quota、Host、存储和原子预留         |
| Provider ready/observe；假 Engine                                   | 上游只证明基础能力；本层仍核本次实际桥和 gateway 配方。错误 driver、TUN/forwarding、NET_RAW 或额外特权读回均不能 ready                               | 保留实际交付核验，没有新增探针           |
| validation cleanup/publication 与 proof；临时 SQLite                | 持久 journal、receipt 和实际 absent 对账；失败创建沿同票收尾，不伪造 ready/缺失对象或人工 cleanup passed                                             | 保留实际回收后才核销/发布                |

以上是源码与合成/localhost 证据；真实普通桥、网关数据道和完整现场闭环仍由原实施方在获准范围验证。TC acquire、profile 选择及 proof DTO 没有新增字段；只需同候选 contracts/SDK 构建后使用既有登记入口提交实际资源证据。Controller 和 contracts 改动，Runtime 源码没有本轮增量。
