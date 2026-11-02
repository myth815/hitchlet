import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalEngine,
  disableAndVerifyBridgeIPv6,
  enableAndVerifyBridgeNetfilter,
  parseBridgeNetfilter,
  parseFirewallBackend,
  parseDockerSecurityOptions,
  requireBridgeNetfilterModule,
  verifyBridgeNetfilter,
  verifyBridgeNetfilterSysfs,
  verifyBridgeIPv6Disabled,
} from "../src/engine.js";

const dockerExec = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: dockerExec.execFile }));
vi.mock("node:util", () => ({
  promisify:
    (fn: (...args: any[]) => void) =>
    (...args: any[]) =>
      new Promise((resolve, reject) =>
        fn(...args, (error: Error | null, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }),
        ),
      ),
}));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Docker 29 firewall info", () => {
  it("parses the real Driver and Info key/value array shape", () => {
    const fixture = JSON.stringify({
      Driver: "iptables",
      Info: [
        ["EnableUserlandProxy", "true"],
        ["UserlandProxyPath", "/usr/bin/docker-proxy"],
      ],
    });
    expect(parseFirewallBackend(fixture)).toEqual({
      driver: "iptables",
      userlandProxy: true,
    });
  });

  it("accepts an explicit false value and rejects missing or non-string values", () => {
    expect(
      parseFirewallBackend(
        JSON.stringify({
          Driver: "iptables",
          Info: [["EnableUserlandProxy", "false"]],
        }),
      ),
    ).toEqual({ driver: "iptables", userlandProxy: false });
    for (const info of [
      [["UserlandProxyPath", "/usr/bin/docker-proxy"]],
      [["EnableUserlandProxy", true]],
      [["EnableUserlandProxy", "maybe"]],
    ]) {
      expect(() =>
        parseFirewallBackend(
          JSON.stringify({ Driver: "iptables", Info: info }),
        ),
      ).toThrow(/Cannot verify Docker/);
    }
  });
});

describe("local Engine startup preflight", () => {
  const config = {
    dockerHost: "unix:///run/docker.sock",
    nativeEngineId: "engine-expected",
    ipv6SysctlRoot: "/run/hitchlet-ipv6",
  };
  const response = (overrides: Record<string, unknown> = {}) => ({
    ID: "engine-expected",
    SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
    FirewallBackend: {
      Driver: "iptables",
      Info: [["EnableUserlandProxy", "true"]],
    },
    ...overrides,
  });
  const mockInfo = (value: unknown) => {
    dockerExec.execFile.mockImplementation((...args: any[]) => {
      const callback = args.at(-1);
      callback?.(null, JSON.stringify(value), "");
    });
  };

  it("reports rootless mode without bypassing required firewall checks using one info call", async () => {
    mockInfo(
      response({
        SecurityOptions: [
          "name=seccomp,profile=builtin",
          "name=rootless",
          "name=cgroupns",
        ],
      }),
    );
    const engine = new LocalEngine(config);

    await expect(engine.assertEngine()).resolves.toBe(config.nativeEngineId);
    expect(engine.mode).toBe("rootless");
    expect(dockerExec.execFile).toHaveBeenCalledTimes(1);
    expect(dockerExec.execFile.mock.calls[0]?.[1]).toEqual([
      "--host",
      config.dockerHost,
      "info",
      "--format",
      "{{json .}}",
    ]);
  });

  it("still rejects a rootless Engine when a required backend check fails", async () => {
    mockInfo(
      response({
        SecurityOptions: ["name=rootless"],
        FirewallBackend: {
          Driver: "unsupported",
          Info: [["EnableUserlandProxy", "true"]],
        },
      }),
    );
    const engine = new LocalEngine(config);

    await expect(engine.assertEngine()).rejects.toThrow(
      "Docker iptables firewall backend is required",
    );
    expect(engine.mode).toBe("rootless");
  });

  it("keeps Engine identity mismatch ahead of SecurityOptions parsing", async () => {
    mockInfo(
      response({
        ID: "different-engine",
        SecurityOptions: undefined,
      }),
    );
    await expect(new LocalEngine(config).assertEngine()).rejects.toThrow(
      "Native Engine identity mismatch",
    );
  });

  it("treats missing or malformed SecurityOptions as unknown diagnostics only", async () => {
    expect(parseDockerSecurityOptions(undefined)).toBe("unknown");
    expect(parseDockerSecurityOptions([])).toBe("unknown");
    expect(parseDockerSecurityOptions(["name=seccomp", 7])).toBe("unknown");
    expect(
      parseDockerSecurityOptions([
        "name=seccomp,profile=builtin",
        "name=cgroupns",
        "name=future-engine-feature",
      ]),
    ).toBe("rootful");

    mockInfo(response({ SecurityOptions: undefined }));
    const engine = new LocalEngine(config);
    await expect(engine.assertEngine()).resolves.toBe(config.nativeEngineId);
    expect(engine.mode).toBe("unknown");

    mockInfo(
      response({
        SecurityOptions: ["name=rootless", 7],
        FirewallBackend: {
          Driver: "unsupported",
          Info: [["EnableUserlandProxy", "true"]],
        },
      }),
    );
    await expect(new LocalEngine(config).assertEngine()).rejects.toThrow(
      "Docker iptables firewall backend is required",
    );
  });
});

describe("per-bridge IPv6 sysctl", () => {
  it("disables only the selected bridge and verifies the value by reading it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "hitchlet-ipv6-sysctl-"));
    tempDirs.push(root);
    await mkdir(join(root, "br-hitchlet"));
    await mkdir(join(root, "br-other"));
    await writeFile(join(root, "br-hitchlet", "disable_ipv6"), "0\n");
    await writeFile(join(root, "br-other", "disable_ipv6"), "0\n");

    await disableAndVerifyBridgeIPv6(root, "br-hitchlet");

    expect(
      await readFile(join(root, "br-hitchlet", "disable_ipv6"), "utf8"),
    ).toBe("1\n");
    expect(await readFile(join(root, "br-other", "disable_ipv6"), "utf8")).toBe(
      "0\n",
    );
    await expect(verifyBridgeIPv6Disabled(root, "br-other")).rejects.toThrow(
      "IPv6 remains enabled on the allocation bridge",
    );
  });

  it("rejects invalid interface names before resolving a sysctl path", async () => {
    await expect(disableAndVerifyBridgeIPv6("/tmp", "../all")).rejects.toThrow(
      "Invalid Docker bridge interface name",
    );
  });
});

describe("per-bridge iptables hooks", () => {
  const link = (bridge: string, enabled: number) =>
    JSON.stringify([
      {
        ifname: bridge,
        linkinfo: {
          info_kind: "bridge",
          info_data: { nf_call_iptables: enabled },
        },
      },
    ]);

  it("parses and requires the exact bridge's kernel nf_call_iptables value", () => {
    expect(parseBridgeNetfilter(link("br-hitchlet", 1), "br-hitchlet")).toBe(
      true,
    );
    expect(parseBridgeNetfilter(link("br-hitchlet", 0), "br-hitchlet")).toBe(
      false,
    );
    for (const raw of [
      link("br-other", 1),
      JSON.stringify([
        { ifname: "br-hitchlet", linkinfo: { info_kind: "dummy" } },
      ]),
      JSON.stringify([
        {
          ifname: "br-hitchlet",
          linkinfo: {
            info_kind: "bridge",
            info_data: { nf_call_iptables: true },
          },
        },
      ]),
    ])
      expect(() => parseBridgeNetfilter(raw, "br-hitchlet")).toThrow(
        "Cannot verify allocation bridge iptables hooks",
      );
  });

  it("sets only the verified bridge's hook and reads back the enabled state", async () => {
    const commands: string[][] = [];
    let enabled = 0;
    const runIp = async (args: readonly string[]) => {
      commands.push([...args]);
      if (args[0] === "-j") return link("br-hitchlet", enabled);
      if (
        args.join(" ") ===
        "link set dev br-hitchlet type bridge nf_call_iptables 1"
      ) {
        enabled = 1;
        return "";
      }
      throw new Error("unexpected ip command");
    };

    await enableAndVerifyBridgeNetfilter("br-hitchlet", runIp);

    expect(commands).toEqual([
      ["-j", "-d", "link", "show", "dev", "br-hitchlet"],
      [
        "link",
        "set",
        "dev",
        "br-hitchlet",
        "type",
        "bridge",
        "nf_call_iptables",
        "1",
      ],
      ["-j", "-d", "link", "show", "dev", "br-hitchlet"],
    ]);
    await expect(
      verifyBridgeNetfilter("br-hitchlet", async () => link("br-hitchlet", 0)),
    ).rejects.toThrow("Allocation bridge iptables hooks are not enabled");
  });

  it("requires the host module and the bridge's kernel sysfs capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "hitchlet-bridge-netfilter-"));
    tempDirs.push(root);
    const moduleRoot = join(root, "module");
    await mkdir(join(moduleRoot, "br_netfilter"), { recursive: true });
    await requireBridgeNetfilterModule(moduleRoot);
    await expect(
      requireBridgeNetfilterModule(join(root, "missing-module")),
    ).rejects.toThrow("Linux br_netfilter module is not loaded");

    const sysfsRoot = join(root, "sys", "class", "net");
    const bridgeRoot = join(sysfsRoot, "br-hitchlet", "bridge");
    await mkdir(bridgeRoot, { recursive: true });
    await writeFile(join(bridgeRoot, "nf_call_iptables"), "1\n");
    await verifyBridgeNetfilterSysfs("br-hitchlet", sysfsRoot);
    await writeFile(join(bridgeRoot, "nf_call_iptables"), "0\n");
    await expect(
      verifyBridgeNetfilterSysfs("br-hitchlet", sysfsRoot),
    ).rejects.toThrow("Allocation bridge iptables hooks are not enabled");
  });
});
