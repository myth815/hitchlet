/**
 * 计算资源服务接口设计 v1.3（尚非运行实现）。
 * 仅限控制端内部的持久化领域模型。不可把这里的对象直接序列化给消费者；SQLite repo 负责行记录与模型转换。
 * 所有 number 均须验证有限值；整数/范围/跨字段不变量由运行时 schema 与事务共同保障。
 * 可选字段省略表示使用明确默认；null 表示明确不存在/尚未取得，不互相替换。
 */
import type {
  AcceleratorRequirement,
  Architecture,
  CleanupStatus,
  EffectiveResources,
  HostOs,
  Id,
  ImageVersionStatus,
  LeaseState,
  NonEmptyReadonlyArray,
  ObservationMetadata,
  ProviderKind,
  ResourceAmounts,
  ResourceContract,
  ResourceKind,
  ResourcePressure,
  Role,
  Sha256,
  StorageProtocol,
  TerminalReason,
  TicketState,
  UtcTimestamp,
  Verification,
  Versioned,
} from './common';
import type { AcceptedAcquireRequest, RenewalDecision, StorageRequest } from './consumer';

/** 鉴权中间件构造的可信调用身份，仅用于服务内部；不得从请求体反序列化接受。 */
export interface Actor {
  /** 认证主体标识。 */
  readonly principalId: Id;
  /** 所属消费者标识；必须再次核对调用者范围。 */
  readonly consumerId: Id | null;
  /** 已授权角色；仍需结合对象范围。 */
  readonly role: Role;
  /** 细粒度授权范围，由可信认证层提供。 */
  readonly scopes: readonly string[];
}

/** 持久化的人或程序调用主体，包含授权入口和实体版本。停用与撤销存量租约分别处理。 */
export interface Consumer extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 供人查看的名称；不能代替稳定标识。 */
  readonly name: string;
  /** 对象或请求的判别种类。 */
  readonly kind: 'agent' | 'human' | 'service';
  /** 已授权角色；仍需结合对象范围。 */
  readonly role: Role;
  /** 记录当前可用状态；不同状态的准入行为见对应领域合同。 */
  readonly status: 'active' | 'disabled';
  /** 关联平台策略标识；null 表示未单独绑定。 */
  readonly policyId: Id | null;
  /** 明确的目录访问范围；空列表拒绝，all才表示允许当前及未来所有已登记对象。 */
  readonly authorization: ConsumerAuthorization;
  /** 并发、合计资源及租期上限；排队受理和实际预留分别检查。 */
  readonly quota: ConsumerQuota;
}

/** 资源目录授权。只约束新申请；撤销已有使用权必须调用显式revoke。 */
export interface ConsumerAuthorization {
  /** 允许申请的逻辑镜像目录。 */
  readonly imageIds: 'all' | readonly Id[];
  /** 允许放置的节点。 */
  readonly nodeIds: 'all' | readonly Id[];
  /** 允许选择的网络配置。 */
  readonly networkProfileIds: 'all' | readonly Id[];
  /** 允许挂载的存储配置。 */
  readonly storageProfileIds: 'all' | readonly Id[];
}

/** 消费者配额，不是单张票的规格。需使用安全整数并验证正数及资源边界。 */
export interface ConsumerQuota {
  /** 最多同时queued的票据数，正整数。 */
  readonly maxQueuedTickets: number;
  /** reserved到releasing均计入；只有released才归还并发名额。 */
  readonly maxActiveTickets: number;
  /** 该消费者所有未释放tenant Claim的合计上限，基础设施不重复计入。 */
  readonly maxResources: ResourceAmounts;
  /** 单次租约TTL上限，秒。 */
  readonly maxLeaseTtlSeconds: number;
  /** 单张票从首次ready候选起算的总寿命上限，秒。 */
  readonly maxLifetimeSeconds: number;
}

/** D20 已实现协议以 contracts 运行时 schema 为唯一字段权威。接收时间/新鲜度在 HostSnapshotView 中。 */
export type MachineSnapshot = import('../../../packages/contracts/src/host-observation').HostSnapshot;
export type HostSnapshotView = import('../../../packages/contracts/src/host-agent').HostSnapshotView;

/** 安装实例的稳定身份和控制权代次；初始化未完成前不得开放调度。 */
export interface Installation {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 控制权代次，用于拒绝旧控制端命令。 */
  readonly controllerEpoch: number;
  /** 持久化结构版本，启动时校验迁移兼容性。 */
  readonly schemaVersion: number;
  /** 当前强制管理面拒绝基线的修订标识。 */
  readonly currentNetworkDenyRevisionId: Id;
}

/** D20 原生适配器枚举的脱敏交互会话；字段以运行时 schema 为准，锁屏/断开仍受保护。 */
export type HumanSession = MachineSnapshot['sessions'][number];

/** 完整会话枚举及人类活动观测；过期或枚举不完整必须判为 unknown。 */
export interface HumanPresenceReport extends ObservationMetadata {
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'present' | 'absent' | 'unknown';
  /** 会话枚举是否完整；false 时不得推断无人。 */
  readonly enumerationComplete: boolean;
  /** 完整枚举得到的脱敏交互会话。 */
  readonly sessions: readonly HumanSession[];
  /** 近期交互活动；不替代已登录会话保护。 */
  readonly activeInteraction: boolean | 'unknown';
  /** 稳定诊断码；成功或无错误时省略。 */
  readonly errorCode?: string;
}

/** Runtime schema is authoritative; do not duplicate HumanUsePolicy fields here. */
import type { HumanUsePolicy } from '../../../packages/contracts/src/admin';
export type { HumanUsePolicy } from '../../../packages/contracts/src/admin';

/** D22a power configuration and management types come from the runtime schema authority.
 * D22a fixes dryRun=true; capability conclusions/bindings cannot assert real verification.
 * Real prepared permits, Agent receipts and MachinePowerStatus below remain D22b design only. */
import type { PowerPolicy, PowerCapabilities } from '../../../packages/contracts/src/power';
export type { PowerPolicy, FaultRecoveryPolicy, SmartPlugBinding, PowerCapabilities } from '../../../packages/contracts/src/power';

/** 电源流程状态。off_expected 为本平台停机后的推断，off_confirmed 才有可信断电证据。 */
export type PowerPhase = 'idle' | 'draining' | 'shutdown_requested' | 'off_expected' | 'off_confirmed' | 'unknown' | 'waking';

/** 一次启停周期的持久状态，保留回执、版本与超时，防止旧停机计划影响新请求。 */
export interface MachinePowerStatus {
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: PowerPhase;
  /** 本次启停周期标识；无周期时为 null。 */
  readonly cycleId: Id | null;
  /** 当前动作标识，避免同周期重试混淆。 */
  readonly transitionId: Id | null;
  /** 正常停机持久操作标识；null 表示无对应停机操作。 */
  readonly shutdownOperationId: Id | null;
  /** OS 已接受停机的回执引用；不是断电证据。 */
  readonly acceptedShutdownReceiptId: Id | null;
  /** 动作或合同被接受的服务端时间。 */
  readonly acceptedAt: UtcTimestamp | null;
  /** 最早可发唤醒时间；null 表示尚不可按推断唤醒。 */
  readonly wakeNotBefore: UtcTimestamp | null;
  /** 本周期已发送唤醒的次数。 */
  readonly wakeAttemptCount: number;
  /** 当前动作总截止；null 表示无活动动作。 */
  readonly transitionDeadline: UtcTimestamp | null;
  /** 可信带外电源证据标识；null 表示未取得。 */
  readonly outOfBandEvidenceId: Id | null;
  /** 最近持久状态更新时间。 */
  readonly updatedAt: UtcTimestamp;
}

/** 物理资产内部模型。包含工作根、人的会话与策略，不能整体作为消费者响应。 */
export interface Machine extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 供人查看的名称；不能代替稳定标识。 */
  readonly name: string;
  /** 受管理的部署站点标识。 */
  readonly siteId: string; // 安装内逻辑站点键；默认 local，也可使用管理员定义的其他非空键。
  /** 物理宿主操作系统族。 */
  readonly hostOs: HostOs;
  /** CPU 架构；必须与实际执行环境匹配。 */
  readonly architecture: Architecture;
  /** 已授权角色；仍需结合对象范围。 */
  readonly role: 'shared' | 'dedicated';
  /** 已配对 Agent 标识；null 表示尚未配对。 */
  readonly agentId: Id | null; // 可以先登记机器，再进行 Agent 配对。
  /** 是否接受新增分配；不默认撤销已有租约。 */
  readonly admission: 'enabled' | 'draining' | 'disabled';
  /** 控制端希望的电源状态。 */
  readonly desiredPower: 'unchanged' | 'on' | 'off' | 'sleeping';
  /** 最近可信电源事实；掉线只得到 unknown。 */
  readonly observedPower: 'on' | 'sleeping' | 'off' | 'unknown';
  /** 持久电源流程状态，独立于观察事实。 */
  readonly powerStatus: MachinePowerStatus;
  /** 机器准入/电源栅栏版本；新计划会使旧许可失效。 */
  readonly machineEpoch: number;
  /** 机器总资源；可出租预算还需扣除保留与已占用。 */
  readonly totalResources: ResourceAmounts;
  /** 机器唯一物理根容量池标识。 */
  readonly rootCapacityPoolId: Id;
  /** 管理员批准的内部工作根，不能由租客覆盖。 */
  readonly approvedWorkRoots: readonly string[];
  /** 人的会话及保留预算策略。 */
  readonly humanUsePolicy: HumanUsePolicy;
  /** 此机器独立配置的电源规则。 */
  readonly powerPolicy: PowerPolicy;
  /** 此机器实测的电源动作能力。 */
  readonly powerCapabilities: PowerCapabilities;
  /** 最近可信人类观测；null 不代表无人。 */
  readonly presence: HumanPresenceReport | null;
  /** 阻止关机或分配的活动 Hold 标识。 */
  readonly holdIds: readonly Id[];
}

/** 认证得到的不可变运行时记录；地址变化不会改变其身份。 */
export type RuntimeIdentity = RuntimeDescriptor & {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
};

/** 针对指定连接修订的认证证据。接收方仍要核对身份、时间和预期目标。 */
export interface RuntimeIdentityEvidence {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id;
  /** 本次使用的已验证连接修订；重试不读取 current 偷换地址。 */
  readonly connectionRevisionId: Id;
  /** 认证读回的原生 ID，应与预期记录精确匹配。 */
  readonly observedNativeId: string;
  /** 认证已完成；仅验证适配器可生成该字面值。 */
  readonly authenticated: true;
  /** 已与预期原生身份匹配；不允许以普通 boolean 跳过核验。 */
  readonly matchesExpectedIdentity: true;
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
}

/** 一个逻辑运行时入口。currentRevisionId 指向已验证修订；记录创建不意味着可准入。 */
export interface ProviderConnection extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 对象或请求的判别种类。 */
  readonly kind: ProviderKind;
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id; // 一个逻辑连接只指向一个 runtime；多 environment 可共享凭据。
  /** 当前已激活修订；null 表示尚不可服务。 */
  readonly currentRevisionId: Id | null; // 尚未通过首次认证探测时为空，不可提供节点服务。
  /** 是否启用该配置；不代表依赖能力已通过验证。 */
  readonly enabled: boolean;
}

/** 已验证、不可修改的连接配置快照；换地址或秘密版本必须新建修订。 */
export interface ProviderConnectionRevision {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 所属逻辑运行时连接标识。 */
  readonly providerConnectionId: Id;
  /** 不可变配置修订号或清单修订号，不等同于实体 CAS。 */
  readonly revision: number;
  /** 受控管理地址或 Agent 引用，不含内联秘密。 */
  readonly endpointRef: string; // Portainer URL 或 agent ID；不含密码/token。
  /** 管理平台中的环境定位 ID；不能代替原生身份。 */
  readonly providerEndpointId: string; // Portainer environment ID 或宿主端点 ID。
  /** 固定秘密版本引用；null 表示该连接无需额外凭据。 */
  readonly credentialVersionRef: Id | null;
  /** 该修订实际验证过的运行时标识。 */
  readonly verifiedRuntimeIdentityId: Id;
  /** 认证身份匹配证据。 */
  readonly identityEvidence: RuntimeIdentityEvidence;
  /** 验证通过时间，使用时还需检查是否过期。 */
  readonly verifiedAt: UtcTimestamp;
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
}

/** 仅供管理员首次发现或校验的连接输入；不是消费者可指定的执行地址。 */
export interface RuntimeDiscoveryTarget {
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: ProviderKind;
  /** 受控管理地址或 Agent 引用，不含内联秘密。 */
  readonly endpointRef: string;
  /** 管理平台中的环境定位 ID；不能代替原生身份。 */
  readonly providerEndpointId: string;
  /** 固定秘密版本引用；null 表示该连接无需额外凭据。 */
  readonly credentialVersionRef: Id | null;
}

/** 首次发现得到的原生身份；创建持久身份之前不伪造内部 ID。 */
export type RuntimeDiscoveryEvidence = RuntimeDescriptor & {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 认证已完成；仅验证适配器可生成该字面值。 */
  readonly authenticated: true;
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
};

/** 具有时效性的节点能力报告；不匹配修订或过期报告不能用于准入。 */
export interface NodeCapabilities extends ObservationMetadata {
  /** 已验证的后端版本，用于能力兼容性判断。 */
  readonly providerVersion: string;
  /** 该节点经验证可交付的环境种类。 */
  readonly resourceKinds: readonly ResourceKind[];
  /** 镜像客体操作系统族。 */
  readonly guestOs: readonly HostOs[];
  /** 可原生交付的架构集合。 */
  readonly architectures: readonly Architecture[];
  /** CPU 硬限制能力的验证状态。 */
  readonly cpuHardLimit: Verification;
  /** 内存硬限制能力的验证状态。 */
  readonly memoryHardLimit: Verification;
  /** 临时盘硬限制能力的验证状态。 */
  readonly scratchHardLimit: Verification;
  /** 控制端失联时本地执行截止的验证状态。 */
  readonly offlineLeaseEnforcement: Verification;
  /** 网络访问规则实际执行能力的验证状态。 */
  readonly networkPolicyEnforcement: Verification;
  /** 已验证的技术连接协议。 */
  readonly supportedAccess: readonly ('ssh' | 'rdp')[];
  /** 该节点验证过的网络修订，不能只按逻辑 Profile 匹配。 */
  readonly verifiedNetworkProfileRevisionIds: readonly Id[];
  /** 该节点验证过的存储修订。 */
  readonly verifiedStorageProfileRevisionIds: readonly Id[];
  /** 加速器需求；首版默认为空，非空必须匹配专项验证。 */
  readonly accelerators: readonly AcceleratorCapability[];
  /** 对应验证报告标识；未生成时允许 null 的字段须单独处理。 */
  readonly reportId: Id;
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp;
}

/** 执行端可出租的设备能力及分配模式；verification 是使用门槛。 */
export interface AcceleratorCapability {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 加速器运行接口类型。 */
  readonly api: AcceleratorRequirement['api'];
  /** api=other 时的规范接口名；其他类型省略。 */
  readonly apiName?: string;
  /** 内部设备定位信息，不作为消费者自由输入。 */
  readonly device: string;
  /** 能力验证时的设备驱动版本。 */
  readonly driverVersion: string;
  /** 内存预算，单位 MiB；整数。 */
  readonly memoryMiB: number;
  /** 设备分配方式；shared 不承诺独占。 */
  readonly assignmentMode: 'exclusive' | 'partitioned' | 'shared';
  /** 该设备验证支持的特性。 */
  readonly features: readonly string[];
  /** 能力的当前验证结论。 */
  readonly verification: Verification;
}

/** 可调度运行时入口。与物理 Machine、容量池和原生身份分别建模。 */
export interface Node extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 所属逻辑运行时连接标识。 */
  readonly providerConnectionId: Id;
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id; // Node 生存期内不可改；更换原生运行时必须新建 Node。
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: ProviderKind;
  /** 用于记账的容量池标识。 */
  readonly capacityPoolId: Id;
  /** 承载本节点/子池的平台底座；null 表示直接物理根。 */
  readonly parentAllocationId: Id | null; // 经 CapacityPool 派生；仅 infrastructure Allocation。
  /** 是否接受新增分配；不默认撤销已有租约。 */
  readonly admission: 'enabled' | 'draining' | 'disabled';
  /** 最近技术健康状态；unknown 不当作健康或空闲。 */
  readonly observedHealth: 'healthy' | 'degraded' | 'unknown' | 'lost';
  /** 阻止新增分配的稳定原因码。 */
  readonly admissionReasonCodes: readonly string[];
  /** 具有时效性的能力报告；null 表示尚未验证。 */
  readonly capabilities: NodeCapabilities | null;
}

/** 物理或底座的共享容量账本；多个 Node 引用同池不能增加容量。 */
export interface CapacityPool extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 承载本节点/子池的平台底座；null 表示直接物理根。 */
  readonly parentAllocationId: Id | null; // null 为物理根池；否则是底座 Allocation。
  /** 本池原始总容量；根池来自物理机，子池来自底座固定规格，尚未扣保留量。 */
  readonly capacity: ResourceAmounts;
  /** 本池系统和人的合计保留量，仅扣一次；可出租容量=capacity-reservedForPlatform。 */
  readonly reservedForPlatform: ResourceAmounts;
  /** v1 固定 1；子池容器 claim 不再重复扣已由 BaseRuntime 占用的父池。 */
  readonly cpuOvercommitRatio: 1;
  /** 内存超卖比，v1 固定 1。 */
  readonly memoryOvercommitRatio: 1;
}

/** 实际分配占用的容量记录。未知结果与回收失败继续占用，不按低利用率退还。 */
export interface CapacityClaim extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 用于记账的容量池标识。 */
  readonly capacityPoolId: Id;
  /** 对应实际分配标识。 */
  readonly allocationId: Id; // tenant、validation 和 infrastructure 共用同一账本。
  /** 合并、运行或存储账本部分；底座停机只释放运行部分。 */
  readonly component: 'combined' | 'runtime' | 'storage';
  // tenant=combined；底座 runtime 只占 CPU/内存、storage 只占盘，停止底座不释放盘。
  /** 本条 Claim 占用的整数资源数量。 */
  readonly amounts: ResourceAmounts;
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'reserved' | 'committed' | 'quarantined' | 'released';
  /** 确认可释放的证据标识；未获证据时为 null。 */
  readonly releaseEvidenceRef: Id | null;
}

/** 平台 Linux 底座的内部管理视图，复用 infrastructure Allocation 的账本和生命周期。 */
export interface BaseRuntime {
  /** 对应实际分配标识。 */
  readonly allocationId: Id;
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 创建平台底座的父节点。 */
  readonly parentNodeId: Id;
  /** 底座内登记的 Docker 子节点。 */
  readonly childNodeId: Id;
  /** 本次固定使用的镜像制品标识。 */
  readonly imageArtifactId: Id;
  /** 已发现的精确主资源引用；未创建或未知时可能为 null。 */
  readonly resourceRef: OwnedResourceRef | null;
  /** 底座在父池的 CPU/内存占用记录。 */
  readonly parentRuntimeClaimId: Id;
  /** 底座持久盘占用记录，停机后仍保留。 */
  readonly parentStorageClaimId: Id;
  /** 期望资源状态，不代表外部已完成。 */
  readonly desiredState: Allocation['desiredState'];
  /** 实际观测的资源状态，未知不能当作不存在。 */
  readonly observedState: Allocation['observedState'];
  /** 冻结资源合同，Provider 不自行扩容或降配。 */
  readonly resourceContract: ResourceContract;
}

/** 镜像版本内部记录；version 是目录版本名，与实体 CAS 数字分开。发布后合同不可原地修改。 */
export interface ImageVersion {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 逻辑镜像目录标识。 */
  readonly imageId: Id;
  /** 镜像记录的实体 CAS 版本；不是镜像字符串版本名。 */
  readonly entityVersion: number;
  /** 最近持久状态更新时间。 */
  readonly updatedAt: UtcTimestamp;
  /** 镜像目录中的不可变版本名，与实体 CAS 数字无关。 */
  readonly version: string; // 镜像不可变版本名，不是实体 CAS 数字。
  /** 记录当前可用状态；不同状态的准入行为见对应领域合同。 */
  readonly status: ImageVersionStatus;
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
  /** 成功发布的时间，未发布时为 null。 */
  readonly publishedAt: UtcTimestamp | null;
  /** 可启动该镜像的最低资源。 */
  readonly minimumResources: ResourceAmounts;
  /** 初始化协议版本；不得用可变脚本替换已发布合同。 */
  readonly bootstrapContractVersion: string;
  /** 所属制品标识集合。 */
  readonly artifactIds: readonly Id[];
  /** 发布依据的验证报告标识。 */
  readonly validationReportIds: readonly Id[];
  /** 创建记录的管理主体标识。 */
  readonly createdBy: Id;
}

/** 镜像制品的内部共享字段，包含位置和秘密引用，不作为公开目录 DTO。 */
interface ImageArtifactBase {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 所属不可变镜像版本。 */
  readonly imageVersionId: Id;
  /** 镜像客体操作系统族。 */
  readonly guestOs: HostOs;
  /** CPU 架构；必须与实际执行环境匹配。 */
  readonly architecture: Architecture;
  /** 内部制品位置，不含长期内联凭据。 */
  readonly uri: string; // 不含持久凭据；URI 与摘要在发布后不可修改。
  /** 不可变内容摘要，不能仅使用可变标签。 */
  readonly digest: Sha256;
  /** 制品占用大小，单位 MiB。 */
  readonly sizeMiB: number;
  /** 访问镜像仓库的内部秘密引用；null 表示公开仓库。 */
  readonly registryCredentialRef: Id | null;
  /** 不可变初始化配置引用。 */
  readonly bootstrapProfileId: Id;
  /** 镜像支持并经过验证的连接协议。 */
  readonly accessProtocols: readonly ('ssh' | 'rdp')[];
}

/** 按后端判别的制品联合；Docker、Hyper-V、Tart 的格式与客体限制分别检查。 */
export type ImageArtifact = ImageArtifactBase & ({
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: 'portainer';
  /** 对象或请求的判别种类。 */
  readonly kind: 'container';
  /** 此后端实际支持的制品格式。 */
  readonly format: 'oci';
  /** 镜像客体操作系统族。 */
  readonly guestOs: 'linux';
} | {
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: 'hyperv';
  /** 对象或请求的判别种类。 */
  readonly kind: 'vm';
  /** 此后端实际支持的制品格式。 */
  readonly format: 'hyperv_export' | 'vhdx';
  /** 镜像客体操作系统族。 */
  readonly guestOs: 'linux' | 'windows';
  /** VM 固件、启动与安全设置的固定配置引用。 */
  readonly bootProfileId: Id;
} | {
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: 'tart';
  /** 对象或请求的判别种类。 */
  readonly kind: 'vm';
  /** 此后端实际支持的制品格式。 */
  readonly format: 'tart_oci' | 'tart_native';
  /** 镜像客体操作系统族。 */
  readonly guestOs: 'linux' | 'macos';
  /** CPU 架构；必须与实际执行环境匹配。 */
  readonly architecture: 'arm64';
  /** VM 固件、启动与安全设置的固定配置引用。 */
  readonly bootProfileId: Id;
});

/** 管理员的限时技术验证。无消费者 Lease，仍必须占容量并完成清理才能进入终态。 */
export interface ImageValidationRun extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 本次固定使用的镜像制品标识。 */
  readonly imageArtifactId: Id;
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 发起管理员验证的主体。 */
  readonly requestedByConsumerId: Id;
  /** 内部受理授权快照，禁止直接序列化给消费者。 */
  readonly acceptedProfiles: FrozenProfileSelection;
  /** 由验证 Allocation 反向派生；尚未预留时为 null。 */
  readonly allocationId: Id | null; // 由 Allocation.imageValidationId 反向派生。
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'queued' | 'running' | 'releasing' | 'succeeded' | 'failed' | 'cancelled';
  /** 技术测试结论，与是否完成资源清理分开。 */
  readonly testOutcome: 'pending' | 'passed' | 'failed';
  /** 资源清理状态；blocked 时继续计占用。 */
  readonly cleanupStatus: 'pending' | 'running' | 'blocked' | 'complete';
  /** 本次操作总截止；到期不证明副作用已结束。 */
  readonly deadline: UtcTimestamp;
  /** 对应验证报告标识；未生成时允许 null 的字段须单独处理。 */
  readonly reportId: Id | null;
  /** 运行最终结束时间；未终态时为 null。 */
  readonly finishedAt: UtcTimestamp | null;
}

/** 不可变存储授权配置；sourceRef 与秘密版本仅在内部可见。 */
export interface StorageProfileRevision {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 已授权存储逻辑配置标识。 */
  readonly storageProfileId: Id;
  /** 不可变配置修订号或清单修订号，不等同于实体 CAS。 */
  readonly revision: number;
  /** 挂载实现选择；不从不透明sourceRef猜测协议。 */
  readonly protocol: StorageProtocol;
  /** 内部批准的源根引用，禁止发给消费者。 */
  readonly sourceRef: string; // 内部受批准的 NAS/本地根；不得返回消费者。
  /** 允许的读写模式。 */
  readonly allowedModes: readonly StorageRequest['mode'][];
  /** 允许的相对子路径范围，不允许路径穿越。 */
  readonly allowedSubpaths: readonly string[];
  /** 固定秘密版本的内部引用，不保存明文。 */
  readonly secretVersionRef: Id | null; // 引用固定密钥版本；不得使用可变 latest 别名。
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
}

/** 单个获准出口目的地，以固定 CIDR、传输协议和端口表达。 */
export interface NetworkDestination {
  /** 规范化 IPv4/IPv6 CIDR；输入需验证网络范围。 */
  readonly cidr: string; // v1 只接受固定 CIDR，不以动态 DNS 文本充当防火墙身份。
  /** 传输协议或连接协议的判别值。 */
  readonly protocol: 'tcp' | 'udp';
  /** 允许或拒绝的端口，范围 1–65535；空列表不表示所有端口。 */
  readonly ports: NonEmptyReadonlyArray<number>;
}

/** 平台强制拒绝规则。any 协议必须配 any 端口；允许按端口保护共址 NAS 管理面。 */
export type NetworkDenyRule = {
  /** 规范化 IPv4/IPv6 CIDR；输入需验证网络范围。 */
  readonly cidr: string;
  /** any 分支只允许 ports=any，避免协议与端口组合含糊。 */
  readonly protocol: 'any';
  /** 允许或拒绝的端口，范围 1–65535；空列表不表示所有端口。 */
  readonly ports: 'any';
} | {
  /** 规范化 IPv4/IPv6 CIDR；输入需验证网络范围。 */
  readonly cidr: string;
  /** any 分支只允许 ports=any，避免协议与端口组合含糊。 */
  readonly protocol: 'tcp' | 'udp';
  /** 允许或拒绝的端口，范围 1–65535；空列表不表示所有端口。 */
  readonly ports: 'any' | NonEmptyReadonlyArray<number>;
};

/** 不可变网络允许规则；不能覆盖平台管理面拒绝基线。 */
export interface NetworkProfileRevision {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 已授权网络逻辑配置标识。 */
  readonly networkProfileId: Id;
  /** 不可变配置修订号或清单修订号，不等同于实体 CAS。 */
  readonly revision: number;
  /** 显式允许的出口目的地；仍受平台强制拒绝规则约束。 */
  readonly allowedEgress: readonly NetworkDestination[];
  /** 允许连接租客声明入口的来源网段。 */
  readonly allowedIngressSourceCidrs: readonly string[];
  /** 同等验证 IPv6，或在该网络关闭并验证。 */
  readonly ipv6: 'disabled' | 'verified_equivalent';
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
}

/** 平台强制拒绝集的不可变修订；活跃环境须跟进当前基线，不能只读受理时版本。 */
export interface PlatformNetworkDenyRevision {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 不可变配置修订号或清单修订号，不等同于实体 CAS。 */
  readonly revision: number;
  /** 管理面强制拒绝规则，优先于允许规则。 */
  readonly managementDenyRules: readonly NetworkDenyRule[];
  /** 非空、可审计的操作原因。 */
  readonly reason: string;
  /** 创建此管理配置的已授权主体。 */
  readonly createdByConsumerId: Id;
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
}

/** 受理时固定的存储授权，不假定已经选择 Node。此结构含内部引用，不对消费者输出。 */
export interface FrozenStorageGrant {
  /** 本次授权的稳定标识。 */
  readonly grantId: Id;
  /** 本次冻结授权结构修订，当前为 1。 */
  readonly grantRevision: 1;
  /** 固定存储修订标识，不跟随 latest。 */
  readonly storageProfileRevisionId: Id;
  /** 与该不可变存储修订一致的协议。 */
  readonly protocol: StorageProtocol;
  /** 经过授权与规范化的相对子路径。 */
  readonly authorizedSubpath: string;
  /** 租客内绝对挂载路径；不是宿主源路径。 */
  readonly mountPath: string;
  /** 实际读写或网络模式。 */
  readonly mode: 'read_only' | 'read_write';
  /** 受理时批准的源引用，尚未解析为节点真实路径。 */
  readonly approvedSourceRef: string; // 授权的逻辑源/根引用，受理时不假定已选 Node。
  /** 固定秘密版本的内部引用，不保存明文。 */
  readonly secretVersionRef: Id | null;
}

/** 受理时固定的网络允许规则及基线审计值；有效拒绝集仍叠加当前平台基线。 */
export interface FrozenNetworkGrant {
  /** 本次授权的稳定标识。 */
  readonly grantId: Id;
  /** 固定网络允许规则修订标识。 */
  readonly networkProfileRevisionId: Id;
  /** 受理时的平台拒绝基线，仅用于审计，不阻止后续加强。 */
  readonly platformDenyRevisionId: Id;
  /** 实际读写或网络模式。 */
  readonly mode: 'isolated_bridge';
  /** 显式允许的出口目的地；仍受平台强制拒绝规则约束。 */
  readonly allowedEgress: readonly NetworkDestination[];
  /** 允许连接租客声明入口的来源网段。 */
  readonly allowedIngressSourceCidrs: readonly string[];
  /** 管理面强制拒绝规则，优先于允许规则。 */
  readonly managementDenyRules: readonly NetworkDenyRule[];
  /** 同等验证 IPv6，或在该网络关闭并验证。 */
  readonly ipv6: 'disabled' | 'verified_equivalent';
  /** 实际网络规则实施后端，首版只支持 Docker iptables。 */
  readonly enforcement: 'docker_iptables'; // VM 阶段增加经验证的实现，不以此声称已支持。
  /** 首版固定 true；必须有节点实际验证证据。 */
  readonly verificationRequired: true;
}

/** 受理阶段的内部授权快照。与选定节点后才能生成的解析合同分开。 */
export interface FrozenProfileSelection {
  /** 规范化受理授权快照摘要。 */
  readonly selectionHash: Sha256;
  /** 动作或合同被接受的服务端时间。 */
  readonly acceptedAt: UtcTimestamp;
  /** 挂载授权请求或冻结授权集合；不含任意 mount 参数。 */
  readonly storage: readonly FrozenStorageGrant[];
  /** 冻结或解析的网络合同。 */
  readonly network: FrozenNetworkGrant;
}

/** 选定节点后解析并验证的存储来源；始终受原授权范围约束。 */
export interface ResolvedStorageGrant extends FrozenStorageGrant {
  /** 节点实际源路径/端点，必须处于原批准范围。 */
  readonly resolvedSourceRef: string; // 选 Node 后解析的真实源；必须在 approvedSourceRef 授权范围内。
  /** D23：已核验的宿主 mount/dev/inode 与授权摘要；不含 Agent 自身 namespace mount ID。实际宿主源变更会拒绝沿用，Agent 容器重启不会伪造源变更。 */
  readonly sourceValidationEvidenceId: Id;
}

/** 选定节点后核验的网络合同，绑定该节点的能力证据。 */
export interface ResolvedNetworkGrant extends FrozenNetworkGrant {
  /** 此节点实施对应网络规则的报告。 */
  readonly nodeVerificationReportId: Id;
}

/** 创建前冻结的内部执行配置。重试复用原配置；不能重新读取可变 latest。 */
export interface ResolvedProvisionContract {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 解析后完整执行合同的规范化摘要。 */
  readonly contractHash: Sha256;
  /** 规范化受理授权快照摘要。 */
  readonly selectionHash: Sha256;
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 选定节点并冻结解析结果的时间。 */
  readonly resolvedAt: UtcTimestamp;
  /** 挂载授权请求或冻结授权集合；不含任意 mount 参数。 */
  readonly storage: readonly ResolvedStorageGrant[];
  /** 冻结或解析的网络合同。 */
  readonly network: ResolvedNetworkGrant;
}

/** 绑定制品、初始化、授权和能力指纹的不可变验证报告；通过测试不替代清理证据。 */
export interface ImageValidationReport {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 对应管理员验证运行标识。 */
  readonly validationId: Id;
  /** 本报告实际验证的制品摘要。 */
  readonly artifactDigest: Sha256;
  /** 初始化协议版本；不得用可变脚本替换已发布合同。 */
  readonly bootstrapContractVersion: string;
  /** 本报告验证的完整初始化合同摘要。 */
  readonly bootstrapContractHash: Sha256;
  /** 固定网络允许规则修订标识。 */
  readonly networkProfileRevisionId: Id;
  /** 本次固定的存储修订集合。 */
  readonly storageProfileRevisionIds: readonly Id[];
  /** 本报告使用的节点能力指纹。 */
  readonly nodeCapabilityFingerprint: Sha256;
  /** 已验证的后端版本，用于能力兼容性判断。 */
  readonly providerVersion: string;
  /** 镜像客体操作系统族。 */
  readonly guestOs: HostOs;
  /** CPU 架构；必须与实际执行环境匹配。 */
  readonly architecture: Architecture;
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
  /** 技术验证是否通过；不代表清理完成或允许发布。 */
  readonly passed: boolean;
}

/** Ticket 内部持久模型，包含幂等和授权快照。对外只构造显式白名单的 TicketView。 */
export interface Ticket extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 所属消费者标识；必须再次核对调用者范围。 */
  readonly consumerId: Id;
  /** 一次逻辑写入的持久键，网络重试复用；不同意图必须换键。 */
  readonly idempotencyKey: string;
  /** 规范化请求摘要，用于同键异体冲突检查。 */
  readonly requestHash: Sha256;
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: TicketState;
  /** 第一次终止原因；未开始终止时为 null。 */
  readonly terminalReason: TerminalReason | null;
  /** 资源清理状态；blocked 时继续计占用。 */
  readonly cleanupStatus: CleanupStatus;
  /** 对应实际分配标识。 */
  readonly allocationId: Id | null; // reserved 后必有值；v1 不更换为第二个 Allocation。
  /** 受理时固定的镜像版本标识。 */
  readonly pinnedImageVersionId: Id;
  /** 内部受理授权快照，禁止直接序列化给消费者。 */
  readonly acceptedProfiles: FrozenProfileSelection; // 内部授权快照；不进入消费者视图。
  /** 服务端固定的完整安全请求，不含内部真实源或秘密引用。 */
  readonly acceptedRequest: AcceptedAcquireRequest;
  /** 排队最晚截止。 */
  readonly queueDeadline: UtcTimestamp;
  /** 预留后环境准备截止；尚未预留时为 null。 */
  readonly provisioningDeadline: UtcTimestamp | null;
  /** 关联消费者租约标识。 */
  readonly leaseId: Id | null;
  /** 技术就绪正式提交时间，尚未就绪时为 null。 */
  readonly readyAt: UtcTimestamp | null;
  /** 最终清理提交时间，尚未释放时为 null。 */
  readonly releasedAt: UtcTimestamp | null;
  /** 可稳定匹配的原因码列表，显示文本由界面转换。 */
  readonly reasonCodes: readonly string[];
}

/** 每个受管对象的完整所有权标记；清理时逐项与数据库核对。 */
export type Ownership = AllocationOwner & {
  /** 资源所属安装实例，禁止跨安装误清理。 */
  readonly installationId: Id;
  /** 对应实际分配标识。 */
  readonly allocationId: Id;
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 关联持久操作标识。 */
  readonly operationId: Id;
};

/** 精确实例引用；providerResourceId 已是执行端 ID，不再复制一份 Docker/VM ID。 */
export interface OwnedResourceRef<P extends ProviderKind = ProviderKind> {
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: P;
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id;
  /** 管理平台中的环境定位 ID；不能代替原生身份。 */
  readonly providerEndpointId: string; // 创建时定位快照；换连接后必须先验证同 runtime，不能只信此编号。
  /** 后端精确主实例 ID，不是名称前缀。 */
  readonly providerResourceId: string;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
}

/** 伴生对象清单项；显式区分可删除对象和只可解绑的外部引用。 */
export interface OwnedObjectRef {
  /** 该对象的稳定标识。 */
  readonly id: string;
  /** 对象或请求的判别种类。 */
  readonly kind: 'instance' | 'volume' | 'directory' | 'network' | 'network_policy' | 'port_binding' | 'credential' | 'mount';
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 内部对象位置，不作为消费者输入或普通响应。 */
  readonly locationRef: string;
  /** 清理策略；外部引用只能解绑，不能删除。 */
  readonly disposition: 'delete_on_release' | 'detach_only' | 'retain_until_deadline';
  /** 清理依赖，必须先完成所列对象再处理当前对象。 */
  readonly deleteAfterObjectIds: readonly string[];
}

/** 分配的资源清单，创建伴生对象时逐项持久记录，不能等整个流程成功才记账。 */
export interface ResourceManifest {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 不可变配置修订号或清单修订号，不等同于实体 CAS。 */
  readonly revision: number;
  /** 主实例引用；尚未创建时为 null。 */
  readonly primaryResource: OwnedResourceRef | null;
  /** 所有已发现伴生对象，包含每项清理策略。 */
  readonly objects: readonly OwnedObjectRef[];
  /** 清单是否完整；false 禁止用缺席推断不存在。 */
  readonly complete: boolean; // false 的清单不得用作“未列出则不存在”的依据。
}

/** 实际隔离环境内部模型。tenant 才可持有 Lease；基础设施与验证实例始终无消费者租约。 */
export type Allocation = Versioned & AllocationOwner & ({
  /** 分配归属判别值；tenant、validation、infrastructure 分别校验。 */
  readonly purpose: 'tenant';
  /** 关联消费者租约标识。 */
  readonly leaseId: Id | null;
} | {
  /** 分配归属判别值；tenant、validation、infrastructure 分别校验。 */
  readonly purpose: 'validation' | 'infrastructure';
  /** 关联消费者租约标识。 */
  readonly leaseId: null;
}) & {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 分配控制意图代次，用于拒绝终止之前的旧创建/续租命令。 */
  readonly controlVersion: number; // 独立于观测/实体 version；终止意图优先于旧续租/创建。
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id;
  /** 唤醒/检查前可为null；首次租客create前必须固定，此后不可改写或清空。 */
  readonly resolvedProvisionContractId: Id | null;
  /** 本次固定使用的镜像制品标识。 */
  readonly imageArtifactId: Id;
  /** 当前分配的容量占用记录。 */
  readonly claimIds: readonly Id[];
  /** 期望资源状态，不代表外部已完成。 */
  readonly desiredState: 'present' | 'stopped' | 'absent';
  /** 实际观测的资源状态，未知不能当作不存在。 */
  readonly observedState: 'creating' | 'running' | 'stopped' | 'absent' | 'unknown' | 'error';
  /** 资源清理状态；blocked 时继续计占用。 */
  readonly cleanupStatus: Exclude<CleanupStatus, 'not_needed'>;
  /** 冻结资源合同，Provider 不自行扩容或降配。 */
  readonly resourceContract: ResourceContract;
  /** 已读回的实际资源限制；尚未验证时为 null。 */
  readonly effectiveResources: EffectiveResources | null;
  /** 已发现的精确主资源引用；未创建或未知时可能为 null。 */
  readonly resourceRef: OwnedResourceRef | null;
  /** 该分配完整清单的标识。 */
  readonly manifestId: Id;
};

/** 持久化租约及 CAS 版本。准备期可 pending；激活和续租均按已确认候选版本提交。 */
export interface Lease extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 关联租客 Ticket 标识。 */
  readonly ticketId: Id;
  /** 对应实际分配标识。 */
  readonly allocationId: Id;
  /** 分配身份代次，续租和归还不递增。 */
  readonly generation: number;
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: LeaseState;
  /** 首次接用截止；准备阶段可为 null。 */
  readonly claimBy: UtcTimestamp | null;
  /** 首次成功接用时间；可为空的字段表示尚未接用。 */
  readonly claimedAt: UtcTimestamp | null; // 第一次 renew 成功才填，之后允许领取访问材料。
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp | null;
  /** 不可跨越的总寿命截止。 */
  readonly renewUntil: UtcTimestamp | null;
  /** 撤销正式提交时间；未撤销为 null。 */
  readonly revokedAt: UtcTimestamp | null;
  /** 到期策略引用，省略由服务端选择当前允许策略。 */
  readonly expiryPolicyId: Id;
  /** 最近确认续租时间；未确认续租为 null。 */
  readonly lastRenewedAt: UtcTimestamp | null;
}

/** 内部持久续租提案。每 Lease 最多一个 pending；同键查询同一记录最新状态。 */
export type LeaseRenewal = Versioned & RenewalDecision & {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 关联消费者租约标识。 */
  readonly leaseId: Id;
  /** 关联持久操作标识。 */
  readonly operationId: Id;
  /** 执行前必须匹配的实体 CAS 版本。 */
  readonly expectedVersion: number;
  /** 拟提交 Lease 版本，必须等于 expectedVersion+1。 */
  readonly proposedVersion: number;
  /** 候选截止，未确认前不得用它继续使用环境。 */
  readonly proposedExpiresAt: UtcTimestamp;
  /** 是否为首次接用续租。 */
  readonly isInitialClaim: boolean;
  /** 提案裁决截止，受理和最终确认都必须严格早于它。 */
  readonly decisionDeadline: UtcTimestamp;
};

/** 平台内部到期规则。首版只启用 destroy；保留策略要有单独的取回协议后才能开放。 */
export interface ExpiryPolicy {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 授权终止后的正常停止宽限秒数。 */
  readonly graceSeconds: number;
  /** 本地守卫在宽限后停止实例，固定 true。 */
  readonly localStopAfterGrace: true;
  /** 受控动作名或到期处置，不接受任意脚本。 */
  readonly action: 'destroy' | 'retain_scratch'; // 当前发布只允许destroy；留盘取回协议完成后才可启用扩展值。
  /** 留存期限秒数；当前 destroy 路径不启用留盘取回。 */
  readonly retentionSeconds: number;
  /** 本地判断允许的最大时钟不确定度。 */
  readonly maximumClockUncertaintySeconds: number;
  /** 固定 false；离线 Agent 只能撤权/停止，最终清理由控制端查实。 */
  readonly allowLocalDestruction: false; // Agent 断网时只撤销接入/停止；清理由控制端核实。
}

/** 当前管理 DTO 的唯一权威是运行时 contracts schema。 */
export type { ProfileGrantRevocation, RevocationImpact } from "../../../packages/contracts/src/admin.js";

/** 原生运行时身份的判别联合。provider 与 nativeKind 在类型层面保持一致。 */
export type RuntimeDescriptor = {
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: 'portainer';
  /** 该后端原生身份的类型。 */
  readonly nativeKind: 'docker_engine';
  /** 认证读回的不可变原生 ID；禁止使用 URL 或显示名替代。 */
  readonly nativeId: string;
} | {
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: 'hyperv';
  /** 该后端原生身份的类型。 */
  readonly nativeKind: 'hyperv_host';
  /** 认证读回的不可变原生 ID；禁止使用 URL 或显示名替代。 */
  readonly nativeId: string;
} | {
  /** 实际执行后端标识，须与原生身份及制品一致。 */
  readonly provider: 'tart';
  /** 该后端原生身份的类型。 */
  readonly nativeKind: 'tart_host';
  /** 认证读回的不可变原生 ID；禁止使用 URL 或显示名替代。 */
  readonly nativeId: string;
};

/** 实际资源的归属联合，禁止 tenant/validation 同时占有或均缺少归属。 */
export type AllocationOwner = {
  /** 分配归属判别值；tenant、validation、infrastructure 分别校验。 */
  readonly purpose: 'tenant';
  /** 关联租客 Ticket 标识。 */
  readonly ticketId: Id;
  /** 所属管理员验证标识；非验证资源为 null。 */
  readonly imageValidationId: null;
} | {
  /** 分配归属判别值；tenant、validation、infrastructure 分别校验。 */
  readonly purpose: 'validation';
  /** 关联租客 Ticket 标识。 */
  readonly ticketId: null;
  /** 所属管理员验证标识；非验证资源为 null。 */
  readonly imageValidationId: Id;
} | {
  /** 分配归属判别值；tenant、validation、infrastructure 分别校验。 */
  readonly purpose: 'infrastructure';
  /** 关联租客 Ticket 标识。 */
  readonly ticketId: null;
  /** 所属管理员验证标识；非验证资源为 null。 */
  readonly imageValidationId: null;
};
