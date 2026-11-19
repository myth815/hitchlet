# 未 ready 的清理证明

这是本地源码候选；验证使用合成 Portainer/Runtime 与真实临时 SQLite、HTTP 认证及 SDK，没有现场租约或网络操作。

当容器已创建但启动失败，或只创建了部分对象时，普通租客仍须能在原票重入后完成收尾。原 reader 依赖 ready receipt 与完整 ready manifest，导致底层已经回收、容量已经核销，GET 却返回 404。本改动只补此分支，不修改创建、清理或容量释放的执行逻辑。

## 原接口与正式出口

继续使用 `GET /v1/tickets/{ticketId}/cleanup-proof?leaseId=...&generation=...`，普通 `tickets:read` 和本 consumer 归属不变。SDK 调用仍为 `client.tickets.cleanupProof(ticketId, { leaseId, generation, expected? })`。

`@hitchlet/contracts` 与 `@hitchlet/sdk` 均导出 `TicketCleanupProofSchema`、`ReadyTicketCleanupProofSchema`、`PreReadyTicketCleanupProofSchema` 及相应类型。SDK 方法返回联合类型 `TicketCleanupProof`，按 `version` 缩窄；OpenAPI 的同一 response schema 包含两分支。

- `version:"1.0"`：既有 ready-manifest 证明，返回内容和校验保持原样。
- `version:"1.1"`、`basis:"pre_ready_cleanup"`：从原创建日志与最终清理记录产生的证明，没有 ready manifest，也不伪造完整双成员 inventory。

新分支的字段为：

```ts
{
  version: "1.1",
  basis: "pre_ready_cleanup",
  outcome: "not_created" | "reclaimed",
  ticketId, consumerId, leaseId, generation, allocationId,
  cleanupOperationId, cleanupControlVersion,
  createIdentity, cleanupIdentity,
  cleanupManifest: { id, hash },
  createJournal: {
    operationId, attemptCount,
    effects: [{ key, kind, resourceId }],
  },
  objects: [{ id, kind, ownership: "owned", memberName? }],
  receipts: [/* 原 CleanupProofReceiptSchema */],
  after: /* 原 absent 读回，或 null */,
  claimState: "released", leaseState: "revoked", providerCleanup: "complete",
  producer: "controller.allocation.cleanup", readAtMs,
  io: "unknown", wholeScopeWriteExclusion: "unknown",
}
```

`not_created` 的对象、effects、receipts 均为空；未发出外部创建且无需 Runtime 读回时 `after:null`。如果已执行检查并真实确认没有对象，则可返回实际 absent 读回。`reclaimed` 至少有一个真实 owned 对象，并有逐对象匹配的回执及实际 absent 读回。

`cleanupManifest` 描述本次实际创建并回收的集合，不是 ready manifest。原查询中的可选 `expected.manifestId/manifestHash` 在此分支对应 `cleanupManifest`，可用于后续同票读回固定。没有 allocation/lease 的排队取消仍以普通 Ticket 的 `released/not_needed` 收尾，不制造 lease 或 proof。

`createJournal.effects` 只投影已观察并闭合的创建结果；key 为现有 `network_policy`、`container`、`volume`，以及双成员 recipe 的 `container_gateway`、`volume_gateway`。双成员容器/卷的实际对象可带 `memberName`，没有创建的成员不补齐。引用不进入销毁集合。新分支不返回环境、host source、argv、密钥、原始请求或完整 operation result。

与既有协议一致，native `cleanupIdentity.operationId` 和 receipts identity 仍绑定原 provision operation，增加的是 controlVersion；独立的 `cleanupOperationId` 才指向 cleanup operation。

## 证明依据与消费

每份证明从同一 SQLite 查询快照绑定本票、真实 lease/generation、allocation、原 provision operation、当前 cleanup operation、全部 managed resources、容量 Claims 和未知副作用。必须已经 released/revoked、实际 cleanup succeeded、全部 Claims released；有任何未闭合或 unknown create effect 都不出证明。实际对象、已观察的 create effects、managed ownership 及销毁回执必须完整一致。保留 Runtime、连接 revision、代次、controlVersion 和读回时间检查。

新分支不允许已有 ready receipt 或 ready 时间的票降级；ready 路径证据不完整仍按原路径失败。它不调用 Provider，也不写账本、补造 ready 或重新释放容量。

消费者在没有 ready inventory 时，核验 `version:"1.1"` 分支的原票身份、终态及完整实际对象回执，随后执行自身临时 bootstrap、凭据和 borrow 的善后；不要要求未创建成员的 ready 信息。已有 ready inventory 时继续按原 `1.0` 路径对账。Hitchlet 不宣称业务成功、数据保存完成或整个存储范围无人写入。

定向验证复用 `ticket-proof-provider-integration.test.ts` 的普通 Provider、Worker 和账本：两个成员创建后启动失败、部分创建、已预留但 provision 未启动、排队未预留；前两者分别核对实际五项和四项 owned 及全部回执。正常 SSH/entrypoint/双成员 ready 归还继续使用原回归。无需数据库迁移，Runtime 源码与网络协议没有变更；Controller、contracts 与消费者 SDK 需按本候选构建。
