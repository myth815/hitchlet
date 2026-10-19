import { z } from "zod";
const ConfigSchema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATA_DIR: z.string().min(1),
    GUI_DIR: z.string().default("/app/gui"),
    EXECUTION_MODE: z.enum(["disabled", "simulator"]).default("disabled"),
    SIMULATOR_DATA_DIR: z.string().min(1).optional(),
    COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  })
  .superRefine((config, context) => {
    if (config.EXECUTION_MODE === "simulator" && !config.SIMULATOR_DATA_DIR)
      context.addIssue({
        code: "custom",
        path: ["SIMULATOR_DATA_DIR"],
        message: "required when EXECUTION_MODE=simulator",
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
    "DATA_DIR",
    "GUI_DIR",
    "EXECUTION_MODE",
    "SIMULATOR_DATA_DIR",
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
