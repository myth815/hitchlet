# 实际 API、SDK 与原请求恢复

本文对应当前运行代码；完整字段和响应白名单由 `packages/contracts/src/` 的运行时 schema 生成，在运行服务的 `GET /v1/openapi.json` 查看。设计目录中的 TypeScript 用例不是另一个运行客户端。依赖方向为 GUI → SDK → contracts；控制器的领域/应用用例、SQLite adapter 和 Portainer/Runtime adapter 分开。

## 安装与认证

在独立 Hitchlet checkout 运行 Node 24、pnpm 10 和 `pnpm install --frozen-lockfile && pnpm build`。仓库脚本从根目录可这样导入已构建 SDK：

```js
import { HitchletClient } from "./packages/sdk/dist/index.js";
const client = new HitchletClient(process.env.HITCHLET_ORIGIN, {
  auth: { kind: "bearer", token: process.env.HITCHLET_TOKEN },
});
```

自己的 workspace 可依赖 `@hitchlet/sdk`，并从包名导入。不要把服务器源码或设计目录当运行时依赖。长期 token 从受控终端、秘密管理器或进程环境注入；不放入 URL、代码、日志或浏览器 localStorage。

浏览器使用 `client.session.create(token)` 换取 HttpOnly 会话，然后使用 cookie 模式客户端及 CSRF provider：

```js
const browser = new HitchletClient(location.origin, {
  auth: { kind: "cookie", csrfToken: () => readCsrfCookie() },
});
await browser.session.create(enteredToken);
enteredToken = "";
const principal = await browser.session.me();
await browser.session.logout();
```

`readCsrfCookie()` 是调用者读取 `hitchlet_csrf` 的函数，仓库 GUI 已实现。HTTPS 下保留 `COOKIE_SECURE=true`；只有本地原生服务 `HOST=127.0.0.1` 才允许关闭安全 cookie。会话默认 8 小时；退出、源凭据撤销和消费者停用会使认证失效。写入的真实角色、scope、对象范围和 cookie CSRF 均由服务端再次校验。

| 角色     | 读写边界                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------- |
| consumer | 从自己的授权目录申请，只能操作自己的 Ticket/Lease/access                                          |
| viewer   | 允许范围的管理状态和自己的状态，只读；不具备撤销权限                                              |
| operator | 授权镜像与 Node 范围的 Ticket、原操作重试、Node 排空/恢复和缓存预热；不能登记后端、发布或修改身份 |
| admin    | 只有完整角色 scope 的凭据才具备全局管理能力；受限 admin token 不因 role 名称扩大权限              |

修改消费者时，现有 token scope 只取新角色允许范围的交集，名称/配额编辑不会扩大受限 token。升权后需明确签发新凭据；所有旧 GUI 会话撤销。最后一个可用完整管理员不能被降权/停用，不能仅用没有凭据的 admin 账户作为兜底。

## 消费者闭环

`client.catalog()` / `GET /v1/catalog` 返回安全授权选择：已发布不可变版本、各架构制品及真实资源下限、网络/profile 固定修订、允许存储子路径/模式、授权本地 Node。没有 NAS source、secret ref、后端地址或个人会话信息。授权目录为空时联系管理员登记/发布/授权，不猜 UUID。

在已经设置 `HITCHLET_ORIGIN`、`HITCHLET_TOKEN` 的根目录 Node ESM 脚本中：

```js
import { HitchletClient } from "./packages/sdk/dist/index.js";
import { writeFile, rename, rm } from "node:fs/promises";

const client = new HitchletClient(process.env.HITCHLET_ORIGIN, {
  auth: { kind: "bearer", token: process.env.HITCHLET_TOKEN },
});
const commandFile = process.env.HITCHLET_COMMAND_FILE;
if (!commandFile) throw new Error("Set a protected command-file path");
const options = {
  onPrepared: async (command) => {
    await writeFile(`${commandFile}.next`, JSON.stringify(command), {
      mode: 0o600,
    });
    await rename(`${commandFile}.next`, commandFile);
  },
};
const catalog = await client.catalog();
const image = catalog.versions[0],
  network = catalog.networks[0];
if (!image || !network || !image.platforms[0])
  throw new Error("No authorized choices");
const platform = image.platforms[0];
const request = {
  image: { versionId: image.id },
  kind: "container",
  allowedArchitectures: [platform.architecture],
  networkProfileId: network.id,
  resources: {
    ...platform.minimumResources,
    cpuMillis: Math.max(500, platform.minimumResources.cpuMillis),
    memoryMiB: Math.max(512, platform.minimumResources.memoryMiB),
    scratchEnforcement: "best_effort",
    isolation: "shared_kernel",
  },
  lease: { requestedSeconds: Math.min(900, catalog.quota.maxLeaseTtlSeconds) },
};
const preview = await client.preview(request);
// preview.capacityGuaranteed is always false. No Ticket/Claim was written.
const receipt = await client.tickets.acquire(request, options);
const ticketId = receipt.ticket.id;
await rm(commandFile, { force: true });
await client.tickets.waitUntilReady(ticketId, { timeoutMilliseconds: 300000 });
await client.tickets.claim(ticketId, options);
await rm(commandFile, { force: true });
// When needed: await client.tickets.getAccess(ticketId, options).
// Copy connection material only to protected memory/files; never log it.
await client.tickets.renew(ticketId, {}, options);
await rm(commandFile, { force: true });
// Only after saving work and agreeing to delete the temporary environment:
await client.tickets.release(ticketId, { reclaimable: true }, options);
await client.tickets.waitUntilReleased(ticketId, {
  timeoutMilliseconds: 300000,
});
await rm(commandFile, { force: true });
```

资源必须在消费者累计上限内；上例不自动提高配额。预检复用真实申请归一化、profile 授权和候选资格规则，包括网络/存储取证、Host 准入、架构、协议和必要能力。并发配额、物理/子池剩余容量和版本仍在实际预留事务重检，预检不作容量保证。等待超时只停止本地等待，不能自动释放或申请第二张票。

需要持久存储时从 `catalog.storage` 选择：

```js
const profile = catalog.storage[0];
if (profile)
  request.storage = [
    {
      storageProfileId: profile.id,
      authorizedSubpath: profile.allowedSubpaths[0],
      mountPath: "/workspace/data",
      mode: profile.allowedModes[0],
    },
  ];
```

这段应在预检/acquire 前应用；不要将 NAS source、宿主路径、Docker socket 或挂载选项放入申请。子路径必须安全且在授权前缀内；模式须获授权，容器目标有服务端白名单校验。数据持久引用只解绑，不随临时容器删除。

`NETWORK_RESULT_UNKNOWN`、`INVALID_RESPONSE` 或进程退出后，读取受保护的原命令文件，并先用 `PreparedTicketCommandSchema` 校验，再 `client.tickets.resume(original)`；不要调用一次新的 acquire。续租 `pending` 使用原 `renewalId` 调用 `getRenewal`，当前有效期仍为最后确认值；历史 404 不证明成功。`cancel(ticketId, {}, options)` 撤销尚未结束的租用，必要时继续清理；`release` 要求真实数据保存/删除同意，不能用管理撤销假造消费者同意。

## 管理入口对应关系

以下均为 SDK 上的真实方法。写入传入自己保存的 `key`，一个意图一个键；相同键的 body 或 If-Match 不可改变。

| 工作                        | API                                                                                                          | SDK                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 总览、容量/Host 摘要        | `GET /v1/admin/overview`                                                                                     | `admin.management.overview()`                                                                                               |
| 按所有者/Node/镜像/阶段分页 | `GET /v1/admin/tickets`                                                                                      | `admin.management.tickets(query)`                                                                                           |
| 详情、原操作、事件          | `GET /v1/admin/tickets/{id}`、`/{id}/timeline`、`/v1/admin/operations`                                       | `ticket(id)`、`timeline(id)`、`operations()`                                                                                |
| 授权撤销/失败重试           | `POST /v1/tickets/{id}/revoke`、`/v1/admin/operations/{id}/retry`                                            | `revoke(id, body, key)`、`retryOperation(id, {expectedVersion,reason}, key)`                                                |
| Node/Machine 排空恢复       | `PUT /v1/{nodes                                                                                              | machines}/{id}/admission`                                                                                                   | `admin.management.admission(kind,id,body,key)`                 |
| 探测/修订/同 Engine 激活    | `/v1/provider-connections`、`/{id}/revisions`、`/{id}/activate-revision`                                     | `admin.inventory.discover/proposeRevision/activateRevision`                                                                 |
| 原探测回执与重试            | `/v1/provider-discovery/{id}`、`/v1/provider-connection-proposals/{id}` 及 `/retry`                          | `discovery/retryDiscovery/proposal/retryProposal`                                                                           |
| Machine/Node 与 Runtime     | `/v1/machines`、`/v1/nodes`、`/{id}/runtime-config`                                                          | `createMachine/createNode/configureRuntime`                                                                                 |
| 可信能力报告                | `/v1/nodes/{id}/capability-attestations`                                                                     | `attestCapabilities(id, externallyCollectedReport, expectedVersion, key)`                                                   |
| 平台管理保护基线            | `PUT /v1/admin/network-deny`                                                                                 | `admin.inventory.updateNetworkDeny(body,key)`                                                                               |
| Network/Storage profiles    | `/v1/network-profiles`、`/v1/storage-profiles` 与 `/{id}/revisions`                                          | `createNetwork/reviseNetwork/createStorage/reviseStorage`                                                                   |
| 草稿/版本/制品              | `/v1/images`、`/{id}/versions`、`/v1/image-versions/{id}/artifacts`                                          | `createDraft/createVersion/addArtifact`                                                                                     |
| 验证/报告/取消              | `/v1/image-versions/{id}/validate`、`/v1/image-validations/{id}` 与 `/cancel`                                | `admin.scheduleValidation/validation/cancelValidation`                                                                      |
| 发布/别名/退役              | `/v1/image-versions/{id}/publish`、`/v1/images/{id}/aliases/{alias}`、`/v1/admin/image-versions/{id}/retire` | `admin.publish/setAlias`、`admin.management.retire`                                                                         |
| 缓存预热/回收/原回执        | `/v1/nodes/{id}/image-cache/{prewarm                                                                         | gc}`、`/operations/{operationId}`                                                                                           | `admin.inventory.prewarm/evict`、`admin.cacheOperationReceipt` |
| Consumer 配额/授权 CAS      | `/v1/admin/consumers`、`/{id}`                                                                               | `admin.management.consumers/createConsumer/updateConsumer`                                                                  |
| destroy 政策名称/关联       | `/v1/admin/policies`、`/{id}`                                                                                | `policies/createPolicy/updatePolicy`；TTL 与总寿命来自 Consumer quota                                                       |
| 新凭据一次性签发            | `POST /v1/admin/credentials`                                                                                 | `admin.management.issueCredential(consumerId,key)`                                                                          |
| 备份/恢复/磁盘/轮换         | `/v1/system/*`                                                                                               | `admin.systemHealth/backups/backup/diagnostics/credentials/rotateCredential/pauseAdmission/resumeAdmission/approveRecovery` |

除表中明确写 `admin.inventory` / `admin` 外，方法归表内同一分组。准确签名见 SDK 声明与 OpenAPI。Runtime/物理 Host 的部署、配对与秘密 CLI 是可信管理前置；不从 GUI 认证未实测能力。

`attestCapabilities` 可在报告中传 `validForSeconds`，范围为 3600–2592000 秒，省略时为 3600 秒。有效期从 `checkedAt` 固定计算，Node/Host 心跳不会续期；报告到期后须重新实测并提交。更新报告不会把已处于 `observed_host` 的 Node 降回人工试用模式。该字段属于新增请求 schema，Controller 与 SDK contracts 应成套升级。

## 管理写入恢复和秘密边界

`client.withManagementPreparation(onPrepared, onSettled)` 创建独立客户端，保留原 transport/auth 配置。回调发生在白名单管理请求发送之前，内容为 contracts 校验后的 `PreparedManagementRequest`：固定方法、路径、body、CAS 与 key。先安全持久化；保存失败时 SDK 不发送。用 `client.admin.resumeManagement(original)` 显式恢复。白名单拒绝任意 URL、shell、SQL、访问材料、配对和凭据签发/轮换。SDK 不自动重试管理创建。

服务端在执行前记录该键，普通响应仅存安全回执。同键同body返回原结果；同键不同body/If-Match返回409。`GET /v1/admin/commands` / `commandReceipts()` 只返回调用者最近100条元数据。完成回执保存180天；未知效果保留。期限外的旧键可能成为新请求，不把键当永久资源身份。

正常丢响应可读取原回执并刷新目录，或重放原请求。若控制器在“键已持久化、实际结果尚未写回”之间崩溃，服务端返回 `management_result_unknown` 并拒绝重复执行；进入原 Operation/对象目录确认真实状态。`/v1/admin/commands/review` / `reviewCommand` 记录人工调查理由和已查实对象/原操作引用，只结束本地等待，不把 unknown 改成成功、不修改外部对象、不释放 Claim。不要用任意对象充当成功证据。没有查实效果时保留原意图，不重复创建；其他清理与维护不受阻。

GUI 在每个 Consumer 的标签页 sessionStorage 中保留最多8条安全原请求，刷新可恢复，关闭标签页可能丢失。长期令牌、凭据签发响应和访问材料不在其中。签发凭据以同一个键原子记录**元数据**并只返回一次 token，重复同键返回409，不重发token；丢响应后先查凭据列表，撤销/轮换那一凭据，不能自动多发。D23轮换也不自动重试；自轮换使旧会话失效，新token仍只在当前页面内存显示。

`409/412` 后读取当前配置/CAS，再明确提出新意图和新键；不能静默覆盖。断线时 GUI 保留历史快照并禁用写入，不将未知值算零、不把202受理算回收成功。consumer事件由 `watchEvents(cursor,signal,onEvent,onConnected)` 使用可续接 SSE；十进制游标不转 Number，断开后有界重连和快照轮询补偿。历史已裁剪时重新抓取快照，事件历史缺失不证明状态成功。
