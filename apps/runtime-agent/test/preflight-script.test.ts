import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

// Executes the actual read-only shell helper with a fake Docker executable.
// No Engine, context, firewall, or network is accessed.
it.each(["iptables", "nftables", "wrong-owner"])(
  "filtered preflight reads Docker 29 Driver and retains relevant rejection (%s)",
  async (scenario) => {
    const dir = await mkdtemp(join(tmpdir(), "hitchlet-preflight-"));
    try {
      await writeFile(
        join(dir, "docker"),
        `#!/bin/sh
case "$*" in
  *'{{.ID}}'*) printf '%s\\n' engine ;;
  *'{{.FirewallBackend.Driver}}'*) printf '%s\\n' "$FAKE_BACKEND" ;;
  *'network inspect'*) printf '%s\\n' "network|name|bridge|false|installation|runtime|$FAKE_OWNER" ;;
  *) exit 90 ;;
esac
`,
        { mode: 0o700 },
      );
      const result = promisify(execFile)(
        "sh",
        [resolve("scripts/preflight-context.sh")],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            HITCHLET_DOCKER_CONTEXT: "synthetic-isolated-context",
            HITCHLET_EXPECTED_ENGINE_ID: "engine",
            HITCHLET_NETWORK_ID: "network",
            HITCHLET_INSTALLATION_ID: "installation",
            HITCHLET_RUNTIME_ID: "runtime",
            HITCHLET_ALLOCATION_ID: "allocation",
            FAKE_BACKEND: scenario === "nftables" ? "nftables" : "iptables",
            FAKE_OWNER: scenario === "wrong-owner" ? "other" : "allocation",
          },
        },
      );
      if (scenario === "iptables")
        expect((await result).stdout).toContain(
          "Firewall backend verified: iptables",
        );
      else
        await expect(result).rejects.toMatchObject({
          code: scenario === "nftables" ? 4 : 6,
        });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
