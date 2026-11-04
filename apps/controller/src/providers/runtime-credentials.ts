import type { z } from "zod";
import {
  NodeRuntimeConfigSchema,
  TartNodeRuntimeConfigSchema,
} from "@hitchlet/contracts/admin";
import {
  RuntimeAgentHttpTransport,
  RuntimeNetworkHttpClient,
  type RuntimeAgentJsonTransport,
  type RuntimeNetworkCredentials,
} from "./runtime-network-client.js";
import {
  readTartRuntimeFacts,
  TartRuntimeHttpClient,
} from "./tart-runtime-client.js";

type SecretReader = { get(ref: string): Promise<string> };
const TART_ACTION_TIMEOUT_MS = 240_000;
const TART_FACTS_TIMEOUT_MS = 30_000;
type RuntimeAgentProfile = Readonly<{
  runtimeAgent: z.infer<typeof NodeRuntimeConfigSchema>["runtimeAgent"];
}>;

export type TartFactsForRevisionInput = Readonly<{
  installationId: string;
  runtimeIdentityId: string;
  connectionRevisionId: string;
  nodeId: string;
  config: Readonly<Record<string, unknown>>;
}>;
export type TartFactsForRevision = (
  input: TartFactsForRevisionInput,
) => ReturnType<typeof tartRuntimeFactsForNode>;

function credentialLoader(
  profile: RuntimeAgentProfile,
  secrets: SecretReader,
): () => Promise<RuntimeNetworkCredentials> {
  const agent = profile.runtimeAgent;
  return async () => {
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
  };
}

/** Shared versioned credential loader; secrets never enter command payloads. */
export function runtimeClient(
  profile: z.infer<typeof NodeRuntimeConfigSchema>,
  secrets: SecretReader,
) {
  const agent = profile.runtimeAgent;
  return new RuntimeNetworkHttpClient({
    baseUrl: agent.baseUrl,
    loadCredentials: credentialLoader(profile, secrets),
  });
}

/** Tart-only HTTP budget; the caller caps it to the frozen operation deadline. */
export function runtimeAgentTransport(
  profile: RuntimeAgentProfile,
  secrets: SecretReader,
  timeoutMs: number,
) {
  return new RuntimeAgentHttpTransport({
    baseUrl: profile.runtimeAgent.baseUrl,
    loadCredentials: credentialLoader(profile, secrets),
    timeoutMs,
  });
}

/** Current secret refs come from the exact Node profile; the caller supplies frozen identity/deadline. */
export function createTartRuntimeClient(
  input: Readonly<{
    profile: z.infer<typeof TartNodeRuntimeConfigSchema>;
    secrets: SecretReader;
    installationId: string;
    runtimeIdentityId: string;
    controllerEpoch: number;
    deadlineMs: number;
    now?: () => number;
  }>,
  transport?: RuntimeAgentJsonTransport,
): TartRuntimeHttpClient {
  const now = input.now ?? Date.now;
  const remainingMs = input.deadlineMs - now();
  if (remainingMs < 1)
    throw new Error("Tart Runtime Agent action deadline has expired");
  return new TartRuntimeHttpClient({
    transport:
      transport ??
      runtimeAgentTransport(
        input.profile,
        input.secrets,
        Math.min(TART_ACTION_TIMEOUT_MS, remainingMs),
      ),
    installationId: input.installationId,
    runtimeIdentityId: input.runtimeIdentityId,
    controllerEpoch: input.controllerEpoch,
    deadlineMs: input.deadlineMs,
    now,
  });
}

/** Read-only current facts for probe/discovery; the result is not node qualification. */
export function tartRuntimeFactsForNode(
  input: Readonly<{
    profile: z.infer<typeof TartNodeRuntimeConfigSchema>;
    secrets: SecretReader;
    installationId: string;
    runtimeIdentityId: string;
  }>,
  timeoutMs = TART_FACTS_TIMEOUT_MS,
  transportOverride?: RuntimeAgentJsonTransport,
) {
  const transport =
    transportOverride ??
    runtimeAgentTransport(input.profile, input.secrets, timeoutMs);
  return readTartRuntimeFacts(
    transport,
    input.installationId,
    input.runtimeIdentityId,
    timeoutMs,
  );
}

export function tartRuntimeFactsForRevision(
  input: TartFactsForRevisionInput,
  secrets: SecretReader,
) {
  if (
    !input.installationId ||
    !input.runtimeIdentityId ||
    !input.connectionRevisionId ||
    !input.nodeId
  )
    throw new Error("Tart facts revision binding is required");
  const profileValue = input.config.runtimeProfile ?? input.config;
  const profile = TartNodeRuntimeConfigSchema.parse(profileValue);
  return tartRuntimeFactsForNode({
    profile,
    secrets,
    installationId: input.installationId,
    runtimeIdentityId: input.runtimeIdentityId,
  });
}

export type HyperVFactsForRevisionInput = TartFactsForRevisionInput;
export type HyperVFactsForRevision = (
  input: HyperVFactsForRevisionInput,
) => Promise<import("@hitchlet/contracts/internal").HyperVRuntimeFacts>;
export async function hyperVRuntimeFactsForNode(
  input: {
    profile: RuntimeAgentProfile;
    secrets: SecretReader;
    installationId: string;
    runtimeIdentityId: string;
  },
  timeoutMs = 30_000,
  transport?: RuntimeAgentJsonTransport,
) {
  const { readHyperVRuntimeFacts } = await import("./hyperv-runtime-client.js");
  return readHyperVRuntimeFacts(
    transport ?? runtimeAgentTransport(input.profile, input.secrets, timeoutMs),
    input.installationId,
    input.runtimeIdentityId,
    timeoutMs,
  );
}
export async function hyperVRuntimeFactsForRevision(
  input: HyperVFactsForRevisionInput,
  secrets: SecretReader,
) {
  const { HyperVNodeRuntimeConfigSchema } = await import(
    "@hitchlet/contracts/admin"
  );
  const profile = HyperVNodeRuntimeConfigSchema.parse(
    input.config.runtimeProfile ?? input.config,
  );
  return hyperVRuntimeFactsForNode({
    profile,
    secrets,
    installationId: input.installationId,
    runtimeIdentityId: input.runtimeIdentityId,
  });
}
export async function createHyperVRuntimeClient(
  input: {
    profile: RuntimeAgentProfile;
    secrets: SecretReader;
    installationId: string;
    runtimeIdentityId: string;
    controllerEpoch: number;
    deadlineMs: number;
  },
  transport?: RuntimeAgentJsonTransport,
) {
  const { HyperVRuntimeHttpClient } = await import(
    "./hyperv-runtime-client.js"
  );
  const remaining = input.deadlineMs - Date.now();
  if (remaining < 1) throw Error("Hyper-V Runtime deadline expired");
  return new HyperVRuntimeHttpClient({
    transport:
      transport ??
      runtimeAgentTransport(
        input.profile,
        input.secrets,
        Math.min(240000, remaining),
      ),
    installationId: input.installationId,
    runtimeIdentityId: input.runtimeIdentityId,
    controllerEpoch: input.controllerEpoch,
    deadlineMs: input.deadlineMs,
  });
}
