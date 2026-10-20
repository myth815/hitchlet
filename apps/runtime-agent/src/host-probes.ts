import { execFile } from "node:child_process";
import { cpus, freemem, totalmem, release } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  hostSnapshotSchema,
  type HostSnapshot,
} from "@hitchlet/contracts/internal";
import { fileURLToPath } from "node:url";

/** Fixed programs/argv only. stdout is bounded and never logged; failures expose stable codes. */
export type HostCommand =
  | "mac-console"
  | "mac-json"
  | "mac-virtual"
  | "who"
  | "linux-virtual"
  | "linux-sessions"
  | "linux-session"
  | "windows-sessions";
export type CommandRunner = (
  command: HostCommand,
  argument?: string,
) => Promise<string>;
export const runHostCommand: CommandRunner = async (command, argument) => {
  let file: string, args: string[], input: string | undefined;
  switch (command) {
    case "mac-console":
      file = "/usr/sbin/ioreg";
      args = ["-n", "Root", "-d1", "-a"];
      break;
    case "mac-json":
      file = "/usr/bin/plutil";
      args = ["-convert", "json", "-o", "-", "-"];
      input = argument;
      break;
    case "mac-virtual":
      file = "/usr/sbin/sysctl";
      args = ["-n", "kern.hv_vmm_present"];
      break;
    case "who":
      file = "/usr/bin/who";
      args = [];
      break;
    case "linux-virtual":
      file = "/usr/bin/systemd-detect-virt";
      args = [];
      break;
    case "linux-sessions":
      file = "/usr/bin/loginctl";
      args = ["list-sessions", "--json=short", "--no-pager"];
      break;
    case "linux-session":
      if (!argument || !/^[a-zA-Z0-9_-]{1,128}$/.test(argument))
        throw new Error("invalid_session_id");
      file = "/usr/bin/loginctl";
      args = [
        "show-session",
        argument,
        "--no-pager",
        "--property=Id,User,Name,Class,Type,Remote,State,LockedHint,IdleHint",
      ];
      break;
    case "windows-sessions":
      file = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./host-windows.ps1", import.meta.url)),
      ];
      break;
  }
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        shell: false,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      },
      (error, stdout) => {
        // detect-virt's documented exit=1 with "none" is its successful bare-metal result.
        if (
          command === "linux-virtual" &&
          error &&
          "code" in error &&
          error.code === 1 &&
          stdout.trim() === "none"
        )
          resolve("none");
        else if (error) reject(new Error("host_command_failed"));
        else resolve(stdout);
      },
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    } else child.stdin?.end();
  });
};

type Session = HostSnapshot["sessions"][number];
type SessionEvidence = {
  sessions: Session[];
  complete: boolean;
  errors: string[];
  activeInteraction: boolean | "unknown";
};
const ref = (value: string) => createHash("sha256").update(value).digest("hex");
const unknown = (code: string): SessionEvidence => ({
  sessions: [],
  complete: false,
  errors: [code],
  activeInteraction: "unknown",
});
const macEntry = z
  .object({
    kCGSSessionIDKey: z.number().int().nonnegative(),
    kCGSSessionUserIDKey: z.number().int().nonnegative(),
    kCGSessionLoginDoneKey: z.boolean(),
    kCGSSessionOnConsoleKey: z.boolean(),
    CGSSessionScreenIsLocked: z.boolean().optional(),
  })
  .passthrough();
/** ioreg is positive console evidence only; it cannot prove full SSH / fast-switch enumeration. */
export function parseMacConsole(value: unknown): SessionEvidence {
  const roots = z
    .array(z.object({ IOConsoleUsers: z.array(z.unknown()) }).passthrough())
    .min(1)
    .safeParse(value);
  if (!roots.success) return unknown("mac_console_shape_unknown");
  const sessions: Session[] = [];
  const errors = ["mac_remote_enumeration_unproven"];
  for (const root of roots.data)
    for (const raw of root.IOConsoleUsers) {
      const parsed = macEntry.safeParse(raw);
      if (!parsed.success) {
        errors.push("mac_console_entry_incomplete");
        continue;
      }
      const s = parsed.data;
      if (!s.kCGSessionLoginDoneKey) continue;
      sessions.push({
        sessionId: ref(`console:${s.kCGSSessionIDKey}`),
        principalRef: ref(`uid:${s.kCGSSessionUserIDKey}`),
        type: "console",
        connection: s.kCGSSessionOnConsoleKey ? "connected" : "disconnected",
        locked: s.CGSSessionScreenIsLocked ?? "unknown",
      });
      if (s.CGSSessionScreenIsLocked === undefined)
        errors.push("mac_lock_state_unknown");
    }
  return {
    sessions,
    complete: false,
    errors: [...new Set(errors)],
    activeInteraction: "unknown",
  };
}
/** who may add positive evidence; an empty file/output never upgrades completeness. */
export function parseWho(text: string): Session[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parts = line.trim().split(/\s+/);
      const name = parts[0],
        tty = parts[1];
      if (!name || !tty) return [];
      return [
        {
          sessionId: ref(`who:${tty}:${name}`),
          principalRef: ref(name),
          type: tty.startsWith("console")
            ? ("console" as const)
            : ("ssh" as const),
          connection: "unknown" as const,
          locked: "unknown" as const,
        },
      ];
    });
}
export function parseLinuxSession(text: string): SessionEvidence {
  const data: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) data[line.slice(0, index)] = line.slice(index + 1);
  }
  if (
    !data.Id ||
    !data.User ||
    !/^\d+$/.test(data.User) ||
    !data.Class ||
    !data.Type ||
    !data.State
  )
    return unknown("linux_session_incomplete");
  if (
    ["manager", "manager-early", "background", "background-light"].includes(
      data.Class,
    )
  )
    return {
      sessions: [],
      complete: true,
      errors: [],
      activeInteraction: false,
    };
  if (!["user", "user-early", "user-light"].includes(data.Class))
    return unknown("linux_session_class_unknown");
  // Unknown session classes/types are not discarded as non-interactive evidence.
  const recognized = ["tty", "x11", "wayland", "unspecified"].includes(
    data.Type,
  );
  const locked =
    data.LockedHint === "yes"
      ? true
      : data.LockedHint === "no"
        ? false
        : "unknown";
  const stateKnown = ["active", "online", "closing"].includes(data.State);
  return {
    sessions: [
      {
        sessionId: ref(data.Id),
        principalRef: ref(`uid:${data.User}`),
        type:
          data.Remote === "yes"
            ? "ssh"
            : data.Type === "tty"
              ? "console"
              : "other_interactive",
        connection:
          data.State === "active"
            ? "connected"
            : data.State === "online"
              ? "disconnected"
              : "unknown",
        locked,
      },
    ],
    complete:
      recognized &&
      stateKnown &&
      locked !== "unknown" &&
      ["yes", "no"].includes(data.IdleHint ?? ""),
    errors:
      recognized && stateKnown && locked !== "unknown"
        ? []
        : ["linux_session_state_unknown"],
    activeInteraction:
      data.IdleHint === "yes"
        ? false
        : data.IdleHint === "no"
          ? true
          : "unknown",
  };
}
const windowsOutput = z
  .object({
    physical: z.boolean(),
    complete: z.boolean(),
    sessions: z.array(
      z.object({
        id: z.number().int().nonnegative(),
        user: z.string().min(1),
        domain: z.string(),
        state: z.number().int().nonnegative(),
        protocol: z.number().int().nonnegative(),
      }),
    ),
  })
  .strict();
export function parseWindowsSessions(
  value: unknown,
): SessionEvidence & { physical: boolean } {
  const parsed = windowsOutput.safeParse(value);
  if (!parsed.success)
    return { ...unknown("windows_wts_shape_unknown"), physical: false };
  const d = parsed.data;
  return {
    physical: d.physical,
    sessions: d.sessions.map((s) => ({
      sessionId: ref(`wts:${s.id}`),
      principalRef: ref(`${s.domain}\\${s.user}`),
      type:
        s.protocol === 0
          ? "console"
          : s.protocol === 2
            ? "rdp"
            : "other_interactive",
      connection:
        s.state === 0
          ? "connected"
          : s.state === 4
            ? "disconnected"
            : "unknown",
      locked: "unknown",
    })),
    complete: d.complete && d.sessions.length === 0,
    activeInteraction:
      d.sessions.length === 0 && d.complete ? false : "unknown",
    errors:
      d.complete && d.sessions.length === 0
        ? []
        : ["windows_lock_state_unknown"],
  };
}

/** physicalContext must be established by a native probe, never by a caller's role string alone. */
export async function collectHostEvidence(
  platform: NodeJS.Platform,
  run: CommandRunner = runHostCommand,
  sample: () => Promise<
    NonNullable<HostSnapshot["resources"]>
  > = sampleResources,
): Promise<
  Pick<
    HostSnapshot,
    | "sessions"
    | "sessionsComplete"
    | "activeInteraction"
    | "resources"
    | "unmanagedActivityHold"
    | "probeStatus"
    | "errorCodes"
  >
> {
  let evidence = unknown("unsupported_host_os"),
    physical = false;
  try {
    if (platform === "darwin") {
      try {
        physical = (await run("mac-virtual")).trim() === "0";
      } catch {
        /* unknown virtual boundary */
      }
      try {
        evidence = parseMacConsole(
          JSON.parse(await run("mac-json", await run("mac-console"))),
        );
      } catch {
        evidence = unknown("mac_console_probe_failed");
      }
      try {
        evidence.sessions.push(...parseWho(await run("who")));
      } catch {
        evidence.complete = false;
        evidence.errors.push("mac_remote_probe_failed");
      }
    } else if (platform === "linux") {
      physical =
        !/microsoft|wsl/i.test(release()) &&
        (await run("linux-virtual")).trim() === "none";
      const list = z
        .array(
          z
            .object({ session: z.union([z.string(), z.number().int()]) })
            .passthrough(),
        )
        .parse(JSON.parse(await run("linux-sessions")));
      evidence = {
        sessions: [],
        complete: true,
        errors: [],
        activeInteraction: false,
      };
      for (const item of list) {
        const entry = parseLinuxSession(
          await run("linux-session", String(item.session)),
        );
        evidence.sessions.push(...entry.sessions);
        evidence.complete &&= entry.complete;
        evidence.errors.push(...entry.errors);
        if (entry.activeInteraction === true) evidence.activeInteraction = true;
        else if (
          entry.activeInteraction === "unknown" &&
          evidence.activeInteraction !== true
        )
          evidence.activeInteraction = "unknown";
      }
    } else if (platform === "win32") {
      const parsed = parseWindowsSessions(
        JSON.parse(await run("windows-sessions")),
      );
      physical = parsed.physical;
      evidence = parsed;
    }
  } catch {
    evidence.complete = false;
    evidence.errors.push("host_session_probe_failed");
  }
  if (!physical) {
    // Guest observations cannot represent the enclosing physical Machine, even as positive evidence.
    return {
      sessions: [],
      sessionsComplete: false,
      activeInteraction: "unknown",
      resources: null,
      unmanagedActivityHold: null,
      probeStatus: "failed",
      errorCodes: ["physical_host_context_unproven"],
    };
  }
  let resources: HostSnapshot["resources"] = null;
  try {
    resources = await sample();
  } catch {
    evidence.errors.push("host_resources_probe_failed");
  }
  // D20 does not claim comprehensive classification of unmanaged native workloads.
  evidence.errors.push("unmanaged_activity_unproven");
  return {
    sessions: evidence.sessions,
    sessionsComplete: evidence.complete,
    activeInteraction: evidence.activeInteraction,
    resources,
    unmanagedActivityHold: null,
    probeStatus: "partial",
    errorCodes: [...new Set(evidence.errors)],
  };
}
async function sampleResources(): Promise<
  NonNullable<HostSnapshot["resources"]>
> {
  const before = cpus();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = cpus();
  if (!before.length || before.length !== after.length)
    throw new Error("cpu_sample_unavailable");
  let idle = 0,
    total = 0;
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!,
      b = after[i]!;
    idle += b.times.idle - a.times.idle;
    for (const key of ["user", "nice", "sys", "idle", "irq"] as const) {
      const delta = b.times[key] - a.times[key];
      if (delta < 0) throw new Error("cpu_counter_reset");
      total += delta;
    }
  }
  const memoryTotalBytes = totalmem(),
    memoryUsedBytes = memoryTotalBytes - freemem();
  if (total <= 0) throw new Error("cpu_sample_unavailable");
  return hostSnapshotSchema.shape.resources.unwrap().parse({
    cpuPercent: 100 * (1 - idle / total),
    memoryUsedBytes,
    memoryTotalBytes,
  });
}
