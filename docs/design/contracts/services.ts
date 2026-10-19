/**
 * 计算资源服务接口设计 v1.3（尚非运行实现）。
 * 控制端应用用例接口。上下文集中承载身份/幂等；消费者直接使用 TicketClient。这里是起步端口，非完整路由清单。
 * 所有 number 均须验证有限值；整数/范围/跨字段不变量由运行时 schema 与事务共同保障。
 * 可选字段省略表示使用明确默认；null 表示明确不存在/尚未取得，不互相替换。
 */
import type { RevocationImpact } from './domain';
import type { Consumer, ConsumerAuthorization, ConsumerQuota, MachineSnapshot } from './domain';
import type { Role } from './common';

/** 创建消费者时必须明确授权和配额；不以空JSON或隐式全权限作为默认。 */
export interface CreateConsumerRequest {
  /** 可读名称。 */
  readonly name: string;
  /** 主体种类，不构成额外权限。 */
  readonly kind: Consumer['kind'];
  /** 管理角色只能由现有admin授予。 */
  readonly role: Role;
  /** 目录允许范围。 */
  readonly authorization: ConsumerAuthorization;
  /** 并发、资源合计和未来新票的期限上限。 */
  readonly quota: ConsumerQuota;
}

/** 管理员更新新准入规则，保留已受理票的授权和期限，撤销存量另走revoke。 */
export interface UpdateConsumerAccessRequest {
  /** Consumer的实体CAS版本。 */
  readonly expectedVersion: number;
  /** 新目录范围。 */
  readonly authorization: ConsumerAuthorization;
  /** 新准入上限；现有占用超限时停止新增，不强杀租客。 */
  readonly quota: ConsumerQuota;
}

/** 消费者管理的最小应用端口；凭据发行仍由独立身份用例负责。 */
export interface ConsumerService {
  /**
   * 管理员创建主体并显式设置最小权限。
   * @param context 可信管理员上下文。
   * @param request 已验证的身份属性、授权和配额。
   * @returns 已持久化消费者，不含可重复读取的明文凭据。
   */
  create(context: CommandContext, request: CreateConsumerRequest): Promise<Consumer>;
  /**
   * 读取有权查看的消费者配置。
   * @param context 可信调用上下文。
   * @param consumerId 目标消费者。
   * @returns 内部消费者记录，仅管理路由可输出对应视图。
   */
  get(context: QueryContext, consumerId: Id): Promise<Consumer>;
  /**
   * CAS更新目录和配额，存量撤销必须使用显式终止入口。
   * @param context 可信管理员写入上下文。
   * @param consumerId 目标消费者。
   * @param request 旧版本和新的准入规则。
   * @returns 更新后的消费者。
   */
  updateAccess(context: CommandContext, consumerId: Id, request: UpdateConsumerAccessRequest): Promise<Consumer>;
}
import type { CursorPage, Id } from './common';
import type {
  AccessGrant,
  AcquireRequest,
  CancelRequest,
  ImageValidationRequest,
  EventQuery,
  ResourceEvent,
  LeaseRenewalView,
  ProfileGrantRevokeRequest,
  ReleaseRequest,
  RenewOutcome,
  RenewRequest,
  RevokeRequest,
  TicketListQuery,
  TicketSummary,
  TicketView,
} from './consumer';

/** GUI/SSE共同使用的已授权事件补读端口，不另建消息队列。 */
export interface EventService {
  /**
   * 返回游标后的安全事件；游标早于保留窗口则返回CURSOR_EXPIRED并映射HTTP 410。
   * @param context 可信调用上下文，决定可见消费者和对象范围。
   * @param query 事件游标和可选Ticket过滤；禁止按未授权ID探测事件。
   * @returns 有序事件页；SSE使用相同信封，空页不是订阅终止。
   */
  list(context: QueryContext, query: EventQuery): Promise<CursorPage<ResourceEvent>>;
}
import type {
  Actor,
  ImageArtifact,
  ImageValidationRun,
  ImageVersion,
  Machine,
  NetworkProfileRevision,
  Node,
  ProfileGrantRevocation,
  ProviderConnection,
  ProviderConnectionRevision,
  RuntimeDiscoveryTarget,
  StorageProfileRevision,
} from './domain';
import type { Operation } from './provider';

/** 控制端 Ticket 应用用例。与无 Actor 参数的消费者 SDK 分开；统一鉴权、幂等和事务。 */
export interface TicketService {
  /** 验证并归一化请求，在短事务内受理 Ticket；返回不代表已完成资源准备。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  acquire(context: CommandContext, request: AcquireRequest): Promise<TicketView>;
  /** 返回经过当前调用者范围校验的对象；不存在或不可见统一映射 404。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ticketId 关联租客 Ticket 标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  get(context: QueryContext, ticketId: Id): Promise<TicketView>;
  /** 按当前身份过滤并返回游标页；默认 50，最多 200。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param query 经过校验的过滤/分页条件。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  list(context: QueryContext, query: TicketListQuery): Promise<CursorPage<TicketSummary>>;
  /** 检查 owner、generation、Lease CAS 与截止；返回 confirmed、pending 或 rejected，不把候选期限当承诺。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  renew(context: CommandContext, ticketId: Id, request: RenewRequest): Promise<RenewOutcome>;
  /** 返回同一持久续租的当前公开状态；仅 owner 可查询。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ticketId 关联租客 Ticket 标识。
   * @param renewalId 可由 owner 查询的持久续租记录标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getRenewal(context: QueryContext, ticketId: Id, renewalId: Id): Promise<LeaseRenewalView>;
  /** 先持久终止授权，再异步清理；重复请求幂等。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  release(context: CommandContext, ticketId: Id, request: ReleaseRequest): Promise<TicketView>;
  /** 取消申请；若已有资源必须统一回收。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  cancel(context: CommandContext, ticketId: Id, request: CancelRequest): Promise<TicketView>;
  /** 限定范围的管理员撤销；版本或 generation 冲突拒绝，不能冒充消费者归还。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  revoke(context: CommandContext, ticketId: Id, request: RevokeRequest): Promise<TicketView>;
  /** 检查 owner 和当前有效已接用租约，再签发短期访问材料；响应 no-store。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getAccess(context: CommandContext, ticketId: Id, request: {
    /** 分配身份代次，续租和归还不递增。 */
    readonly generation: number;
  }): Promise<AccessGrant>;
}

/** 控制端物理资产用例；返回内部模型，仅暴露给经过授权的管理路由。 */
export interface MachineService {
  /**
   * 读取最新物理宿主观测，GUI据此展示来源、启动ID和新鲜度。
   * @param context 可信管理读取上下文。
   * @param machineId 目标物理机器。
   * @returns 未收到host观测时为null，不解释为无人。
   */
  getSnapshot(context: QueryContext, machineId: Id): Promise<MachineSnapshot | null>;
  /** 返回经过当前调用者范围校验的对象；不存在或不可见统一映射 404。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param machineId 所属物理机器的稳定标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  get(context: QueryContext, machineId: Id): Promise<Machine>;
  /** 按 expectedVersion 修改准入；状态更新写审计，不隐式停止现有租约。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param machineId 所属物理机器的稳定标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  setAdmission(context: CommandContext, machineId: Id, request: AdmissionRequest): Promise<Machine>;
}

/** 控制端节点用例；probe 是持久异步动作，不在 HTTP 事务内等待外部执行。 */
export interface NodeService {
  /** 返回经过当前调用者范围校验的对象；不存在或不可见统一映射 404。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param nodeId 实际调度节点标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  get(context: QueryContext, nodeId: Id): Promise<Node>;
  /** 持久化并安排能力探测；外部调用在数据库事务之外执行。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param nodeId 实际调度节点标识。
   * @returns 已持久化的异步操作，尚不代表外部动作完成。 */
  probe(context: CommandContext, nodeId: Id): Promise<Operation>;
  /** 按 expectedVersion 修改准入；状态更新写审计，不隐式停止现有租约。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param nodeId 实际调度节点标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  setAdmission(context: CommandContext, nodeId: Id, request: AdmissionRequest): Promise<Node>;
}

/** 控制端连接发现、验证与激活用例，三步的身份边界不可合并跳过。 */
export interface ProviderConnectionService {
  /** 先创建只读发现 Operation，认证成功后登记运行时身份/连接/首修订；失败不生成假身份。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 已持久化的异步操作，尚不代表外部动作完成。 */
  register(context: CommandContext, request: RuntimeDiscoveryTarget): Promise<Operation>;
  /** 返回经过当前调用者范围校验的对象；不存在或不可见统一映射 404。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param connectionId 目标对象的稳定标识，仍须校验访问范围。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  get(context: QueryContext, connectionId: Id): Promise<ProviderConnection>;
  /** 持久化同运行时连接提案，认证通过后才创建不可变修订；异步返回 Operation。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param connectionId 目标对象的稳定标识，仍须校验访问范围。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 已持久化的异步操作，尚不代表外部动作完成。 */
  verifyAndCreateRevision(context: CommandContext, connectionId: Id, request: VerifyConnectionRevisionRequest): Promise<Operation>;
  /** 按连接范围读取已验证修订，不返回秘密值。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param connectionId 目标对象的稳定标识，仍须校验访问范围。
   * @param revisionId 目标不可变修订的标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getRevision(context: QueryContext, connectionId: Id, revisionId: Id): Promise<ProviderConnectionRevision>;
  /** 读取修订自带认证证据并核对同一运行时，以 expectedVersion CAS 激活；不要求调用方再传 evidenceId。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param connectionId 目标对象的稳定标识，仍须校验访问范围。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  activateRevision(context: CommandContext, connectionId: Id, request: ActivateConnectionRevisionRequest): Promise<ProviderConnection>;
}

/** 管理员镜像与验证用例，和消费者只读 ImageCatalogClient 分开。 */
export interface ImageService {
  /** 读取镜像版本；内部管理视图不得整体作为消费者响应。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param imageVersionId 所属不可变镜像版本。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getVersion(context: QueryContext, imageVersionId: Id): Promise<ImageVersion>;
  /** 返回管理员可见的制品记录，包含敏感位置引用。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param imageVersionId 所属不可变镜像版本。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getArtifacts(context: QueryContext, imageVersionId: Id): Promise<readonly ImageArtifact[]>;
  /** 创建管理员限时验证运行；已产生资源的失败路径必须回收。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param imageVersionId 所属不可变镜像版本。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  validate(context: CommandContext, imageVersionId: Id, request: ImageValidationRequest): Promise<ImageValidationRun>;
  /** 按全局唯一 validationId 查询管理员验证运行，避免再重复传 imageVersionId。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param validationId 对应管理员验证运行标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getValidation(context: QueryContext, validationId: Id): Promise<ImageValidationRun>;
  /** 事务中核对报告指纹和清理完成证据后发布；不通过则拒绝。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param imageVersionId 所属不可变镜像版本。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  publish(context: CommandContext, imageVersionId: Id, request: ImageVersionPrecondition): Promise<ImageVersion>;
  /** 阻止新准备并处理未 ready 的引用；已有 ready 需显式撤销。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param imageVersionId 所属不可变镜像版本。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  block(context: CommandContext, imageVersionId: Id, request: ImageBlockRequest): Promise<ImageVersion>;
}

/** 内部授权修订查询与撤销用例；预览无副作用，执行重新评估影响范围。 */
export interface ProfileService {
  /** 读取不可变存储修订；仅管理或内部授权解析可见。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param revisionId 目标不可变修订的标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getStorageRevision(context: QueryContext, revisionId: Id): Promise<StorageProfileRevision>;
  /** 读取不可变网络修订，不能绕过当前强制拒绝基线。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param revisionId 目标不可变修订的标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getNetworkRevision(context: QueryContext, revisionId: Id): Promise<NetworkProfileRevision>;
  /** 计算当前影响范围，无副作用，不作执行锁定。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  previewGrantRevocation(context: QueryContext, request: ProfileGrantRevokeRequest): Promise<RevocationImpact>;
  /** 核对逻辑 Profile 版本并持久撤销，原子创建终止意图，再异步清理。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  revokeGrants(context: CommandContext, request: ProfileGrantRevokeRequest): Promise<ProfileGrantRevocation>;
}

/** 应用用例的可信读取上下文，由鉴权层构造。调用方不能自报角色。 */
export interface QueryContext {
  /** 可信身份，不接受客户端提交。 */
  readonly actor: Actor;
  /** 本次 HTTP 调用的追踪 ID；网络重试可有新 requestId，但复用幂等键。 */
  readonly requestId: Id;
}

/** 持久写入用例的可信上下文，集中承载身份、请求追踪和幂等键。 */
export interface CommandContext extends QueryContext {
  /** 一次逻辑写入的持久键，网络重试复用；不同意图必须换键。 */
  readonly idempotencyKey: string;
}

/** 唯一的实体 CAS 条件。HTTP If-Match 转换成该字段，不另存一份可能冲突的版本。 */
export interface VersionPrecondition {
  /** 执行前必须匹配的实体 CAS 版本。 */
  readonly expectedVersion: number;
}

/** 管理员调整准入的请求。停新单不自动撤销已有有效租约。 */
export interface AdmissionRequest extends VersionPrecondition {
  /** 是否接受新增分配；不默认撤销已有租约。 */
  readonly admission: Machine['admission'];
  /** 非空、可审计的操作原因。 */
  readonly reason: string;
}

/** 同运行时连接修订提案；异步验证成功后才可持久化不可变修订。 */
export interface VerifyConnectionRevisionRequest extends VersionPrecondition {
  /** 受控管理地址或 Agent 引用，不含内联秘密。 */
  readonly endpointRef: string;
  /** 管理平台中的环境定位 ID；不能代替原生身份。 */
  readonly providerEndpointId: string;
  /** 固定秘密版本引用；null 表示该连接无需额外凭据。 */
  readonly credentialVersionRef: Id | null;
}

/** 激活已验证修订的请求；服务内部读取其认证证据，客户端不重复提交证据 ID。 */
export interface ActivateConnectionRevisionRequest extends VersionPrecondition {
  /** 目标不可变修订的标识。 */
  readonly revisionId: Id;
}

/** 镜像修改的实体 CAS 条件，明确区别于字符串版本名。 */
export interface ImageVersionPrecondition {
  /** 此前读取的镜像实体 CAS 版本，修改时必须匹配。 */
  readonly expectedEntityVersion: number;
}

/** 管理员阻止镜像继续使用的请求，包含版本前提与审计理由。 */
export interface ImageBlockRequest extends ImageVersionPrecondition {
  /** 非空、可审计的操作原因。 */
  readonly reason: string;
}
