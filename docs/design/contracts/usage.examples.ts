/**
 * 消费者接入示例。只描述调用顺序，不创建网络客户端、不在导入时执行任务。
 * 真实客户端由已实现的 @hitchlet/sdk HitchletClient 提供并注入认证；可执行接入和管理恢复示例见 docs/api-sdk.md。此文件只做编译期调用合同校验。
 */
import type { AccessGrant, ComputeClient, Id, PreparedTicketCommand, RenewReceipt } from './public';

/** 申请、等待就绪、明确接用，再领取连接材料。幂等键应由调用方保存以便恢复。 */
export async function openDevelopmentEnvironment(client: ComputeClient, imageVersionId: Id, networkProfileId: Id, idempotencyKey: string): Promise<{
  readonly ticketId: Id;
  readonly access: AccessGrant;
}> {
  const { ticket } = await client.tickets.acquire({
    image: { versionId: imageVersionId },
    resources: { cpuMillis: 2000, memoryMiB: 4096, scratchMiB: 20480 },
    networkProfileId,
  }, { idempotencyKey });
  await client.tickets.waitUntilReady(ticket.id, { timeoutMilliseconds: 1200000 });
  // claim 内部等待原续租记录 confirmed；未确定结果会抛带恢复引用的错误。
  await client.tickets.claim(ticket.id, { idempotencyKey: `${idempotencyKey}:claim` });
  const access = await client.tickets.getAccess(ticket.id);
  return { ticketId: ticket.id, access };
}

/** 使用过程中显式续租。调用方应按已确认 expiresAt 安排下一次续租。 */
export async function keepEnvironment(client: ComputeClient, ticketId: Id): Promise<void> {
  const receipt = await client.tickets.renew(ticketId, { requestedTtlSec: 900 });
  // 实际调用方在此记录 receipt.expiresAt，并在其之前调度下一次续租。
  void receipt;
}

/** 仅在调用方已经保存持久数据后调用；取消等待不会取消后台清理。 */
export async function returnEnvironmentAfterSaving(client: ComputeClient, ticketId: Id): Promise<void> {
  await client.tickets.release(ticketId, { reclaimable: true });
  await client.tickets.waitUntilReleased(ticketId, { timeoutMilliseconds: 300000 });
}

/** 需要跨进程恢复的 Agent：发送前持久化完整准备请求，而不只保存幂等键。 */
export async function renewWithRecovery(
  client: ComputeClient,
  ticketId: Id,
  persist: (command: PreparedTicketCommand) => Promise<void>,
): Promise<RenewReceipt> {
  return client.tickets.renew(ticketId, { requestedTtlSec: 900 }, { onPrepared: persist });
}

/** 恢复时复用原请求体和版本，不再调用普通 renew 重新读取版本。 */
export async function resumeSavedRenewal(
  client: ComputeClient,
  command: Extract<PreparedTicketCommand, { kind: 'renew' }>,
): Promise<RenewReceipt> {
  return client.tickets.resume(command);
}
