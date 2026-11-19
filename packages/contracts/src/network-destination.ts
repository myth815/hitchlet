import { z } from "zod";

const ipv4 = z.ipv4();
/** Omitted scope preserves the existing forwarded-egress contract. */
export const networkDestinationSchema = z
  .object({
    cidr: z.string().min(3).max(64),
    protocol: z.enum(["tcp", "udp"]),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
    destinationScope: z.enum(["forward", "host"]).optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.destinationScope !== "host") return;
    if (
      !rule.cidr.endsWith("/32") ||
      !ipv4.safeParse(rule.cidr.slice(0, -3)).success ||
      rule.cidr === "0.0.0.0/32"
    )
      context.addIssue({
        code: "custom",
        path: ["cidr"],
        message: "Host egress requires one explicit IPv4 /32 destination",
      });
    if (rule.protocol !== "tcp")
      context.addIssue({
        code: "custom",
        path: ["protocol"],
        message: "Host egress requires TCP with explicit ports",
      });
  });

export type NetworkDestination = Readonly<
  Omit<z.infer<typeof networkDestinationSchema>, "ports"> & {
    ports: readonly number[];
  }
>;
