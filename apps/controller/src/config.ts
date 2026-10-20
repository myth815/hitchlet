import { z } from "zod";
const ConfigSchema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    BACKUP_DAILY_COPIES: z.coerce.number().int().min(1).max(365).default(7),
    BACKUP_WEEKLY_COPIES: z.coerce.number().int().min(1).max(52).default(4),
    DISK_LOW_WATER_MIB: z.coerce.number().int().min(1).default(1024),
    DISK_RESERVE_MIB: z.coerce.number().int().min(1).default(128),
    IMAGE_PULL_BUDGET_MIB: z.coerce.number().int().min(1).default(8192),
    LOG_MAX_BYTES: z.coerce.number().int().min(1024).default(10485760),
    LOG_FILES: z.coerce.number().int().min(1).max(20).default(5),
    DATA_DIR: z.string().min(1),
    GUI_DIR: z.string().default("/app/gui"),
    EXECUTION_MODE: z
      .enum(["disabled", "simulator", "portainer"])
      .default("disabled"),
    SIMULATOR_DATA_DIR: z.string().min(1).optional(),
    HITCHLET_SECRET_KEY_FILE: z.string().min(1).optional(),
    PORTAINER_ALLOW_LOOPBACK_HTTP: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  })
  .superRefine((config, context) => {
    if (config.DISK_RESERVE_MIB >= config.DISK_LOW_WATER_MIB)
      context.addIssue({
        code: "custom",
        path: ["DISK_RESERVE_MIB"],
        message: "must be below DISK_LOW_WATER_MIB",
      });
    if (config.EXECUTION_MODE === "simulator" && !config.SIMULATOR_DATA_DIR)
      context.addIssue({
        code: "custom",
        path: ["SIMULATOR_DATA_DIR"],
        message: "required when EXECUTION_MODE=simulator",
      });
    if (
      config.EXECUTION_MODE === "portainer" &&
      !config.HITCHLET_SECRET_KEY_FILE
    )
      context.addIssue({
        code: "custom",
        path: ["HITCHLET_SECRET_KEY_FILE"],
        message: "required when EXECUTION_MODE=portainer",
      });
    if (
      !config.COOKIE_SECURE &&
      !["localhost", "127.0.0.1", "::1"].includes(config.HOST)
    )
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SECURE"],
        message: "false is allowed only when HOST is loopback",
      });
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const keys = [
    "HOST",
    "PORT",
    "LOG_LEVEL",
    "BACKUP_DAILY_COPIES",
    "BACKUP_WEEKLY_COPIES",
    "DISK_LOW_WATER_MIB",
    "DISK_RESERVE_MIB",
    "IMAGE_PULL_BUDGET_MIB",
    "LOG_MAX_BYTES",
    "LOG_FILES",
    "DATA_DIR",
    "GUI_DIR",
    "EXECUTION_MODE",
    "SIMULATOR_DATA_DIR",
    "HITCHLET_SECRET_KEY_FILE",
    "PORTAINER_ALLOW_LOOPBACK_HTTP",
    "COOKIE_SECURE",
  ] as const;
  const selected = Object.fromEntries(
    keys.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
  const result = ConfigSchema.safeParse(selected);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  return result.data;
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /authorization|token|secret|password|credential|cookie/i.test(key)
          ? "[REDACTED]"
          : redact(item),
      ]),
    );
  }
  return value;
}
