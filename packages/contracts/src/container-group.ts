import { z } from "zod";

export const CONTAINER_GROUP_BOOTSTRAP =
  "hitchlet-container-group-entrypoint-v1";
export const containerMemberNameSchema = z.enum(["workload", "gateway"]);
export const containerLinkSchema = z
  .object({
    from: containerMemberNameSchema,
    to: containerMemberNameSchema,
    protocol: z.literal("tcp"),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
  })
  .strict()
  .refine((v) => v.from !== v.to, {
    message: "A member link must connect different members",
  });
export const containerGroupSchema = z
  .object({
    gateway: z
      .object({
        artifactRef: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        resources: z
          .object({
            cpuMillis: z.number().int().positive(),
            memoryMiB: z.number().int().positive(),
            scratchMiB: z.number().int().nonnegative().default(0),
          })
          .strict(),
        mountPaths: z
          .array(z.string().regex(/^\/[A-Za-z0-9_./-]+$/))
          .refine((v) => new Set(v).size === v.length),
        stateMountPath: z
          .string()
          .regex(/^\/var\/lib\/[A-Za-z0-9_.-]+$/)
          .refine((v) => ![".", ".."].includes(v.split("/").at(-1)!)),
        networkCapability: z.literal("tun"),
        ipv4Forwarding: z.boolean().default(false),
        environment: z
          .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096))
          .optional(),
        imageVersionId: z.string().uuid().optional(),
        imageArtifactId: z.string().uuid().optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.artifactRef.endsWith("@" + v.digest) &&
          (v.imageVersionId === undefined) ===
            (v.imageArtifactId === undefined),
        {
          message: "Gateway ref must pin its digest",
        },
      ),
    links: z.array(containerLinkSchema).min(1),
  })
  .strict();
export type ContainerGroup = z.infer<typeof containerGroupSchema>;
export type ContainerMemberName = z.infer<typeof containerMemberNameSchema>;
export const memberDetailsSchema = z
  .object({
    memberName: containerMemberNameSchema,
    artifactDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullish(),
    ipv4: z.ipv4().nullish(),
    target: z.string().nullish(),
    resources: z
      .object({
        cpuMillis: z.number().int().positive(),
        memoryMiB: z.number().int().positive(),
        scratchMiB: z.number().int().nonnegative(),
      })
      .strict()
      .nullish(),
    mountBindings: z
      .array(
        z
          .object({
            grantId: z.string().min(1),
            revisionId: z.string().min(1),
            target: z.string().min(1),
            mode: z.enum(["read_only", "read_write"]),
          })
          .strict(),
      )
      .nullish(),
  })
  .strict();
export const containerGroupInventorySchema = z
  .object({
    members: z
      .array(
        z
          .object({
            name: containerMemberNameSchema,
            containerId: z.string().min(1),
            artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            ipv4: z.ipv4(),
            resources: z
              .object({
                cpuMillis: z.number().int().positive(),
                memoryMiB: z.number().int().positive(),
                scratchMiB: z.number().int().nonnegative(),
              })
              .strict(),
            imageVersionId: z.string().uuid().optional(),
            imageArtifactId: z.string().uuid().optional(),
            stateVolume: z
              .object({
                id: z.string().min(1),
                target: z.string().min(1),
                ownership: z.literal("owned"),
              })
              .strict(),
            mountBindings: z.array(
              z
                .object({
                  grantId: z.string().min(1),
                  revisionId: z.string().min(1),
                  target: z.string().min(1),
                  mode: z.enum(["read_only", "read_write"]),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .length(2)
      .refine(
        (v) =>
          new Set(v.map((m) => m.name)).size === 2 &&
          new Set(v.map((m) => m.containerId)).size === 2 &&
          new Set(v.map((m) => m.ipv4)).size === 2 &&
          new Set(v.map((m) => m.stateVolume.id)).size === 2,
      ),
    links: z.array(containerLinkSchema).min(1),
  })
  .strict();
export type ContainerGroupInventory = z.infer<
  typeof containerGroupInventorySchema
>;

/** Read only registered immutable metadata, never a consumer command or Docker YAML. */
export function containerGroupFromRequirements(
  value: unknown,
): ContainerGroup | undefined {
  const r =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const b =
    r.bootstrap !== null && typeof r.bootstrap === "object"
      ? (r.bootstrap as Record<string, unknown>)
      : {};
  if (
    r.containerGroup === undefined &&
    b.mechanism !== CONTAINER_GROUP_BOOTSTRAP
  )
    return undefined;
  if (b.mechanism !== CONTAINER_GROUP_BOOTSTRAP)
    throw new Error("Container group requires its fixed bootstrap recipe");
  return containerGroupSchema.parse(r.containerGroup);
}
export function expectedContainerKinds(
  group: ContainerGroup | undefined,
): string[] {
  return [
    ...(group ? ["container", "container", "volume"] : ["container"]),
    "volume",
    "network_policy",
  ].sort();
}
export function validDockerOwnedKinds(
  objects: readonly { id: string; kind: string }[],
): boolean {
  return (
    objects.length >= 3 &&
    new Set(objects.map((o) => o.kind + ":" + o.id)).size === objects.length &&
    objects.filter((o) => o.kind === "volume").length >= 1 &&
    objects.filter((o) => o.kind === "container").length >= 1 &&
    objects.filter((o) => o.kind === "network_policy").length === 1 &&
    objects.filter((o) => o.kind === "container").length +
      objects.filter((o) => o.kind === "volume").length ===
      objects.length - 1
  );
}

/** Concrete Engine bindings. These are not user-supplied addresses. */
export const runtimeMemberLinkSchema = z
  .object({
    fromContainerId: z.string().min(1).max(200),
    toContainerId: z.string().min(1).max(200),
    fromIpv4: z.ipv4(),
    toIpv4: z.ipv4(),
    protocol: z.literal("tcp"),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
  })
  .strict()
  .refine(
    (v) => v.fromContainerId !== v.toContainerId && v.fromIpv4 !== v.toIpv4,
    { message: "Member link bindings must be distinct" },
  );
