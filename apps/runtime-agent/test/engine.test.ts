import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  disableAndVerifyBridgeIPv6,
  enableAndVerifyBridgeNetfilter,
  parseBridgeNetfilter,
  parseFirewallBackend,
  requireBridgeNetfilterModule,
  verifyBridgeNetfilter,
  verifyBridgeNetfilterSysfs,
  verifyBridgeIPv6Disabled,
} from "../src/engine.js";

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
