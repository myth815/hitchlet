import { z } from "zod";
import { hostSnapshotSchema } from "./host-observation.js";

const id = z.string().uuid();
const counter = z.number().int().nonnegative().safe();
const epoch = counter.min(1);
const os = z.enum(["linux", "windows", "macos"]);
const architecture = z.enum(["amd64", "arm64"]);
/** Administrator supplies the UUID generated locally on the intended physical host. */
export const hostPairingRequestSchema = z
  .object({
    machineId: id,
    hostIdentity: id,
    expectedSessionEpoch: counter.optional(),
    reason: z.string().trim().min(1).max(256),
  })
  .strict();
export const hostPairingReceiptSchema = z
  .object({
    agentId: id,
    machineId: id,
    installationId: id,
    controllerEpoch: epoch,
    pairingToken: z.string().regex(/^hcp_[A-Za-z0-9_-]{43}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const hostEnrollRequestSchema = z
  .object({
    agentId: id,
    machineId: id,
    installationId: id,
    hostIdentity: id,
    pairingToken: z.string().regex(/^hcp_[A-Za-z0-9_-]{43}$/),
    hostOs: os,
    architecture,
    protocolVersion: z.literal(1),
    role: z.literal("physical_host"),
  })
  .strict();
/** This is the only response that contains an active credential. Never log or cache it. */
export const hostEnrollReceiptSchema = z
  .object({
    agentId: id,
    machineId: id,
    installationId: id,
    credential: z.string().regex(/^hch_[A-Za-z0-9_-]{43}$/),
    controllerEpoch: epoch,
    sessionEpoch: counter,
  })
  .strict();
/** expectedSessionEpoch fences competing service processes; every new process uses a fresh bootId. */
export const hostBootRequestSchema = z
  .object({
    installationId: id,
    controllerEpoch: epoch,
    bootId: id,
    expectedSessionEpoch: counter,
  })
  .strict();
export const hostBootReceiptSchema = z
  .object({ bootId: id, sessionEpoch: epoch, controllerEpoch: epoch })
  .strict();
export const hostHeartbeatSchema = z
  .object({
    installationId: id,
    controllerEpoch: epoch,
    sessionEpoch: epoch,
    protocolVersion: z.literal(1),
    agentVersion: z.string().min(1).max(64),
    snapshot: hostSnapshotSchema,
  })
  .strict();
export const hostHeartbeatReceiptSchema = z
  .object({
    sequence: counter,
    sessionEpoch: epoch,
    receivedAt: z.string().datetime(),
    duplicate: z.boolean(),
    offlineLeaseEnforcement: z.literal(false),
  })
  .strict();
/** Resource values remain null when sampling fails. Freshness never grants permission to power off. */
export const hostSnapshotViewSchema = z
  .object({
    snapshot: hostSnapshotSchema,
    receivedAt: z.string().datetime(),
    fresh: z.boolean(),
    humanPresence: z.enum(["present", "absent", "unknown"]),
    offlineLeaseEnforcement: z.literal(false),
  })
  .strict();
export const hostAgentViewSchema = z
  .object({
    agentId: id,
    machineId: id,
    status: z.enum(["active", "disabled"]),
    paired: z.boolean(),
    sessionEpoch: counter,
    bootId: id.nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    protocolVersion: z.literal(1),
    offlineLeaseEnforcement: z.literal(false),
  })
  .strict();
export const hostRevokeRequestSchema = z
  .object({
    expectedSessionEpoch: counter,
    reason: z.string().trim().min(1).max(256),
  })
  .strict();
export type HostPairingRequest = z.infer<typeof hostPairingRequestSchema>;
export type HostEnrollRequest = z.infer<typeof hostEnrollRequestSchema>;
export type HostBootRequest = z.infer<typeof hostBootRequestSchema>;
export type HostHeartbeat = z.infer<typeof hostHeartbeatSchema>;

export const hostSessionViewSchema = z
  .object({
    installationId: id,
    controllerEpoch: epoch,
    sessionEpoch: counter,
    bootId: id.nullable(),
  })
  .strict();
export type HostSnapshotView = z.infer<typeof hostSnapshotViewSchema>;
