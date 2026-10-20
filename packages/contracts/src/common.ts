/**
 * Hitchlet 当前共享合同；运行时 schema 与 SQLite 事务执行边界校验。
 * 共享值类型与单位。既供公开 DTO 使用，也供内部模型使用；不包含秘密定位符或服务实现。
 * 所有 number 均须验证有限值；整数/范围/跨字段不变量由运行时 schema 与事务共同保障。
 * 可选字段省略表示使用明确默认；null 表示明确不存在/尚未取得，不互相替换。
 */

/** 稳定对象标识。外部输入须验证 UUID 格式；ID 或 generation 本身均不授予权限。 */
export type Id = string;

/** UTC RFC 3339 时间字符串。边界统一规范为带 Z 的毫秒精度；禁止以客户端时间裁决租约。 */
export type UtcTimestamp = string;

/** SQLite自增事件ID的十进制字符串；不是UUID，也不能转成可能丢精度的JavaScript number。 */
export type EventCursor = string;

/** 当前只交付本地目录、NFS和SMB挂载；对象存储适配按需后置。 */
export type StorageProtocol = "local" | "nfs" | "smb";

/** 瞬时资源观测，只供压力与准入判断，不能替代容量Claim账本。 */
export interface ResourcePressure {
  /** 可用内存，MiB。 */
  readonly availableMemoryMiB: number;
  /** 批准工作根的可用空间，MiB。 */
  readonly availableScratchMiB: number;
  /** 采样窗口CPU忙碌百分比，范围0–100。 */
  readonly cpuBusyPercent: number;
}

/** 内容或规范化参数的 SHA-256 摘要。运行时验证编码格式；摘要不替代认证和权限检查。 */
export type Sha256 = string;

/** 可原生执行的 CPU 架构。未列出的架构不通过静默模拟提供。 */
export type Architecture = "amd64" | "arm64";

/** 操作系统族；分别用于物理宿主与镜像客体时，以字段上下文为准。 */
export type HostOs = "linux" | "windows" | "macos";

/** 调度后端标识。portainer 为当前交付；hyperv/tart 为后置扩展。 */
export type ProviderKind = "portainer" | "hyperv" | "tart";

/** 通过物理宿主 Agent 执行的 VM 后端；不包含 Docker 管理入口。 */
export type NativeProviderKind = "hyperv" | "tart";

/** 申请的隔离环境种类，不表示业务任务类型。 */
export type ResourceKind = "container" | "vm";

/** 放置范围。v1 仅 local_only；云扩容需后续版本显式增加合同。 */
export type Locality = "local_only";

/** 能力验证状态。只有 verified 可满足要求该能力的请求。 */
export type Verification = "unsupported" | "unverified" | "verified";

/** 可序列化 JSON 值；不允许函数、undefined、NaN 或循环引用。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | {
      readonly [key: string]: JsonValue;
    };

/** 身份角色。实际允许动作还受对象范围和 scopes 限制。 */
export type Role = "viewer" | "consumer" | "operator" | "admin";

/** HTTP 错误信封。code 稳定供程序分支，message 可变供显示；details 必须脱敏。 */
export interface ApiErrorResponse {
  /** 脱敏的结构化错误；不能复制原始 Provider 响应。 */
  readonly error: {
    /** 稳定错误码，供程序进行分支处理。 */
    readonly code: string;
    /** 已脱敏的可读说明，不用于程序匹配。 */
    readonly message: string;
    /** 脱敏结构化错误上下文。 */
    readonly details: Readonly<Record<string, JsonValue>>;
    /** 是否允许按恢复策略重试；不说明副作用是否已经发生。 */
    readonly retryable: boolean;
    /** 本次 HTTP 调用的追踪 ID；网络重试可有新 requestId，但复用幂等键。 */
    readonly requestId: Id;
  };
}

/** 可变实体的审计与 CAS 字段。每次持久状态更新递增 version，使用旧值作写入条件。 */
export interface Versioned {
  /** 当前实体 CAS 版本；写入必须匹配旧版本后递增。 */
  readonly version: number; // 正整数，控制端 CAS。
  /** 记录创建时间。 */
  readonly createdAt: UtcTimestamp;
  /** 最近持久状态更新时间。 */
  readonly updatedAt: UtcTimestamp;
}

/** 整数资源数量，单位写在字段名中。资源池可为零；有效实例 CPU/内存必须大于零。 */
export interface ResourceAmounts {
  /** CPU 时间预算，1000 表示一个逻辑 CPU；整数，不承诺独占物理核心。 */
  readonly cpuMillis: number; // 1000 = 一个逻辑 CPU 的时间预算，并非独占物理核。
  /** 内存预算，单位 MiB；整数。 */
  readonly memoryMiB: number;
  /** 临时可写空间预算，单位 MiB；实际硬限制能力单独验证。 */
  readonly scratchMiB: number;
}

/** 可选加速器需求。由明确验证的能力匹配，不从显卡存在推断可出租。 */
export interface AcceleratorRequirement {
  /** 加速器运行接口类型。 */
  readonly api: "cuda" | "metal" | "video_codec" | "other";
  /** api=other 时的规范接口名；其他类型省略。 */
  readonly apiName?: string;
  /** 设备所需最小显存，单位 MiB；省略表示不增加该限制。 */
  readonly minimumMemoryMiB?: number;
  /** 必须全部满足的加速器特性；空数组表示无附加特性。 */
  readonly requiredFeatures: readonly string[];
}

/** 服务端归一化的容量合同。v1 request 与 limit 完全相等；不是消费者需要重复填写的输入。 */
export interface ResourceContract {
  /** 记账预留资源；v1 与 limit 完全相等。 */
  readonly request: ResourceAmounts;
  /** 执行端必须施加的资源上限；v1 与 request 完全相等。 */
  readonly limit: ResourceAmounts;
  /** required 要求经过验证的硬限额；best_effort 只是明确的空间预算。 */
  readonly scratchEnforcement: "required" | "best_effort";
  /** 隔离强度；不能把共享内核容器视为独立内核。 */
  readonly isolation: "shared_kernel" | "virtual_machine";
  /** 加速器需求；首版默认为空，非空必须匹配专项验证。 */
  readonly accelerators: readonly AcceleratorRequirement[]; // v1 默认 []；非空须能力匹配。
}

/** 执行端读回并验证的实际限制；配置请求成功不等于这些值已生效。 */
export interface EffectiveResources {
  /** 执行端读回的实际资源上限。 */
  readonly limits: ResourceAmounts;
  /** CPU 限额的实际实施强度。 */
  readonly cpuEnforcement: "hard";
  /** 内存限额的实际实施强度。 */
  readonly memoryEnforcement: "hard";
  /** required 要求已验证硬配额；best_effort 仅预算和监控。 */
  readonly scratchEnforcement: "hard" | "best_effort";
  /** 已分配设备或分区的稳定引用。 */
  readonly acceleratorAssignments: readonly Id[];
}

/** 观测发生时间、控制端接收时间与来源；两种时间不得混用。 */
export interface ObservationMetadata {
  /** 事实在执行端被观测的时间。 */
  readonly observedAt: UtcTimestamp;
  /** 控制端收到观测的时间，用于新鲜度判断。 */
  readonly receivedAt: UtcTimestamp;
  /** 经过识别的观测来源。 */
  readonly source: string;
}

/** 请求明确依赖的能力名称；只能匹配 verified 状态。 */
export type RequiredCapability =
  | "offlineLeaseEnforcement"
  | "cpuHardLimit"
  | "memoryHardLimit"
  | "scratchHardLimit"
  | "networkPolicyEnforcement";

/** 资源申请阶段；ready 包含未接用和使用中，业务是否完成由消费者决定。 */
export type TicketState =
  | "queued"
  | "reserved"
  | "provisioning"
  | "ready"
  | "releasing"
  | "released";

/** 首次终止原因。独立于清理状态，后续重试不得改写。 */
export type TerminalReason =
  | "consumer_release"
  | "consumer_cancel"
  | "queue_timeout"
  | "provision_timeout"
  | "provision_failed"
  | "unclaimed_timeout"
  | "lease_expired"
  | "max_lifetime"
  | "resource_lost"
  | "admin_revoke";

/** 资源清理进展。blocked 代表仍占容量；complete 才允许回收结束。 */
export type CleanupStatus =
  | "not_needed"
  | "pending"
  | "running"
  | "blocked"
  | "complete";

/** 稳定分页结果。nextCursor 为 null 时没有下一页，不用空字符串表示。 */
export interface CursorPage<T> {
  /** 当前页按权限过滤后的结果。 */
  readonly items: readonly T[];
  /** 下一页不透明游标；null 表示结束。 */
  readonly nextCursor: string | null;
}

/** 至少含一个元素的只读列表；外部 JSON 仍须运行时检查非空和去重。 */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/** 消费者填写一次资源数量；服务端生成等额 request/limit。省略策略按已授权的镜像/系统默认解析。 */
export interface RequestedResources extends ResourceAmounts {
  /** 省略默认 best_effort；required 只匹配真实硬配额能力。 */
  readonly scratchEnforcement?: ResourceContract["scratchEnforcement"];
  /** 省略时 container=shared_kernel、vm=virtual_machine。 */
  readonly isolation?: ResourceContract["isolation"];
  /** 省略默认空数组，不申请任何硬件加速器。 */
  readonly accelerators?: readonly AcceleratorRequirement[];
}

/** 不透明游标分页。默认 50、最大 200；游标不代表访问权限。 */
export interface PageQuery {
  /** 上页返回的不透明游标，省略表示首页。 */
  readonly cursor?: string;
  /** 当前上下文中的上限；分页为默认 50、最大 200。 */
  readonly limit?: number;
}

/** 租约授权状态，独立于 Ticket 阶段和资源实际状态。 */
export type LeaseState = "pending" | "active" | "revoking" | "revoked";

/** 镜像版本发布状态；draft/validating 不接受普通消费者申请。 */
export type ImageVersionStatus =
  | "draft"
  | "validating"
  | "published"
  | "deprecated"
  | "blocked";
