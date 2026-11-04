import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HyperVGuestBootstrapRequest } from "@hitchlet/contracts/internal";
import { createPowerShellDirectBootstrap } from "../src/drivers/hyperv-powershell-direct.js";
import { hyperVPublicKeyFingerprint } from "../src/drivers/hyperv-guest.js";
const id = "00000000-0000-4000-8000-000000000001";
function publicKey() {
  const k = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32);
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    k,
  ]);
  return "ssh-ed25519 " + blob.toString("base64");
}
function fixture() {
  const client = publicKey(),
    host = publicKey();
  const request: HyperVGuestBootstrapRequest = {
    identity: {
      installationId: id,
      runtimeIdentityId: id,
      connectionRevisionId: id,
      allocationId: id,
      generation: 1,
      operationId: id,
      controlVersion: 1,
      purpose: "tenant",
    },
    vmId: id,
    nonce: "fixed-bootstrap-nonce-123",
    account: "workspace",
    guestOs: "windows",
    architecture: "amd64",
    clientPublicKey: client,
    clientPublicKeyFingerprint: hyperVPublicKeyFingerprint(client),
  };
  const { clientPublicKey: _, ...rest } = request;
  return {
    request,
    receipt: {
      ...rest,
      status: "applied" as const,
      hostPublicKey: host,
      hostKeyFingerprint: hyperVPublicKeyFingerprint(host),
      observedAt: new Date(1000).toISOString(),
    },
  };
}
describe("fixed Windows PowerShell Direct channel (controlled runner, no Windows execution)", () => {
  it("reads before applying and sends only a protected credential reference plus public material", async () => {
    const { request } = fixture(),
      run = vi.fn(async () => ({ status: "not_applied" }));
    const channel = createPowerShellDirectBootstrap({
      credentialFile: "/private/guest.xml",
      run,
      now: () => 1000,
    });
    expect(await channel.inspect(request, 100000)).toEqual({
      status: "not_applied",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual({
      mode: "inspect",
      request,
      credentialFile: "/private/guest.xml",
      budgetMs: 30000,
    });
    expect(JSON.stringify(run.mock.calls)).not.toContain("privateKey");
  });
  it("accepts only an exact VM/owner/nonce/account/key receipt", async () => {
    const { request, receipt } = fixture();
    const run = vi.fn(async () => receipt);
    const channel = createPowerShellDirectBootstrap({
      credentialFile: "/guest.xml",
      run,
      now: () => 1000,
    });
    expect(await channel.apply(request, 5000)).toEqual(receipt);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      mode: "apply",
      budgetMs: 4000,
    });
    for (const changed of [
      { ...receipt, vmId: "00000000-0000-4000-8000-000000000002" },
      { ...receipt, nonce: "a-different-nonce-123" },
      { ...receipt, identity: { ...receipt.identity, generation: 2 } },
      { ...receipt, account: "admin" },
    ]) {
      await expect(
        createPowerShellDirectBootstrap({
          credentialFile: "/guest.xml",
          run: async () => changed,
          now: () => 1000,
        }).apply(request, 5000),
      ).rejects.toThrow("identity mismatch");
    }
  });
  it("keeps an unknown result unknown without retrying apply", async () => {
    const { request } = fixture(),
      run = vi.fn(async () => ({
        status: "unknown",
        reason: "guest_initialization_incomplete_or_changed",
      }));
    const channel = createPowerShellDirectBootstrap({
      credentialFile: "/guest.xml",
      run,
      now: () => 1000,
    });
    expect(await channel.inspect(request, 5000)).toMatchObject({
      status: "unknown",
    });
    expect(run).toHaveBeenCalledOnce();
  });
  it("rejects mismatched host key proof and late results", async () => {
    const { request, receipt } = fixture();
    await expect(
      createPowerShellDirectBootstrap({
        credentialFile: "/guest.xml",
        run: async () => ({ ...receipt, hostPublicKey: publicKey() }),
        now: () => 1000,
      }).apply(request, 5000),
    ).rejects.toThrow("host key mismatch");
    let now = 1000;
    await expect(
      createPowerShellDirectBootstrap({
        credentialFile: "/guest.xml",
        run: async () => {
          now = 5000;
          return receipt;
        },
        now: () => now,
      }).apply(request, 5000),
    ).rejects.toThrow("deadline expired");
  });
  it("does not spawn on expired budgets, wrong public key or unimplemented Linux channel", async () => {
    const { request } = fixture(),
      run = vi.fn(async () => ({ status: "not_applied" }));
    const channel = createPowerShellDirectBootstrap({
      credentialFile: "/guest.xml",
      run,
      now: () => 1000,
    });
    await expect(channel.apply(request, 999)).rejects.toThrow(
      "deadline expired",
    );
    await expect(
      channel.inspect({ ...request, guestOs: "linux" }, 5000),
    ).rejects.toThrow("Windows amd64 only");
    await expect(
      channel.apply({ ...request, clientPublicKey: publicKey() }, 5000),
    ).rejects.toThrow("client key mismatch");
    expect(run).not.toHaveBeenCalled();
    expect(() =>
      createPowerShellDirectBootstrap({ credentialFile: "relative" }),
    ).toThrow("Absolute");
  });
});
