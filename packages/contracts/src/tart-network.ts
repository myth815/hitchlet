import { z } from "zod";
const id = z.string().min(1).max(200);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cidr = z.string().min(3).max(64);
const port = z.number().int().min(1).max(65535);

const allowedEgress = z
  .object({
    cidr,
    protocol: z.enum(["tcp", "udp"]),
    ports: z.array(port).min(1).max(4096),
  })
  .strict();

const managementDenyRule = z
  .object({
    cidr,
    protocol: z.enum(["any", "tcp", "udp"]),
    ports: z.union([z.literal("any"), z.array(port).min(1).max(4096)]),
  })
  .strict();

/** Frozen subset of the resolved VM network contract needed by Tart Softnet. */
const isolatedTartNetworkPlanSchema = z
  .object({
    grantId: id,
    revisionId: id,
    frozenPlatformDenyRevisionId: id,
    platformDenyRevisionId: id,
    mode: z.literal("isolated_vm"),
    enforcement: z.literal("tart_agent"),
    ipv6: z.enum(["disabled", "verified_equivalent"]),
    allowedEgress: z.array(allowedEgress).max(1024),
    allowedIngressSourceCidrs: z.array(cidr).max(1024),
    accessSourceCidrs: z.array(cidr).max(1024),
    accessPorts: z.array(port).max(128),
    managementDenyRules: z.array(managementDenyRule).max(4096),
    contractHash: sha256,
  })
  .strict();

const trustedNatTartNetworkPlanSchema = isolatedTartNetworkPlanSchema.extend({
  mode: z.literal("trusted_nat"),
  enforcement: z.literal("tart_nat"),
  ipv6: z.literal("not_enforced"),
});
export const tartNetworkPlanSchema = z.discriminatedUnion("mode", [
  isolatedTartNetworkPlanSchema,
  trustedNatTartNetworkPlanSchema,
]);

export type TartNetworkPlan = z.infer<typeof tartNetworkPlanSchema>;

const tartNetworkPlanWithoutHashSchema = z.union([
  isolatedTartNetworkPlanSchema.omit({ contractHash: true }),
  trustedNatTartNetworkPlanSchema.omit({ contractHash: true }),
]);

/** Stable canonical form used to bind the full source and access contract. */
export function canonicalTartNetworkPlan(value: unknown): string {
  const parsed = tartNetworkPlanSchema.safeParse(value);
  if (parsed.success) {
    const plan: Record<string, unknown> = { ...parsed.data };
    delete plan.contractHash;
    return canonical(plan);
  }
  return canonical(tartNetworkPlanWithoutHashSchema.parse(value));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",") +
    "}"
  );
}
