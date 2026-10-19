/**
 * 编译期契约回归；使用 tsc --noEmit 检查，不作为运行时测试执行。
 * 保护公开边界、状态收窄、输入简化和命令/结果关联。
 */
import type * as Public from './public';
import type {
  ActiveLeaseView,
  AcquireRequest,
  ComputeClient,
  ConsumerAccessEndpoint,
  ImageSelector,
  LeaseRenewalView,
  ReadyTicketView,
  RenewReceipt,
  TicketView,
  PreparedTicketCommand,
  TicketCommandResult,
} from './public';
import type { Allocation, AllocationOwner, OwnedResourceRef, RuntimeIdentity, Consumer, ConsumerAuthorization, FrozenStorageGrant, NetworkDestination, MachineSnapshot } from './domain';
import type { AcceptedLeaseRequest, EventCursor, ResourceEvent } from './public';
import type { StorageProtocol } from './common';
import type {
  AllocationOperationContext,
  AllocationOperationIdentity,
  CreateReceipt,
  DiscoveryOperationContext,
  OperationContext,
  OperationResult,
  ResourceOperationContext,
  ResourceProvider,
  ProvisionPlan,
} from './provider';
import type { NetworkDenyRule } from './domain';
import type {
  AgentCommand,
  AgentCommandResult,
  LocalStopTarget,
  ShutdownAcceptedReceipt,
  NativeProviderPayloads,
  NativeProviderResults,
  NativeProviderCommand,
  AgentControlCommand,
  DockerNetworkCommand,
  ControlCommandResults,
} from './agent';
import type { CommandContext, TicketService } from './services';
type Assert<T extends true> = T;
type Not<T extends boolean> = T extends true ? false : true;
type Extends<A, B> = [A] extends [B] ? true : false;
type Equal<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;
// 正向：默认 Docker 请求只需三项，资源数量只填写一次。
export const minimalRequest = {
  image: { versionId: '00000000-0000-4000-8000-000000000101' },
  resources: { cpuMillis: 2000, memoryMiB: 4096, scratchMiB: 20480 },
  networkProfileId: '00000000-0000-4000-8000-000000000201',
} as const satisfies AcquireRequest;
type ExactImageNeedsNoParent = Assert<Extends<{
  versionId: string;
}, ImageSelector>>;
type AliasStillNeedsParent = Assert<Not<Extends<{
  alias: string;
}, ImageSelector>>>;
type ImageModesExclusive = Assert<Not<Extends<{
  versionId: string;
  imageId: string;
  alias: string;
}, ImageSelector>>>;
type ExplicitArchitecturesNotEmpty = Assert<Not<Extends<readonly [], NonNullable<AcquireRequest['allowedArchitectures']>>>>;
type ExplicitNodeFilterNotEmpty = Assert<Not<Extends<readonly [], NonNullable<AcquireRequest['allowedNodeIds']>>>>;
type RequestedResourcesNoDuplicatedLimit = Assert<Not<Extends<'limit', keyof AcquireRequest['resources']>>>;
// 公开实体显式白名单：内部新增字段不自动泄漏。
type PublicTicketHasNoGrantSnapshot = Assert<Not<Extends<'acceptedProfiles', keyof TicketView>>>;
type PublicTicketHasNoRequestHash = Assert<Not<Extends<'requestHash', keyof TicketView>>>;
type PublicTicketHasNoIdempotencyRecord = Assert<Not<Extends<'idempotencyKey', keyof TicketView>>>;
type PublicEndpointHasNoSecretLocator = Assert<Not<Extends<'secretClaimRef', keyof ConsumerAccessEndpoint>>>;
type PublicEndpointHasNoInternalResource = Assert<Not<Extends<'ref', keyof ConsumerAccessEndpoint>>>;
// @ts-expect-error 内部可信身份不能从公开入口导入。
type PublicActorMustNotExist = Public.Actor;
// @ts-expect-error Provider 执行端口不属于消费者包。
type PublicProviderMustNotExist = Public.ResourceProvider;
// 按状态收窄后，调用方不再手工断言 ! 或 as。
type ConfirmedRenewal = Extract<LeaseRenewalView, {
  state: 'confirmed';
}>;
type PendingRenewal = Extract<LeaseRenewalView, {
  state: 'pending';
}>;
type ConfirmedMustHaveReceipt = Assert<Equal<ConfirmedRenewal['confirmedReceipt'], RenewReceipt>>;
type PendingMustNotHaveReceipt = Assert<Equal<PendingRenewal['confirmedReceipt'], null>>;
type ReadyHasActiveLease = Assert<Equal<ReadyTicketView['lease'], ActiveLeaseView>>;
type SDKRenewOnlyReturnsConfirmed = Assert<Equal<Awaited<ReturnType<ComputeClient['tickets']['renew']>>, RenewReceipt>>;
// 互斥归属和后端身份组合。
type ValidValidationOwner = Assert<Extends<{
  purpose: 'validation';
  ticketId: null;
  imageValidationId: string;
}, AllocationOwner>>;
type ValidationCannotOwnTicket = Assert<Not<Extends<{
  purpose: 'validation';
  ticketId: string;
  imageValidationId: string;
}, AllocationOwner>>>;
type DockerCannotUseTartIdentity = Assert<Not<Extends<{
  id: string;
  provider: 'portainer';
  nativeKind: 'tart_host';
  nativeId: string;
  createdAt: string;
}, RuntimeIdentity>>>;
type ValidationLeaseAlwaysNull = Assert<Equal<Extract<Allocation, {
  purpose: 'validation';
}>['leaseId'], null>>;
type LocalStopReusesExactReference = Assert<Equal<LocalStopTarget, OwnedResourceRef>>;
// 执行上下文不能缺少已验证身份；只读发现例外不能调用 create。
type ResourceContextRequiresIdentity = Assert<Equal<ResourceOperationContext['runtimeIdentityId'], string>>;
type ResourceContextRequiresRevision = Assert<Equal<ResourceOperationContext['connectionRevisionId'], string>>;
type DiscoveryIdentityMustBeEmpty = Assert<Equal<DiscoveryOperationContext['runtimeIdentityId'], null>>;
type GenericContextCannotCreate = Assert<Not<Extends<OperationContext, AllocationOperationContext>>>;
type CreateRequiresAllocationContext = Assert<Equal<Parameters<ResourceProvider['create']>[0], AllocationOperationContext>>;
type ServiceHasOneTrustedContext = Assert<Equal<Parameters<TicketService['acquire']>[0], CommandContext>>;
// 网络规则和命令/回执类型关联。
type ValidWholeHostDeny = Assert<Extends<{
  cidr: string;
  protocol: 'any';
  ports: 'any';
}, NetworkDenyRule>>;
type AnyProtocolCannotHaveSpecificPorts = Assert<Not<Extends<{
  cidr: string;
  protocol: 'any';
  ports: readonly [
    443
  ];
}, NetworkDenyRule>>>;
type ExplicitPortsNotEmpty = Assert<Not<Extends<{
  cidr: string;
  protocol: 'tcp';
  ports: readonly [];
}, NetworkDenyRule>>>;
type PowerCommit = Extract<AgentCommand, {
  kind: 'power.commit';
}>;
type PowerOutput = Extract<AgentCommandResult<PowerCommit>, {
  phase: 'succeeded';
}>['output'];
type PowerAcceptsShutdownReceipt = Assert<Extends<OperationResult<ShutdownAcceptedReceipt>, PowerOutput>>;
type PowerRejectsCreateReceipt = Assert<Not<Extends<OperationResult<CreateReceipt>, PowerOutput>>>;
type InterimReplyHasNoOutput = Assert<Equal<Extract<AgentCommandResult<PowerCommit>, {
  phase: 'accepted' | 'running';
}>['output'], null>>;
type NativeActionsHaveAllResults = Assert<Equal<keyof NativeProviderPayloads, keyof NativeProviderResults>>;
type ControlActionsHaveAllResults = Assert<Equal<AgentControlCommand['kind'] | DockerNetworkCommand['kind'], keyof ControlCommandResults>>;
type CreateWireHasAllocationContext = Assert<Equal<Extract<NativeProviderCommand, { action: 'create' }>['operation'], AllocationOperationIdentity>>;
type SavedRenewal = Extract<PreparedTicketCommand, { kind: 'renew' }>;
type SavedRenewalHasOriginalVersion = Assert<Equal<SavedRenewal['request']['expectedLeaseVersion'], number>>;
type SavedRenewalHasNoToken = Assert<Not<Extends<'token', keyof SavedRenewal>>>;
type ResumeKeepsConfirmedReturn = Assert<Equal<TicketCommandResult<SavedRenewal>, RenewReceipt>>;
type FrozenTtlLimitIsPresent = Assert<Equal<AcceptedLeaseRequest['maximumTtlSeconds'], number>>;
type ConsumerScopeIsExplicit = Assert<Equal<Consumer['authorization'], ConsumerAuthorization>>;
type ScopeMayExplicitlyDenyAll = Assert<Extends<readonly [], ConsumerAuthorization['nodeIds']>>;
type ReservationMayAwaitResolution = Assert<Extends<null, Allocation['resolvedProvisionContractId']>>;
type ProviderCannotCreateWithoutResolution = Assert<Not<Extends<null, ProvisionPlan['resolved']>>>;
type EventCursorIsLosslessString = Assert<Equal<ResourceEvent['id'], EventCursor>>;
type FrozenStorageProtocolIsExplicit = Assert<Equal<FrozenStorageGrant['protocol'], StorageProtocol>>;
type HostSnapshotStatesAreExplicit = Assert<Equal<MachineSnapshot['probeStatus'], 'complete' | 'partial' | 'failed'>>;
type EmptyEgressPortRuleIsRejected = Assert<Not<Extends<readonly [], NetworkDestination['ports']>>>;
