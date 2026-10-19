/**
 * 计算资源服务接口设计 v1.3（尚非运行实现）。
 * 控制端到执行后端的受限端口。副作用与领域事务分离；身份不匹配、结果未知时保持占用。
 * 所有 number 均须验证有限值；整数/范围/跨字段不变量由运行时 schema 与事务共同保障。
 * 可选字段省略表示使用明确默认；null 表示明确不存在/尚未取得，不互相替换。
 */
import type {
  EffectiveResources,
  Id,
  ObservationMetadata,
  ProviderKind,
  ResourceContract,
  Sha256,
  UtcTimestamp,
  Versioned,
} from './common';
import type {
  ImageArtifact,
  Node,
  NodeCapabilities,
  OwnedObjectRef,
  OwnedResourceRef,
  Ownership,
  ResolvedProvisionContract,
  ResourceManifest,
  RuntimeDiscoveryEvidence,
  RuntimeDiscoveryTarget,
  RuntimeIdentityEvidence,
} from './domain';

/** 执行适配器的脱敏错误。retryable 表示可尝试恢复，不代表外部副作用不存在。 */
export interface ProviderError {
  /** 稳定错误码，供程序进行分支处理。 */
  readonly code: string;
  /** 稳定的执行错误类别。 */
  readonly category: 'unsupported' | 'invalid' | 'auth' | 'unreachable' | 'timeout' | 'conflict' | 'internal';
  /** 已脱敏的可读说明，不用于程序匹配。 */
  readonly message: string; // 脱敏，不得含凭据或任意 inspect 原文。
  /** 是否允许按恢复策略重试；不说明副作用是否已经发生。 */
  readonly retryable: boolean;
  /** 已脱敏的厂商错误码，缺失时省略。 */
  readonly providerCode?: string;
}

/** 执行结果判别联合。unknown 必须查实，failed 且 sideEffects=possible 仍保留占用。 */
export type OperationResult<T> = {
  /** 执行或续租结果判别值，先判断再读取相应字段。 */
  readonly outcome: 'succeeded';
  /** 仅 succeeded 分支的成功结果。 */
  readonly value: T;
} | {
  /** 执行或续租结果判别值，先判断再读取相应字段。 */
  readonly outcome: 'failed';
  /** 脱敏的结构化错误；不能复制原始 Provider 响应。 */
  readonly error: ProviderError;
  /** none 表示确认无外部副作用；possible 仍需查实和回收。 */
  readonly sideEffects: 'none' | 'possible';
} | {
  /** 执行或续租结果判别值，先判断再读取相应字段。 */
  readonly outcome: 'unknown';
  /** 脱敏的结构化错误；不能复制原始 Provider 响应。 */
  readonly error: ProviderError;
};

/** 外部操作的持久身份和栅栏。仅用于传输的数据，不包含回调和数据库对象。 */
export interface OperationIdentity {
  /** 关联持久操作标识。 */
  readonly operationId: Id;
  /** 一次逻辑写入的持久键，网络重试复用；不同意图必须换键。 */
  readonly idempotencyKey: string;
  /** 规范化命令参数摘要，重放必须一致。 */
  readonly argumentsHash: Sha256;
  /** 唯一持久动作目标，不允许同时指向多个范围。 */
  readonly target: {
    /** 对象或请求的判别种类。 */
    readonly kind: 'allocation' | 'machine' | 'node' | 'installation';
    /** 该对象的稳定标识。 */
    readonly id: Id;
  };
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership | null; // Node 的预热/探测没有 Allocation。
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id | null; // 已登记provider操作必须有；与Node/Allocation冻结身份一致。
  /** 本次使用的已验证连接修订；重试不读取 current 偷换地址。 */
  readonly connectionRevisionId: Id | null; // 同上；重试沿用本修订，不读current。installation范围只读discovery例外。
  /** 控制权代次，用于拒绝旧控制端命令。 */
  readonly controllerEpoch: number;
  /** 机器准入/电源栅栏版本；新计划会使旧许可失效。 */
  readonly machineEpoch: number;
  /** 危险动作所依据的分配控制版本，无分配时为 null。 */
  readonly expectedControlVersion: number | null;
  /** 本次操作总截止；到期不证明副作用已结束。 */
  readonly deadline: UtcTimestamp;
}

/** Provider 的受限记账回调；只记录事实，不负责调度、续租或任意业务状态更新。 */
export interface ResourceJournal {
  /** 每个外部资源创建后立即记账；不得等整个 create 全部成功才提交 manifest。 */
  recordCreated(operationId: Id, object: OwnedObjectRef): Promise<void>;
  /** 持久化实际观测，不让 Provider 自行推进 Ticket 或退还容量。
   * @param operationId 待记录事实对应的持久操作。
   * @param observation 已验证来源和完整性的实际观测。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  recordObserved(operationId: Id, observation: ResourceObservation): Promise<void>;
}

/** 进程内协作取消信号；取消不证明外部操作已停止，不能据此释放容量。 */
export interface CancellationSignal {
  /** 是否收到协作取消；已有副作用仍须对账。 */
  readonly cancelled: boolean;
}

/** 内部执行上下文。包含记账/取消函数，不能直接序列化给 Agent。 */
export interface OperationContext extends OperationIdentity {
  /** 受限持久记账端口，禁止序列化传给 Agent。 */
  readonly journal: ResourceJournal;
  /** 协作取消信号，不构成不存在证据。 */
  readonly cancellation: CancellationSignal;
}

/** 针对单个已登记分配的执行上下文；要求完整 ownership 与控制版本。 */
export interface AllocationOperationContext extends ResourceOperationContext {
  /** 唯一持久动作目标，不允许同时指向多个范围。 */
  readonly target: {
    /** 对象或请求的判别种类。 */
    readonly kind: 'allocation';
    /** 该对象的稳定标识。 */
    readonly id: Id;
  };
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 危险动作所依据的分配控制版本，无分配时为 null。 */
  readonly expectedControlVersion: number;
}

/** 持久化外部动作记录。worker 所有权、实体版本和控制意图分别处理。 */
export interface Operation extends Versioned {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 本操作持久身份与栅栏。 */
  readonly identity: OperationIdentity;
  /** 对象或请求的判别种类。 */
  readonly kind: string; // 服务端固定 action allowlist，不是脚本或 shell。
  /** 同目标流程中的稳定步骤标识，重试复用。 */
  readonly stepKey: string;
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'planned' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  /** 已进行的执行尝试次数。 */
  readonly attemptCount: number;
  /** 计划再次检查或执行的时间，不是成功承诺。 */
  readonly nextCheckAt: UtcTimestamp;
  /** 当前 worker 所有权令牌；未领取为 null。 */
  readonly workerToken: Id | null;
  /** worker 执行权截止；到期不证明外部动作停止。 */
  readonly workerLeaseUntil: UtcTimestamp | null;
}

/** 身份匹配后的可信不存在证据；单独的 404 或空列表不足以生成该结果。 */
export interface VerifiedAbsence {
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
  /** 可追溯验证证据标识。 */
  readonly evidenceId: Id;
  /** 生成不存在证据的已认证检查方式。 */
  readonly method: 'authenticated_exact_lookup' | 'authenticated_complete_inventory';
  /** 本次操作使用的原生身份认证证据。 */
  readonly runtimeIdentityEvidence: RuntimeIdentityEvidence; // 404 本身不是证明，先认证并匹配冻结身份。
}

/** 身份已认证的现存资源观测；不再用可矛盾的 identityVerified 布尔值重复表述。 */
export interface PresentResource extends ObservationMetadata {
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 资源实例的实际电源/运行状态。 */
  readonly powerState: 'running' | 'stopped' | 'starting' | 'stopping';
  /** 已读回的实际资源限制；尚未验证时为 null。 */
  readonly effectiveResources: EffectiveResources;
  /** 本次操作使用的原生身份认证证据。 */
  readonly runtimeIdentityEvidence: RuntimeIdentityEvidence;
}

/** 资源存在、不存在、未知的判别联合。只有 absent 附带可信缺失证据。 */
export type ResourceObservation = {
  /** 最近可信人类观测；null 不代表无人。 */
  readonly presence: 'present';
  /** 已认证且实际存在的资源观测。 */
  readonly resource: PresentResource;
} | {
  /** 最近可信人类观测；null 不代表无人。 */
  readonly presence: 'absent';
  /** 目标确实不存在的可信证据。 */
  readonly evidence: VerifiedAbsence;
} | {
  /** 最近可信人类观测；null 不代表无人。 */
  readonly presence: 'unknown';
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 脱敏的结构化错误；不能复制原始 Provider 响应。 */
  readonly error: ProviderError;
};

/** 带范围和完整性标记的受管资源清单；不完整清单不能证明缺失。 */
export interface OwnedInventory extends ObservationMetadata {
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 明确限定的受管资源范围，不能表示任意宿主对象。 */
  readonly namespace: string;
  /** 清单是否完整；false 禁止用缺席推断不存在。 */
  readonly complete: boolean;
  /** 本次操作使用的原生身份认证证据。 */
  readonly runtimeIdentityEvidence: RuntimeIdentityEvidence;
  /** 资源数量或已经归一化的合同，依所属类型区分。 */
  readonly resources: readonly PresentResource[];
}

/** 精确镜像制品在指定节点缓存成功的回执；只表示技术缓存事实。 */
export interface ImageCacheReceipt {
  /** 实际调度节点标识。 */
  readonly nodeId: Id;
  /** 固定制品标识。 */
  readonly artifactId: Id;
  /** 不可变内容摘要，不能仅使用可变标签。 */
  readonly digest: Sha256;
  /** 验证通过时间，使用时还需检查是否过期。 */
  readonly verifiedAt: UtcTimestamp;
  /** 内部本地缓存位置。 */
  readonly localImageRef: string;
}

/** 应用层已经授权和归一化的创建计划；Provider 不重新读取可变策略自行调度。 */
export interface ProvisionPlan {
  /** 已选定节点的可信内部快照。 */
  readonly node: Node;
  /** 已固定的镜像制品。 */
  readonly artifact: ImageArtifact;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 资源数量或已经归一化的合同，依所属类型区分。 */
  readonly resources: ResourceContract;
  /** 创建前冻结的授权与实际执行配置。 */
  readonly resolved: ResolvedProvisionContract;
  /** 一次性初始化授权引用，完成后应撤销。 */
  readonly bootstrapGrantRef: Id;
  /** 本次交付的技术连接协议。 */
  readonly accessProtocol: 'ssh' | 'rdp';
  /** 从稳定分配身份生成的资源名，用于重试查找。 */
  readonly deterministicResourceName: string;
}

/** 主资源与逐项清单的创建结果；返回前需要完成已发生副作用的持久记账。 */
export interface CreateReceipt {
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 已记录的资源清单。 */
  readonly manifest: ResourceManifest;
}

/** 内部入口和验证记录，包含秘密领取引用。对消费者转换为 ConsumerAccessEndpoint。 */
export interface AccessDescriptor {
  /** 本次授权的稳定标识。 */
  readonly grantId: Id;
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 传输协议或连接协议的判别值。 */
  readonly protocol: 'ssh' | 'rdp';
  /** 消费者可达的地址，不是后端管理入口。 */
  readonly host: string;
  /** 技术入口端口，整数 1–65535。 */
  readonly port: number;
  /** 本次独立租客身份名。 */
  readonly username: string;
  /** SSH 主机身份指纹；不适用协议为 null。 */
  readonly hostKeyFingerprint: string | null;
  /** 内部秘密领取定位引用，不能出现在公开入口 DTO。 */
  readonly secretClaimRef: Id | null; // 只给引用；列表/事件不含秘密。
  /** 截止时间；等于当前服务端时间即已过期。 */
  readonly expiresAt: UtcTimestamp;
  /** 已授权网络逻辑配置标识。 */
  readonly networkProfileId: Id;
  /** 固定网络允许规则修订标识。 */
  readonly networkProfileRevisionId: Id;
  /** 实际完成入口探针的网络范围引用。 */
  readonly verifiedFromNetworkId: Id;
  /** 验证通过时间，使用时还需检查是否过期。 */
  readonly verifiedAt: UtcTimestamp;
}

/** 技术就绪证据。初始化、限额、挂载、入口和网络保护均通过才可生成。 */
export interface ReadyEvidence {
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 已读回的实际资源限制；尚未验证时为 null。 */
  readonly effectiveResources: EffectiveResources;
  /** 初始化已全部完成并通过检查，固定 true。 */
  readonly bootstrapComplete: true;
  /** 本次操作使用的原生身份认证证据。 */
  readonly runtimeIdentityEvidence: RuntimeIdentityEvidence;
  /** 当前实际网络隔离证据。 */
  readonly networkPolicyEvidence: NetworkPolicyEvidence;
  /** 已按授权验证的挂载标识集合。 */
  readonly mountGrantIdsVerified: readonly Id[];
  /** 敏感入口领取命令或连接参数，依所属结构区分。 */
  readonly access: AccessDescriptor;
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
}

/** 实际内核规则和正反向连通验证的完整证据；不能用 API 调用成功替代。 */
export interface NetworkPolicyEvidence {
  /** 该对象的稳定标识。 */
  readonly id: Id;
  /** 本次操作使用的原生身份认证证据。 */
  readonly runtimeIdentityEvidence: RuntimeIdentityEvidence;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: Ownership;
  /** 本次冻结网络授权标识。 */
  readonly networkGrantId: Id;
  /** 固定网络允许规则修订标识。 */
  readonly networkProfileRevisionId: Id;
  /** 受理时的基线审计修订。 */
  readonly frozenPlatformDenyRevisionId: Id;
  /** 当前实际验证生效的强制拒绝基线修订。 */
  readonly appliedPlatformDenyRevisionId: Id;
  /** 本次分配独有的 Docker bridge 网络 ID。 */
  readonly dockerNetworkId: string;
  /** 实际内核规则规范化摘要。 */
  readonly rulesetHash: Sha256;
  /** 宿主 INPUT 管理面保护已经验证。 */
  readonly ipv4IngressHostProtection: 'verified';
  /** 转发及发布端口保护已经验证。 */
  readonly ipv4ForwardProtection: 'verified';
  /** IPv6 等价隔离已验证，或已关闭并验证不可用。 */
  readonly ipv6Protection: 'disabled_verified' | 'equivalent_verified';
  /** 管理面不可达的反向探针已通过。 */
  readonly managementDenyProbe: 'passed';
  /** 获准消费者入口的正向探针已通过。 */
  readonly declaredAccessProbe: 'passed';
  /** 获准数据路径探针通过；无数据请求时为 not_requested。 */
  readonly declaredDataPathProbe: 'passed' | 'not_requested';
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
  /** 该短效证据或许可的最晚有效时间。 */
  readonly validUntil: UtcTimestamp;
}

/** 指定访问授权已撤销的证据，不等于实例和磁盘都已删除。 */
export interface RevocationEvidence {
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 已经撤销的访问授权标识。 */
  readonly revokedGrantIds: readonly Id[];
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
}

/** 实例已停止或不存在的证据；持久盘仍须按清单单独处理。 */
export interface StopEvidence {
  /** 目标资源的精确内部引用。 */
  readonly ref: OwnedResourceRef;
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'stopped' | 'absent';
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
  /** 可追溯验证证据标识。 */
  readonly evidenceId: Id;
}

/** 清理完成、阻塞和未知的判别联合。只有 complete 可用于提交最终释放。 */
export type CleanupEvidence = {
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'complete';
  /** 该分配完整清单的标识。 */
  readonly manifestId: Id;
  /** 逐项确认已经不存在的对象 ID。 */
  readonly verifiedAbsentObjectIds: readonly string[];
  /** 已经安全解绑的外部引用，不能删除其源数据。 */
  readonly detachedObjectIds: readonly string[];
  /** 该校验在可信执行路径完成的时间。 */
  readonly checkedAt: UtcTimestamp;
  /** 可追溯验证证据标识。 */
  readonly evidenceId: Id;
} | {
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'blocked';
  /** 该分配完整清单的标识。 */
  readonly manifestId: Id;
  /** 仍阻止回收完成的对象 ID。 */
  readonly remainingObjectIds: readonly string[];
  /** 可稳定匹配的原因码列表，显示文本由界面转换。 */
  readonly reasonCodes: readonly string[];
} | {
  /** 该对象的领域状态；按判别值读取对应字段。 */
  readonly state: 'unknown';
  /** 该分配完整清单的标识。 */
  readonly manifestId: Id;
  /** 脱敏的结构化错误；不能复制原始 Provider 响应。 */
  readonly error: ProviderError;
};

/** 业务无关执行端口。checkReady 返回技术证据；用户领取材料由 TicketService.getAccess 负责。 */
export interface ResourceProvider {
  /** 对象或请求的判别种类。 */
  readonly kind: ProviderKind;
  /** 只读认证发现原生身份；不创建任何租客或更改运行时。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param target 管理员授权的只读发现目标。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  discover(context: DiscoveryOperationContext, target: RuntimeDiscoveryTarget): Promise<OperationResult<RuntimeDiscoveryEvidence>>;
  // 每次调用先验证 context 选定连接的 runtime identity；不匹配返回失败/unknown，绝不返回 absent。
  /** 持久化并安排能力探测；外部调用在数据库事务之外执行。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param node 已登记节点的可信快照。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  probe(context: ResourceOperationContext, node: Node): Promise<OperationResult<NodeCapabilities>>;
  /** 确保精确摘要的制品可用，幂等重试并记录缓存副作用。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param node 已登记节点的可信快照。
   * @param artifact 固定摘要的制品。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  ensureImage(context: ResourceOperationContext, node: Node, artifact: ImageArtifact): Promise<OperationResult<ImageCacheReceipt>>;
  /** 按固定计划创建唯一环境，逐项 journal；超时不能另创第二份。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param plan 已经授权、固定并校验的执行计划。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  create(context: AllocationOperationContext, plan: ProvisionPlan): Promise<OperationResult<CreateReceipt>>;
  /** 返回 present/absent/unknown；身份错误或不完整查询只能 unknown。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ref 精确已认证的资源引用。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  inspect(context: AllocationOperationContext, ref: OwnedResourceRef): Promise<ResourceObservation>;
  /** 仅列出已授权的精确平台范围，声明清单完整性。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param node 已登记节点的可信快照。
   * @param namespace 受限平台资源范围。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  listOwned(context: ResourceOperationContext, node: Node, namespace: string): Promise<OperationResult<OwnedInventory>>;
  /** 验证实例身份、实际限制、初始化、挂载、网络及入口，返回技术证据，不签发消费者公开响应。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ref 精确已认证的资源引用。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  checkReady(context: AllocationOperationContext, ref: OwnedResourceRef): Promise<OperationResult<ReadyEvidence>>;
  /** 撤销指定分配的访问；不承诺实例已删除。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ref 精确已认证的资源引用。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  revokeAccess(context: AllocationOperationContext, ref: OwnedResourceRef): Promise<OperationResult<RevocationEvidence>>;
  /** 幂等停止精确实例，禁止按名称前缀或未知归属操作。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param ref 精确已认证的资源引用。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  stop(context: AllocationOperationContext, ref: OwnedResourceRef): Promise<OperationResult<StopEvidence>>;
  /** 按清单和依赖清理自有对象；外部数据只解绑，返回逐项证据。
   * @param context 可信应用上下文；不接受请求体自报身份。
   * @param manifest 完整清单及逐项所有权与清理依赖。
   * @returns 仅在该方法定义的确认边界返回；Promise 拒绝不代表外部副作用不存在。 */
  destroy(context: AllocationOperationContext, manifest: ResourceManifest): Promise<CleanupEvidence>;
}

/** 已登记运行时上的执行上下文，在类型层面要求明确 runtime/connection revision。 */
export interface ResourceOperationContext extends OperationContext {
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: Id;
  /** 本次使用的已验证连接修订；重试不读取 current 偷换地址。 */
  readonly connectionRevisionId: Id;
}

/** 首次只读发现的例外上下文，仅允许 installation 目标与空运行时绑定。 */
export interface DiscoveryOperationContext extends OperationContext {
  /** 唯一持久动作目标，不允许同时指向多个范围。 */
  readonly target: {
    /** 对象或请求的判别种类。 */
    readonly kind: 'installation';
    /** 该对象的稳定标识。 */
    readonly id: Id;
  };
  /** 已登记真实运行时标识；不得换绑到另一 Engine/宿主。 */
  readonly runtimeIdentityId: null;
  /** 本次使用的已验证连接修订；重试不读取 current 偷换地址。 */
  readonly connectionRevisionId: null;
  /** 完整平台所有权，危险动作前必须核对。 */
  readonly ownership: null;
  /** 危险动作所依据的分配控制版本，无分配时为 null。 */
  readonly expectedControlVersion: null;
}

/** 已验证运行时操作的可序列化身份；runtime 与连接修订不能为空。 */
export type ResourceOperationIdentity = Pick<ResourceOperationContext, keyof OperationIdentity>;

/** 首次只读发现的可序列化身份；尚无运行时与连接修订 ID。 */
export type DiscoveryOperationIdentity = Pick<DiscoveryOperationContext, keyof OperationIdentity>;

/** 分配级操作的可序列化身份，要求非空 ownership、控制版本及运行时绑定。 */
export type AllocationOperationIdentity = Pick<AllocationOperationContext, keyof OperationIdentity>;
