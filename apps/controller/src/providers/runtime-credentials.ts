import type { z } from "zod";
import { NodeRuntimeConfigSchema } from "@hitchlet/contracts/admin";
import { RuntimeNetworkHttpClient } from "./runtime-network-client.js";

/** Shared versioned credential loader; secrets never enter command payloads. */
export function runtimeClient(
  profile: z.infer<typeof NodeRuntimeConfigSchema>,
  secrets: { get(ref: string): Promise<string> },
) {
  const agent = profile.runtimeAgent;
  return new RuntimeNetworkHttpClient({
    baseUrl: agent.baseUrl,
    loadCredentials: async () => {
      const [token, ca, cert, key] = await Promise.all([
        secrets.get(agent.tokenSecretRef),
        secrets.get(agent.caSecretRef),
        secrets.get(agent.clientCertSecretRef),
        secrets.get(agent.clientKeySecretRef),
      ]);
      return {
        token,
        ca: Buffer.from(ca),
        cert: Buffer.from(cert),
        key: Buffer.from(key),
      };
    },
  });
}
