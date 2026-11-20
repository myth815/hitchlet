import {
  PortainerRequestError,
  requestStage,
  failureCategory,
  assertContainerRunning,
  type PortainerFailure,
} from "./portainer-request-error.js";
import { resourceManifest } from "../domain/resource-manifest.js";
import { supportsContainerEntrypoint } from "@hitchlet/contracts/internal";
import { createHash, randomUUID } from "node:crypto";
import { probeSsh } from "./ssh-readiness.js";
import type {
  RuntimeStorageRequest,
  RuntimeStorageResult,
  RuntimeNetworkCommand,
  RuntimeNetworkPlan,
  RuntimeNetworkResult,
} from "@hitchlet/contracts/internal";
import { runtimeMemberLinkSchema } from "@hitchlet/contracts/internal";
import {
  containerMembers,
  memberNativeName,
  groupAddresses,
  containerIpv4,
  runtimeLinksForResources,
  groupContainerBody,
} from "./container-group.js";
import {
  buildRuntimeNetworkCommand,
  buildRuntimeNetworkPlan,
  hashRuntimeNetworkRules,
} from "./runtime-network-client.js";
import type {
  ExecutionPort,
  PortainerEvidence,
  CleanupReceipt,
  CreateEffect,
  Inspection,
  InventoryEvidence,
  OwnedResource,
  ProvisionPlan,
  ReadyReceipt,
  ResourceJournal,
} from "./port.js";
import type { RuntimeNetworkPort } from "./runtime-network-port.js";
import type { SQLiteAccessMaterialStore } from "../storage/access-material-store.js";
import { dockerImageReferencePath } from "../domain/docker-image-reference.js";
import { supportsNodeSshRecipe } from "../domain/docker-recipe.js";

type RuntimeAccess = Readonly<{
  endpointUrl: string;
  environmentId: string;
  apiKey: string;
  engineId: string;
  providerEvidence: Pick<
    PortainerEvidence,
    "dockerVersion" | "portainerVersion"
  >;
  agentId: string;
  controllerEpoch: number;
  networkCidrBase: string;
  ingressSourceCidrs: readonly string[];
  effectiveDenyRevisionId: string;
  accessHost: string;
  userlandProxy: boolean;
  managementDenyRules: ProvisionPlan["resolved"]["network"]["managementDenyRules"];
  runtimeNetwork: RuntimeNetworkPort;
  storageLowWaterMiB?: number;
  storageReserveMiB?: number;
  storageFacts?: (
    request: RuntimeStorageRequest,
  ) => Promise<RuntimeStorageResult>;
}>;
type Json = Record<string, unknown>;

/**
 * Portainer adapter for the deliberately narrow Linux Docker capability set.
 * Every operation re-authenticates and compares Engine ID before inspecting or
 * mutating resources. Resource labels locate candidates; their complete frozen
 * ownership tuple must match before a candidate is ever treated as managed.
 */
export class PortainerExecutionProvider implements ExecutionPort {
  constructor(
    private readonly resolveRuntime: (
      plan: ProvisionPlan,
    ) => Promise<RuntimeAccess>,
    private readonly accessMaterials: Pick<
      SQLiteAccessMaterialStore,
      "getOrCreate"
    >,
    private readonly now = Date.now,
  ) {}

  async resolveMounts(
    plan: ProvisionPlan,
  ): Promise<ProvisionPlan["resolved"]["mounts"]> {
    if (!plan.resolved.mounts.length) return [];
    const runtime = await this.runtime(plan, true);
    if (!runtime.storageFacts)
      throw new Error("Runtime Agent storage facts unavailable");
    const facts = await runtime.storageFacts({
      requestId: randomUUID(),
      installationId: plan.identity.installationId,
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      nativeEngineId: runtime.engineId,
      inventory: false,
      mounts: plan.resolved.mounts.map((m) => ({
        grantId: m.grantId,
        revisionId: m.revisionId,
        approvedSourceRef: m.approvedSourceRef,
        authorizedSubpath: m.authorizedSubpath,
        protocol: m.protocol,
        secretVersionRef: m.secretVersionRef,
        target: m.target,
        mode: m.mode,
      })),
    });
    return plan.resolved.mounts.map((m) => {
      const found = facts.mounts.find((f) => f.grantId === m.grantId);
      if (!found) throw new Error("Incomplete mount facts");
      return { ...m, ...found };
    });
  }
  private async assertStorageCapacity(plan: ProvisionPlan): Promise<void> {
    const runtime = await this.runtime(plan, true);
    if (!runtime.storageFacts)
      throw new Error("Runtime Agent image-store facts unavailable");
    const facts = await runtime.storageFacts({
      requestId: randomUUID(),
      installationId: plan.identity.installationId,
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      nativeEngineId: runtime.engineId,
      mounts: [],
      inventory: false,
    });
    const reserve = runtime.storageReserveMiB ?? 128,
      low = runtime.storageLowWaterMiB ?? 1024;
    if (
      facts.imageStore.availableMiB <= low ||
      facts.imageStore.availableMiB <
        plan.resources.request.scratchMiB + reserve
    )
      throw new Error("Runtime image-store is below admission reserve");
  }
  private async assertMounts(plan: ProvisionPlan): Promise<void> {
    if (!plan.resolved.mounts.length) return;
    const fresh = await this.resolveMounts(plan);
    if (JSON.stringify(fresh) !== JSON.stringify(plan.resolved.mounts))
      throw new Error("Frozen storage source changed");
  }
  private storageReferences(plan: ProvisionPlan): OwnedResource[] {
    return plan.resolved.mounts.map((m) => ({
      ...this.owned(plan, `storage:${m.grantId}`, "storage_reference", {
        persistent: true,
        source: m.resolvedSourceRef,
        target: m.target,
        mode: m.mode,
      }),
      ownership: "reference" as const,
      referenceKey: m.revisionId,
    }));
  }

  async create(
    plan: ProvisionPlan,
    journal: ResourceJournal,
  ): Promise<readonly OwnedResource[]> {
    assertDockerRecipe(plan);
    if (plan.containerGroup) return this.createGroup(plan, journal);
    await this.assertStorageCapacity(plan);
    await this.assertMounts(plan);
    await journal.assertActive?.();
    const runtime = await this.runtime(plan, true);
    const accessMaterial =
      plan.accessProtocol === "none"
        ? undefined
        : await this.accessMaterials.getOrCreate(plan.identity.allocationId);
    const name = resourceName(plan);
    const labels = ownershipLabels(plan);
    const prior = await this.inspect(plan);
    if (prior.presence === "unknown")
      throw new Error(
        "Cannot resume Docker creation while ownership is unknown",
      );
    const priorObjects =
      prior.presence === "present" ? prior.evidence.objects : [];
    const priorNetwork = priorObjects.find(
      (item) => item.kind === "network_policy",
    );
    const priorVolume = priorObjects.find((item) => item.kind === "volume");
    const priorContainer = priorObjects.find(
      (item) => item.kind === "container",
    );
    await journal.assertActive?.();
    const network = priorNetwork
      ? { Id: priorNetwork.id }
      : await this.createNative(
          journal,
          runtime,
          "network_policy",
          name,
          "networks/create",
          {
            Name: name,
            Driver: "bridge",
            CheckDuplicate: true,
            Internal: false,
            Attachable: false,
            EnableIPv6: plan.resolved.network.ipv6 === "verified_equivalent",
            Labels: labels,
          },
        );
    const networkId = requiredString(network.Id, "Docker network ID");
    const networkReadback = await this.request(
      runtime,
      "GET",
      `networks/${encodeURIComponent(networkId)}`,
    );
    if (
      networkReadback.Id !== networkId ||
      networkReadback.Name !== name ||
      !matchesOwnership(record(networkReadback.Labels), plan)
    )
      throw new Error(
        "Created Docker network does not match its frozen owner and name",
      );
    let networkResource = this.owned(plan, networkId, "network_policy", {
      networkName: name,
      ...networkFacts(networkReadback, networkId),
    });
    await journal.recordCreated(networkResource);

    await journal.assertActive?.();
    const volume = priorVolume
      ? { Name: priorVolume.id }
      : await this.createNative(
          journal,
          runtime,
          "volume",
          `${name}-workspace`,
          "volumes/create",
          {
            Name: `${name}-workspace`,
            Driver: "local",
            Labels: labels,
          },
        );
    const volumeName = requiredString(volume.Name, "Docker workspace volume");
    const volumeReadback = await this.request(
      runtime,
      "GET",
      `volumes/${encodeURIComponent(volumeName)}`,
    );
    if (
      volumeReadback.Name !== `${name}-workspace` ||
      !matchesOwnership(record(volumeReadback.Labels), plan)
    )
      throw new Error(
        "Created Docker volume does not match its frozen owner and name",
      );
    const volumeResource = this.owned(plan, volumeName, "volume", {
      temporary: true,
    });
    await journal.recordCreated(volumeResource);

    const local = await this.request(runtime, "GET", "info");
    const architecture = dockerArchitecture(local.Architecture);
    await this.verifyDistributionArtifact(
      runtime,
      plan.artifact.ref,
      plan.artifact.digest,
      architecture,
    );
    let image = await this.inspectImage(
      runtime,
      plan.artifact.ref,
      plan.artifact.digest,
      architecture,
    );
    if (!image) {
      await this.pullImage(runtime, plan.artifact.ref);
      await this.verifyDistributionArtifact(
        runtime,
        plan.artifact.ref,
        plan.artifact.digest,
        architecture,
      );
      image = await this.inspectImage(
        runtime,
        plan.artifact.ref,
        plan.artifact.digest,
        architecture,
      );
    }
    if (!image)
      throw new Error(
        "Pinned artifact digest is not present on the selected Engine",
      );

    const portBindings = bindingsFor(plan);
    const exposed = Object.fromEntries(
      Object.keys(portBindings).map((port) => [port, {}]),
    );
    await journal.assertActive?.();
    const container = priorContainer
      ? { Id: priorContainer.id }
      : await this.createNative(
          journal,
          runtime,
          "container",
          name,
          `containers/create?name=${encodeURIComponent(name)}`,
          {
            Image: plan.artifact.ref,
            Cmd: [],
            ...(plan.accessProtocol === "none" ? { User: "1000:1000" } : {}),
            Hostname: `h-${plan.identity.allocationId.slice(0, 12)}`,
            Labels: labels,
            ExposedPorts: exposed,
            HostConfig: {
              NetworkMode: name,
              PortBindings: portBindings,
              AutoRemove: false,
              RestartPolicy: { Name: "no" },
              ReadonlyRootfs: false,
              Privileged: false,
              PublishAllPorts: false,
              Binds: [],
              CapDrop: ["ALL"],
              CapAdd: [
                "CHOWN",
                "DAC_OVERRIDE",
                "FOWNER",
                "SETGID",
                "SETUID",
                "SYS_CHROOT",
                "NET_BIND_SERVICE",
              ],
              SecurityOpt: ["no-new-privileges:true"],
              CpuQuota: Math.floor(plan.resources.limit.cpuMillis * 100),
              CpuPeriod: 100_000,
              Memory: plan.resources.limit.memoryMiB * 1024 * 1024,
              MemorySwap: plan.resources.limit.memoryMiB * 1024 * 1024,
              PidsLimit: 512,
              Sysctls: {
                "net.ipv6.conf.all.disable_ipv6": "1",
                "net.ipv6.conf.default.disable_ipv6": "1",
              },
              Mounts: [
                ...plan.resolved.mounts.map((m) => ({
                  Type: "bind",
                  Source: m.resolvedSourceRef,
                  Target: m.target,
                  ReadOnly: m.mode === "read_only",
                  BindOptions: { Propagation: "rprivate", NonRecursive: true },
                })),
                {
                  Type: "volume",
                  Source: volumeName,
                  Target: "/workspace",
                  ReadOnly: false,
                },
              ],
            },
            NetworkingConfig: { EndpointsConfig: { [name]: {} } },
          },
        );
    const containerId = requiredString(container.Id, "Docker container ID");
    const containerReadback = await this.request(
      runtime,
      "GET",
      `containers/${encodeURIComponent(containerId)}/json`,
    );
    if (
      containerReadback.Id !== containerId ||
      containerReadback.Name !== `/${name}` ||
      !matchesOwnership(record(record(containerReadback.Config).Labels), plan)
    )
      throw new Error(
        "Created Docker container does not match its frozen owner and name",
      );
    const existingDetail = priorContainer ? containerReadback : undefined;
    if (
      accessMaterial &&
      (!existingDetail || record(existingDetail.State).Running !== true)
    )
      await this.putArchive(
        runtime,
        `containers/${encodeURIComponent(containerId)}/archive?path=%2Frun%2Fhitchlet`,
        tarFile(
          "authorized_keys",
          Buffer.from(`${accessMaterial.publicKey}\n`),
        ),
      );
    const containerResource = this.owned(plan, containerId, "container", {
      name,
      imageId: image.Id,
      workspaceVolume: volumeName,
    });
    await journal.recordCreated(containerResource);
    if (
      existingDetail &&
      !containerMatchesFrozen(
        existingDetail,
        plan,
        image.Id,
        volumeName,
        name,
        undefined,
        networkId,
      )
    )
      throw new Error(
        "Existing Docker container no longer matches its frozen contract",
      );

    // Identity, engine and actual bindings are inspected before the host rule
    // is installed. Container remains stopped until the agent acknowledges it.
    const inspectedNetwork = await this.request(
      runtime,
      "GET",
      `networks/${encodeURIComponent(networkId)}`,
    );
    if (inspectedNetwork.Id !== networkId || inspectedNetwork.Name !== name)
      throw new Error(
        "Docker network readback does not match the created network",
      );
    networkResource = this.owned(plan, networkId, "network_policy", {
      networkName: name,
      ...networkFacts(inspectedNetwork, networkId),
    });
    await journal.recordCreated(networkResource);
    // No container config/attachment mutation occurs after the owned readback;
    // SSH archive injection changes files only. Reuse it instead of a second
    // identical pre-start inspect. Running attachment is checked by ready().
    const inspectedContainer = containerReadback;
    if (plainBridge(plan)) {
      this.assertNativeBridge(
        plan,
        runtime,
        inspectedNetwork,
        [inspectedContainer],
        "before_start",
      );
    } else {
      const networkPlan = this.networkPlan(
        plan,
        runtime,
        networkId,
        name,
        [containerId],
        undefined,
        inspectedContainer,
        inspectedNetwork,
      );
      await journal.recordCreated(
        this.owned(plan, networkId, "network_policy", {
          networkName: name,
          ...networkFacts(inspectedNetwork, networkId),
          publishedPorts: networkPlan.publishedPorts,
        }),
      );
      await journal.assertActive?.();
      const ensured = await this.agentCommand(
        plan,
        runtime,
        networkPlan,
        "network.ensure",
      );
      assertNetworkResult(
        ensured,
        plan,
        runtime,
        "installed",
        networkPlan.expectedRulesetHash,
      );
      const verified = await this.agentCommand(
        plan,
        runtime,
        networkPlan,
        "network.inspect",
      );
      assertNetworkResult(
        verified,
        plan,
        runtime,
        "present",
        networkPlan.expectedRulesetHash,
      );
    }
    await this.assertStorageCapacity(plan);
    await this.assertMounts(plan);
    await journal.assertActive?.();
    if (record(inspectedContainer.State).Running !== true)
      await this.request(
        runtime,
        "POST",
        `containers/${encodeURIComponent(containerId)}/start`,
        undefined,
        [304],
      );
    const started = await this.request(
      runtime,
      "GET",
      `containers/${encodeURIComponent(containerId)}/json`,
    );
    assertContainerRunning(started, containerId, "container_start");
    const startedPorts = containerPorts(started);
    await journal.recordCreated(
      this.owned(plan, containerId, "container", {
        name,
        imageId: image.Id,
        workspaceVolume: volumeName,
        hostPort: startedPorts[0]?.hostPort ?? null,
        hostAddress: startedPorts[0]?.hostAddress ?? null,
      }),
    );
    const completedNetwork = this.owned(plan, networkId, "network_policy", {
      networkName: name,
      ...networkFacts(inspectedNetwork, networkId),
      publishedPorts: startedPorts.map((port) => ({
        containerId,
        protocol: port.protocol,
        hostPort: port.hostPort,
        containerPort: port.containerPort,
        hostAddress: port.hostAddress,
      })),
    });
    await journal.recordCreated(completedNetwork);
    const references = this.storageReferences(plan);
    for (const reference of references) await journal.recordCreated(reference);
    return [completedNetwork, volumeResource, containerResource, ...references];
  }

  private async groupImage(
    runtime: RuntimeAccess,
    member: ProvisionPlan,
  ): Promise<Json> {
    const architecture = dockerArchitecture(
      (await this.request(runtime, "GET", "info")).Architecture,
    );
    await this.verifyDistributionArtifact(
      runtime,
      member.artifact.ref,
      member.artifact.digest,
      architecture,
    );
    let image = await this.inspectImage(
      runtime,
      member.artifact.ref,
      member.artifact.digest,
      architecture,
    );
    if (!image) {
      await this.pullImage(runtime, member.artifact.ref);
      await this.verifyDistributionArtifact(
        runtime,
        member.artifact.ref,
        member.artifact.digest,
        architecture,
      );
      image = await this.inspectImage(
        runtime,
        member.artifact.ref,
        member.artifact.digest,
        architecture,
      );
    }
    if (!image)
      throw new Error(
        "Pinned member image is unavailable on the selected Engine",
      );
    return image;
  }

  private async createGroup(
    plan: ProvisionPlan,
    journal: ResourceJournal,
  ): Promise<readonly OwnedResource[]> {
    const members = containerMembers(plan);
    await this.assertStorageCapacity(plan);
    await this.assertMounts(plan);
    await journal.assertActive?.();
    const runtime = await this.runtime(plan, true),
      name = resourceName(plan),
      labels = ownershipLabels(plan);
    const prior = await this.inspect(plan);
    if (prior.presence === "unknown")
      throw new Error("Cannot resume group with unknown ownership");
    const objects = prior.presence === "present" ? prior.evidence.objects : [];
    const priorNetwork = objects.find((o) => o.kind === "network_policy");
    const createdNetwork = priorNetwork
      ? { Id: priorNetwork.id }
      : await this.createNative(
          journal,
          runtime,
          "network_policy",
          name,
          "networks/create",
          {
            Name: name,
            Driver: "bridge",
            CheckDuplicate: true,
            Internal: false,
            Attachable: false,
            EnableIPv6: false,
            Labels: labels,
          },
        );
    const networkId = requiredString(createdNetwork.Id, "Group network ID");
    const network = await this.request(
      runtime,
      "GET",
      `networks/${encodeURIComponent(networkId)}`,
    );
    if (
      network.Id !== networkId ||
      network.Name !== name ||
      !matchesOwnership(record(network.Labels), plan)
    )
      throw new Error("Group network readback differs from its frozen owner");
    const networkResource = this.owned(plan, networkId, "network_policy", {
      networkName: name,
      ...networkFacts(network, networkId),
    });
    await journal.recordCreated(networkResource);
    const volumeName = `${name}-workspace`,
      stateVolumeName = `${name}-gateway-state`;
    for (const v of [
      { name: volumeName, memberName: "workload", target: "/workspace" },
      {
        name: stateVolumeName,
        memberName: "gateway",
        target: plan.containerGroup!.gateway.stateMountPath,
      },
    ]) {
      if (!objects.some((o) => o.kind === "volume" && o.id === v.name))
        await this.createNative(
          journal,
          runtime,
          "volume",
          v.name,
          "volumes/create",
          {
            Name: v.name,
            Driver: "local",
            Labels: { ...labels, "io.hitchlet.member": v.memberName },
          },
          v.memberName === "gateway" ? "volume_gateway" : undefined,
        );
      const volume = await this.request(
        runtime,
        "GET",
        `volumes/${encodeURIComponent(v.name)}`,
      );
      if (
        volume.Name !== v.name ||
        !matchesOwnership(record(volume.Labels), plan) ||
        record(volume.Labels)["io.hitchlet.member"] !== v.memberName
      )
        throw new Error("Group volume ownership differs");
      await journal.recordCreated(
        this.owned(plan, v.name, "volume", {
          temporary: true,
          memberName: v.memberName,
          target: v.target,
        }),
      );
    }
    const ips = groupAddresses(subnetAddress(network), gatewayAddress(network));
    const created: Array<{
      id: string;
      detail: Json;
      member: (typeof members)[number];
    }> = [];
    for (const member of members) {
      const memberVolumeName =
        member.name === "gateway" ? stateVolumeName : volumeName;
      const image = await this.groupImage(runtime, member.plan);
      const nativeName = memberNativeName(name, member.name);
      const priorContainer = objects.find(
        (o) => o.kind === "container" && o.details?.memberName === member.name,
      );
      const labelsForMember = { ...labels, "io.hitchlet.member": member.name };
      const container = priorContainer
        ? { Id: priorContainer.id }
        : await this.createNative(
            journal,
            runtime,
            "container",
            nativeName,
            `containers/create?name=${encodeURIComponent(nativeName)}`,
            groupContainerBody(
              member.plan,
              name,
              memberVolumeName,
              member.name,
              ips[member.name],
              labelsForMember,
              member.name === "gateway"
                ? plan.containerGroup!.gateway.environment
                : undefined,
            ),
            member.name === "gateway" ? "container_gateway" : undefined,
          );
      const id = requiredString(container.Id, "Group member ID");
      const detail = await this.request(
        runtime,
        "GET",
        `containers/${encodeURIComponent(id)}/json`,
      );
      if (
        detail.Id !== id ||
        detail.Name !== `/${nativeName}` ||
        !matchesOwnership(record(record(detail.Config).Labels), plan) ||
        record(record(detail.Config).Labels)["io.hitchlet.member"] !==
          member.name ||
        containerIpv4(detail, name) !== ips[member.name] ||
        !containerMatchesFrozen(
          detail,
          member.plan,
          image.Id,
          memberVolumeName,
          name,
          member.name === "gateway"
            ? plan.containerGroup!.gateway.environment
            : undefined,
          networkId,
        )
      )
        throw new Error(
          "Group member differs from frozen image, limits, mounts or network identity",
        );
      await journal.recordCreated(
        this.owned(plan, id, "container", {
          memberName: member.name,
          ipv4: ips[member.name],
          name: nativeName,
          imageId: image.Id,
          networkName: name,
        }),
      );
      created.push({ id, detail, member });
    }
    const bindingResources = created.map((c) =>
      this.owned(plan, c.id, "container", {
        memberName: c.member.name,
        ipv4: ips[c.member.name],
      }),
    );
    const memberLinks = runtimeLinksForResources(plan, bindingResources);
    if (!memberLinks) throw new Error("Group link bindings are incomplete");
    // Persist the exact revocation input before any rule can be installed.
    const boundNetwork = this.owned(plan, networkId, "network_policy", {
      ...networkResource.details,
      memberLinks,
      publishedPorts: [],
    });
    await journal.recordCreated(boundNetwork);
    if (plainBridge(plan)) {
      this.assertNativeBridge(
        plan,
        runtime,
        network,
        created.map((c) => c.detail),
        "before_start",
      );
    } else {
      const agentPlan = this.networkPlan(
        plan,
        runtime,
        networkId,
        name,
        created.map((c) => c.id),
        [],
        undefined,
        network,
        memberLinks,
      );
      const ensured = await this.agentCommand(
        plan,
        runtime,
        agentPlan,
        "network.ensure",
      );
      assertNetworkResult(
        ensured,
        plan,
        runtime,
        "installed",
        agentPlan.expectedRulesetHash,
      );
      const checked = await this.agentCommand(
        plan,
        runtime,
        agentPlan,
        "network.inspect",
      );
      assertNetworkResult(
        checked,
        plan,
        runtime,
        "present",
        agentPlan.expectedRulesetHash,
      );
    }
    for (const c of created) {
      await journal.assertActive?.();
      if (record(c.detail.State).Running !== true)
        await this.request(
          runtime,
          "POST",
          `containers/${encodeURIComponent(c.id)}/start`,
          undefined,
          [304],
        );
      const started = await this.request(
        runtime,
        "GET",
        `containers/${encodeURIComponent(c.id)}/json`,
      );
      assertContainerRunning(started, c.id, "container_start");
      if (containerIpv4(started, name) !== ips[c.member.name])
        throw new Error("Group member start or assigned IP was not verified");
      await journal.recordCreated(
        this.owned(plan, c.id, "container", {
          memberName: c.member.name,
          ipv4: ips[c.member.name],
          name: memberNativeName(name, c.member.name),
          networkName: name,
        }),
      );
    }
    const references = this.storageReferences(plan);
    for (const r of references) await journal.recordCreated(r);
    const final = await this.inspect(plan);
    if (final.presence !== "present")
      throw new Error("Group inventory is incomplete after start");
    // The bound link facts must survive cleanup after either container disappears.
    return final.evidence.objects.map((o) =>
      o.kind === "network_policy" ? boundNetwork : o,
    );
  }

  private async readyGroup(
    plan: ProvisionPlan,
    _inventory: InventoryEvidence,
  ): Promise<ReadyReceipt> {
    await this.assertMounts(plan);
    if (plan.resources.scratchEnforcement === "required")
      throw new Error("Group scratch hard limits are unsupported");
    const runtime = await this.runtime(plan, true);
    const inspection = await this.inspect({
      ...plan,
      executionPhase: "provision",
    });
    if (inspection.presence !== "present")
      throw new Error("Group inventory is unavailable");
    const objects = inspection.evidence.objects;
    const networkResource = objects.find((o) => o.kind === "network_policy"),
      volume = objects.find(
        (o) => o.kind === "volume" && o.details?.memberName === "workload",
      );
    const members = containerMembers(plan);
    if (
      !networkResource ||
      !volume ||
      objects.filter((o) => o.kind === "container").length !== members.length
    )
      throw new Error("Group owned membership is incomplete");
    const architecture = dockerArchitecture(
      (await this.request(runtime, "GET", "info")).Architecture,
    );
    const observedMembers: Json[] = [];
    for (const member of members) {
      const owned = objects.find(
        (o) => o.kind === "container" && o.details?.memberName === member.name,
      );
      const memberVolume = objects.find(
        (o) => o.kind === "volume" && o.details?.memberName === member.name,
      );
      if (!owned || !memberVolume)
        throw new Error("Group member or state volume is missing");
      const detail = await this.request(
        runtime,
        "GET",
        `containers/${encodeURIComponent(owned.id)}/json`,
      );
      assertContainerRunning(detail, owned.id, "readiness");
      observedMembers.push(detail);
      const image = await this.inspectImage(
        runtime,
        member.plan.artifact.ref,
        member.plan.artifact.digest,
        architecture,
      );
      if (
        !image ||
        !containerMatchesFrozen(
          detail,
          member.plan,
          image.Id,
          memberVolume.id,
          resourceName(plan),
          member.name === "gateway"
            ? plan.containerGroup!.gateway.environment
            : undefined,
          networkResource.id,
        )
      )
        throw new Error(
          "Group readiness differs from its frozen resource contract",
        );
    }
    const network = await this.request(
      runtime,
      "GET",
      `networks/${encodeURIComponent(networkResource.id)}`,
    );
    const memberLinks = runtimeLinksForResources(plan, objects);
    if (!memberLinks) throw new Error("Group link inventory is incomplete");
    if (plainBridge(plan)) {
      this.assertNativeBridge(plan, runtime, network, observedMembers);
    } else {
      const networkPlan = this.networkPlan(
        plan,
        runtime,
        networkResource.id,
        resourceName(plan),
        objects.filter((o) => o.kind === "container").map((o) => o.id),
        [],
        undefined,
        network,
        memberLinks,
      );
      const verified = await this.agentCommand(
        plan,
        runtime,
        networkPlan,
        "network.inspect",
      );
      assertNetworkResult(
        verified,
        plan,
        runtime,
        "present",
        networkPlan.expectedRulesetHash,
      );
    }
    return {
      identity: plan.identity,
      artifactDigest: plan.artifact.digest,
      contractHash: plan.resolved.contractHash,
      ...resourceManifest(plan, objects),
      objectIds: objects.map((o) => o.id).sort(),
      effectiveResources: {
        limits: {
          cpuMillis: plan.resources.limit.cpuMillis,
          memoryMiB: plan.resources.limit.memoryMiB,
          scratchMiB: 0,
        },
        cpuEnforcement: "hard",
        memoryEnforcement: "hard",
        scratchEnforcement: "best_effort",
        acceleratorAssignments: [],
      },
      networkRevisionId: plan.resolved.network.revisionId,
      networkContractHash: sha256(plan.resolved.network),
      mountContractHash: sha256(plan.resolved.mounts),
      accessProtocol: "none",
      bootstrapComplete: true,
      offlineLeaseEnforcement: "unsupported",
    };
  }

  /** Native Docker bridge delivery: no host policy, sysctl, or Runtime network action. */
  private assertNativeBridge(
    plan: ProvisionPlan,
    runtime: RuntimeAccess,
    network: Json,
    containers: readonly Json[],
    phase: "before_start" | "running" = "running",
  ) {
    const fail = (
      reasonCode: NonNullable<PortainerFailure["reasonCode"]>,
    ): never => {
      throw new PortainerRequestError({
        provider: "portainer",
        stage:
          phase === "before_start" ? "container_create" : "container_start",
        category: "configuration_mismatch",
        reasonCode,
      });
    };
    const subnet = subnetAddress(network);
    if (
      network.Name !== resourceName(plan) ||
      network.Driver !== "bridge" ||
      network.Internal !== false ||
      network.EnableIPv6 !== false ||
      !matchesOwnership(record(network.Labels), plan) ||
      !cidrContains(runtime.networkCidrBase, subnet)
    )
      fail("bridge_contract_mismatch");
    for (const container of containers) {
      const host = record(container.HostConfig);
      if (!matchesOwnership(record(record(container.Config).Labels), plan))
        fail("container_identity_mismatch");
      if (host.NetworkMode !== network.Name && host.NetworkMode !== network.Id)
        fail("container_network_mode_mismatch");
      if (host.Privileged === true) fail("container_privilege_mismatch");
      if (
        host.PublishAllPorts === true ||
        Object.keys(record(host.PortBindings)).length ||
        containerPorts(container).length
      )
        fail("container_published_port_mismatch");
      const attachments = Object.entries(
        record(record(container.NetworkSettings).Networks),
      );
      if (attachments.length !== 1)
        fail("container_network_attachment_mismatch");
      const endpoint = record(attachments[0]?.[1]);
      const state = record(container.State);
      const pending =
        phase === "before_start" &&
        state.Running === false &&
        state.Status === "created";
      if (
        pending &&
        (endpoint.NetworkID === undefined || endpoint.NetworkID === "") &&
        attachments[0]?.[0] !== network.Name &&
        attachments[0]?.[0] !== network.Id
      )
        fail("container_network_attachment_mismatch");
      // Docker fills endpoint operational facts during start. An explicit
      // foreign ID is never acceptable, even on an unstarted container.
      if (
        pending
          ? endpoint.NetworkID !== undefined &&
            endpoint.NetworkID !== "" &&
            endpoint.NetworkID !== network.Id
          : endpoint.NetworkID !== network.Id
      )
        fail("container_network_id_mismatch");
      if (
        state.Running === true &&
        (typeof endpoint.IPAddress !== "string" ||
          !endpoint.IPAddress ||
          !cidrContains(subnet, `${endpoint.IPAddress}/32`))
      )
        fail("container_network_address_mismatch");
    }
    const running = containers
      .filter((c) => record(c.State).Running === true)
      .map((c) => String(c.Id))
      .sort();
    if (
      running.length &&
      JSON.stringify(Object.keys(record(network.Containers)).sort()) !==
        JSON.stringify(running)
    )
      fail("bridge_membership_mismatch");
  }

  private async createNative(
    journal: ResourceJournal,
    runtime: RuntimeAccess,
    kind: CreateEffect["kind"],
    name: string,
    path: string,
    body: Json,
    key?: CreateEffect["key"],
  ): Promise<Json> {
    if (!journal.beforeCreate)
      throw new Error(
        "Portainer create requires a durable before-create journal",
      );
    await journal.beforeCreate({
      kind,
      name,
      requestHash: sha256({ method: "POST", path, body }),
      ...(key === undefined ? {} : { key }),
    });
    // A timeout, transport error or unclassified rejection remains unknown. Never infer non-execution from it.
    return this.request(runtime, "POST", path, body);
  }

  async inspect(plan: ProvisionPlan): Promise<Inspection> {
    let runtime: RuntimeAccess;
    try {
      runtime = await this.runtime(plan, plan.executionPhase === "observe");
    } catch {
      return { presence: "unknown", reason: "runtime_identity_mismatch" };
    }
    try {
      const candidates = await this.requestArray(
        runtime,
        "containers/json?all=true",
      );
      if (!Array.isArray(candidates))
        return { presence: "unknown", reason: "inventory_incomplete" };
      const owned: OwnedResource[] = [];
      for (const raw of candidates) {
        const item = record(raw);
        const labels = record(item.Labels);
        const names = Array.isArray(item.Names) ? item.Names : [];
        const member = containerMembers(plan).find((m) =>
          names.some(
            (n) =>
              typeof n === "string" &&
              n.replace(/^\//, "") ===
                memberNativeName(resourceName(plan), m.name),
          ),
        );
        const expectedName = member
          ? memberNativeName(resourceName(plan), member.name)
          : resourceName(plan);
        const nameCandidate = names.some(
          (name) =>
            typeof name === "string" &&
            name.replace(/^\//, "") === expectedName,
        );
        if (
          (hasPartialOwnership(labels, plan) &&
            !matchesOwnership(labels, plan)) ||
          (nameCandidate && !matchesOwnership(labels, plan))
        )
          return { presence: "unknown", reason: "inventory_incomplete" };
        if (!matchesOwnership(labels, plan)) continue;
        const id = requiredString(item.Id, "Docker container ID");
        const detail = await this.request(
          runtime,
          "GET",
          `containers/${encodeURIComponent(id)}/json`,
        );
        if (
          detail.Id !== id ||
          detail.Name !== `/${expectedName}` ||
          (plan.containerGroup !== undefined &&
            (!member ||
              record(detail.Config).Labels === undefined ||
              record(record(detail.Config).Labels)["io.hitchlet.member"] !==
                member.name)) ||
          !matchesOwnership(
            record(detail.Config && record(detail.Config).Labels),
            plan,
          )
        )
          return { presence: "unknown", reason: "inventory_incomplete" };
        const ports = containerPorts(detail);
        owned.push(
          this.owned(plan, id, "container", {
            nativeName:
              typeof detail.Name === "string"
                ? detail.Name.replace(/^\//, "")
                : null,
            state: record(detail.State).Status,
            imageId:
              typeof detail.Image === "string"
                ? detail.Image
                : record(detail.Image).Id,
            networkName: record(detail.HostConfig).NetworkMode,
            restartPolicy: record(record(detail.HostConfig).RestartPolicy).Name,
            running: record(detail.State).Running === true,
            cpuQuota: Number(record(detail.HostConfig).CpuQuota),
            cpuPeriod: Number(record(detail.HostConfig).CpuPeriod),
            memoryBytes: Number(record(detail.HostConfig).Memory),
            memorySwapBytes: Number(record(detail.HostConfig).MemorySwap),
            hostPort: ports[0]?.hostPort ?? null,
            hostAddress: ports[0]?.hostAddress ?? null,
            ...(plan.containerGroup && member
              ? {
                  memberName: member.name,
                  ipv4: containerIpv4(detail, resourceName(plan)),
                  artifactDigest: member.plan.artifact.digest,
                  resources: member.plan.resources.limit,
                  mountBindings: member.plan.resolved.mounts.map((m) => ({
                    grantId: m.grantId,
                    revisionId: m.revisionId,
                    target: m.target,
                    mode: m.mode,
                  })),
                }
              : {}),
          }),
        );
      }
      const networks = await this.requestArray(runtime, "networks");
      for (const raw of networks) {
        const item = record(raw);
        const labels = record(item.Labels);
        const expectedName = resourceName(plan);
        const nameCandidate = item.Name === expectedName;
        if (
          (hasPartialOwnership(labels, plan) &&
            !matchesOwnership(labels, plan)) ||
          (nameCandidate && !matchesOwnership(labels, plan))
        )
          return { presence: "unknown", reason: "inventory_incomplete" };
        if (!matchesOwnership(labels, plan)) continue;
        if (item.Name !== expectedName)
          return { presence: "unknown", reason: "inventory_incomplete" };
        const networkId = requiredString(item.Id, "Docker network ID");
        const detail = await this.request(
          runtime,
          "GET",
          `networks/${encodeURIComponent(networkId)}`,
        );
        if (
          detail.Id !== networkId ||
          detail.Name !== expectedName ||
          !matchesOwnership(record(detail.Labels), plan)
        )
          return { presence: "unknown", reason: "inventory_incomplete" };
        const publishedPorts = owned
          .filter(
            (resource) =>
              resource.kind === "container" &&
              resource.details?.networkName === item.Name,
          )
          .flatMap((resource) => {
            const hostPort = resource.details?.hostPort;
            const hostAddress = resource.details?.hostAddress;
            return typeof hostPort === "number" &&
              typeof hostAddress === "string"
              ? [
                  {
                    containerId: resource.id,
                    protocol: "tcp" as const,
                    hostPort,
                    containerPort: 22,
                    hostAddress,
                  },
                ]
              : [];
          });
        const savedLinks = plan.cleanupResources?.find(
          (r) => r.kind === "network_policy",
        )?.details?.memberLinks;
        const memberLinks =
          runtimeLinksForResources(plan, owned) ??
          (savedLinks === undefined
            ? undefined
            : runtimeMemberLinkSchema.array().parse(savedLinks));
        owned.push(
          this.owned(plan, networkId, "network_policy", {
            networkName: item.Name,
            ...networkFacts(detail, networkId),
            publishedPorts,
            ...(memberLinks === undefined ? {} : { memberLinks }),
          }),
        );
      }
      const volumes = await this.request(runtime, "GET", "volumes");
      const volumeList = record(volumes);
      if (!Array.isArray(volumeList.Volumes))
        return { presence: "unknown", reason: "inventory_incomplete" };
      for (const raw of volumeList.Volumes) {
        const item = record(raw);
        const labels = record(item.Labels);
        const gatewayVolume =
          plan.containerGroup !== undefined &&
          item.Name === `${resourceName(plan)}-gateway-state`;
        const expectedVolumeName = `${resourceName(plan)}-${gatewayVolume ? "gateway-state" : "workspace"}`;
        if (
          hasPartialOwnership(labels, plan) &&
          !matchesOwnership(labels, plan)
        )
          return { presence: "unknown", reason: "inventory_incomplete" };
        if (item.Name === expectedVolumeName && !matchesOwnership(labels, plan))
          return { presence: "unknown", reason: "inventory_incomplete" };
        if (matchesOwnership(labels, plan)) {
          if (item.Name !== expectedVolumeName)
            return { presence: "unknown", reason: "inventory_incomplete" };
          const volumeDetail = await this.request(
            runtime,
            "GET",
            `volumes/${encodeURIComponent(expectedVolumeName)}`,
          );
          if (
            volumeDetail.Name !== expectedVolumeName ||
            !matchesOwnership(record(volumeDetail.Labels), plan) ||
            (plan.containerGroup !== undefined &&
              record(volumeDetail.Labels)["io.hitchlet.member"] !==
                (gatewayVolume ? "gateway" : "workload"))
          )
            return { presence: "unknown", reason: "inventory_incomplete" };
          owned.push(
            this.owned(
              plan,
              requiredString(item.Name, "Docker volume name"),
              "volume",
              {
                temporary: true,
                ...(plan.containerGroup
                  ? {
                      memberName: gatewayVolume ? "gateway" : "workload",
                      target: gatewayVolume
                        ? plan.containerGroup.gateway.stateMountPath
                        : "/workspace",
                    }
                  : {}),
              },
            ),
          );
        }
      }
      if (owned.length === 0) {
        if (plan.executionPhase === "observe") await this.runtime(plan, true);
        return {
          presence: "absent",
          evidence: {
            completeness: "complete",
            runtime: {
              runtimeIdentityId: plan.identity.runtimeIdentityId,
              connectionRevisionId: plan.identity.connectionRevisionId,
            },
            identity: plan.identity,
          },
        };
      }
      if (plan.executionPhase === "observe") await this.runtime(plan, true);
      if (owned.some((r) => r.kind === "container"))
        owned.push(...this.storageReferences(plan));
      const evidence: InventoryEvidence = {
        completeness: "complete",
        runtime: {
          runtimeIdentityId: plan.identity.runtimeIdentityId,
          connectionRevisionId: plan.identity.connectionRevisionId,
        },
        identity: plan.identity,
        objects: owned,
      };
      if (plan.executionPhase !== "observe")
        return { presence: "present", evidence };

      const containers = owned.filter((item) => item.kind === "container");
      const networksOwned = owned.filter(
        (item) => item.kind === "network_policy",
      );
      const workspace = owned.find((item) => item.kind === "volume");
      if (containers.length === 0 || networksOwned.length !== 1 || !workspace)
        return {
          presence: "present",
          evidence,
          integrity: { state: "lost", reason: "RESOURCE_OBJECT_MISSING" },
        };
      const firstContainer = containers[0]!;
      if (plan.containerGroup) {
        if (containers.length !== containerMembers(plan).length)
          return {
            presence: "present",
            evidence,
            integrity: { state: "lost", reason: "RESOURCE_OBJECT_MISSING" },
          };
        await this.readyGroup(
          { ...plan, executionPhase: "provision" },
          evidence,
        );
        return {
          presence: "present",
          evidence,
          integrity: { state: "healthy" },
        };
      }
      const networkResource = networksOwned[0]!;
      const containerDetail = await this.request(
        runtime,
        "GET",
        `containers/${encodeURIComponent(firstContainer.id)}/json`,
      );
      const local = await this.request(runtime, "GET", "info");
      const image = await this.inspectImage(
        runtime,
        plan.artifact.ref,
        plan.artifact.digest,
        dockerArchitecture(local.Architecture),
      );
      const networkDetail = await this.request(
        runtime,
        "GET",
        `networks/${encodeURIComponent(networkResource.id)}`,
      );
      if (
        record(containerDetail.State).Running !== true ||
        record(record(containerDetail.HostConfig).RestartPolicy).Name !==
          "no" ||
        !image ||
        !containerMatchesFrozen(
          containerDetail,
          plan,
          image.Id,
          workspace.id,
          String(networkResource.details?.networkName),
          undefined,
          networkResource.id,
        )
      )
        return {
          presence: "present",
          evidence,
          integrity: { state: "lost", reason: "CONTAINER_GUARANTEE_LOST" },
        };
      if (plainBridge(plan)) {
        this.assertNativeBridge(plan, runtime, networkDetail, [
          containerDetail,
        ]);
      } else {
        const networkPlan = this.networkPlan(
          plan,
          runtime,
          networkResource.id,
          String(networkResource.details?.networkName),
          containers.map((item) => item.id),
          undefined,
          containerDetail,
          networkDetail,
        );
        const networkResult = await this.agentCommand(
          plan,
          runtime,
          networkPlan,
          "network.inspect",
        );
        const boundToSnapshot =
          networkResult.nativeEngineId === runtime.engineId &&
          networkResult.operationId === plan.identity.operationId &&
          networkResult.allocationId === plan.identity.allocationId &&
          networkResult.generation === plan.identity.generation;
        if (!boundToSnapshot)
          return { presence: "unknown", reason: "runtime_identity_mismatch" };
        if (networkResult.status === "unknown")
          return {
            presence: "present",
            evidence,
            integrity: {
              state: "lost",
              reason: "NETWORK_GUARANTEE_UNVERIFIED",
            },
          };
        if (
          networkResult.status !== "present" ||
          networkResult.rulesetHash !== networkPlan.expectedRulesetHash
        )
          return {
            presence: "present",
            evidence,
            integrity: { state: "lost", reason: "NETWORK_GUARANTEE_LOST" },
          };
      }
      {
        try {
          await this.assertMounts(plan);
        } catch {
          return {
            presence: "present",
            evidence,
            integrity: { state: "lost", reason: "STORAGE_SOURCE_UNVERIFIED" },
          };
        }
      }
      return { presence: "present", evidence, integrity: { state: "healthy" } };
    } catch {
      return { presence: "unknown", reason: "inventory_incomplete" };
    }
  }

  async ready(
    _plan: ProvisionPlan,
    _inventory: InventoryEvidence,
  ): Promise<ReadyReceipt> {
    const plan = _plan;
    assertDockerRecipe(plan);
    if (plan.containerGroup) return this.readyGroup(plan, _inventory);
    await this.assertMounts(plan);
    if (plan.resources.scratchEnforcement === "required")
      throw new Error(
        "Docker overlay scratch hard limits are unsupported by this Provider",
      );
    const runtime = await this.runtime(plan, true);
    const inspection = await this.inspect(plan);
    if (inspection.presence !== "present")
      throw new Error("Owned Docker resources are not completely present");
    const containerResource = inspection.evidence.objects.find(
      (item) => item.kind === "container",
    );
    const networkResource = inspection.evidence.objects.find(
      (item) => item.kind === "network_policy",
    );
    if (!containerResource || !networkResource)
      throw new Error("Container or private network is missing");
    const detail = await this.request(
      runtime,
      "GET",
      `containers/${encodeURIComponent(containerResource.id)}/json`,
    );
    assertContainerRunning(detail, containerResource.id, "readiness");
    const image = await this.inspectImage(
      runtime,
      plan.artifact.ref,
      plan.artifact.digest,
      dockerArchitecture(
        (await this.request(runtime, "GET", "info")).Architecture,
      ),
    );
    const workspace = inspection.evidence.objects.find(
      (item) => item.kind === "volume",
    );
    if (
      !image ||
      !workspace ||
      !containerMatchesFrozen(
        detail,
        plan,
        image.Id,
        workspace.id,
        resourceName(plan),
        undefined,
        networkResource.id,
      )
    )
      throw new Error(
        "Docker ready readback differs from the frozen image, identity, isolation or workspace contract",
      );
    const hostConfig = record(detail.HostConfig);
    const actualCpu =
      Number(hostConfig.CpuQuota) > 0 && Number(hostConfig.CpuPeriod) > 0
        ? Math.floor(
            (Number(hostConfig.CpuQuota) * 1000) / Number(hostConfig.CpuPeriod),
          )
        : 0;
    const actualMemory = Math.floor(Number(hostConfig.Memory) / (1024 * 1024));
    if (
      actualCpu !== plan.resources.limit.cpuMillis ||
      actualMemory !== plan.resources.limit.memoryMiB ||
      Number(hostConfig.MemorySwap) !== Number(hostConfig.Memory)
    )
      throw new Error(
        "Docker Engine did not read back the requested hard CPU/memory limits",
      );
    const networkInspect = await this.request(
      runtime,
      "GET",
      `networks/${encodeURIComponent(networkResource.id)}`,
    );
    if (plainBridge(plan)) {
      this.assertNativeBridge(plan, runtime, networkInspect, [detail]);
    } else {
      const networkPlan = this.networkPlan(
        plan,
        runtime,
        networkResource.id,
        String(containerResource.details?.networkName ?? resourceName(plan)),
        [containerResource.id],
        undefined,
        detail,
        networkInspect,
      );
      const net = await this.agentCommand(
        plan,
        runtime,
        networkPlan,
        "network.inspect",
      );
      assertNetworkResult(
        net,
        plan,
        runtime,
        "present",
        networkPlan.expectedRulesetHash,
      );
    }
    const receipt: ReadyReceipt = {
      identity: plan.identity,
      artifactDigest: plan.artifact.digest,
      contractHash: plan.resolved.contractHash,
      ...resourceManifest(plan, inspection.evidence.objects),
      objectIds: inspection.evidence.objects.map((item) => item.id).sort(),
      effectiveResources: {
        limits: {
          cpuMillis: actualCpu,
          memoryMiB: actualMemory,
          scratchMiB: 0,
        },
        cpuEnforcement: "hard",
        memoryEnforcement: "hard",
        scratchEnforcement: "best_effort",
        acceleratorAssignments: [],
      },
      networkRevisionId: plan.resolved.network.revisionId,
      networkContractHash: sha256(plan.resolved.network),
      mountContractHash: sha256(plan.resolved.mounts),
      accessProtocol: plan.accessProtocol,
      bootstrapComplete: true,
      offlineLeaseEnforcement: "unsupported",
    };
    if (plan.accessProtocol === "none") return receipt;
    const ports = containerPorts(detail);
    const ssh = ports.find(
      (port) => port.containerPort === 22 && port.protocol === "tcp",
    );
    if (!ssh) throw new Error("SSH endpoint has no published host binding");
    const materials = await this.accessMaterials.getOrCreate(
      plan.identity.allocationId,
    );
    const hostArchive = await this.getArchive(
      runtime,
      `containers/${encodeURIComponent(containerResource.id)}/archive?path=%2Fetc%2Fssh%2Fssh_host_ed25519_key.pub`,
    );
    const hostKeyText = readTarFile(hostArchive, "ssh_host_ed25519_key.pub")
      .toString("utf8")
      .trim()
      .split(/\s+/);
    if (hostKeyText[0] !== "ssh-ed25519" || !hostKeyText[1])
      throw new Error("SSH host key is missing or has an unsupported type");
    const expectedHostKey = Buffer.from(hostKeyText[1], "base64");
    const fingerprint = `SHA256:${createHash("sha256").update(expectedHostKey).digest("base64").replace(/=+$/, "")}`;
    await probeSsh({
      host: runtime.accessHost,
      port: ssh.hostPort,
      username: plan.access.account,
      privateKey: materials.privateKey,
      expectedHostKey,
    });
    return {
      ...receipt,
      access: {
        host: runtime.accessHost,
        port: ssh.hostPort,
        username: plan.access.account,
        hostKeyFingerprint: fingerprint,
        clientPublicKeyFingerprint: materials.fingerprint,
      },
    };
  }

  async revokeStop(plan: ProvisionPlan): Promise<void> {
    const runtime = await this.runtime(plan);
    const inspection = await this.inspect(plan);
    if (inspection.presence === "unknown")
      throw new Error("Cannot revoke access while Docker ownership is unknown");
    if (inspection.presence === "absent") return;
    const containerIds = inspection.evidence.objects
      .filter((r) => r.kind === "container")
      .map((r) => r.id);
    const network = inspection.evidence.objects.find(
      (r) => r.kind === "network_policy",
    );
    const journaledNetwork = plan.cleanupResources?.find(
      (r) => r.kind === "network_policy",
    );
    if (plainBridge(plan)) {
      await this.stopOwnedContainers(runtime, containerIds);
      return;
    }
    if (!network) {
      if (containerIds.length === 0) return;
      await this.stopOwnedContainers(runtime, containerIds);
      throw new Error("Owned Docker network is missing");
    }
    const detail = await this.request(
      runtime,
      "GET",
      `networks/${encodeURIComponent(network.id)}`,
      undefined,
      [404],
    );
    if (!detail.Id) {
      if (containerIds.length === 0) return;
      await this.stopOwnedContainers(runtime, containerIds);
      throw new Error("Owned Docker network is missing");
    }
    if (containerIds.length === 0 && !hasNoAttachedEndpoints(detail))
      throw new Error("Docker bridge still has attached endpoints");
    const networkName = requiredString(
      detail.Name ?? journaledNetwork?.details?.networkName,
      "Docker network name",
    );
    const containerDetail =
      containerIds.length === 1
        ? await this.request(
            runtime,
            "GET",
            `containers/${encodeURIComponent(containerIds[0]!)}/json`,
          )
        : undefined;
    const savedPorts = Array.isArray(journaledNetwork?.details?.publishedPorts)
      ? (journaledNetwork.details
          .publishedPorts as RuntimeNetworkPlan["publishedPorts"])
      : undefined;
    const networkPlan = this.networkPlan(
      plan,
      runtime,
      network.id,
      networkName,
      containerIds,
      savedPorts,
      containerDetail,
      detail,
    );
    let revokeError: unknown;
    try {
      const revoked = await this.agentCommand(
        plan,
        runtime,
        networkPlan,
        "network.revoke",
      );
      assertNetworkResult(
        revoked,
        plan,
        runtime,
        "revoked",
        hashRuntimeNetworkRules(networkPlan, true),
      );
    } catch (error) {
      revokeError = error;
    }
    let stopError: unknown;
    try {
      await this.stopOwnedContainers(runtime, containerIds);
    } catch (error) {
      stopError = error;
    }
    if (
      revokeError &&
      (containerIds.length > 0 || !hasNoAttachedEndpoints(detail))
    )
      throw revokeError;
    if (stopError) throw stopError;
  }

  private async stopOwnedContainers(
    runtime: RuntimeAccess,
    containerIds: readonly string[],
  ): Promise<void> {
    let firstError: unknown;
    for (const id of containerIds) {
      try {
        await this.request(
          runtime,
          "POST",
          `containers/${encodeURIComponent(id)}/stop?t=10`,
          undefined,
          [304, 404],
        );
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  async destroy(
    plan: ProvisionPlan,
    resource: OwnedResource,
  ): Promise<CleanupReceipt> {
    if (resource.ownership !== "owned" || resource.kind === "storage_reference")
      throw new Error("Persistent references are never destroy targets");
    const runtime = await this.runtime(plan);
    const inspection = await this.inspect(plan);
    if (inspection.presence === "unknown")
      throw new Error(
        "Cannot delete Docker resource while ownership is unknown",
      );
    if (inspection.presence === "absent" && resource.kind !== "network_policy")
      return this.cleanupReceipt(plan, resource, "not_applicable");
    const current =
      inspection.presence === "present"
        ? inspection.evidence.objects.find(
            (item) => item.id === resource.id && item.kind === resource.kind,
          )
        : undefined;
    if (!current && resource.kind !== "network_policy")
      return this.cleanupReceipt(plan, resource, "not_applicable"); // Complete inventory confirms this journaled object is already absent.
    if (current && !matchesResource(current, resource))
      throw new Error("Docker resource ownership changed before deletion");
    if (resource.kind === "container")
      await this.request(
        runtime,
        "DELETE",
        `containers/${encodeURIComponent(resource.id)}?force=true&v=false`,
        undefined,
        [404],
      );
    else if (resource.kind === "volume")
      await this.request(
        runtime,
        "DELETE",
        `volumes/${encodeURIComponent(resource.id)}`,
        undefined,
        [404],
      );
    else if (resource.kind === "network_policy") {
      const ownedContainers =
        inspection.presence === "present"
          ? inspection.evidence.objects.filter(
              (item) => item.kind === "container",
            )
          : [];
      if (ownedContainers.length > 0)
        throw new Error(
          "Owned containers must be absent before network removal",
        );
      const detail = await this.request(
        runtime,
        "GET",
        `networks/${encodeURIComponent(resource.id)}`,
        undefined,
        [404],
      );
      if (plainBridge(plan)) {
        if (detail.Id) {
          if (
            !matchesOwnership(record(detail.Labels), plan) ||
            !hasNoAttachedEndpoints(detail)
          )
            throw new Error(
              "Owned Docker bridge must be empty before deletion",
            );
          await this.request(
            runtime,
            "DELETE",
            `networks/${encodeURIComponent(resource.id)}`,
            undefined,
            [404],
          );
        }
        const absent = await this.request(
          runtime,
          "GET",
          `networks/${encodeURIComponent(resource.id)}`,
          undefined,
          [404],
        );
        if (absent.Id)
          throw new Error("Owned Docker bridge deletion is not confirmed");
        return this.cleanupReceipt(plan, resource, "not_applicable");
      }
      if (
        !detail.Id &&
        (typeof resource.details?.networkSubnet !== "string" ||
          typeof resource.details?.bridgeGateway !== "string")
      )
        return this.cleanupReceipt(plan, resource, "never_installed"); // Complete facts are journaled before the first Agent ensure.
      const networkName =
        typeof detail.Name === "string"
          ? detail.Name
          : requiredString(
              resource.details?.networkName,
              "journaled Docker network name",
            );
      const savedPorts = Array.isArray(resource.details?.publishedPorts)
        ? (resource.details
            .publishedPorts as RuntimeNetworkPlan["publishedPorts"])
        : [];
      if (detail.Id) {
        if (!matchesOwnership(record(detail.Labels), plan))
          throw new Error("Docker network ownership changed before deletion");
        if (!hasNoAttachedEndpoints(detail))
          throw new Error("Docker bridge still has attached endpoints");
      }
      const removeInspection: Json = detail.Id
        ? detail
        : {
            Id: resource.id,
            Name: networkName,
            Options: {
              "com.docker.network.bridge.name": resource.details?.bridgeName,
            },
            IPAM: {
              Config: [
                {
                  Subnet: resource.details?.networkSubnet,
                  Gateway: resource.details?.bridgeGateway,
                },
              ],
            },
          };
      const agentPlan = this.networkPlan(
        plan,
        runtime,
        resource.id,
        networkName,
        [],
        savedPorts,
        undefined,
        removeInspection,
      );
      // Revoke before deleting the native bridge. This also repairs cleanup
      // after an external stop/delete while the frozen Agent rules may remain.
      let revokeError: unknown;
      try {
        const revoked = await this.agentCommand(
          plan,
          runtime,
          agentPlan,
          "network.revoke",
        );
        assertNetworkResult(
          revoked,
          plan,
          runtime,
          "revoked",
          hashRuntimeNetworkRules(agentPlan, true),
        );
      } catch (error) {
        revokeError = error;
      }
      // With no attached containers, revoke may be unable to replay historical
      // published-port facts after the container has gone. The Agent's remove
      // command still requires its durable tombstone and independently verifies
      // every native object and hook is absent before cleanup can complete.
      if (
        revokeError &&
        (ownedContainers.length > 0 ||
          (detail.Id && !hasNoAttachedEndpoints(detail)))
      )
        throw revokeError;
      if (detail.Id)
        await this.request(
          runtime,
          "DELETE",
          `networks/${encodeURIComponent(resource.id)}`,
          undefined,
          [404],
        );
      const removed = await this.agentCommand(
        plan,
        runtime,
        agentPlan,
        "network.remove",
      );
      assertNetworkResult(removed, plan, runtime, "removed", null);
      return this.cleanupReceipt(plan, resource, "removed", removed);
    } else throw new Error("Unsupported Docker resource ownership kind");
    return this.cleanupReceipt(plan, resource, "not_applicable");
  }

  private cleanupReceipt(
    plan: ProvisionPlan,
    resource: OwnedResource,
    networkRules: CleanupReceipt["networkRules"],
    agentResult?: RuntimeNetworkResult,
  ): CleanupReceipt {
    return {
      resourceId: resource.id,
      kind: resource.kind,
      runtime: {
        runtimeIdentityId: plan.identity.runtimeIdentityId,
        connectionRevisionId: plan.identity.connectionRevisionId,
      },
      identity: plan.identity,
      presence: "absent",
      networkRules,
      verifiedAtMs: this.now(),
      ...(agentResult ? { agentResult } : {}),
    };
  }

  private async runtime(
    plan: ProvisionPlan,
    verifyVersions = false,
  ): Promise<RuntimeAccess> {
    const runtime = await this.resolveRuntime(plan);
    const endpoint = new URL(runtime.endpointUrl);
    if (
      endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)
      )
    )
      throw new Error(
        "Portainer execution requires validated HTTPS (or loopback development HTTP)",
      );
    const evidence = await this.request(runtime, "GET", "info");
    if (requiredString(evidence.ID, "Docker Engine ID") !== runtime.engineId)
      throw new Error(
        "Portainer endpoint now authenticates as a different Docker Engine",
      );
    if (verifyVersions) {
      const response = await fetch(
        new URL("/api/system/version", runtime.endpointUrl),
        {
          method: "GET",
          headers: { "X-API-Key": runtime.apiKey, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error("Portainer version readback failed");
      const portainer = record(await response.json());
      if (
        requiredString(evidence.ServerVersion, "Docker ServerVersion") !==
          runtime.providerEvidence.dockerVersion ||
        requiredString(portainer.ServerVersion, "Portainer ServerVersion") !==
          runtime.providerEvidence.portainerVersion
      )
        throw new Error(
          "Docker or Portainer version differs from the frozen connection revision",
        );
    }
    return runtime;
  }

  private async request(
    runtime: RuntimeAccess,
    method: string,
    path: string,
    body?: unknown,
    allowed: readonly number[] = [],
  ): Promise<Json> {
    const base = new URL(runtime.endpointUrl);
    if (method !== "GET") await this.assertEngineIdentity(runtime);
    const url = new URL(
      `/api/endpoints/${encodeURIComponent(runtime.environmentId)}/docker/${path.replace(/^\//, "")}`,
      base,
    );
    const stage = requestStage(path, method);
    const response = await fetch(url, {
      method,
      headers: {
        "X-API-Key": runtime.apiKey,
        Accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new PortainerRequestError({
        provider: "portainer",
        stage,
        category: failureCategory(error, "transport_error"),
      });
    });
    if (!response.ok && !allowed.includes(response.status)) {
      // Only a fixed short class is retained; the upstream body is never logged or saved.
      const remote = await response.text().catch(() => "");
      throw new PortainerRequestError({
        provider: "portainer",
        stage,
        category: failureCategory(remote, "http_error"),
        statusCode: response.status,
      });
    }
    if (
      response.status === 204 ||
      response.status === 304 ||
      response.status === 404
    )
      return {};
    const text = await response.text();
    if (!text) return {};
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new PortainerRequestError({
        provider: "portainer",
        stage,
        category: "invalid_response",
        statusCode: response.status,
      });
    }
    if (Array.isArray(value))
      throw new PortainerRequestError({
        provider: "portainer",
        stage,
        category: "invalid_response",
        statusCode: response.status,
      });
    return record(value);
  }

  private async requestArray(
    runtime: RuntimeAccess,
    path: string,
  ): Promise<unknown[]> {
    const url = new URL(
      `/api/endpoints/${encodeURIComponent(runtime.environmentId)}/docker/${path.replace(/^\//, "")}`,
      runtime.endpointUrl,
    );
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": runtime.apiKey, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        `Portainer Docker list request failed (${response.status})`,
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Portainer returned invalid Docker list JSON");
    }
    if (!Array.isArray(value))
      throw new Error("Docker inventory response is not a complete list");
    return value;
  }

  private async assertEngineIdentity(runtime: RuntimeAccess): Promise<void> {
    const url = new URL(
      `/api/endpoints/${encodeURIComponent(runtime.environmentId)}/docker/info`,
      runtime.endpointUrl,
    );
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": runtime.apiKey, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        `Portainer Engine identity preflight failed (${response.status})`,
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(
        "Portainer Engine identity preflight returned invalid JSON",
      );
    }
    if (
      requiredString(record(value).ID, "Docker Engine ID") !== runtime.engineId
    )
      throw new Error(
        "Portainer endpoint now authenticates as a different Docker Engine",
      );
  }

  private async pullImage(runtime: RuntimeAccess, ref: string): Promise<void> {
    await this.assertEngineIdentity(runtime);
    const base = new URL(runtime.endpointUrl);
    const url = new URL(
      `/api/endpoints/${encodeURIComponent(runtime.environmentId)}/docker/images/create?fromImage=${encodeURIComponent(ref)}`,
      base,
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { "X-API-Key": runtime.apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Pinned Docker image pull failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Json;
        try {
          event = record(JSON.parse(line));
        } catch {
          throw new Error("Docker image pull returned malformed progress data");
        }
        if (
          typeof event.error === "string" ||
          typeof record(event.errorDetail).message === "string"
        )
          throw new Error(
            "Docker image pull failed while resolving the pinned digest",
          );
      }
    }
    if (pending.trim()) {
      let event: Json;
      try {
        event = record(JSON.parse(pending));
      } catch {
        throw new Error("Docker image pull returned malformed progress data");
      }
      if (
        typeof event.error === "string" ||
        typeof record(event.errorDetail).message === "string"
      )
        throw new Error(
          "Docker image pull failed while resolving the pinned digest",
        );
    }
  }

  private async putArchive(
    runtime: RuntimeAccess,
    path: string,
    archive: Buffer,
  ): Promise<void> {
    await this.assertEngineIdentity(runtime);
    const url = new URL(
      `/api/endpoints/${encodeURIComponent(runtime.environmentId)}/docker/${path}`,
      runtime.endpointUrl,
    );
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "X-API-Key": runtime.apiKey,
        "content-type": "application/x-tar",
      },
      body: new Uint8Array(archive),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Docker bootstrap file copy failed (${response.status})`);
  }
  private async getArchive(
    runtime: RuntimeAccess,
    path: string,
  ): Promise<Buffer> {
    const url = new URL(
      `/api/endpoints/${encodeURIComponent(runtime.environmentId)}/docker/${path}`,
      runtime.endpointUrl,
    );
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": runtime.apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Docker file readback failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async verifyDistributionArtifact(
    runtime: RuntimeAccess,
    ref: string,
    digest: string,
    architecture: string,
  ): Promise<void> {
    if (!ref.endsWith(`@${digest}`))
      throw new Error(
        "Artifact reference is not pinned to its recorded digest",
      );
    const distribution = await this.request(
      runtime,
      "GET",
      `distribution/${dockerImageReferencePath(ref)}/json`,
    );
    const descriptor = record(distribution.Descriptor);
    if (descriptor.digest !== digest)
      throw new Error(
        "Registry distribution descriptor differs from the frozen artifact digest",
      );
    if (
      typeof descriptor.mediaType !== "string" ||
      !descriptor.mediaType.includes("manifest")
    )
      throw new Error(
        "Registry did not resolve the pinned artifact to a manifest",
      );
    const platforms = Array.isArray(distribution.Platforms)
      ? distribution.Platforms.map(record)
      : [];
    if (
      platforms.length > 0 &&
      !platforms.some(
        (p) =>
          p.os === "linux" &&
          dockerArchitecture(p.architecture) === architecture,
      )
    )
      throw new Error(
        "Registry artifact has no platform matching the selected Docker Engine",
      );
  }

  private async inspectImage(
    runtime: RuntimeAccess,
    ref: string,
    digest: string,
    architecture: string,
  ): Promise<Json | undefined> {
    const local = await this.request(
      runtime,
      "GET",
      `images/${dockerImageReferencePath(ref)}/json`,
      undefined,
      [404],
    );
    if (!local.Id) return undefined;
    const repoDigests = Array.isArray(local.RepoDigests)
      ? local.RepoDigests
      : [];
    if (!repoDigests.includes(ref))
      throw new Error(
        "Local image RepoDigest does not exactly match the frozen immutable artifact reference",
      );
    if (
      record(local).Architecture !== architecture ||
      record(local).Os !== "linux"
    )
      throw new Error(
        "Local image OS/architecture does not match the selected Engine",
      );
    if (ref.length === 0)
      throw new Error("Missing immutable artifact reference");
    return local;
  }

  private networkPlan(
    plan: ProvisionPlan,
    runtime: RuntimeAccess,
    networkId: string,
    networkName: string,
    containerIds: string[],
    publishedPortsOverride?: RuntimeNetworkPlan["publishedPorts"],
    container?: Json,
    network?: Json,
    memberLinks?: RuntimeNetworkPlan["memberLinks"],
  ): RuntimeNetworkPlan {
    const activeBindings = record(
      container && record(container.NetworkSettings).Ports,
    );
    const endpoint =
      Object.keys(activeBindings).length > 0
        ? activeBindings
        : record(container && record(container.HostConfig).PortBindings);
    const publishedPorts =
      publishedPortsOverride ??
      Object.entries(endpoint).flatMap(([key, bindings]) => {
        const match = /^(\d+)\/(tcp|udp)$/.exec(key);
        if (!match || !Array.isArray(bindings)) return [];
        return bindings.map((raw) => {
          const binding = record(raw);
          return {
            containerId: requiredString(container!.Id, "container ID"),
            protocol: match[2] as "tcp" | "udp",
            containerPort: Number(match[1]),
            hostAddress: requiredString(
              binding.HostIp,
              "published host address",
            ),
            hostPort: Number(binding.HostPort),
          };
        });
      });
    const n = plan.resolved.network;
    const savedLinks = plan.cleanupResources?.find(
      (r) => r.kind === "network_policy",
    )?.details?.memberLinks;
    const links =
      memberLinks ??
      (savedLinks === undefined
        ? undefined
        : runtimeMemberLinkSchema.array().parse(savedLinks));
    const allocatedSubnet = subnetAddress(network);
    if (!cidrContains(runtime.networkCidrBase, allocatedSubnet))
      throw new Error(
        "Docker allocated a bridge subnet outside the configured node network pool",
      );
    return buildRuntimeNetworkPlan({
      installationId: plan.identity.installationId,
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      nativeEngineId: runtime.engineId,
      allocationId: plan.identity.allocationId,
      generation: plan.identity.generation,
      operationId: plan.identity.operationId,
      controlVersion: plan.identity.controlVersion,
      networkId,
      networkName,
      networkSubnet: allocatedSubnet,
      containerIds,
      ...(links === undefined ? {} : { memberLinks: links }),
      bridgeInterface:
        typeof record(network?.Options)["com.docker.network.bridge.name"] ===
          "string" && record(network?.Options)["com.docker.network.bridge.name"]
          ? String(record(network?.Options)["com.docker.network.bridge.name"])
          : `br-${networkId.slice(0, 12)}`,
      bridgeGateway: gatewayAddress(network),
      userlandProxy: runtime.userlandProxy,
      publishedPorts,
      grantId: n.grantId,
      networkRevisionId: n.revisionId,
      frozenDenyRevisionId: n.frozenPlatformDenyRevisionId,
      effectiveDenyRevisionId: runtime.effectiveDenyRevisionId,
      ingressSourceCidrs: [...n.allowedIngressSourceCidrs],
      egress: n.allowedEgress.map((rule) => ({
        ...rule,
        ports: [...rule.ports],
      })),
      managementDeny: [
        ...runtime.managementDenyRules,
        ...n.managementDenyRules,
      ].map((r) => ({
        cidr: r.cidr,
        protocol: r.protocol,
        ports: r.ports === "any" ? "any" : [...r.ports],
      })),
    });
  }

  private async agentCommand(
    plan: ProvisionPlan,
    runtime: RuntimeAccess,
    network: RuntimeNetworkPlan,
    kind: RuntimeNetworkCommand["kind"],
  ): Promise<RuntimeNetworkResult> {
    if (!Number.isSafeInteger(plan.deadlineMs) || plan.deadlineMs <= this.now())
      throw new Error("Network operation deadline has expired");
    const metadata = {
      installationId: plan.identity.installationId,
      runtimeIdentityId: plan.identity.runtimeIdentityId,
      agentId: runtime.agentId,
      commandId: randomUUID(),
      operationId: plan.identity.operationId,
      allocationId: plan.identity.allocationId,
      generation: plan.identity.generation,
      controlVersion: plan.identity.controlVersion,
      controllerEpoch: runtime.controllerEpoch,
      deadline: new Date(plan.deadlineMs).toISOString(),
      plan: network,
    };
    if (kind === "network.ensure")
      return runtime.runtimeNetwork.ensure(
        buildRuntimeNetworkCommand({ ...metadata, kind }) as Extract<
          RuntimeNetworkCommand,
          { kind: "network.ensure" }
        >,
      );
    if (kind === "network.inspect")
      return runtime.runtimeNetwork.inspect(
        buildRuntimeNetworkCommand({ ...metadata, kind }) as Extract<
          RuntimeNetworkCommand,
          { kind: "network.inspect" }
        >,
      );
    if (kind === "network.revoke")
      return runtime.runtimeNetwork.revoke(
        buildRuntimeNetworkCommand({ ...metadata, kind }) as Extract<
          RuntimeNetworkCommand,
          { kind: "network.revoke" }
        >,
      );
    return runtime.runtimeNetwork.remove(
      buildRuntimeNetworkCommand({
        ...metadata,
        kind: "network.remove",
      }) as Extract<RuntimeNetworkCommand, { kind: "network.remove" }>,
    );
  }

  private owned(
    plan: ProvisionPlan,
    id: string,
    kind: OwnedResource["kind"],
    detail: Json,
  ): OwnedResource {
    const evidence = {
      artifactDigest: plan.artifact.digest,
      resourcesHash: sha256(plan.resources),
      networkHash: sha256(plan.resolved.network),
      mountsHash: sha256(plan.resolved.mounts),
      accessProtocol: plan.accessProtocol,
    };
    return {
      id,
      kind,
      ownership: "owned",
      identity: plan.identity,
      contractHash: plan.resolved.contractHash,
      evidence,
      details: {
        ...detail,
        nativeName:
          detail.nativeName ??
          (kind === "network_policy"
            ? detail.networkName
            : kind === "volume"
              ? id
              : kind === "container"
                ? detail.name
                : undefined),
      },
    };
  }
}

function assertNetworkResult(
  result: RuntimeNetworkResult,
  plan: ProvisionPlan,
  runtime: RuntimeAccess,
  status: RuntimeNetworkResult["status"],
  hash: string | null,
) {
  if (
    result.status !== status ||
    result.nativeEngineId !== runtime.engineId ||
    result.operationId !== plan.identity.operationId ||
    result.allocationId !== plan.identity.allocationId ||
    result.generation !== plan.identity.generation ||
    result.rulesetHash !== hash
  )
    throw new Error(
      "Runtime Agent network evidence does not match the frozen operation",
    );
}
function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${name}`);
  return value;
}
function ownershipLabels(plan: ProvisionPlan): Record<string, string> {
  return {
    "io.hitchlet.purpose": plan.identity.purpose,
    "io.hitchlet.installation": plan.identity.installationId,
    "io.hitchlet.runtime": plan.identity.runtimeIdentityId,
    "io.hitchlet.allocation": plan.identity.allocationId,
    "io.hitchlet.generation": String(plan.identity.generation),
    "io.hitchlet.operation": plan.identity.operationId,
    "io.hitchlet.contract": plan.resolved.contractHash,
  };
}
function matchesOwnership(labels: Json, plan: ProvisionPlan): boolean {
  const expected = ownershipLabels(plan);
  return Object.entries(expected).every(
    ([key, value]) => labels[key] === value,
  );
}
function hasPartialOwnership(labels: Json, plan: ProvisionPlan): boolean {
  // Installations own many simultaneous allocations. A shared installation
  // label alone never makes another allocation's object a conflict.
  return labels["io.hitchlet.allocation"] === plan.identity.allocationId;
}
function matchesResource(a: OwnedResource, b: OwnedResource): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.contractHash === b.contractHash &&
    a.identity.allocationId === b.identity.allocationId &&
    a.identity.generation === b.identity.generation
  );
}
function resourceName(plan: ProvisionPlan): string {
  return `hitchlet-${plan.identity.allocationId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 35)}-${plan.identity.generation}`;
}
function dockerArchitecture(value: unknown): string {
  if (value === "x86_64") return "amd64";
  if (value === "aarch64") return "arm64";
  return requiredString(value, "Engine architecture");
}
function gatewayAddress(network?: Json): string {
  const ipam = record(network?.IPAM);
  const configs = Array.isArray(ipam.Config) ? ipam.Config : [];
  const config = record(configs[0]);
  return requiredString(config.Gateway, "Docker bridge gateway");
}
function subnetAddress(network?: Json): string {
  const ipam = record(network?.IPAM);
  const configs = Array.isArray(ipam.Config) ? ipam.Config : [];
  return requiredString(record(configs[0]).Subnet, "Docker network subnet");
}
function networkFacts(
  network: Json,
  networkId: string,
): Record<string, unknown> {
  const options = record(network.Options);
  return {
    bridgeName:
      typeof options["com.docker.network.bridge.name"] === "string" &&
      options["com.docker.network.bridge.name"]
        ? options["com.docker.network.bridge.name"]
        : `br-${networkId.slice(0, 12)}`,
    networkSubnet: subnetAddress(network),
    bridgeGateway: gatewayAddress(network),
  };
}
function hasNoAttachedEndpoints(network: Json): boolean {
  const endpoints = network.Containers;
  return (
    endpoints !== null &&
    typeof endpoints === "object" &&
    !Array.isArray(endpoints) &&
    Object.keys(endpoints).length === 0
  );
}
function cidrContains(pool: string, subnet: string): boolean {
  const toNetwork = (
    value: string,
  ): { address: number; prefix: number } | null => {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
    if (!match) return null;
    const parts = match[1]!.split(".").map(Number),
      prefix = Number(match[2]);
    if (
      parts.some((part) => part < 0 || part > 255) ||
      prefix < 0 ||
      prefix > 32
    )
      return null;
    return {
      address:
        (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 +
          parts[3]!) >>>
        0,
      prefix,
    };
  };
  const base = toNetwork(pool),
    allocated = toNetwork(subnet);
  if (!base || !allocated || base.prefix > allocated.prefix) return false;
  const mask = base.prefix === 0 ? 0 : (0xffffffff << (32 - base.prefix)) >>> 0;
  return (base.address & mask) === (allocated.address & mask);
}
function bindingsFor(
  plan: ProvisionPlan,
): Record<string, Array<{ HostIp: string; HostPort: string }>> {
  assertDockerRecipe(plan);
  if (plan.accessProtocol === "none") return {};
  const value = createHash("sha256")
    .update(`${plan.identity.allocationId}:${plan.identity.generation}`)
    .digest()
    .readUInt16BE(0);
  const hostPort = String(30_000 + (value % 20_000));
  return { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: hostPort }] };
}
function containerMatchesFrozen(
  container: Json,
  plan: ProvisionPlan,
  imageId: unknown,
  volumeName: string,
  networkName: string,
  environment?: Readonly<Record<string, string>>,
  networkId?: string,
): boolean {
  const host = record(container.HostConfig);
  const actualCpu =
    Number(host.CpuQuota) > 0 && Number(host.CpuPeriod) > 0
      ? Math.floor((Number(host.CpuQuota) * 1000) / Number(host.CpuPeriod))
      : 0;
  const actualMemory = Math.floor(Number(host.Memory) / (1024 * 1024));
  const mounts = Array.isArray(container.Mounts)
    ? container.Mounts.map(record)
    : [];
  const workspace = mounts.find(
    (mount) => mount.Destination === (plan.ownedVolumeTarget ?? "/workspace"),
  );
  const capAdd = Array.isArray(host.CapAdd) ? host.CapAdd : [];
  const expectedPorts = bindingsFor(plan);
  const actualPorts = record(host.PortBindings);
  const configuredEnv = record(container.Config).Env;
  const actualEnv = Array.isArray(configuredEnv) ? configuredEnv : [];
  return (
    container.Image === imageId &&
    Object.entries(environment ?? {}).every(([key, value]) =>
      actualEnv.includes(`${key}=${value}`),
    ) &&
    (plan.accessProtocol !== "none" ||
      record(container.Config).User ===
        (plan.containerRole === "gateway" ? "0" : "1000:1000")) &&
    (host.NetworkMode === networkName ||
      (networkId !== undefined && host.NetworkMode === networkId)) &&
    actualCpu === plan.resources.limit.cpuMillis &&
    actualMemory === plan.resources.limit.memoryMiB &&
    Number(host.MemorySwap) === Number(host.Memory) &&
    host.Privileged !== true &&
    record(host.Sysctls)["net.ipv6.conf.all.disable_ipv6"] === "1" &&
    record(host.Sysctls)["net.ipv6.conf.default.disable_ipv6"] === "1" &&
    (plan.containerRole !== "gateway" ||
      record(host.Sysctls)["net.ipv4.ip_forward"] ===
        (plan.gatewayIpv4Forwarding ? "1" : undefined)) &&
    Array.isArray(host.Binds) &&
    host.Binds.length === 0 &&
    mounts.length === 1 + plan.resolved.mounts.length &&
    plan.resolved.mounts.every((expected) =>
      mounts.some(
        (actual) =>
          actual.Type === "bind" &&
          actual.Source === expected.resolvedSourceRef &&
          actual.Destination === expected.target &&
          actual.RW === (expected.mode === "read_write") &&
          actual.Propagation === "rprivate",
      ),
    ) &&
    workspace?.Type === "volume" &&
    workspace.Name === volumeName &&
    workspace.RW === true &&
    JSON.stringify(actualPorts) === JSON.stringify(expectedPorts) &&
    Array.isArray(host.CapDrop) &&
    host.CapDrop.includes("ALL") &&
    (plan.containerRole === "gateway"
      ? ["NET_ADMIN", "NET_RAW"]
      : [
          "CHOWN",
          "DAC_OVERRIDE",
          "FOWNER",
          "SETGID",
          "SETUID",
          "SYS_CHROOT",
          "NET_BIND_SERVICE",
        ]
    ).every((cap) => capAdd.includes(cap)) &&
    (plan.containerRole === undefined ||
      capAdd.length === (plan.containerRole === "gateway" ? 2 : 7)) &&
    (plan.containerRole === undefined ||
      JSON.stringify(Array.isArray(host.Devices) ? host.Devices : []) ===
        JSON.stringify(
          plan.containerRole === "gateway"
            ? [
                {
                  PathOnHost: "/dev/net/tun",
                  PathInContainer: "/dev/net/tun",
                  CgroupPermissions: "rw",
                },
              ]
            : [],
        ))
  );
}
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function assertDockerRecipe(plan: ProvisionPlan) {
  if (
    plainBridge(plan) &&
    (plan.accessProtocol !== "none" ||
      plan.resolved.network.mode !== "isolated_bridge" ||
      plan.resolved.network.verificationRequired !== false ||
      plan.resolved.network.ipv6 !== "disabled" ||
      plan.resolved.network.allowedEgress.length ||
      plan.resolved.network.allowedIngressSourceCidrs.length ||
      plan.resolved.network.managementDenyRules.length)
  )
    throw new Error(
      "Native Docker bridge requires its no-published-access contract",
    );

  if (
    plan.accessProtocol === "none" &&
    supportsContainerEntrypoint(
      {
        bootstrap: plan.bootstrap,
        ...(plan.containerGroup === undefined
          ? {}
          : { containerGroup: plan.containerGroup }),
      },
      plan.access,
    )
  )
    return;
  if (
    plan.accessProtocol !== "ssh" ||
    !supportsNodeSshRecipe({ bootstrap: plan.bootstrap }, plan.access)
  )
    throw new Error(
      "Only the fixed Docker bootstrap/access recipes are supported by this Provider",
    );
}
function containerPorts(container: Json): Array<{
  protocol: "tcp" | "udp";
  containerPort: number;
  hostAddress: string;
  hostPort: number;
}> {
  const ports = record(record(container.NetworkSettings).Ports);
  return Object.entries(ports).flatMap(([key, values]) => {
    const match = /^(\d+)\/(tcp|udp)$/.exec(key);
    if (!match || !Array.isArray(values)) return [];
    return values.flatMap((entry) => {
      const value = record(entry);
      const hostAddress = typeof value.HostIp === "string" ? value.HostIp : "";
      const hostPort = Number(value.HostPort);
      return Number.isSafeInteger(hostPort) && hostPort > 0 && hostAddress
        ? [
            {
              protocol: match[2] as "tcp" | "udp",
              containerPort: Number(match[1]),
              hostAddress,
              hostPort,
            },
          ]
        : [];
    });
  });
}
function tarFile(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  const put = (offset: number, length: number, value: string) =>
    header.write(value.slice(0, length), offset, length, "utf8");
  const octal = (offset: number, length: number, value: number) =>
    put(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
  put(0, 100, name);
  octal(100, 8, 0o600);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, contents.length);
  octal(136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  put(156, 1, "0");
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = Buffer.alloc(Math.ceil(contents.length / 512) * 512);
  contents.copy(padded);
  return Buffer.concat([header, padded, Buffer.alloc(1024)]);
}
function readTarFile(archive: Buffer, wanted: string): Buffer {
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(
      header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(),
      8,
    );
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Docker archive has an invalid file size");
    const start = offset + 512;
    if (name === wanted) return archive.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Docker archive is missing ${wanted}`);
}

function plainBridge(plan: ProvisionPlan): boolean {
  return plan.resolved.network.enforcement === "docker_bridge";
}
