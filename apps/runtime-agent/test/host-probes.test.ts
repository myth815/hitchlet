import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  parseMacConsole,
  parseWho,
  parseLinuxSession,
  parseLinuxMemoryInfo,
  parseMacMemoryPressure,
  parseWindowsSessions,
  collectHostEvidence,
  type CommandRunner,
} from "../src/host-probes.js";
import {
  classifyHumanPresence,
  hostSnapshotSchema,
} from "@hitchlet/contracts/internal";
const ids = {
  machineId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  bootId: "00000000-0000-4000-8000-000000000003",
  sequence: 0,
  observedAt: "2026-10-20T00:00:00Z",
};
const sample = async () => ({
  cpuPercent: 2,
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  memoryAvailableBytes: 1,
  memoryAvailableTotalBytes: 2,
  memoryAvailablePercent: 50,
  memoryPressurePercent: 50,
  memoryPressureSource: "linux_memavailable" as const,
});
const present = (sessions: ReturnType<typeof parseMacConsole>) =>
  classifyHumanPresence(
    hostSnapshotSchema.parse({
      ...ids,
      probeStatus: "partial",
      sessions: sessions.sessions,
      sessionsComplete: sessions.complete,
      activeInteraction: sessions.activeInteraction,
      resources: null,
      unmanagedActivityHold: null,
      errorCodes: sessions.errors,
    }),
  );
describe("fixed native Host probes", () => {
  it("parses independently sampled Mac console shape with missing lock as unknown and protects the login", async () => {
    const data: unknown = JSON.parse(
      await readFile(
        new URL("./fixtures/mac-console.json", import.meta.url),
        "utf8",
      ),
    );
    const evidence = parseMacConsole(data);
    expect(evidence.sessions).toHaveLength(1);
    expect(evidence.sessions[0]).toMatchObject({
      type: "console",
      connection: "connected",
      locked: "unknown",
    });
    expect(present(evidence)).toBe("present");
    expect(evidence.complete).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain("fixture-user");
    expect(present(parseMacConsole([{ IOConsoleUsers: [] }]))).toBe("unknown");
    expect(present(parseMacConsole({}))).toBe("unknown");
  });
  it("keeps fast switched, locked and remote service account logins protected without account filters", () => {
    const e = parseMacConsole([
      {
        IOConsoleUsers: [
          {
            kCGSSessionIDKey: 1,
            kCGSSessionUserIDKey: 500,
            kCGSessionLoginDoneKey: true,
            kCGSSessionOnConsoleKey: false,
            CGSSessionScreenIsLocked: true,
          },
        ],
      },
    ]);
    expect(e.sessions[0]).toMatchObject({
      connection: "disconnected",
      locked: true,
    });
    expect(present(e)).toBe("present");
    const remote = parseWindowsSessions({
      physical: true,
      complete: true,
      sessions: [
        { id: 5, user: "service-user", domain: "HOST", state: 4, protocol: 2 },
      ],
    });
    expect(remote.sessions[0]).toMatchObject({
      connection: "disconnected",
      locked: "unknown",
    });
    expect(present(remote)).toBe("present");
    expect(
      parseWho("service-user pts/1 2026-10-20 10:00 (remote)\n"),
    ).toHaveLength(1);
    expect(parseWho("")).toEqual([]);
  });
  it("requires complete loginctl class/state/lock evidence and never excludes new unknown classes", () => {
    const entry =
      "Id=42\nUser=1000\nName=service-account\nClass=user\nType=tty\nRemote=yes\nState=online\nLockedHint=yes\nIdleHint=yes\n";
    expect(parseLinuxSession(entry)).toMatchObject({
      complete: true,
      sessions: [{ type: "ssh", connection: "disconnected", locked: true }],
    });
    expect(present(parseLinuxSession(entry))).toBe("present");
    expect(
      parseLinuxSession(entry.replace("Class=user", "Class=new-class")),
    ).toMatchObject({ complete: false });
    expect(
      parseLinuxSession(entry.replace("LockedHint=yes\n", "")),
    ).toMatchObject({ complete: false, sessions: [{ locked: "unknown" }] });
    expect(
      parseLinuxSession(entry.replace("Class=user", "Class=manager")),
    ).toMatchObject({ complete: true, sessions: [] });
  });
  it("derives Linux pressure from MemAvailable and parses macOS native free percentage", () => {
    const linux = parseLinuxMemoryInfo(
      "MemTotal: 1000 kB\nMemFree: 20 kB\nMemAvailable: 250 kB\n",
    );
    expect(linux).toEqual({
      memoryAvailableBytes: 256_000,
      memoryAvailableTotalBytes: 1_024_000,
      memoryAvailablePercent: 25,
      memoryPressurePercent: 75,
      memoryPressureSource: "linux_memavailable",
    });
    expect(
      parseMacMemoryPressure("System-wide memory free percentage: 78%\n"),
    ).toEqual({
      memoryAvailablePercent: 78,
      memoryPressurePercent: 22,
      memoryPressureSource: "macos_memory_pressure_free",
    });
    expect(() =>
      parseLinuxMemoryInfo("MemTotal: 1 kB\nMemFree: 1 kB\n"),
    ).toThrow();
    expect(() =>
      parseLinuxMemoryInfo("MemTotal: 1 kB\nMemAvailable: 2 kB\n"),
    ).toThrow();
    expect(() => parseMacMemoryPressure("unrecognized output")).toThrow();
  });
  it("uses Windows GlobalMemoryStatusEx only when its returned bounds are valid", () => {
    expect(
      parseWindowsSessions({
        physical: true,
        complete: true,
        sessions: [],
        memoryAvailableTotalBytes: 1000,
        memoryAvailableBytes: 250,
      }),
    ).toMatchObject({
      memory: {
        memoryAvailableBytes: 250,
        memoryAvailableTotalBytes: 1000,
        memoryAvailablePercent: 25,
        memoryPressurePercent: 75,
        memoryPressureSource: "windows_global_memory_status_ex",
      },
    });
    expect(
      parseWindowsSessions({
        physical: true,
        complete: true,
        sessions: [],
        memoryAvailableTotalBytes: 1000,
        memoryAvailableBytes: 1001,
      }),
    ).not.toHaveProperty("memory");
    expect(
      parseWindowsSessions({ physical: true, complete: true, sessions: [] }),
    ).toMatchObject({ errors: ["windows_memory_availability_unknown"] });
  });
  it("keeps old Host memory payloads parseable without inventing a pressure value", () => {
    const legacy = hostSnapshotSchema.parse({
      ...ids,
      probeStatus: "partial",
      sessionsComplete: false,
      sessions: [],
      activeInteraction: "unknown",
      resources: {
        cpuPercent: 1,
        memoryUsedBytes: 990,
        memoryTotalBytes: 1000,
      },
      unmanagedActivityHold: null,
      errorCodes: ["fixture"],
    });
    expect(legacy.resources?.memoryPressurePercent).toBeUndefined();
  });
  it("treats native complete empty Linux/WTS session enumeration separately from unknown unmanaged workloads", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const run: CommandRunner = async (command) => {
        if (command === "linux-virtual") return "none\n";
        if (command === "linux-sessions") return "[]";
        if (command === "windows-sessions")
          return JSON.stringify({
            physical: true,
            complete: true,
            sessions: [],
          });
        throw new Error("unexpected");
      };
      const evidence = await collectHostEvidence(platform, run, sample);
      expect(evidence).toMatchObject({
        sessionsComplete: true,
        unmanagedActivityHold: null,
        probeStatus: "partial",
      });
      expect(
        classifyHumanPresence(
          hostSnapshotSchema.parse({ ...ids, ...evidence }),
        ),
      ).toBe("absent");
    }
  });
  it("fails closed on permission/command failures, malformed WTS output and guest namespaces", async () => {
    const fail: CommandRunner = async () => {
      throw new Error("permission_denied");
    };
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const evidence = await collectHostEvidence(platform, fail, sample);
      expect(evidence).toMatchObject({
        sessionsComplete: false,
        resources: null,
        probeStatus: "failed",
      });
      expect(
        classifyHumanPresence(
          hostSnapshotSchema.parse({ ...ids, ...evidence }),
        ),
      ).toBe("unknown");
    }
    for (const marker of ["docker", "wsl", "kvm"]) {
      const guest: CommandRunner = async (command) =>
        command === "linux-virtual"
          ? marker
          : command === "linux-sessions"
            ? "[]"
            : "";
      expect(await collectHostEvidence("linux", guest, sample)).toMatchObject({
        sessionsComplete: false,
        resources: null,
        errorCodes: ["physical_host_context_unproven"],
      });
    }
    expect(parseWindowsSessions({ sessions: [] })).toMatchObject({
      physical: false,
      complete: false,
    });
  });
  it("preserves resource failures as null and empty who never creates complete absence on Mac", async () => {
    const run: CommandRunner = async (command) => {
      if (command === "mac-virtual") return "0";
      if (command === "mac-console") return "plist-fixture";
      if (command === "mac-json")
        return JSON.stringify([{ IOConsoleUsers: [] }]);
      if (command === "who") return "";
      throw new Error("unexpected");
    };
    const evidence = await collectHostEvidence("darwin", run, async () => {
      throw new Error("not available");
    });
    expect(evidence).toMatchObject({
      resources: null,
      sessionsComplete: false,
    });
    expect(evidence.errorCodes).toContain("host_resources_probe_failed");
    expect(
      classifyHumanPresence(hostSnapshotSchema.parse({ ...ids, ...evidence })),
    ).toBe("unknown");
  });
  it("does not fall back to raw used ratio when native Linux availability is missing", async () => {
    const run: CommandRunner = async (command) => {
      if (command === "linux-virtual") return "none";
      if (command === "linux-sessions") return "[]";
      throw new Error("native memory source unavailable");
    };
    const evidence = await collectHostEvidence("linux", run, async () => ({
      cpuPercent: 1,
      memoryUsedBytes: 990,
      memoryTotalBytes: 1000,
    }));
    expect(evidence.resources).toMatchObject({
      memoryUsedBytes: 990,
      memoryTotalBytes: 1000,
    });
    expect(evidence.resources).not.toHaveProperty("memoryPressurePercent");
    expect(evidence.errorCodes).toContain("linux_memory_availability_unknown");
  });
});
