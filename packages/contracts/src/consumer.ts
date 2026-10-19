/**
 * 计算资源服务接口设计 v1.3（尚非运行实现）。
 * 公开 DTO、消费者 SDK 与管理请求类型。所有公开响应显式列字段，禁止展开内部实体；本文件不实现 HTTP 或调度。
 * 所有 number 均须验证有限值；整数/范围/跨字段不变量由运行时 schema 与事务共同保障。
 * 可选字段省略表示使用明确默认；null 表示明确不存在/尚未取得，不互相替换。
 */
import type {
  Architecture,
  CleanupStatus,
  CursorPage,
  HostOs,
  Id,
  EventCursor,
  JsonValue,
  ImageVersionStatus,
  LeaseState,
  Locality,
  NonEmptyReadonlyArray,
  PageQuery,
  ProviderKind,
  RequestedResources,
  RequiredCapability,
  ResourceAmounts,
  ResourceContract,
  ResourceKind,
  Sha256,
  TerminalReason,
  TicketState,
  UtcTimestamp,
} from "./common.js";

/** 对外资源事件信封；payload经过授权和脱敏，禁止放入秘密或原始Provider输出。 */
export interface ResourceEvent {
  /** SQLite事件ID的十进制字符串，同时作为SSE id。 */
  readonly id: EventCursor;
  /** 领域对象类型；读方忽略未知的新增事件类型。 */
  readonly aggregateType: string;
  /** 关联领域对象的稳定ID。 */
  readonly aggregateId: Id;
  /** 事件对应的实体版本，用于丢弃过时刷新提示。 */
  readonly aggregateVersion: number;
  /** 稳定事件名。 */
  readonly eventType: string;
  /** 事件和状态同事务提交的时间。 */
  readonly occurredAt: UtcTimestamp;
  /** 仅用于展示或提示重新读取权威快照的安全载荷。 */
  readonly payload: JsonValue;
}

/** 事件补读查询；分页游标只能来自此前事件ID或服务端nextCursor。 */
export interface EventQuery {
  /** 只读取该ID之后的事件；省略从当前保留窗口开始。 */
  readonly after?: EventCursor;
  /** 默认50，最大200。 */
  readonly limit?: number;
  /** 可选限制到一张有权查看的Ticket。 */
  readonly ticketId?: Id;
}

/** Authenticated browser/API identity summary; never includes credential material. */
export interface AuthenticatedPrincipal {
  /** Consumer identity UUID; safe to expose for UI ownership partitioning. */
  readonly consumerId: Id;
  readonly role: "viewer" | "consumer" | "operator" | "admin";
  readonly scopes: readonly string[];
  readonly source: "bearer" | "session";
}

/** 精确版本只填 versionId；按别名选择填 imageId+alias。服务端受理时固定实际版本。 */
export type ImageSelector =
  | {
      /** 要固定的镜像版本全局标识；精确选择不再重复填写 imageId。 */
      readonly versionId: Id;
      /** 此选择分支禁止同时提供该字段。 */
      readonly imageId?: never;
      /** 此选择分支禁止同时提供该字段。 */
      readonly alias?: never;
    }
  | {
      /** 逻辑镜像目录标识。 */
      readonly imageId: Id;
      /** 逻辑镜像中的可变别名，受理时解析为不可变版本。 */
      readonly alias: string;
      /** 此选择分支禁止同时提供该字段。 */
      readonly versionId?: never;
    };

/** 内部验证运行的管理员输入；目标制品必须属于路径指定的镜像版本。 */
export interface ImageValidationRequest {
  /** 本次固定使用的镜像制品标识。 */
  readonly imageArtifactId: Id;
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 已授权网络逻辑配置标识。 */
  readonly networkProfileId: Id;
  /** 挂载授权请求或冻结授权集合；不含任意 mount 参数。 */
  readonly storage: readonly StorageRequest[];
  /** 资源数量或已经归一化的合同，依所属类型区分。 */
  readonly resources: ResourceContract;
  /** 验证运行总时限，单位秒，受管理策略上限限制。 */
  readonly deadlineSeconds: number; // 受管理员验证策略上限约束，不得无限运行。
}

/** 显式撤销某授权修订的管理请求。版本条件检查逻辑 Profile，影响范围在执行事务重新查询。 */
export interface ProfileGrantRevokeRequest {
  /** 被操作授权的逻辑种类。 */
  readonly profileKind: "storage" | "network";
  /** 被明确撤销的不可变修订标识。 */
  readonly profileRevisionId: Id;
  /** 非空、可审计的操作原因。 */
  readonly reason: string;
  /** 逻辑 Profile 的 CAS 版本；不是不可变修订号。 */
  readonly expectedProfileVersion: number; // 逻辑 profile 的 CAS 版本，revisionId 已固定不可变修订。
}

/** 消费者从授权配置中选择相对子路径、容器内挂载点和读写模式。 */
export interface StorageRequest {
  /** 已授权存储逻辑配置标识。 */
  readonly storageProfileId: Id;
  /** 经过授权与规范化的相对子路径。 */
  readonly authorizedSubpath: string;
  /** 租客内绝对挂载路径；不是宿主源路径。 */
  readonly mountPath: string;
  /** 实际读写或网络模式。 */
  readonly mode: "read_only" | "read_write";
}

/** 可选租期偏好。省略值使用系统默认并受消费者与镜像上限限制。 */
export interface LeaseRequest {
  /** 请求租约 TTL 秒数，省略默认 900，受政策限制。 */
  readonly requestedSeconds?: number; // 默认 900；最终受消费者政策约束。
  /** 最大总寿命秒数，省略默认 86400。 */
  readonly maximumLifetimeSeconds?: number; // 默认 86400。
  /** 排队时限秒数，省略默认 1800。 */
  readonly queueTimeoutSeconds?: number; // 默认 1800。
  /** 环境准备时限秒数，省略默认 1200。 */
  readonly provisioningTimeoutSeconds?: number; // 默认 1200。
  /** 到期策略引用，省略由服务端选择当前允许策略。 */
  readonly expiryPolicyId?: Id;
}

/** 受理时固定的租期合同；后续调整Consumer配额不改写该票已经接受的上限。 */
export interface AcceptedLeaseRequest extends Required<LeaseRequest> {
  /** 此票每次续租可请求的最大TTL，秒；expiry仍不得超过renewUntil。 */
  readonly maximumTtlSeconds: number;
}

/** 精简的公开申请输入。必填仅镜像、资源数量与网络配置；其余字段由服务端在受理时归一化。 */
export interface AcquireRequest {
  /** 按 versionId 申请精确版本，或 imageId+alias；别名在受理时固定。 */
  readonly image: ImageSelector;
  /** 资源数量或已经归一化的合同，依所属类型区分。 */
  readonly resources: RequestedResources;
  /** 已授权网络逻辑配置标识。 */
  readonly networkProfileId: Id;
  /** 省略默认为 container；请求 VM 必须显式 vm。 */
  readonly kind?: ResourceKind;
  /** 可接受架构；省略表示授权目录中所有兼容架构，显式给值必须非空。 */
  readonly allowedArchitectures?: NonEmptyReadonlyArray<Architecture>;
  /** 可接受后端；省略表示所有已授权兼容后端，显式给值必须非空。 */
  readonly allowedProviders?: NonEmptyReadonlyArray<ProviderKind>;
  /** 放置范围，首版默认且仅允许 local_only。 */
  readonly locality?: Locality;
  /** 允许站点；省略或空数组表示所有已授权本地站点。 */
  readonly siteIds?: readonly string[];
  /** 允许机器集合；省略不附加限制，显式集合必须非空。 */
  readonly allowedMachineIds?: NonEmptyReadonlyArray<Id>;
  /** 允许节点集合；省略不附加限制，显式集合必须非空。 */
  readonly allowedNodeIds?: NonEmptyReadonlyArray<Id>;
  /** 节点必须匹配的标签，不是任意业务指令。 */
  readonly requiredLabels?: Readonly<Record<string, string>>;
  /** 必须满足的已验证能力；省略或空数组无附加要求。 */
  readonly requiredCapabilities?: readonly RequiredCapability[];
  /** 省略或空数组表示不挂持久存储。 */
  readonly storage?: readonly StorageRequest[];
  /** 省略默认为 ssh；其他协议须镜像和节点均支持。 */
  readonly access?: AccessRequest;
  /** 省略时使用默认租期，受理后固定最终值。 */
  readonly lease?: LeaseRequest;
  /** 消费者关联元数据；默认空对象，不影响调度业务逻辑。 */
  readonly labels?: Readonly<Record<string, string>>;
  /** 消费者自己的不透明关联标识，省略表示不关联外部任务。 */
  readonly clientRef?: string;
}

/** 公开详情白名单。独立于内部 Ticket，不因内部新增字段而自动扩大响应。 */
export interface TicketView extends TicketSummary {
  /** 服务端固定的完整安全请求，不含内部真实源或秘密引用。 */
  readonly acceptedRequest: AcceptedAcquireRequest;
  /** 对消费者公开的固定授权修订摘要。 */
  readonly pinnedProfileRevisions: {
    /** 固定网络允许规则修订标识。 */
    readonly networkProfileRevisionId: Id;
    /** 本次固定的存储修订集合。 */
    readonly storageProfileRevisionIds: readonly Id[];
  };
  /** 排队最晚截止。 */
  readonly queueDeadline: UtcTimestamp;
  /** 预留后环境准备截止；尚未预留时为 null。 */
  readonly provisioningDeadline: UtcTimestamp | null;
  /** 租约偏好或已确认租约快照，依所属类型区分。 */
  readonly lease: LeaseView | null;
  /** 已选定的实际放置结果；尚未分配时为 null。 */
  readonly placement: TicketPlacementView | null;
  /** 最近技术健康结果，不表示业务成败。 */
  readonly health: TicketHealthView;
  /** 排队与候选解释，不构成预留承诺。 */
  readonly scheduling: SchedulingView;
  /** 未决续租摘要；无待决提案时为 null。 */
  readonly renewalPending: PendingRenewalView | null;
  /** 仍阻止回收完成的资源安全摘要。 */
  readonly cleanupBlockedResources: readonly CleanupBlockerView[];
}

/** 低层 HTTP 续租输入；必须提交本次资源 generation 与读取到的 Lease 版本。 */
export interface RenewRequest {
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 读取到的 Lease CAS 版本，不能由客户端猜测。 */
  readonly expectedLeaseVersion: number;
  /** 请求新 TTL 秒数，省略使用已接受默认。 */
  readonly requestedTtlSec?: number;
}

/** 已确认的不可变续租回执，只有该截止可用于继续使用环境。 */
export interface RenewReceipt {
  /** 可由 owner 查询的持久续租记录标识。 */
  readonly renewalId: Id;
  /** 关联租客 Ticket 标识。 */
  readonly ticketId: Id;
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 关联消费者租约标识。 */
  readonly leaseId: Id;
  /** 守卫/回执对应的租约版本；候选场景指拟提交版本。 */
  readonly leaseVersion: number;
  /** 首次成功接用时间；可为空的字段表示尚未接用。 */
  readonly claimedAt: UtcTimestamp;
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp;
  /** 不可跨越的总寿命截止。 */
  readonly renewUntil: UtcTimestamp;
  /** 是否已经得到执行端离线截止确认。 */
  readonly offlineEnforcement: "confirmed" | "not_guaranteed";
  /** 对应守卫 ACK；不保证离线执行时为 null。 */
  readonly guardAcknowledgementId: Id | null;
}

/** owner 可读取的续租结果白名单。按 state 分支即可安全取得确认回执。 */
export type LeaseRenewalView = RenewalDecision & {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 关联消费者租约标识。 */
  readonly leaseId: Id;
  /** 拟提交 Lease 版本，必须等于 expectedVersion+1。 */
  readonly proposedVersion: number;
  /** 候选截止，未确认前不得用它继续使用环境。 */
  readonly proposedExpiresAt: UtcTimestamp;
  /** 是否为首次接用续租。 */
  readonly isInitialClaim: boolean;
  /** 提案裁决截止，受理和最终确认都必须严格早于它。 */
  readonly decisionDeadline: UtcTimestamp;
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
  /** 最近持久状态更新时间。 */
  readonly updatedAt: UtcTimestamp;
};

/** 低层 HTTP 续租结果。confirmed/pending/rejected 分别映射 200/202/409。 */
export type RenewOutcome =
  | {
      /** 执行或续租结果判别值，先判断再读取相应字段。 */
      readonly outcome: "confirmed";
      /** 可由 owner 查询的持久续租记录标识。 */
      readonly renewalId: Id;
      /** 已确认的续租回执。 */
      readonly receipt: RenewReceipt;
    }
  | {
      /** 执行或续租结果判别值，先判断再读取相应字段。 */
      readonly outcome: "pending";
      /** 本次持久续租的公开状态。 */
      readonly renewal: LeaseRenewalView & {
        /** 该对象的领域状态；按判别值读取对应字段。 */
        readonly state: "pending";
      };
      /** 续租恢复资源的相对 API 路径，不包含认证秘密。 */
      readonly location: string;
      /** 最后确认有效的租约截止，不使用候选期限替换。 */
      readonly lastConfirmedExpiresAt: UtcTimestamp;
    }
  | {
      /** 执行或续租结果判别值，先判断再读取相应字段。 */
      readonly outcome: "rejected";
      /** 本次持久续租的公开状态。 */
      readonly renewal: LeaseRenewalView & {
        /** 该对象的领域状态；按判别值读取对应字段。 */
        readonly state: "rejected" | "cancelled";
      };
      /** 终止/拒绝的稳定原因码；成功或待决按类型约束为 null。 */
      readonly reasonCode: string;
    };

/** 明确允许删除本次临时环境的归还请求；reclaimable 不能默认为 true。 */
export interface ReleaseRequest {
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 消费者明确确认临时环境可删；必须字面量 true。 */
  readonly reclaimable: true;
}

/** operator/admin 的主动撤销输入，必须校验对象范围、版本与理由。 */
export interface RevokeRequest {
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number | null; // queued 尚无 Allocation 时必须 null，其余要求当前 generation。
  /** 调用方读取到的 Ticket CAS 版本。 */
  readonly expectedTicketVersion: number;
  /** 非空、可审计的操作原因。 */
  readonly reason: string;
}

/** 敏感的短期访问响应，仅从显式领取接口返回；禁止缓存、记录日志或进入事件。 */
export interface AccessGrant {
  /** 关联租客 Ticket 标识。 */
  readonly ticketId: Id;
  /** 关联消费者租约标识。 */
  readonly leaseId: Id;
  /** 守卫/回执对应的租约版本；候选场景指拟提交版本。 */
  readonly leaseVersion: number;
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 敏感入口领取命令或连接参数，依所属结构区分。 */
  readonly access: ConsumerAccessEndpoint;
  /** 敏感认证材料的判别联合；只经 no-store 领取响应返回。 */
  readonly authentication:
    | {
        /** 对象或请求的判别种类。 */
        readonly kind: "client_public_key";
        /** 本次获准公钥的指纹。 */
        readonly publicKeyFingerprint: string;
      }
    | {
        /** 对象或请求的判别种类。 */
        readonly kind: "ssh_certificate";
        /** 短期 SSH 证书，只能经敏感领取响应返回。 */
        readonly certificate: string;
      }
    | {
        /** 对象或请求的判别种类。 */
        readonly kind: "ephemeral_private_key";
        /** 本次独立短期私钥，不得持久写入普通日志。 */
        readonly privateKey: string;
      }
    | {
        /** 对象或请求的判别种类。 */
        readonly kind: "ephemeral_password";
        /** 本次独立短期密码，不得进入事件或列表。 */
        readonly password: string;
      };
}

/** 取消申请；尚未分配可直接终止，已产生资源必须走统一回收。 */
export interface CancelRequest {
  /** 非空、可审计的操作原因。 */
  readonly reason?: string;
}

/** 申请的技术连接方式；平台只负责交付入口，不接收业务 shell 命令。 */
export interface AccessRequest {
  /** 传输协议或连接协议的判别值。 */
  readonly protocol: "ssh" | "rdp";
  /** 租客本次使用的公钥，省略时按已验证镜像入口策略签发独立材料。 */
  readonly clientPublicKey?: string;
}

/** 安全、完整的已接受请求。已解析别名与默认值，可返回消费者；不含真实源路径或秘密引用。 */
export interface AcceptedAcquireRequest {
  /** 镜像选择器；别名只在受理时解析一次。 */
  readonly image: {
    /** 要固定的镜像版本全局标识；精确选择不再重复填写 imageId。 */
    readonly versionId: Id;
  };
  /** 资源数量或已经归一化的合同，依所属类型区分。 */
  readonly resources: ResourceContract;
  /** 已授权网络逻辑配置标识。 */
  readonly networkProfileId: Id;
  /** 对象或请求的判别种类。 */
  readonly kind: ResourceKind;
  /** 可接受架构；省略表示授权目录中所有兼容架构，显式给值必须非空。 */
  readonly allowedArchitectures: NonEmptyReadonlyArray<Architecture>;
  /** 可接受后端；省略表示所有已授权兼容后端，显式给值必须非空。 */
  readonly allowedProviders: NonEmptyReadonlyArray<ProviderKind>;
  /** 放置范围，首版默认且仅允许 local_only。 */
  readonly locality: Locality;
  /** 允许站点；省略或空数组表示所有已授权本地站点。 */
  readonly siteIds: readonly string[];
  /** 允许机器集合；省略不附加限制，显式集合必须非空。 */
  readonly allowedMachineIds?: NonEmptyReadonlyArray<Id>;
  /** 受理时已与Consumer节点授权取交集；省略表示当时明确授权all，不重读后续放宽的配置。 */
  readonly allowedNodeIds?: NonEmptyReadonlyArray<Id>;
  /** 节点必须匹配的标签，不是任意业务指令。 */
  readonly requiredLabels: Readonly<Record<string, string>>;
  /** 必须满足的已验证能力；省略或空数组无附加要求。 */
  readonly requiredCapabilities: readonly RequiredCapability[];
  /** 挂载授权请求或冻结授权集合；不含任意 mount 参数。 */
  readonly storage: readonly StorageRequest[];
  /** 敏感入口领取命令或连接参数，依所属结构区分。 */
  readonly access: AccessRequest;
  /** 租约偏好或已确认租约快照，依所属类型区分。 */
  readonly lease: AcceptedLeaseRequest;
  /** 消费者关联元数据；默认空对象，不影响调度业务逻辑。 */
  readonly labels: Readonly<Record<string, string>>;
  /** 消费者自己的不透明关联标识，省略表示不关联外部任务。 */
  readonly clientRef?: string;
}

/** 公开租约快照；有效性仍由控制端的状态和时间裁决。 */
export interface LeaseView {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 当前租约 CAS 版本，与 Ticket.version 独立。 */
  readonly version: number;
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: LeaseState;
  /** 首次接用截止；准备阶段可为 null。 */
  readonly claimBy: UtcTimestamp | null;
  /** 首次成功接用时间；可为空的字段表示尚未接用。 */
  readonly claimedAt: UtcTimestamp | null;
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp | null;
  /** 不可跨越的总寿命截止。 */
  readonly renewUntil: UtcTimestamp | null;
  /** 撤销正式提交时间；未撤销为 null。 */
  readonly revokedAt: UtcTimestamp | null;
}

/** 已经激活且期限完整的租约视图；claimedAt 为 null 时尚未接用。 */
export interface ActiveLeaseView extends LeaseView {
  /** 字面量 active，供 SDK 类型收窄。 */
  readonly state: "active";
  /** 首次接用截止；准备阶段可为 null。 */
  readonly claimBy: UtcTimestamp;
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp;
  /** 不可跨越的总寿命截止。 */
  readonly renewUntil: UtcTimestamp;
}

/** 公开放置结果；不包含连接地址、后端管理凭据或宿主路径。 */
export interface TicketPlacementView {
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: ProviderKind;
  /** CPU 架构；必须与实际执行环境匹配。 */
  readonly architecture: Architecture;
  /** 本次固定使用的镜像制品标识。 */
  readonly imageArtifactId: Id;
}

/** 最近一次技术健康结果；不代表业务执行成功。 */
export interface TicketHealthView {
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: "unknown" | "preparing" | "healthy" | "degraded" | "lost";
  /** 事实在执行端被观测的时间。 */
  readonly observedAt: UtcTimestamp | null;
  /** 可稳定匹配的原因码列表，显示文本由界面转换。 */
  readonly reasonCodes: readonly string[];
}

/** 等待原因和下一次检查提示；可匹配数量不构成容量预留承诺。 */
export interface SchedulingView {
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp | null;
  /** 可稳定匹配的原因码列表，显示文本由界面转换。 */
  readonly reasonCodes: readonly string[];
  /** 当次解释中匹配节点数，不代表已预留容量。 */
  readonly matchingNodeCount: number;
  /** 计划再次检查或执行的时间，不是成功承诺。 */
  readonly nextCheckAt: UtcTimestamp | null;
}

/** 续租未决摘要。候选截止不可当成已获得的期限。 */
export interface PendingRenewalView {
  /** 可由 owner 查询的持久续租记录标识。 */
  readonly renewalId: Id;
  /** 拟提交租约版本，未确认前不是当前版本。 */
  readonly proposedLeaseVersion: number;
  /** 候选截止，未确认前不得用它继续使用环境。 */
  readonly proposedExpiresAt: UtcTimestamp;
  /** 最后确认有效的租约截止，不使用候选期限替换。 */
  readonly lastConfirmedExpiresAt: UtcTimestamp;
  /** 提案裁决截止，受理和最终确认都必须严格早于它。 */
  readonly decisionDeadline: UtcTimestamp;
}

/** 当前未清理对象的安全摘要，用于解释为何仍占容量。 */
export interface CleanupBlockerView {
  /** 需要继续处理的资源清单记录。 */
  readonly managedResourceId: Id;
  /** 对象或请求的判别种类。 */
  readonly kind: string;
  /** 可稳定匹配的原因码列表，显示文本由界面转换。 */
  readonly reasonCodes: readonly string[];
  /** 保留对象的截止；null 表示没有定时释放承诺。 */
  readonly retainUntil: UtcTimestamp | null;
  /** 计划再次检查或执行的时间，不是成功承诺。 */
  readonly nextCheckAt: UtcTimestamp | null;
}

/** 列表使用的轻量公开摘要；不携带访问材料、内部快照或完整运行日志。 */
export interface TicketSummary {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 所属消费者标识；必须再次核对调用者范围。 */
  readonly consumerId: Id;
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: TicketState;
  /** 当前实体 CAS 版本；写入必须匹配旧版本后递增。 */
  readonly version: number;
  /** 受理时固定的镜像版本标识。 */
  readonly pinnedImageVersionId: Id;
  /** 第一次终止原因；未开始终止时为 null。 */
  readonly terminalReason: TerminalReason | null;
  /** 资源清理状态；blocked 时继续计占用。 */
  readonly cleanupStatus: CleanupStatus;
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
  /** 最近持久状态更新时间。 */
  readonly updatedAt: UtcTimestamp;
  /** 技术就绪正式提交时间，尚未就绪时为 null。 */
  readonly readyAt: UtcTimestamp | null;
  /** 最终清理提交时间，尚未释放时为 null。 */
  readonly releasedAt: UtcTimestamp | null;
}

/** waitUntilReady 的精确返回类型，保证已激活租约和放置结果存在。 */
export interface ReadyTicketView extends TicketView {
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: "ready";
  /** 租约偏好或已确认租约快照，依所属类型区分。 */
  readonly lease: ActiveLeaseView;
  /** 已选定的实际放置结果；尚未分配时为 null。 */
  readonly placement: TicketPlacementView;
}

/** waitUntilReleased 的精确返回类型，保证终止原因、释放时间和清理完成条件。 */
export interface ReleasedTicketView extends TicketView {
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: "released";
  /** 第一次终止原因；未开始终止时为 null。 */
  readonly terminalReason: TerminalReason;
  /** 资源清理状态；blocked 时继续计占用。 */
  readonly cleanupStatus: "complete" | "not_needed";
  /** 最终清理提交时间，尚未释放时为 null。 */
  readonly releasedAt: UtcTimestamp;
}

/** 续租裁决判别联合。confirmed 必有回执，其他状态不能携带有效回执。 */
export type RenewalDecision =
  | {
      /** pending/confirmed/rejected/cancelled 决定回执和原因字段是否存在。 */
      readonly state: "pending";
      /** 终止/拒绝的稳定原因码；成功或待决按类型约束为 null。 */
      readonly reasonCode: null;
      /** 仅 confirmed 分支存在的有效回执。 */
      readonly confirmedReceipt: null;
    }
  | {
      /** pending/confirmed/rejected/cancelled 决定回执和原因字段是否存在。 */
      readonly state: "confirmed";
      /** 终止/拒绝的稳定原因码；成功或待决按类型约束为 null。 */
      readonly reasonCode: null;
      /** 仅 confirmed 分支存在的有效回执。 */
      readonly confirmedReceipt: RenewReceipt;
    }
  | {
      /** pending/confirmed/rejected/cancelled 决定回执和原因字段是否存在。 */
      readonly state: "rejected" | "cancelled";
      /** 终止/拒绝的稳定原因码；成功或待决按类型约束为 null。 */
      readonly reasonCode: string;
      /** 仅 confirmed 分支存在的有效回执。 */
      readonly confirmedReceipt: null;
    };

/** 消费者真正需要的连接信息；排除资源管理引用、秘密定位符和内部探针详情。 */
export interface ConsumerAccessEndpoint {
  /** 传输协议或连接协议的判别值。 */
  readonly protocol: "ssh" | "rdp";
  /** 消费者可达的地址，不是后端管理入口。 */
  readonly host: string;
  /** 技术入口端口，整数 1–65535。 */
  readonly port: number;
  /** 本次独立租客身份名。 */
  readonly username: string;
  /** SSH 主机身份指纹；不适用协议为 null。 */
  readonly hostKeyFingerprint: string | null;
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp;
}

/** Ticket 公开列表过滤与游标。owner 范围由身份决定，不接受伪造 consumerId。 */
export interface TicketListQuery extends PageQuery {
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase?: TicketState;
}

/** SDK 写入选项。可传持久幂等键恢复调用；省略时 SDK 为本次逻辑调用生成一次并在网络重试复用。 */
export interface ClientWriteOptions {
  /** 一次逻辑写入的持久键，网络重试复用；不同意图必须换键。 */
  readonly idempotencyKey?: string;
  /** 第一次网络发送前等待此回调成功。需要跨进程恢复时在这里持久化不可变请求；回调失败不发送。 */
  readonly onPrepared?: (command: PreparedTicketCommand) => Promise<void>;
}

/** SDK 等待选项；超时/取消只停止本地等待，不自动取消 Ticket 或归还环境。 */
export interface WaitOptions {
  /** 仅限制本地等待。waitUntilReady默认60分钟、waitUntilReleased默认5分钟；整数1–86400000毫秒。 */
  readonly timeoutMilliseconds?: number;
  /** SDK 轮询前检查的协作取消函数，例如 () => signal.aborted。 */
  readonly isCancelled?: () => boolean;
}

/** SDK 申请回执，暴露实际幂等键，便于保存后在进程重启时恢复申请。 */
export interface AcquireReceipt {
  /** 受理后的当前 Ticket 视图。 */
  readonly ticket: TicketView;
  /** 一次逻辑写入的持久键，网络重试复用；不同意图必须换键。 */
  readonly idempotencyKey: string;
}

/** SDK 续租偏好；generation 和 expectedLeaseVersion 由 SDK 从当前票据读取。 */
export interface ClientRenewRequest {
  /** 请求新 TTL 秒数，省略使用已接受默认。 */
  readonly requestedTtlSec?: number;
}

/** SDK 的结构化错误接口。未知结果附恢复引用，不把超时当作服务端未执行。 */
export interface ComputeClientError extends Error {
  /** 稳定错误码，供程序进行分支处理。 */
  readonly code: string;
  /** 本次 HTTP 调用的追踪 ID；网络重试可有新 requestId，但复用幂等键。 */
  readonly requestId: Id | null;
  /** 仅说明是否适合按恢复引用重试，禁止自动生成新幂等键重复申请。 */
  readonly retryable: boolean;
  /** 未知结果的安全恢复引用；用同幂等键重试或查询已有记录。 */
  readonly recovery: {
    /** SDK 已准备请求；null 表示不是可恢复写入或尚未生成请求。 */
    readonly command: PreparedTicketCommand | null;
    /** 关联租客 Ticket 标识。 */
    readonly ticketId: Id | null;
    /** 可由 owner 查询的持久续租记录标识。 */
    readonly renewalId: Id | null;
    /** 一次逻辑写入的持久键，网络重试复用；不同意图必须换键。 */
    readonly idempotencyKey: string | null;
  };
}

/** 已绑定消费者认证的 SDK。隐藏 Actor、服务端追踪与手工 CAS；不自动执行业务或销毁环境。 */
export interface TicketClient {
  /** 校验恢复结构版本后原样重放已准备请求，不重读 generation/Lease.version，不更换幂等键；续租只查询或等待原提案。
   * @param command 原始受控命令，包含身份、截止与幂等参数。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  resume<C extends PreparedTicketCommand>(
    command: C,
  ): Promise<TicketCommandResult<C>>;
  /** 提交精简申请，返回 Ticket 与实际幂等键。网络重试复用同键，未知结果抛带恢复引用的 ComputeClientError。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  acquire(
    request: AcquireRequest,
    options?: ClientWriteOptions,
  ): Promise<AcquireReceipt>;
  /** 返回经过当前调用者范围校验的对象；不存在或不可见统一映射 404。
   * @param ticketId 关联租客 Ticket 标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  get(ticketId: Id): Promise<TicketView>;
  /** 按当前身份过滤并返回游标页；默认 50，最多 200。
   * @param query 经过校验的过滤/分页条件。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  list(query?: TicketListQuery): Promise<CursorPage<TicketSummary>>;
  /** 通过事件提示和有界轮询等待技术 ready；Ticket 先终止则抛 TICKET_TERMINATED，超时/取消仅停止本地等待。
   * @param ticketId 关联租客 Ticket 标识。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  waitUntilReady(ticketId: Id, options?: WaitOptions): Promise<ReadyTicketView>;
  /** 首次接用：新命令要求尚未接用；相同幂等命令重放返回原确认结果。读取并冻结版本，等待原提案确认。
   * @param ticketId 关联租客 Ticket 标识。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  claim(ticketId: Id, options?: ClientWriteOptions): Promise<RenewReceipt>;
  /** 读取当前 generation/Lease.version，提交一次续租并等待 confirmed。202 仅轮询原提案；版本冲突不自动基于新版本另提案。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  renew(
    ticketId: Id,
    request?: ClientRenewRequest,
    options?: ClientWriteOptions,
  ): Promise<RenewReceipt>;
  /** 恢复指定续租记录；超出保留期可能 404，不能由此推断延期成功。
   * @param ticketId 关联租客 Ticket 标识。
   * @param renewalId 可由 owner 查询的持久续租记录标识。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getRenewal(ticketId: Id, renewalId: Id): Promise<LeaseRenewalView>;
  /** 确认当前 Lease 已接用后领取短期访问材料；SDK 不记录或缓存材料。
   * @param ticketId 关联租客 Ticket 标识。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getAccess(ticketId: Id, options?: ClientWriteOptions): Promise<AccessGrant>;
  /** 显式归还临时环境，reclaimable=true 必填。读取当前 generation；返回 releasing 不代表容量已经释放。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  release(
    ticketId: Id,
    request: {
      /** 消费者明确确认临时环境可删；必须字面量 true。 */
      readonly reclaimable: true;
    },
    options?: ClientWriteOptions,
  ): Promise<TicketView>;
  /** 取消申请并触发必要回收；省略请求相当于未提供可选理由。
   * @param ticketId 关联租客 Ticket 标识。
   * @param request 经过边界 schema 校验的输入；权限与跨表不变量仍在用例中检查。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  cancel(
    ticketId: Id,
    request?: CancelRequest,
    options?: ClientWriteOptions,
  ): Promise<TicketView>;
  /** 等待服务端 confirmed cleanup 完成；超时/取消不改变资源状态。
   * @param ticketId 关联租客 Ticket 标识。
   * @param options 本次调用选项；省略时使用文档默认。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  waitUntilReleased(
    ticketId: Id,
    options?: WaitOptions,
  ): Promise<ReleasedTicketView>;
}

/** 消费者可见的镜像逻辑目录摘要。 */
export interface ImageSummary {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 供人查看的名称；不能代替稳定标识。 */
  readonly name: string;
  /** 可显示的用途说明，不参与调度业务分支。 */
  readonly description: string;
}

/** 消费者可见的制品能力白名单，排除下载位置和 registry 秘密引用。 */
export interface ImageArtifactView {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: ProviderKind;
  /** 对象或请求的判别种类。 */
  readonly kind: ResourceKind;
  /** CPU 架构；必须与实际执行环境匹配。 */
  readonly architecture: Architecture;
  /** 镜像客体操作系统族。 */
  readonly guestOs: HostOs;
  /** 不可变内容摘要，不能仅使用可变标签。 */
  readonly digest: Sha256;
  /** 镜像支持并经过验证的连接协议。 */
  readonly accessProtocols: readonly ("ssh" | "rdp")[];
}

/** 消费者可申请镜像版本的公开信息；内部版本记录新增字段不会自动进入响应。 */
export interface ImageVersionView {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 逻辑镜像目录标识。 */
  readonly imageId: Id;
  /** 消费者可见的不可变镜像版本名。 */
  readonly version: string;
  /** 记录当前可用状态；不同状态的准入行为见对应领域合同。 */
  readonly status: ImageVersionStatus;
  /** 可启动该镜像的最低资源。 */
  readonly minimumResources: ResourceAmounts;
  /** 可公开的制品能力摘要。 */
  readonly artifacts: readonly ImageArtifactView[];
}

/** 已鉴权消费者的只读镜像目录，不能发布或修改镜像。 */
export interface ImageCatalogClient {
  /** 按当前身份过滤并返回游标页；默认 50，最多 200。
   * @param query 经过校验的过滤/分页条件。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  list(query?: PageQuery): Promise<CursorPage<ImageSummary>>;
  /** 读取消费者被授权查看的公开镜像版本，不返回制品位置和秘密引用。
   * @param versionId 要固定的镜像版本全局标识；精确选择不再重复填写 imageId。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getVersion(versionId: Id): Promise<ImageVersionView>;
}

/** 消费者 SDK 的简洁入口，按 tickets/images 分组；连接与认证在客户端创建时注入。 */
export interface ComputeClient {
  /** 租用环境的消费者客户端。 */
  readonly tickets: TicketClient;
  /** 只读镜像目录客户端。 */
  readonly images: ImageCatalogClient;
}

/** SDK 写入命令与实际 HTTP 请求体的对应表；恢复时不重读版本或重算参数。 */
export interface TicketCommandRequests {
  /** 验证并归一化请求，在短事务内受理 Ticket；返回不代表已完成资源准备。 */
  readonly acquire: {
    /** 记账预留资源；v1 与 limit 完全相等。 */
    readonly request: AcquireRequest;
  };
  /** 检查 owner、generation、Lease CAS 与截止；返回 confirmed、pending 或 rejected，不把候选期限当承诺。 */
  readonly renew: {
    /** 关联租客 Ticket 标识。 */
    readonly ticketId: Id;
    /** 记账预留资源；v1 与 limit 完全相等。 */
    readonly request: RenewRequest;
  };
  /** 先持久终止授权，再异步清理；重复请求幂等。 */
  readonly release: {
    /** 关联租客 Ticket 标识。 */
    readonly ticketId: Id;
    /** 记账预留资源；v1 与 limit 完全相等。 */
    readonly request: ReleaseRequest;
  };
  /** 取消申请；若已有资源必须统一回收。 */
  readonly cancel: {
    /** 关联租客 Ticket 标识。 */
    readonly ticketId: Id;
    /** 记账预留资源；v1 与 limit 完全相等。 */
    readonly request: CancelRequest;
  };
  /** 敏感入口领取命令或连接参数，依所属结构区分。 */
  readonly access: {
    /** 关联租客 Ticket 标识。 */
    readonly ticketId: Id;
    /** 记账预留资源；v1 与 limit 完全相等。 */
    readonly request: {
      /** 分配身份代次，续租和归还不递增。 */
      readonly generation: number;
    };
  };
}

/** 可持久化的已准备写入请求。保存固定版本、完整请求体及幂等键，不含认证秘密。恢复仍须服务端重新鉴权。 */
export type PreparedTicketCommand = {
  readonly [Kind in keyof TicketCommandRequests]: {
    /** 准备请求的序列化格式版本，当前为 1；未知版本拒绝恢复。 */
    readonly schemaVersion: 1;
    /** 对象或请求的判别种类。 */
    readonly kind: Kind;
    /** 一次逻辑写入的持久键，网络重试复用；不同意图必须换键。 */
    readonly idempotencyKey: string;
  } & TicketCommandRequests[Kind];
}[keyof TicketCommandRequests];

/** 根据原始准备请求推导 resume 返回类型；续租恢复仍等待同一提案确认。 */
export type TicketCommandResult<C extends PreparedTicketCommand> = C extends {
  /** 对象或请求的判别种类。 */
  readonly kind: "acquire";
}
  ? AcquireReceipt
  : C extends {
        /** 对象或请求的判别种类。 */
        readonly kind: "renew";
      }
    ? RenewReceipt
    : C extends {
          /** 对象或请求的判别种类。 */
          readonly kind: "access";
        }
      ? AccessGrant
      : TicketView;
