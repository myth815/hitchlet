import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  parseMacConsole,
  parseWho,
  parseLinuxSession,
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
});
