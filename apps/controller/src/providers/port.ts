import type { ResourceContract } from "@hitchlet/contracts";
import type { EffectiveResources } from "@hitchlet/contracts/internal";

export type PortainerEvidence = Readonly<{
  engineId: string;
  dockerVersion: string;
  apiVersion: string;
  minimumApiVersion: string;
  os: string;
  architecture: string;
  portainerVersion: string;
  cpuCount: number;
  memoryBytes: number;
  containerCount: number;
  unmanagedContainerCount: number;
}>;
export type PortainerProbe = (input: {
  endpointUrl: string;
  environmentId: string;
  apiKey: string;
}) => Promise<PortainerEvidence>;

export type { EffectiveResources };

export type NetworkDestination = Readonly<{
  cidr: string;
  protocol: "tcp" | "udp";
  ports: readonly number[];
}>;
export type NetworkDenyRule =
  | Readonly<{ cidr: string; protocol: "any"; ports: "any" }>
  | Readonly<{
      cidr: string;
      protocol: "tcp" | "udp";
      ports: "any" | readonly number[];
    }>;
export type StorageProtocol = "nfs" | "smb" | "local";
export type RuntimeBinding = Readonly<{
  runtimeIdentityId: string;
  connectionRevisionId: string;
}>;
export type ProvisionIdentity = RuntimeBinding &
  Readonly<{
    installationId: string;
    allocationId: string;
    generation: number;
    operationId: string;
    controlVersion: number;
    purpose: "tenant" | "validation";
  }>;
export type ProvisionPlan = Readonly<{
  deadlineMs: number;
  runtimeConfig?: Readonly<Record<string, unknown>>;
  identity: ProvisionIdentity;
  artifact: Readonly<{ id: string; ref: string; digest: string }>;
  resources: ResourceContract;
  resolved: Readonly<{
    id: string;
    contractHash: string;
    selectionHash: string;
    network: Readonly<{
      grantId: string;
      revisionId: string;
      frozenPlatformDenyRevisionId: string;
      platformDenyRevisionId: string;
      mode: "isolated_bridge";
      ipv6: "disabled" | "verified_equivalent";
      allowedEgress: readonly NetworkDestination[];
      allowedIngressSourceCidrs: readonly string[];
      managementDenyRules: readonly NetworkDenyRule[];
      enforcement: "docker_iptables";
      verificationRequired: true;
    }>;
    mounts: readonly Readonly<{
      grantId: string;
      grantRevision: 1;
      revisionId: string;
      protocol: StorageProtocol;
      authorizedSubpath: string;
      approvedSourceRef: string;
      resolvedSourceRef: string;
      sourceValidationEvidenceId: string;
      target: string;
      mode: "read_only" | "read_write";
      secretVersionRef: string | null;
    }>[];
  }>;
  /** Cleanup has its own short command deadline; the create deadline stays frozen. */
  executionPhase?: "provision" | "cleanup" | "observe";
  /** Persisted resources supplied only to cleanup so a missing container does
   * not erase the original network ports/bridge facts needed to revoke rules. */
  cleanupResources?: readonly OwnedResource[];
  accessProtocol: "ssh" | "rdp";
  bootstrap: Readonly<{
    mechanism: string;
    contractVersion: string;
    identityReset: true;
  }>;
  access: Readonly<{
    accessProtocols: readonly ("ssh" | "rdp")[];
    ports: readonly number[];
    account: string;
    allowedSourceCidrs: readonly string[];
    discovery: string;
    readiness: string;
  }>;
}>;
export type OwnedResource = Readonly<{
  id: string;
  kind:
    | "container"
    | "network_policy"
    | "endpoint"
    | "storage_reference"
    | "volume";
  ownership: "owned" | "reference";
  referenceKey?: string;
  /** Provider-only inspectable facts persisted alongside the receipt. */
  details?: Readonly<Record<string, unknown>>;
  identity: ProvisionIdentity;
  contractHash: string;
  evidence: Readonly<{
    artifactDigest: string;
    resourcesHash: string;
    networkHash: string;
    mountsHash: string;
    accessProtocol: "ssh" | "rdp";
  }>;
}>;
export type InventoryEvidence = Readonly<{
  completeness: "complete" | "incomplete";
  runtime: RuntimeBinding;
  identity: ProvisionIdentity;
  objects: readonly OwnedResource[];
}>;
export type Inspection =
  | {
      presence: "present";
      evidence: InventoryEvidence;
      /** Populated only by an explicit read-only integrity inspection. */
      integrity?: Readonly<{
        state: "healthy" | "lost";
        reason?: string;
      }>;
    }
  | {
      presence: "absent";
      evidence: Readonly<{
        completeness: "complete";
        runtime: RuntimeBinding;
        identity: ProvisionIdentity;
      }>;
    }
  | {
      presence: "unknown";
      reason: "runtime_identity_mismatch" | "inventory_incomplete";
    };
export type ReadyReceipt = Readonly<{
  identity: ProvisionIdentity;
  artifactDigest: string;
  contractHash: string;
  manifestId: string;
  manifestHash: string;
  objectIds: readonly string[];
  effectiveResources: EffectiveResources;
  networkRevisionId: string;
  networkContractHash: string;
  mountContractHash: string;
  accessProtocol: "ssh" | "rdp";
  bootstrapComplete: true;
  offlineLeaseEnforcement: "unsupported";
  access?: Readonly<{
    host: string;
    port: number;
    username: string;
    hostKeyFingerprint: string;
    clientPublicKeyFingerprint: string;
  }>;
}>;

export type CleanupReceipt = Readonly<{
  resourceId: string;
  kind: OwnedResource["kind"];
  runtime: RuntimeBinding;
  identity: ProvisionIdentity;
  presence: "absent";
  networkRules: "removed" | "never_installed" | "not_applicable";
  verifiedAtMs: number;
  agentResult?: Readonly<Record<string, unknown>>;
}>;

export type CreateEffect = Readonly<{
  kind: "network_policy" | "volume" | "container";
  name: string;
  requestHash: string;
}>;

export interface ResourceJournal {
  /** Durable unknown intent precedes a Portainer create; an existing intent must never resend. */
  beforeCreate?(effect: CreateEffect): Promise<void>;
  /** Check the durable operation fence immediately before each new side effect. */
  assertActive?(): Promise<void>;
  /** Persist each verified side effect immediately; failure leaves capacity reserved for reconciliation. */
  recordCreated(resource: OwnedResource): Promise<void>;
}

/** Small internal D04 execution boundary; providers return evidence, never Ticket state. */
export interface ExecutionPort {
  create(
    plan: ProvisionPlan,
    journal: ResourceJournal,
  ): Promise<readonly OwnedResource[]>;
  inspect(plan: ProvisionPlan): Promise<Inspection>;
  ready(
    plan: ProvisionPlan,
    inventory: InventoryEvidence,
  ): Promise<ReadyReceipt>;
  revokeStop(plan: ProvisionPlan): Promise<void>;
  destroy(
    plan: ProvisionPlan,
    resource: OwnedResource,
  ): Promise<CleanupReceipt | void>;
}
