import { z } from "zod";

const id = z.string().uuid();
const integer = z.number().int().safe().nonnegative();
const version = z.number().int().safe().positive();
/** Conclusions are not verification evidence. D22a management cannot mark hardware verified. */
export const PowerVerificationSchema = z.enum([
  "unsupported",
  "unverified",
  "verified",
]);
export const FaultRecoveryPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("smart_plug_cycle"),
      /** Fixed exclusive target; never supplied by a tenant or inferred from device model. */
      plugBindingId: id,
      /** automatic_verified remains blocked until independent D22b acceptance. */
      authorization: z.enum(["operator", "automatic_verified"]),
      /** Seconds after confirmed off; at least 600, never restarted after controller recovery. */
      minimumOffSeconds: z.number().int().safe().min(600).max(86400),
      /** A stable incident cannot initiate a second cut, including after terminal failure. */
      maximumCyclesPerIncident: z.literal(1),
    })
    .strict(),
]);
export const PowerPolicySchema = z
  .object({
    /** Enables evaluation only; does not imply accepted hardware capabilities. */
    enabled: z.boolean().default(false),
    /** D22a cannot enable an executor through configuration. */
    dryRun: z.literal(true).default(true),
    /** Continuous eligible seconds; a blocker or observation gap resets this timer. */
    idleSeconds: z.number().int().safe().min(1).max(604800).default(1800),
    /** sleep is reserved configuration; D22a rejects starting that unsupported preview. */
    idleAction: z.enum(["none", "sleep", "shutdown"]).default("none"),
    /** Requires a separately verified route and the appropriate off evidence. */
    wakeOnDemand: z.boolean().default(false),
    /** Seconds in one bounded wake window, also limited by the original cycle/provision deadline. */
    wakeTimeoutSeconds: z.number().int().min(30).max(300).default(300),
    /** At most three sends, separated by 30 seconds; retry cannot extend the deadline. */
    maximumWakeAttempts: z.number().int().min(1).max(3).default(3),
    /** Seconds after an owned accepted shutdown before heartbeat loss may imply expected-off. */
    expectedOffGuardSeconds: z.number().int().min(120).max(3600).default(120),
    /** Normal energy saving can never escalate into force-kill or AC removal. */
    permitForcedPhysicalPowerOff: z.literal(false).default(false),
    /** Independent machine-fault use case; absent configuration defaults to disabled. */
    faultRecovery: FaultRecoveryPolicySchema.default({ mode: "disabled" }),
  })
  .strict();
export type PowerPolicy = z.infer<typeof PowerPolicySchema>;
export type FaultRecoveryPolicy = z.infer<typeof FaultRecoveryPolicySchema>;
export const PowerCapabilitiesSchema = z
  .object({
    /** Entering normal sleep is distinct from shutdown and all wake capabilities. */
    sleep: PowerVerificationSchema,
    /** Non-forced, cancelable OS shutdown acceptance and behavior. */
    normalShutdown: PowerVerificationSchema,
    wakeFromSleep: PowerVerificationSchema,
    /** Starting from actual off; network wake from sleep does not prove this. */
    coldBoot: PowerVerificationSchema,
    /** Independent safety proof for WOL while the OS might still be on. */
    wolWhilePossiblyOn: PowerVerificationSchema,
    /** null means no available always-on/LAN relay route. A configured ID is not verification. */
    wakeRouteRef: id.nullable(),
    /** Accepted hardware evidence only; D22a exposes none and cannot accept reports via management. */
    verificationReportIds: z.array(id),
  })
  .strict();
export type PowerCapabilities = z.infer<typeof PowerCapabilitiesSchema>;

/** Administrative conclusions are editable; accepted verification evidence remains a D22b concern. */
export const PowerCapabilityConclusionsSchema = PowerCapabilitiesSchema.omit({
  verificationReportIds: true,
})
  .extend({
    sleep: z.enum(["unsupported", "unverified"]),
    normalShutdown: z.enum(["unsupported", "unverified"]),
    wakeFromSleep: z.enum(["unsupported", "unverified"]),
    coldBoot: z.enum(["unsupported", "unverified"]),
    wolWhilePossiblyOn: z.enum(["unsupported", "unverified"]),
  })
  .strict();
export const PowerCapabilityUpdateSchema = z
  .object({
    expectedMachineVersion: version,
    conclusions: PowerCapabilityConclusionsSchema,
  })
  .strict();
export type PowerCapabilityUpdate = z.infer<typeof PowerCapabilityUpdateSchema>;

/** Only fixed secret-version references are accepted; no token or latest alias. */
export const SmartPlugBindingInputSchema = z
  .object({
    id,
    /** One physical Machine exclusively supplied by this device. */
    machineId: id,
    adapter: z.literal("xiaomi_miio_lan"),
    device: z
      .object({
        model: z.literal("cuco.plug.v3"),
        /** Exact decimal identity, kept as text to avoid precision loss or leading-zero aliases. */
        deviceId: z.string().regex(/^[1-9][0-9]{0,19}$/),
        /** Accepted case-insensitively, normalized lowercase and globally unique in storage. */
        macAddress: z.string().regex(/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/),
      })
      .strict(),
    /** Installation endpoint reference; never a consumer-controlled network address. */
    endpointRef: z.string().regex(/^endpoint:[a-zA-Z0-9._-]{1,120}$/),
    /** Immutable secret-store version reference, resolved only by a future real adapter. */
    credentialVersionRef: z.string().regex(/^secret:[a-f0-9]{32}$/),
    /** Physical exclusive wiring conclusion; configuration alone cannot verify it. */
    dedicatedSupply: z.enum(["unsupported", "unverified"]),
    /** Full-machine AC restore/auto-boot conclusion, separate from plug switch control. */
    acPowerOn: z.enum(["unsupported", "unverified"]),
    verificationReportIds: z.array(id).max(0),
  })
  .strict();
export const SmartPlugBindingSchema = SmartPlugBindingInputSchema.extend({
  /** Binding revision, copied with identity and credential reference into the recovery intent. */
  version,
});
export type SmartPlugBinding = z.infer<typeof SmartPlugBindingSchema>;
export const PowerConfigurationUpdateSchema = z
  .object({
    /** Independent power-policy version; zero means no policy has been saved yet. */
    expectedVersion: integer,
    policy: PowerPolicySchema,
  })
  .strict();
export const SmartPlugBindingUpdateSchema = z
  .object({
    expectedMachineVersion: version,
    binding: SmartPlugBindingInputSchema.nullable(),
  })
  .strict();
export const PowerConfigurationSchema = z
  .object({
    machineId: id,
    machineVersion: version,
    machineEpoch: version,
    /** Power-policy version, independent of Machine version. Zero projects disabled defaults. */
    version: integer,
    policy: PowerPolicySchema,
    binding: SmartPlugBindingSchema.nullable(),
    capabilities: PowerCapabilitiesSchema,
    /** D22a never issues a real execution permit, even if legacy JSON claims verified. */
    executionAllowed: z.literal(false),
    executionDisabledReasons: z.array(z.string()),
    shutdownDisabledReasons: z.array(z.string()),
    activePreviewId: id.nullable(),
  })
  .strict();
export const PowerPolicyPreviewSchema = z
  .object({
    configuration: PowerConfigurationSchema,
    canSave: z.literal(true),
  })
  .strict();
export const PowerPreviewStartSchema = z
  .object({
    expectedPolicyVersion: integer,
    mode: z.enum(["idle_shutdown", "fault_recovery"]),
    /** Required for fault recovery, installation-deduplicated per Machine across terminal cycles. */
    incidentId: id.optional(),
    /** Explicit description, retained with affected claims, never clears their ownership. */
    riskAcknowledgement: z.string().min(12).max(1000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === "fault_recovery" && !v.incidentId)
      ctx.addIssue({
        code: "custom",
        path: ["incidentId"],
        message: "A stable incident ID is required",
      });
  });
/** Administrator-supplied synthetic events, never Agent receipts or executable permits. */
export const PowerPreviewEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evaluate") }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
  z
    .object({
      kind: z.literal("accept_shutdown"),
      simulatedLocalCheck: z.literal("complete_absent_clear"),
    })
    .strict(),
  z.object({ kind: z.literal("confirm_off"), evidenceId: id }).strict(),
  z.object({ kind: z.literal("wake"), provisionDeadlineMs: integer }).strict(),
  z
    .object({
      kind: z.literal("plug_readback"),
      deviceId: z.string().regex(/^[1-9][0-9]{0,19}$/),
      macAddress: z.string().regex(/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/),
      state: z.enum(["on", "off", "unknown"]),
    })
    .strict(),
  z.object({ kind: z.literal("off_result_unknown") }).strict(),
]);
export const PowerPreviewAdvanceSchema = z
  .object({ expectedVersion: version, event: PowerPreviewEventSchema })
  .strict();
export const PowerPreviewStateSchema = z
  .object({
    id,
    machineId: id,
    version,
    dryRun: z.literal(true),
    executable: z.literal(false),
    mode: z.enum(["idle_shutdown", "fault_recovery"]),
    phase: z.enum([
      "idle",
      "draining",
      "shutdown_requested",
      "off_expected",
      "off_confirmed",
      "waking",
      "inspect",
      "off_pending",
      "inspect_off",
      "off_wait",
      "on_pending",
      "verifying",
      "complete",
      "cancelled",
      "manual",
    ]),
    /** Original policy/entity/control fences; new normal power actions require all still current. */
    policyVersion: integer,
    machineVersion: version,
    machineEpoch: version,
    /** Sandbox drain counter only. It never replaces or increments the real Machine epoch. */
    virtualEpoch: version,
    controllerEpoch: version,
    bootId: z.string().nullable(),
    /** UTC milliseconds; null means no continuous idle interval is established. */
    idleSinceMs: integer.nullable(),
    lastEvaluationAtMs: integer,
    /** SHA-256 of current safety conditions, excluding ordinary sampling sequence/time. */
    conditionKey: z.string().regex(/^[a-f0-9]{64}$/),
    /** Synthetic OS acceptance time/ID only; both null before acceptance or after invalidation. */
    acceptedAtMs: integer.nullable(),
    acceptedReceiptId: id.nullable(),
    /** Virtual observation only; expected-off must remain unknown, never fabricate observed off. */
    observedPower: z.enum(["on", "off", "unknown"]),
    /** null until an independent synthetic off-confirmation event. */
    offEvidenceId: id.nullable(),
    wakeAttempts: integer,
    nextWakeAtMs: integer.nullable(),
    /** UTC milliseconds; null before a bounded normal transition or confirmed recovery wait. */
    deadlineMs: integer.nullable(),
    /** Frozen duration in seconds; subsequent policy edits cannot shorten or restart the wait. */
    minimumOffSeconds: z.number().int().min(600),
    /** Independent durable obligation once off might have occurred; cancellation does not clear it. */
    restoreRequired: z.boolean(),
    /** UTC milliseconds of synthetic on readback; null until supply is known restored. */
    supplyRestoredAtMs: integer.nullable(),
    /** Original UTC-millisecond earliest restore time; null while off is still unknown. */
    restoreNotBeforeMs: integer.nullable(),
    incidentId: id.nullable(),
    /** Complete frozen target/revision/secret reference; null for normal power previews. */
    binding: SmartPlugBindingSchema.nullable(),
    riskAcknowledgement: z.string().nullable(),
    affectedClaimIds: z.array(z.string()),
    reasons: z.array(z.string()),
    createdAtMs: integer,
    updatedAtMs: integer,
  })
  .strict();
export type PowerPreviewState = z.infer<typeof PowerPreviewStateSchema>;
export type PowerPreviewEvent = z.infer<typeof PowerPreviewEventSchema>;
export type PowerPreviewStart = z.infer<typeof PowerPreviewStartSchema>;
export const PowerSchemas = {
  PowerPolicySchema,
  PowerConfigurationUpdateSchema,
  SmartPlugBindingUpdateSchema,
  PowerCapabilityUpdateSchema,
  PowerConfigurationSchema,
  PowerPolicyPreviewSchema,
  PowerPreviewStartSchema,
  PowerPreviewAdvanceSchema,
  PowerPreviewStateSchema,
};

export type PowerConfigurationUpdate = z.infer<
  typeof PowerConfigurationUpdateSchema
>;
export type SmartPlugBindingUpdate = z.infer<
  typeof SmartPlugBindingUpdateSchema
>;
export type PowerPreviewAdvance = z.infer<typeof PowerPreviewAdvanceSchema>;
