/**
 * 计算资源服务接口设计 v1.3（尚非运行实现）。
 * Host/Runtime Agent 的白名单协议。VM 命令是后置扩展；所有输入除静态类型外还须验证 schema、签名、角色和栅栏。
 * 所有 number 均须验证有限值；整数/范围/跨字段不变量由运行时 schema 与事务共同保障。
 * 可选字段省略表示使用明确默认；null 表示明确不存在/尚未取得，不互相替换。
 */
import type { Id, NativeProviderKind, ObservationMetadata, Sha256, UtcTimestamp } from './common';
import type {
  ExpiryPolicy,
  HumanPresenceReport,
  ImageArtifact,
  NetworkDenyRule,
  Node,
  NodeCapabilities,
  OwnedResourceRef,
  Ownership,
  ResolvedNetworkGrant,
  ResourceManifest,
  RuntimeDiscoveryEvidence,
  RuntimeDiscoveryTarget,
  RuntimeIdentityEvidence,
} from './domain';
import type {
  AllocationOperationIdentity,
  CleanupEvidence,
  CreateReceipt,
  DiscoveryOperationIdentity,
  ImageCacheReceipt,
  NetworkPolicyEvidence,
  OperationResult,
  OwnedInventory,
  ProviderError,
  ProvisionPlan,
  ReadyEvidence,
  ResourceObservation,
  ResourceOperationIdentity,
  RevocationEvidence,
  StopEvidence,
} from './provider';

/** 控制端到 Agent 的通用传输头。必须验证身份、目标启动代次、期限和参数摘要。 */
export interface AgentCommandEnvelope {
  /** 一次 Agent 命令的稳定幂等标识。 */
  readonly commandId: Id;
  /** 关联持久操作标识。 */
  readonly operationId: Id;
  /** 已配对 Agent 标识；null 表示尚未配对。 */
  readonly agentId: Id;
  /** 该发送方单调序列号，用于去重和识别倒序。 */
  readonly sequence: number;
  /** 规范化命令参数摘要，重放必须一致。 */
  readonly argumentsHash: Sha256;
  /** 命令只针对该次 Agent 启动，重启后旧命令失效。 */
  readonly expectedBootId: Id;
  /** 命令或候选签发时间。 */
  readonly issuedAt: UtcTimestamp;
  /** 本次操作总截止；到期不证明副作用已结束。 */
  readonly deadline: UtcTimestamp;
  /** 执行前必须匹配的策略版本。 */
  readonly expectedPolicyVersion: number;
  /** 控制权代次，用于拒绝旧控制端命令。 */
  readonly controllerEpoch: number;
  /** 机器准入/电源栅栏版本；新计划会使旧许可失效。 */
  readonly machineEpoch: number;
}

/** 后置 VM Provider 的白名单动作与请求载荷；不接受任意命令字符串。 */
export interface NativeProviderPayloads {
  /** 只读认证发现原生身份；不创建任何租客或更改运行时。 */
  readonly discover: {
    /** 唯一持久动作目标，不允许同时指向多个范围。 */
    readonly target: RuntimeDiscoveryTarget;
  };
  /** 持久化并安排能力探测；外部调用在数据库事务之外执行。 */
  readonly probe: {
    /** 已选定节点的可信内部快照。 */
    readonly node: Node;
  };
  /** 确保精确摘要的制品可用，幂等重试并记录缓存副作用。 */
  readonly ensureImage: {
    /** 已选定节点的可信内部快照。 */
    readonly node: Node;
    /** 已固定的镜像制品。 */
    readonly artifact: ImageArtifact;
  };
  /** 按固定计划创建唯一环境，逐项 journal；超时不能另创第二份。 */
  readonly create: {
    /** 已授权且固定的执行计划。 */
    readonly plan: ProvisionPlan;
  };
  /** 返回 present/absent/unknown；身份错误或不完整查询只能 unknown。 */
  readonly inspect: {
    /** 目标资源的精确内部引用。 */
    readonly ref: OwnedResourceRef;
  };
  /** 仅列出已授权的精确平台范围，声明清单完整性。 */
  readonly listOwned: {
    /** 已选定节点的可信内部快照。 */
    readonly node: Node;
    /** 明确限定的受管资源范围，不能表示任意宿主对象。 */
    readonly namespace: string;
  };
  /** 验证并返回技术就绪证据，不签发消费者访问材料。 */
  readonly checkReady: {
    /** 目标资源的精确内部引用。 */
    readonly ref: OwnedResourceRef;
  };
  /** 撤销指定分配的访问；不承诺实例已删除。 */
  readonly revokeAccess: {
    /** 目标资源的精确内部引用。 */
    readonly ref: OwnedResourceRef;
  };
  /** 幂等停止精确实例，禁止按名称前缀或未知归属操作。 */
  readonly stop: {
    /** 目标资源的精确内部引用。 */
    readonly ref: OwnedResourceRef;
  };
  /** 按清单和依赖清理自有对象；外部数据只解绑，返回逐项证据。 */
  readonly destroy: {
    /** 已记录的资源清单。 */
    readonly manifest: ResourceManifest;
  };
}

/** 按 action 判别的 VM 命令；发现动作和已登记运行时操作的上下文分别约束。 */
export type NativeProviderCommand = {
  readonly [Action in keyof NativeProviderPayloads]: AgentCommandEnvelope & {
    /** 对象或请求的判别种类。 */
    readonly kind: 'native_provider';
    /** 实际执行后端标识，须与原生身份及制品一致。 */
    readonly provider: NativeProviderKind;
    /** 受控动作名或到期处置，不接受任意脚本。 */
    readonly action: Action;
    /** 本次持久操作的可序列化身份。 */
    readonly operation: Action extends 'discover' ? DiscoveryOperationIdentity : Action extends 'probe' | 'ensureImage' | 'listOwned' ? ResourceOperationIdentity : AllocationOperationIdentity;
    /** 与判别动作对应的结构化参数；禁止任意脚本。 */
    readonly payload: NativeProviderPayloads[Action];
  };
}[keyof NativeProviderPayloads];

/** 本地到期停止目标，直接复用完整资源引用，避免两份运行时或实例 ID 漂移。 */
export type LocalStopTarget = OwnedResourceRef;

/** 执行端持久化的租约候选。ACK 的版本和期限必须与控制端最终提交完全一致。 */
export interface LocalLeaseGuard {
  /** 守卫更新幂等标识，同键参数必须完全一致。 */
  readonly updateId: Id; // 同 renew Operation 的幂等标识。
  /** 初次就绪或续租候选。 */
  readonly candidateKind: 'initial_ready' | 'renewal';
  /** 初次就绪为 Operation ID，续租为 LeaseRenewal ID。 */
  readonly candidateId: Id; // initial_ready 使用 Operation ID；renewal 使用 LeaseRenewal ID。
  /** 规范化命令参数摘要，重放必须一致。 */
  readonly argumentsHash: Sha256; // 规范化候选参数摘要，不含摘要字段本身。
  /** 关联消费者租约标识。 */
  readonly leaseId: Id;
  /** 读取到的 Lease CAS 版本，不能由客户端猜测。 */
  readonly expectedLeaseVersion: number;
  /** 拟提交版本，必须等于 expectedLeaseVersion+1；初次 ready 通常为 2。 */
  readonly leaseVersion: number; // 拟提交版本 expectedLeaseVersion + 1，不是当前数据库版本。
  /** 控制权代次，用于拒绝旧控制端命令。 */
  readonly controllerEpoch: number;
  /** 机器准入/电源栅栏版本；新计划会使旧许可失效。 */
  readonly machineEpoch: number;
  /** 分配控制意图代次，用于拒绝终止之前的旧创建/续租命令。 */
  readonly controlVersion: number;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 首次接用截止；准备阶段可为 null。 */
  readonly claimBy: UtcTimestamp;
  /** 首次成功接用时间；可为空的字段表示尚未接用。 */
  readonly claimedAt: UtcTimestamp | null; // initial_ready=null；首次续租为拟确认接用时刻。
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp;
  /** 不可跨越的总寿命截止。 */
  readonly renewUntil: UtcTimestamp;
  /** 提案裁决截止，受理和最终确认都必须严格早于它。 */
  readonly decisionDeadline: UtcTimestamp; // 超时拒绝安装/确认；不能靠同 updateId 重放延长。
  /** 本次租约接受的到期行为合同。 */
  readonly expiryPolicy: ExpiryPolicy;
  /** 被此守卫允许停止的精确资源引用。 */
  readonly targets: readonly LocalStopTarget[];
  /** 此租约控制的访问授权标识。 */
  readonly accessGrantIds: readonly Id[];
  /** 命令或候选签发时间。 */
  readonly issuedAt: UtcTimestamp;
}

/** 守卫已持久化候选的回执，核对 candidate/hash/version/deadline 后才可提交续租。 */
export interface LeaseGuardAcknowledgement {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 守卫更新幂等标识，同键参数必须完全一致。 */
  readonly updateId: Id;
  /** 初次就绪或续租候选。 */
  readonly candidateKind: LocalLeaseGuard['candidateKind'];
  /** 初次就绪为 Operation ID，续租为 LeaseRenewal ID。 */
  readonly candidateId: Id;
  /** 规范化命令参数摘要，重放必须一致。 */
  readonly argumentsHash: Sha256;
  /** 已配对 Agent 标识；null 表示尚未配对。 */
  readonly agentId: Id;
  /** 生成观测/回执的 Agent 启动标识。 */
  readonly bootId: Id;
  /** 关联消费者租约标识。 */
  readonly leaseId: Id;
  /** 读取到的 Lease CAS 版本，不能由客户端猜测。 */
  readonly expectedLeaseVersion: number;
  /** 守卫/回执对应的租约版本；候选场景指拟提交版本。 */
  readonly leaseVersion: number;
  /** 分配控制意图代次，用于拒绝终止之前的旧创建/续租命令。 */
  readonly controlVersion: number;
  /** 控制权代次，用于拒绝旧控制端命令。 */
  readonly controllerEpoch: number;
  /** 执行端实际持久化的候选截止，控制端须核对。 */
  readonly persistedExpiresAt: UtcTimestamp;
  /** 执行端实际持久化的首次接用截止。 */
  readonly persistedClaimBy: UtcTimestamp;
  /** 执行端持久化的接用时间，未接用为 null。 */
  readonly persistedClaimedAt: UtcTimestamp | null;
  /** 提案裁决截止，受理和最终确认都必须严格早于它。 */
  readonly decisionDeadline: UtcTimestamp;
  /** 执行端完成持久化后签发 ACK 的时间。 */
  readonly acknowledgedAt: UtcTimestamp;
}

/** 完成本地最终复核后签发的短效停机许可；commit 前仍须再次核对。 */
export interface ShutdownPermit {
  /** 短效关机许可标识。 */
  readonly permitId: Id;
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 生成观测/回执的 Agent 启动标识。 */
  readonly bootId: Id;
  /** 本次排空电源流程的机器版本。 */
  readonly drainEpoch: number;
  /** 许可依据的电源策略版本。 */
  readonly policyVersion: number;
  /** 该短效证据或许可的最晚有效时间。 */
  readonly validUntil: UtcTimestamp;
  /** 受控动作名或到期处置，不接受任意脚本。 */
  readonly action: 'sleep' | 'shutdown';
}

/** 操作系统接受正常关机或睡眠的回执，不是已经断电的证据。 */
export interface ShutdownAcceptedReceipt {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 关联持久操作标识。 */
  readonly operationId: Id;
  /** 短效关机许可标识。 */
  readonly permitId: Id;
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 生成观测/回执的 Agent 启动标识。 */
  readonly bootId: Id;
  /** 动作或合同被接受的服务端时间。 */
  readonly acceptedAt: UtcTimestamp;
  /** 受控动作名或到期处置，不接受任意脚本。 */
  readonly action: 'sleep' | 'shutdown';
  /** OS 已接受正常动作，固定 true，不代表动作完成。 */
  readonly nativeRequestAccepted: true;
}

/** 每票网络策略的内部执行计划，包含冻结允许范围与当前强制拒绝基线。 */
export interface DockerNetworkPolicyPlan {
  /** 本次持久操作的可序列化身份。 */
  readonly operation: AllocationOperationIdentity;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id;
  /** 本次分配独有的 Docker bridge 网络 ID。 */
  readonly dockerNetworkId: string;
  /** 已选节点对应的完整网络授权。 */
  readonly networkGrant: ResolvedNetworkGrant;
  /** 本次必须执行的最新强制基线修订。 */
  readonly effectivePlatformDenyRevisionId: Id;
  /** 受理拒绝集与当前强制拒绝集的并集。 */
  readonly effectiveManagementDenyRules: readonly NetworkDenyRule[]; // 冻结拒绝集 ∪ 当前强制拒绝集。
  /** 预期规范化规则摘要，安装后读回比对。 */
  readonly expectedRulesetHash: Sha256;
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: 'prestart' | 'active';
}

/** 网络规则安装/撤销/移除的结果；就绪仍需独立 NetworkPolicyEvidence 探针。 */
export interface DockerNetworkPolicyReceipt {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 本次操作使用的原生身份认证证据。 */
  readonly runtimeIdentityEvidence: RuntimeIdentityEvidence;
  /** 本次分配独有的 Docker bridge 网络 ID。 */
  readonly dockerNetworkId: string;
  /** 实际内核规则规范化摘要。 */
  readonly rulesetHash: Sha256;
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'installed' | 'revoked' | 'removed';
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
}

/** Docker 网络组件允许执行的有限动作；删除规则需要实例与网络均已消失的证据。 */
export interface DockerNetworkPayloads {
  /** 安装并读回本票网络规则；必须先于租客启动。 */
  readonly ensure: {
    /** 已授权且固定的执行计划。 */
    readonly plan: DockerNetworkPolicyPlan;
  };
  /** 返回 present/absent/unknown；身份错误或不完整查询只能 unknown。 */
  readonly inspect: {
    /** 已授权且固定的执行计划。 */
    readonly plan: DockerNetworkPolicyPlan;
  };
  /** 撤销租客网络访问，但保留拒绝规则直到资源消失。 */
  readonly revoke: {
    /** 已授权且固定的执行计划。 */
    readonly plan: DockerNetworkPolicyPlan;
    /** 接收端至少记录此控制代次，拒绝更旧的恢复/授权命令。 */
    readonly minimumControlVersion: number;
  };
  /** 实例与网络消失后移除本票规则。 */
  readonly remove: {
    /** 已授权且固定的执行计划。 */
    readonly plan: DockerNetworkPolicyPlan;
    /** 全部受控实例已经消失的证据。 */
    readonly absentInstanceEvidenceId: Id;
    /** 独占 bridge 网络已经消失的证据。 */
    readonly absentNetworkEvidenceId: Id;
  }; // 全部租客执行资源和 bridge 已消失，最后才删除该票专属拒绝规则。
}

/** 按 network 动作判别的受限命令，始终携带操作身份和所有权。 */
export type DockerNetworkCommand = {
  readonly [Action in keyof DockerNetworkPayloads]: AgentCommandEnvelope & {
    /** 对象或请求的判别种类。 */
    readonly kind: `network.${Action}`;
    /** 与判别动作对应的结构化参数；禁止任意脚本。 */
    readonly payload: DockerNetworkPayloads[Action];
  };
}[keyof DockerNetworkPayloads];

/** 通用观测、租约和电源命令联合；不包含业务命令执行能力。 */
export type AgentControlCommand = AgentCommandEnvelope & ({
  /** 对象或请求的判别种类。 */
  readonly kind: 'inventory';
} | {
  /** 对象或请求的判别种类。 */
  readonly kind: 'lease_guard.install';
  /** 要幂等安装的租约候选与截止。 */
  readonly guard: LocalLeaseGuard;
} | {
  /** 对象或请求的判别种类。 */
  readonly kind: 'lease_guard.revoke';
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 接收端至少记录此控制代次，拒绝更旧的恢复/授权命令。 */
  readonly minimumControlVersion: number;
} | {
  /** 对象或请求的判别种类。 */
  readonly kind: 'power.prepare';
  /** 所属物理机器的稳定标识。 */
  readonly machineId: Id;
  /** 本次排空电源流程的机器版本。 */
  readonly drainEpoch: number;
  /** 受控动作名或到期处置，不接受任意脚本。 */
  readonly action: 'sleep' | 'shutdown';
} | {
  /** 对象或请求的判别种类。 */
  readonly kind: 'power.commit';
  /** 短效且尚未失效的停机许可。 */
  readonly permit: ShutdownPermit;
} | {
  /** 对象或请求的判别种类。 */
  readonly kind: 'power.cancel';
  /** 短效关机许可标识。 */
  readonly permitId: Id;
  /** 本次排空电源流程的机器版本。 */
  readonly drainEpoch: number;
});

/** Agent 全部允许命令的封闭联合；运行时必须同样使用白名单 schema。 */
export type AgentCommand = NativeProviderCommand | AgentControlCommand | DockerNetworkCommand;

/** Agent 离线执行撤销访问/停止的结果，供控制端恢复后对账。 */
export interface LocalExpiryAction extends ObservationMetadata {
  /** 关联消费者租约标识。 */
  readonly leaseId: Id;
  /** 守卫/回执对应的租约版本；候选场景指拟提交版本。 */
  readonly leaseVersion: number;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 受控动作名或到期处置，不接受任意脚本。 */
  readonly action: 'revoke_access' | 'stop';
  /** 本地动作是否成功；unknown 继续查实。 */
  readonly result: 'succeeded' | 'failed' | 'unknown';
  /** 可追溯验证证据标识。 */
  readonly evidenceId: Id;
}

/** 最新 Agent 观测；不把历史累积列表无限附在每次心跳中。 */
export interface AgentHeartbeat {
  /** 已配对 Agent 标识；null 表示尚未配对。 */
  readonly agentId: Id;
  /** 生成观测/回执的 Agent 启动标识。 */
  readonly bootId: Id;
  /** 该发送方单调序列号，用于去重和识别倒序。 */
  readonly sequence: number;
  /** 控制协议版本，当前为 1；不兼容版本拒绝执行。 */
  readonly protocolVersion: 1;
  /** Agent 软件版本。 */
  readonly agentVersion: string;
  /** 事实在执行端被观测的时间。 */
  readonly observedAt: UtcTimestamp;
  /** 物理宿主会话观测；Runtime 角色不得代报，使用 null。 */
  readonly humanPresence: HumanPresenceReport | null; // runtime-agent 不得代报物理会话。
  /** 该 Agent 负责观测的节点标识。 */
  readonly nodeIds: readonly Id[];
  /** 本次资源压力摘要，不替代容量账本。 */
  readonly resourcePressure: {
    /** 采样时可用内存 MiB，不替代资源预留账本。 */
    readonly availableMemoryMiB: number;
    /** 批准工作根的可用空间 MiB。 */
    readonly availableScratchMiB: number;
    /** 采样窗口 CPU 忙碌百分比，范围 0–100。 */
    readonly cpuBusyPercent: number;
  };
  /** 当前守卫版本摘要；完整明细按需查询。 */
  readonly installedLeaseGuards: readonly {
    /** 关联消费者租约标识。 */
    readonly leaseId: Id;
    /** 守卫/回执对应的租约版本；候选场景指拟提交版本。 */
    readonly leaseVersion: number;
    /** 分配控制意图代次，用于拒绝终止之前的旧创建/续租命令。 */
    readonly controlVersion: number;
    /** 控制权代次，用于拒绝旧控制端命令。 */
    readonly controllerEpoch: number;
  }[];
  /** 待控制端确认的本地到期动作，不无限重放历史。 */
  readonly localExpiryActions: readonly LocalExpiryAction[];
  /** 是否发现需要阻止节能的未纳管活动。 */
  readonly unmanagedActivityHold: boolean;
  /** 本次观测的脱敏错误码集合。 */
  readonly errorCodes: readonly string[];
}

/** 按具体命令推导合法结果；避免 power 命令误返回容器创建回执。 */
export type AgentCommandOutput<C extends AgentCommand = AgentCommand> = C extends {
  /** 对象或请求的判别种类。 */
  readonly kind: 'native_provider';
  /** 受控动作名或到期处置，不接受任意脚本。 */
  readonly action: infer A extends keyof NativeProviderResults;
} ? NativeProviderResults[A] : C extends {
  /** 对象或请求的判别种类。 */
  readonly kind: infer K extends keyof ControlCommandResults;
} ? ControlCommandResults[K] : never;

/** 命令回执联合。中间阶段无输出，最终输出受命令类型约束；业务成败仍读取 output。 */
export type AgentCommandResult<C extends AgentCommand = AgentCommand> = {
  /** 一次 Agent 命令的稳定幂等标识。 */
  readonly commandId: Id;
  /** 已配对 Agent 标识；null 表示尚未配对。 */
  readonly agentId: Id;
  /** 生成观测/回执的 Agent 启动标识。 */
  readonly bootId: Id;
  /** 回执单调序列号。 */
  readonly receiptSequence: number;
  /** 规范化命令参数摘要，重放必须一致。 */
  readonly argumentsHash: Sha256;
  /** 回执完成持久记录的时间。 */
  readonly recordedAt: UtcTimestamp;
} & ({
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: 'accepted' | 'running';
  /** 与原命令对应的结果；accepted/running 时必须为 null。 */
  readonly output: null;
} | {
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: 'succeeded';
  /** 与原命令对应的结果；accepted/running 时必须为 null。 */
  readonly output: AgentCommandOutput<C>;
} | {
  /** 当前生命周期阶段，不能据此推断业务执行结果。 */
  readonly phase: 'failed' | 'rejected';
  /** 与原命令对应的结果；accepted/running 时必须为 null。 */
  readonly output: {
    /** 执行或续租结果判别值，先判断再读取相应字段。 */
    readonly outcome: 'failed' | 'unknown';
    /** 脱敏的结构化错误；不能复制原始 Provider 响应。 */
    readonly error: ProviderError;
    /** none 表示确认无外部副作用；possible 仍需查实和回收。 */
    readonly sideEffects: 'none' | 'possible';
  };
});

/** 控制端的 Agent 传输抽象；回执查询带原命令，以验证类型和参数摘要。 */
export interface HostAgentTransport {
  /** 将完整受控命令持久化投递；重复 commandId/参数返回同结果。
   * @param command 原始受控命令，包含身份、截止与幂等参数。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  enqueue(command: AgentCommand): Promise<{
    /** 一次 Agent 命令的稳定幂等标识。 */
    readonly commandId: Id;
  }>;
  /** 携带原命令查询并验证回执；null 仅表示尚无回执，不代表未执行。
   * @param command 原始受控命令，包含身份、截止与幂等参数。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getResult<C extends AgentCommand>(command: C): Promise<AgentCommandResult<C> | null>;
  /** 读取最新可信心跳；null 表示尚无观测，不代表离线或无人。
   * @param agentId 已配对 Agent 标识；null 表示尚未配对。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  getHeartbeat(agentId: Id): Promise<AgentHeartbeat | null>;
}

/** Agent 内部执行入口。accept 的返回类型由输入动作推导，受限于已安装角色与能力。 */
export interface HostAgentRuntime {
  /** 已授权角色；仍需结合对象范围。 */
  readonly role: 'physical_host' | 'runtime';
  /** 收集当前角色负责的观测，标注完整性与错误。

   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  collectHeartbeat(): Promise<AgentHeartbeat>;
  /** 核验角色、参数、代次、期限后幂等受理；泛型保证返回值与输入动作匹配。
   * @param command 原始受控命令，包含身份、截止与幂等参数。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  accept<C extends AgentCommand>(command: C): Promise<AgentCommandResult<C>>;
  /** 按已接受守卫撤权/停止并持久记录，不离线删除持久数据。
   * @param now 服务端可信时间，不能由租客任意指定。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  enforceLocalExpiry(now: UtcTimestamp): Promise<readonly LocalExpiryAction[]>;
}

/** VM 动作与结果类型的一一映射；新增动作必须补齐请求与结果。 */
export interface NativeProviderResults {
  /** 只读认证发现原生身份；不创建任何租客或更改运行时。 */
  readonly discover: OperationResult<RuntimeDiscoveryEvidence>;
  /** 持久化并安排能力探测；外部调用在数据库事务之外执行。 */
  readonly probe: OperationResult<NodeCapabilities>;
  /** 确保精确摘要的制品可用，幂等重试并记录缓存副作用。 */
  readonly ensureImage: OperationResult<ImageCacheReceipt>;
  /** 按固定计划创建唯一环境，逐项 journal；超时不能另创第二份。 */
  readonly create: OperationResult<CreateReceipt>;
  /** 返回 present/absent/unknown；身份错误或不完整查询只能 unknown。 */
  readonly inspect: ResourceObservation;
  /** 仅列出已授权的精确平台范围，声明清单完整性。 */
  readonly listOwned: OperationResult<OwnedInventory>;
  /** 验证并返回技术就绪证据，不签发消费者访问材料。 */
  readonly checkReady: OperationResult<ReadyEvidence>;
  /** 撤销指定分配的访问；不承诺实例已删除。 */
  readonly revokeAccess: OperationResult<RevocationEvidence>;
  /** 幂等停止精确实例，禁止按名称前缀或未知归属操作。 */
  readonly stop: OperationResult<StopEvidence>;
  /** 按清单和依赖清理自有对象；外部数据只解绑，返回逐项证据。 */
  readonly destroy: CleanupEvidence;
}

/** Host/Runtime Agent 白名单动作与结果映射，供泛型回执约束使用。 */
export interface ControlCommandResults {
  /** 返回完整性明确的受管资源观测。 */
  readonly inventory: OperationResult<OwnedInventory>;
  /** 与 lease_guard.install 命令匹配的唯一结果类型。 */
  readonly 'lease_guard.install': OperationResult<LeaseGuardAcknowledgement>;
  /** 与 lease_guard.revoke 命令匹配的唯一结果类型。 */
  readonly 'lease_guard.revoke': OperationResult<RevocationEvidence>;
  /** 与 power.prepare 命令匹配的唯一结果类型。 */
  readonly 'power.prepare': OperationResult<ShutdownPermit>;
  /** 与 power.commit 命令匹配的唯一结果类型。 */
  readonly 'power.commit': OperationResult<ShutdownAcceptedReceipt>;
  /** 与 power.cancel 命令匹配的唯一结果类型。 */
  readonly 'power.cancel': OperationResult<{
    /** 是否收到协作取消；已有副作用仍须对账。 */
    readonly cancelled: true;
  }>;
  /** 与 network.ensure 命令匹配的唯一结果类型。 */
  readonly 'network.ensure': OperationResult<DockerNetworkPolicyReceipt>;
  /** 与 network.inspect 命令匹配的唯一结果类型。 */
  readonly 'network.inspect': OperationResult<NetworkPolicyEvidence>;
  /** 与 network.revoke 命令匹配的唯一结果类型。 */
  readonly 'network.revoke': OperationResult<DockerNetworkPolicyReceipt>;
  /** 与 network.remove 命令匹配的唯一结果类型。 */
  readonly 'network.remove': OperationResult<DockerNetworkPolicyReceipt>;
}
