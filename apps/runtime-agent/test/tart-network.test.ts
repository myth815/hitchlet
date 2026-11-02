import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { Duplex } from "node:stream";
import { expect, it } from "vitest";
import {
  canonicalTartNetworkPlan,
  type TartNetworkPlan,
} from "@hitchlet/contracts/internal";
import {
  compileTartNetworkPolicy,
  SoftnetControlChannel,
  type CompiledTartNetworkPolicy,
} from "../src/drivers/tart-network.js";

it("compiles direct ingress/egress CIDRs and subtracts management denies", () => {
  const plan = makePlan({
    allowedIngressSourceCidrs: ["192.0.2.0/24", "198.51.100.0/24"],
    accessSourceCidrs: ["192.0.2.128/25", "203.0.113.0/24"],
    allowedEgress: [
      { cidr: "10.0.0.0/8", protocol: "tcp", ports: [443] },
      { cidr: "198.51.100.0/24", protocol: "udp", ports: [53] },
    ],
    managementDenyRules: [
      { cidr: "10.1.0.0/16", protocol: "tcp", ports: [443] },
    ],
  });
  const policy = compileTartNetworkPolicy(plan);
  expect(policy.allow).toContain("in proto tcp 192.0.2.128/25 port 22");
  expect(policy.allow).not.toContain("in proto tcp 198.51.100.0/24 port 22");
  expect(policy.allow).toContain("out proto udp 198.51.100.0/24 port 53");
  expect(policy.block).toContain("out proto tcp 0.0.0.0/0 port 443");

  expect(decide(policy, "out", "10.2.3.4", "tcp", 443)).toBe("allow");
  expect(decide(policy, "out", "10.1.3.4", "tcp", 443)).toBe("block");
  expect(decide(policy, "out", "198.51.100.12", "udp", 53)).toBe("allow");
  expect(decide(policy, "out", "198.51.100.12", "tcp", 53)).toBe("block");
  expect(decide(policy, "in", "192.0.2.200", "tcp", 22)).toBe("allow");
  expect(decide(policy, "in", "192.0.2.20", "tcp", 22)).toBe("block");
  expect(decide(policy, "in", "198.51.100.20", "tcp", 22)).toBe("block");
});

it("keeps an explicitly allowed IPv4 /0 service allowed under Softnet precedence", () => {
  const policy = compileTartNetworkPolicy(
    makePlan({
      allowedEgress: [{ cidr: "0.0.0.0/0", protocol: "tcp", ports: [443] }],
    }),
  );
  expect(decide(policy, "out", "203.0.113.80", "tcp", 443)).toBe("allow");
  expect(decide(policy, "out", "203.0.113.80", "tcp", 80)).toBe("block");
});

it("rejects IPv6 and a mismatched frozen plan hash", () => {
  expect(() =>
    compileTartNetworkPolicy(makePlan({ ipv6: "verified_equivalent" })),
  ).toThrow("tart_network_ipv6_unsupported");
  const plan = makePlan();
  expect(() =>
    compileTartNetworkPolicy({
      ...plan,
      contractHash: "sha256:" + "0".repeat(64),
    }),
  ).toThrow("tart_network_contract_hash_mismatch");
});

it("uses a connected inherited Unix stream for JSON-RPC and observes EOF", async () => {
  const python = spawnSync("which", ["python3"], {
    encoding: "utf8",
  }).stdout.trim();
  if (!python) throw new Error("python3_fixture_required");
  const childSource = [
    "import json,socket",
    "s=socket.socket(fileno=3)",
    "assert s.family == socket.AF_UNIX and s.type & 0xf == socket.SOCK_STREAM",
    "s.getpeername()",
    "policy={'allow':[],'block':[]}",
    "data=b''",
    "while True:",
    " chunk=s.recv(4096)",
    " if not chunk: break",
    " data+=chunk",
    " while b'\\n' in data:",
    "  line,data=data.split(b'\\n',1)",
    "  req=json.loads(line)",
    "  if req['method']=='softnet.policy.set': policy=req['params']",
    "  result={**policy,'ruleCount':len(policy['allow'])+len(policy['block'])}",
    "  s.sendall((json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result})+'\\n').encode())",
    "s.close()",
  ].join("\n");
  const child = spawn(python, ["-c", childSource], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  const stream = child.stdio[3] as Duplex;
  const control = new SoftnetControlChannel(stream);
  const expected: CompiledTartNetworkPolicy = {
    allow: ["out proto tcp 198.51.100.0/24 port 443"],
    block: ["in 0.0.0.0/0", "out 0.0.0.0/0"],
    policyHash: "sha256:" + "1".repeat(64),
  };
  expect(await control.setPolicy(expected.allow, expected.block)).toMatchObject(
    {
      allow: expected.allow,
      block: expected.block,
    },
  );
  expect(await control.getPolicy()).toMatchObject({
    allow: expected.allow,
    block: expected.block,
  });
  control.close();
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`fixture_exit_${code}`)),
    );
  });
});

function makePlan(
  overrides: Partial<Omit<TartNetworkPlan, "contractHash">> = {},
): TartNetworkPlan {
  const raw = {
    grantId: "grant-1",
    revisionId: "revision-1",
    frozenPlatformDenyRevisionId: "frozen-deny-1",
    platformDenyRevisionId: "effective-deny-1",
    mode: "isolated_vm" as const,
    enforcement: "tart_agent" as const,
    ipv6: "disabled" as const,
    allowedEgress: [],
    allowedIngressSourceCidrs: ["0.0.0.0/0"],
    accessSourceCidrs: ["0.0.0.0/0"],
    accessPorts: [22],
    managementDenyRules: [],
    ...overrides,
  };
  return {
    ...raw,
    contractHash:
      "sha256:" +
      createHash("sha256").update(canonicalTartNetworkPlan(raw)).digest("hex"),
  };
}

function decide(
  policy: CompiledTartNetworkPolicy,
  direction: "in" | "out",
  address: string,
  protocol: "tcp" | "udp",
  port: number,
): "allow" | "block" {
  const candidates = [...policy.allow, ...policy.block].flatMap((rule) => {
    const match =
      /^(in|out) (?:proto (tcp|udp) )?(\d+\.\d+\.\d+\.\d+\/\d+)(?: port (\d+))?$/.exec(
        rule,
      );
    if (!match || match[1] !== direction) return [];
    if (match[2] && match[2] !== protocol) return [];
    if (match[4] && Number(match[4]) !== port) return [];
    const [prefixAddress, prefixText] = match[3]!.split("/");
    const prefix = Number(prefixText);
    if (!contains(prefixAddress!, prefix, address)) return [];
    return [
      {
        action: policy.block.includes(rule)
          ? ("block" as const)
          : ("allow" as const),
        priority: [
          Boolean(match[4]),
          prefix,
          Boolean(match[2]),
          policy.block.includes(rule),
        ] as const,
      },
    ];
  });
  candidates.sort((left, right) => {
    for (let index = 0; index < left.priority.length; index++) {
      const a = Number(left.priority[index]);
      const b = Number(right.priority[index]);
      if (a !== b) return b - a;
    }
    return 0;
  });
  return candidates[0]?.action ?? "block";
}

function contains(
  cidrAddress: string,
  prefix: number,
  inputAddress: string,
): boolean {
  const toNumber = (value: string) =>
    value.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const size = 2 ** (32 - prefix);
  const base = Math.floor(toNumber(cidrAddress) / size) * size;
  return toNumber(inputAddress) >= base && toNumber(inputAddress) < base + size;
}
