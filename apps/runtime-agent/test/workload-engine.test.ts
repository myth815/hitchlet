import { expect, it, vi } from "vitest";
import { LocalEngine } from "../src/engine.js";
const state = vi.hoisted(() => ({
  changed: false,
  legacyBackend: false,
  lists: 0,
  calls: [] as string[][],
  background: false,
}));
vi.mock("../src/command-exec.js", () => ({
  isFixedCommandTimeout: () => false,
  runFixedCommand: vi.fn(async (_binary: string, argv: string[]) => {
    state.calls.push(argv);
    const args = argv.slice(2);
    let stdout = "";
    if (args[0] === "info")
      stdout = JSON.stringify({
        ID: "engine",
        SecurityOptions: ["name=rootless"],
        FirewallBackend: state.legacyBackend
          ? { Driver: "iptables" }
          : {
              Driver: "iptables",
              Info: [["EnableUserlandProxy", "false"]],
            },
      });
    else if (args[1] === "ls")
      stdout =
        "a".repeat(64) +
        (state.changed && ++state.lists > 1 ? " exited" : " running");
    else if (args[1] === "inspect")
      stdout = JSON.stringify(
        state.background
          ? { id: "a".repeat(64), imageId: "sha256:" + "b".repeat(64), pid: 42 }
          : {
              id: "a".repeat(64),
              running: true,
              paused: false,
              installationId: "",
              runtimeIdentityId: "",
              allocationId: "",
              generation: "",
            },
      );
    else throw Error("unexpected command");
    return { stdout, stderr: "" };
  }),
}));
const engine = () =>
  new LocalEngine({
    dockerHost: "unix:///run/user/1000/docker.sock",
    nativeEngineId: "engine",
    ipv6SysctlRoot: "/proc/sys/net/ipv6/conf",
  });
it("projects all container identities/states without container environment or command strings", async () => {
  state.changed = false;
  state.calls = [];
  state.lists = 0;
  const result = await engine().workloadInventory();
  expect(result.complete).toBe(true);
  expect(result.containers[0]!.installationId).toBeNull();
  const inspect = state.calls.find((args) => args.includes("inspect"))!;
  expect(inspect).toContain("--format");
  expect(inspect.join(" ")).not.toContain(".Config.Env");
  expect(inspect.join(" ")).not.toContain(".Args");
});
it("reads only fixed management image/init identity without environment or caller commands", async () => {
  state.background = true;
  state.calls = [];
  try {
    expect(await engine().backgroundContainerIdentity("a".repeat(64))).toEqual({
      id: "a".repeat(64),
      imageId: "sha256:" + "b".repeat(64),
      pid: 42,
    });
    expect(
      state.calls.find((args) => args.includes("inspect"))!.join(" "),
    ).not.toMatch(/\.Env|\.Cmd|\.Args/);
    await expect(
      engine().backgroundContainerIdentity("arbitrary"),
    ).rejects.toThrow("Invalid");
  } finally {
    state.background = false;
  }
});
it("does not call a changing container inventory complete", async () => {
  state.changed = true;
  state.calls = [];
  state.lists = 0;
  expect((await engine().workloadInventory()).complete).toBe(false);
});

it("reads a legacy Engine without using network mutation qualification as an observation gate", async () => {
  state.changed = false;
  state.legacyBackend = true;
  state.calls = [];
  state.lists = 0;
  expect((await engine().workloadInventory()).complete).toBe(true);
  await expect(engine().assertEngine()).rejects.toThrow(
    "Cannot verify Docker firewall capabilities",
  );
  state.legacyBackend = false;
});
