import {
  containerGroupInventorySchema,
  memberDetailsSchema,
  type ContainerGroup,
} from "@hitchlet/contracts/internal";

/** Only the certified non-secret member projection is returned; no host source,
 * environment, command, setup key, or arbitrary Provider details. */
export function groupInventory(
  group: ContainerGroup | undefined,
  primaryDigest: unknown,
  objects: readonly {
    id: string;
    kind: string;
    ownership: string;
    details?: unknown;
  }[],
) {
  if (!group) return undefined;
  const members = (["workload", "gateway"] as const).map((name) => {
    const containers = objects.filter(
      (o) =>
        o.ownership === "owned" &&
        o.kind === "container" &&
        memberDetailsSchema.safeParse(o.details).data?.memberName === name,
    );
    const volumes = objects.filter(
      (o) =>
        o.ownership === "owned" &&
        o.kind === "volume" &&
        memberDetailsSchema.safeParse(o.details).data?.memberName === name,
    );
    if (containers.length !== 1 || volumes.length !== 1)
      throw new Error("Certified group role inventory is incomplete");
    const container = containers[0]!,
      volume = volumes[0]!;
    const detail = memberDetailsSchema.parse(container.details),
      state = memberDetailsSchema.parse(volume.details);
    const digest = name === "gateway" ? group.gateway.digest : primaryDigest;
    const target =
      name === "gateway" ? group.gateway.stateMountPath : "/workspace";
    if (
      detail.artifactDigest !== digest ||
      !detail.ipv4 ||
      !detail.resources ||
      state.target !== target
    )
      throw new Error(
        "Certified group member image or state volume differs from its recipe",
      );
    const mountBindings = detail.mountBindings ?? [];
    if (
      name === "gateway" &&
      (mountBindings.length !== group.gateway.mountPaths.length ||
        mountBindings.some(
          (m) =>
            m.mode !== "read_only" ||
            !group.gateway.mountPaths.includes(m.target),
        ))
    )
      throw new Error(
        "Certified gateway storage reference differs from its recipe",
      );
    if (
      name === "workload" &&
      mountBindings.some((m) => group.gateway.mountPaths.includes(m.target))
    )
      throw new Error("Gateway-only reference leaked into workload membership");
    if (
      name === "gateway" &&
      (detail.resources.cpuMillis !== group.gateway.resources.cpuMillis ||
        detail.resources.memoryMiB !== group.gateway.resources.memoryMiB ||
        detail.resources.scratchMiB !== group.gateway.resources.scratchMiB)
    )
      throw new Error(
        "Certified gateway resource share differs from its recipe",
      );
    return {
      name,
      containerId: container.id,
      artifactDigest: String(digest),
      ipv4: detail.ipv4,
      resources: detail.resources,
      ...(name === "gateway" && group.gateway.imageVersionId
        ? {
            imageVersionId: group.gateway.imageVersionId,
            imageArtifactId: group.gateway.imageArtifactId!,
          }
        : {}),
      stateVolume: { id: volume.id, target, ownership: "owned" as const },
      mountBindings,
    };
  });
  return containerGroupInventorySchema.parse({ members, links: group.links });
}
