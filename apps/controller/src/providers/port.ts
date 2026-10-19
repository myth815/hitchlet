import type { ResourceAmounts, ResourceContract } from "@hitchlet/contracts";
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
    purpose: "tenant";
  }>;
export type ProvisionPlan = Readonly<{
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
  accessProtocol: "ssh" | "rdp";
}>;
export type OwnedResource = Readonly<{
  id: string;
  kind: "container" | "network_policy" | "endpoint" | "storage_reference";
  ownership: "owned" | "reference";
  referenceKey?: string;
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
  | { presence: "present"; evidence: InventoryEvidence }
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
  manifestHash: string;
  objectIds: readonly string[];
  effectiveResources: EffectiveResources;
  networkRevisionId: string;
  networkContractHash: string;
  mountContractHash: string;
  accessProtocol: "ssh" | "rdp";
  bootstrapComplete: true;
  offlineLeaseEnforcement: "unsupported";
}>;

export interface ResourceJournal {
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
  destroy(plan: ProvisionPlan, resource: OwnedResource): Promise<void>;
}
