import { TartNodeRuntimeConfigSchema } from "@hitchlet/contracts/admin";
import type { TartRuntimeFacts } from "@hitchlet/contracts/internal";
import type { TartAllocationIdentity } from "@hitchlet/contracts/internal";
import {
  tartRuntimeFactsForNode,
  createTartRuntimeClient,
} from "./runtime-credentials.js";
import type {
  ResolvedTartCleanupRuntime,
  ResolvedTartRuntime,
} from "./tart-provider.js";
import type { ProvisionPlan } from "./port.js";
import type { TartExecutionProviderOptions } from "./tart-provider.js";
import { probeTartSsh } from "./tart-ssh-readiness.js";
import type { LocalSecretStore } from "../storage/secret-store.js";
import type { Storage } from "../storage/index.js";
import type { RuntimeAgentJsonTransport } from "./runtime-network-client.js";

const TART_FACTS_TIMEOUT_MS = 30_000;

export function createTartReadinessPorts(): Pick<
  TartExecutionProviderOptions,
  "ssh"
> {
  return { ssh: { verify: probeTartSsh } };
}

export type TartRuntimeBinding = Readonly<{
  profile: unknown;
  secrets: { get(ref: string): Promise<string> };
  installationId: string;
  runtimeIdentityId: string;
  connectionRevisionId: string;
  nativeRuntimeNamespaceId: string;
  controllerEpoch: number;
}>;

/** Resolve the current authenticated transport from the exact frozen operation and its Tart Node. */
export async function resolveTartExecutionRuntime(
  storage: Storage,
  secrets: LocalSecretStore,
  plan: ProvisionPlan,
  controllerEpoch: number,
  now = Date.now(),
): Promise<ResolvedTartRuntime> {
  const row = await storage.get<{
    installation_id: string;
    runtime_identity_id: string;
    native_runtime_namespace_id: string;
    connection_revision_id: string;
    config_json: string;
  }>(
    `SELECT i.installation_id,a.runtime_identity_id,ri.native_id AS native_runtime_namespace_id,
            operation.connection_revision_id,n.config_json
       FROM allocations a
       JOIN operations operation ON operation.id=? AND operation.allocation_id=a.id
       JOIN nodes n ON n.id=a.node_id AND n.runtime_identity_id=a.runtime_identity_id AND n.backend_kind='tart'
       JOIN runtime_identities ri ON ri.id=a.runtime_identity_id AND ri.backend_kind='tart' AND ri.native_kind='tart_host'
       JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=ri.id AND pc.backend_kind='tart' AND pc.enabled=1
       JOIN provider_connection_revisions current_revision ON current_revision.id=pc.current_revision_id AND current_revision.connection_id=pc.id AND current_revision.verified_runtime_identity_id=ri.id
       JOIN provider_connection_revisions frozen_revision ON frozen_revision.id=operation.connection_revision_id AND frozen_revision.connection_id=pc.id AND frozen_revision.verified_runtime_identity_id=ri.id
       JOIN installations i ON i.singleton=1
      WHERE a.id=? AND a.runtime_identity_id=? AND a.generation=? AND a.control_version=?
        AND operation.generation=a.generation AND operation.control_version=a.control_version
        AND operation.connection_revision_id=? AND i.installation_id=?`,
    [
      plan.identity.operationId,
      plan.identity.allocationId,
      plan.identity.runtimeIdentityId,
      plan.identity.generation,
      plan.identity.controlVersion,
      plan.identity.connectionRevisionId,
      plan.identity.installationId,
    ],
  );
  if (!row)
    throw new Error(
      "Frozen Tart operation, revision, or exact Node is unavailable",
    );

  const nodeConfig = parseJsonRecord(row.config_json);
  if (nodeConfig.executionMode !== "tart")
    throw new Error("Exact Tart Node is not configured for Tart execution");
  return resolveTartRuntimeFromAgent(
    plan,
    {
      profile: TartNodeRuntimeConfigSchema.parse(nodeConfig.runtimeProfile),
      secrets,
      installationId: row.installation_id,
      runtimeIdentityId: row.runtime_identity_id,
      connectionRevisionId: row.connection_revision_id,
      nativeRuntimeNamespaceId: row.native_runtime_namespace_id,
      controllerEpoch,
    },
    now,
  );
}

/** Resolve only read/stop/delete methods from an active, exact cleanup operation. */
export async function resolveTartCleanupRuntime(
  storage: Storage,
  secrets: LocalSecretStore,
  plan: ProvisionPlan,
  authorization: NonNullable<ProvisionPlan["cleanupAuthorization"]>,
  controllerEpoch: number,
  now = Date.now(),
  transport?: RuntimeAgentJsonTransport,
): Promise<ResolvedTartCleanupRuntime> {
  if (
    plan.executionPhase !== "cleanup" ||
    authorization.createOperationId !== plan.identity.operationId ||
    !authorization.ownerToken
  )
    throw new Error("Tart cleanup authorization is invalid");
  const row = await storage.get<{
    installation_id: string;
    runtime_identity_id: string;
    native_runtime_namespace_id: string;
    connection_revision_id: string;
    config_json: string;
  }>(
    `SELECT i.installation_id,a.runtime_identity_id,ri.native_id AS native_runtime_namespace_id,
            cleanup.connection_revision_id,n.config_json
       FROM operations cleanup
       JOIN allocations a ON a.id=cleanup.allocation_id
       JOIN operations created ON created.id=? AND created.allocation_id=a.id AND created.kind='allocation.provision'
       JOIN nodes n ON n.id=a.node_id AND n.runtime_identity_id=a.runtime_identity_id AND n.backend_kind='tart'
       JOIN runtime_identities ri ON ri.id=a.runtime_identity_id AND ri.backend_kind='tart' AND ri.native_kind='tart_host'
       JOIN provider_connections pc ON pc.id=n.provider_connection_id AND pc.runtime_identity_id=ri.id AND pc.backend_kind='tart'
       JOIN provider_connection_revisions current_revision ON current_revision.id=pc.current_revision_id AND current_revision.connection_id=pc.id AND current_revision.verified_runtime_identity_id=ri.id
       JOIN provider_connection_revisions frozen_revision ON frozen_revision.id=cleanup.connection_revision_id AND frozen_revision.connection_id=pc.id AND frozen_revision.verified_runtime_identity_id=ri.id
       JOIN installations i ON i.singleton=1
      WHERE cleanup.id=? AND cleanup.kind='allocation.cleanup' AND cleanup.state='running'
        AND cleanup.owner_token=? AND cleanup.version=? AND cleanup.locked_until_ms>?
        AND cleanup.generation=a.generation AND cleanup.control_version=a.control_version
        AND cleanup.runtime_identity_id=a.runtime_identity_id AND cleanup.connection_revision_id=?
        AND created.generation=a.generation AND created.runtime_identity_id=a.runtime_identity_id
        AND created.connection_revision_id=cleanup.connection_revision_id AND created.control_version<=a.control_version
        AND json_extract(cleanup.intent_json,'$.purpose')=? AND json_extract(created.intent_json,'$.purpose')=?
        AND json_extract(cleanup.intent_json,'$.executionMode')='tart' AND json_extract(created.intent_json,'$.executionMode')='tart'
        AND a.purpose=? AND cleanup.controller_epoch=?
        AND cleanup.installation_id IS NULL AND created.installation_id IS NULL
        AND i.controller_epoch=?
        AND a.desired_state='absent' AND a.id=? AND a.runtime_identity_id=?
        AND a.generation=? AND a.control_version=? AND i.installation_id=?
        AND ri.id=? AND pc.id=n.provider_connection_id
        AND current_revision.verified_runtime_identity_id=ri.id
        AND frozen_revision.verified_runtime_identity_id=ri.id`,
    [
      authorization.createOperationId,
      authorization.cleanupOperationId,
      authorization.ownerToken,
      authorization.operationVersion,
      now,
      plan.identity.connectionRevisionId,
      plan.identity.purpose,
      plan.identity.purpose,
      plan.identity.purpose,
      controllerEpoch,
      controllerEpoch,
      plan.identity.allocationId,
      plan.identity.runtimeIdentityId,
      plan.identity.generation,
      plan.identity.controlVersion,
      plan.identity.installationId,
      plan.identity.runtimeIdentityId,
    ],
  );
  if (!row)
    throw new Error(
      "Exact Tart cleanup operation or current revision is unavailable",
    );
  const nodeConfig = parseJsonRecord(row.config_json);
  if (nodeConfig.executionMode !== "tart")
    throw new Error("Exact Tart Node is not configured for Tart cleanup");
  const profile = TartNodeRuntimeConfigSchema.parse(nodeConfig.runtimeProfile);
  const remainingMs = plan.deadlineMs - now;
  if (remainingMs < 1) throw new Error("Tart cleanup deadline has expired");
  const facts = await tartRuntimeFactsForNode(
    {
      profile,
      secrets,
      installationId: row.installation_id,
      runtimeIdentityId: row.runtime_identity_id,
    },
    Math.min(TART_FACTS_TIMEOUT_MS, remainingMs),
    transport,
  );
  if (
    facts.nativeRuntimeNamespaceId !== row.native_runtime_namespace_id ||
    facts.hostOS !== "macos" ||
    facts.hostArch !== "arm64"
  )
    throw new Error("Tart cleanup Runtime Agent identity changed");
  const client = createTartRuntimeClient(
    {
      profile,
      secrets,
      installationId: row.installation_id,
      runtimeIdentityId: row.runtime_identity_id,
      controllerEpoch,
      deadlineMs: plan.deadlineMs,
    },
    transport,
  );
  const boundIdentity: TartAllocationIdentity = {
    installationId: plan.identity.installationId,
    runtimeIdentityId: plan.identity.runtimeIdentityId,
    connectionRevisionId: plan.identity.connectionRevisionId,
    allocationId: plan.identity.allocationId,
    generation: plan.identity.generation,
    operationId: plan.identity.operationId,
    controlVersion: plan.identity.controlVersion,
    purpose: plan.identity.purpose,
  };
  return {
    runtimeIdentityId: row.runtime_identity_id,
    connectionRevisionId: row.connection_revision_id,
    artifactDigest: plan.artifact.digest,
    runtime: {
      inspect: (identity) => {
        assertCleanupIdentity(identity, boundIdentity);
        return client.inspect(boundIdentity);
      },
      revokeNetwork: (identity, network) => {
        assertCleanupIdentity(identity, boundIdentity);
        return client.revokeNetwork(boundIdentity, network);
      },
      destroy: (identity) => {
        assertCleanupIdentity(identity, boundIdentity);
        return client.destroy(boundIdentity);
      },
    },
  };
}

function assertCleanupIdentity(
  actual: TartAllocationIdentity,
  expected: TartAllocationIdentity,
): void {
  if (
    actual.installationId !== expected.installationId ||
    actual.runtimeIdentityId !== expected.runtimeIdentityId ||
    actual.connectionRevisionId !== expected.connectionRevisionId ||
    actual.allocationId !== expected.allocationId ||
    actual.generation !== expected.generation ||
    actual.operationId !== expected.operationId ||
    actual.controlVersion !== expected.controlVersion ||
    actual.purpose !== expected.purpose
  )
    throw new Error(
      "Tart cleanup action identity differs from its authorization",
    );
}

/** Resolve from live authenticated facts and sealed template evidence, never from config hash alone. */
export async function resolveTartRuntimeFromAgent(
  plan: ProvisionPlan,
  binding: TartRuntimeBinding,
  now = Date.now(),
): Promise<ResolvedTartRuntime> {
  const profile = TartNodeRuntimeConfigSchema.parse(binding.profile);
  if (
    binding.installationId !== plan.identity.installationId ||
    binding.runtimeIdentityId !== plan.identity.runtimeIdentityId ||
    binding.connectionRevisionId !== plan.identity.connectionRevisionId
  )
    throw new Error("Tart Runtime Agent does not match the frozen plan");

  const remainingMs = plan.deadlineMs - now;
  if (remainingMs < 1)
    throw new Error("Tart Runtime Agent action deadline has expired");
  const facts = await tartRuntimeFactsForNode(
    {
      profile,
      secrets: binding.secrets,
      installationId: binding.installationId,
      runtimeIdentityId: binding.runtimeIdentityId,
    },
    Math.min(TART_FACTS_TIMEOUT_MS, remainingMs),
  );
  assertFactsMatchPlan(facts, binding, plan, now);

  return {
    runtimeIdentityId: binding.runtimeIdentityId,
    connectionRevisionId: binding.connectionRevisionId,
    artifactDigest: plan.artifact.digest,
    template: facts.templates.find(
      (proof) => proof.templateRef.name === plan.artifact.ref,
    )!.templateRef,
    runtime: createTartRuntimeClient({
      profile,
      secrets: binding.secrets,
      installationId: binding.installationId,
      runtimeIdentityId: binding.runtimeIdentityId,
      controllerEpoch: binding.controllerEpoch,
      deadlineMs: plan.deadlineMs,
    }),
  };
}

export function assertFactsMatchPlan(
  facts: TartRuntimeFacts,
  binding: TartRuntimeBinding,
  plan: ProvisionPlan,
  now = Date.now(),
): void {
  if (
    facts.nativeRuntimeNamespaceId !== binding.nativeRuntimeNamespaceId ||
    facts.hostOS !== "macos" ||
    facts.hostArch !== "arm64" ||
    (plan.artifact.guestOS !== "linux" && plan.artifact.guestOS !== "macos") ||
    plan.artifact.architecture !== "arm64"
  )
    throw new Error("Tart Runtime Agent does not match the frozen plan");

  const matches = facts.templates.filter(
    (proof) => proof.templateRef.name === plan.artifact.ref,
  );
  if (matches.length !== 1)
    throw new Error("Frozen Tart template proof is unavailable or ambiguous");
  const proof = matches[0]!;
  const expectedTemplateOS =
    plan.artifact.guestOS === "macos" ? "darwin" : "linux";
  if (
    proof.proofKind !== "sealed_local_bundle_v1" ||
    proof.artifactDigest !== plan.artifact.digest ||
    proof.templateRef.source !== "local" ||
    proof.templateRef.guestOS !== expectedTemplateOS ||
    proof.templateRef.guestArch !== plan.artifact.architecture ||
    !Number.isFinite(Date.parse(proof.sealedAt)) ||
    Date.parse(proof.sealedAt) > now
  )
    throw new Error(
      "Tart sealed template proof does not match the frozen artifact",
    );
}

function parseJsonRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Exact Tart Node configuration is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Exact Tart Node configuration is invalid");
  return parsed as Record<string, unknown>;
}
