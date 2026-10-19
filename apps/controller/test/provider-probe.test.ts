import { afterEach, describe, expect, it, vi } from "vitest";
import { probePortainer } from "../src/providers/portainer-probe.js";

describe("Portainer read-only probe", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses the environment proxy, ServerVersion, and normalized Engine identity without retaining raw environment output", async () => {
    const urls: string[] = [];
    const payloads: Record<string, unknown> = {
      "docker/info": {
        ID: "engine-id",
        OSType: "linux",
        Architecture: "aarch64",
        NCPU: 2,
        MemTotal: 2_053_578_752,
      },
      "docker/version": {
        Version: "29.5.2",
        ApiVersion: "1.54",
        MinAPIVersion: "1.40",
        Arch: "arm64",
      },
      "/api/system/version": {
        ServerVersion: "2.45.2",
        ServerEdition: "CE",
        Runtime: { Env: ["SENTINEL_NEVER_STORE"] },
      },
      "docker/containers/json?all=true": [
        {
          Id: "external-container",
          Labels: { "io.hitchlet.lookalike": "true" },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        urls.push(url);
        const key = Object.keys(payloads).find((suffix) =>
          url.endsWith(suffix),
        );
        if (!key) throw new Error("Unexpected probe URL");
        return new Response(JSON.stringify(payloads[key]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const evidence = await probePortainer({
      endpointUrl: "https://portainer.example",
      environmentId: "1",
      apiKey: "api-secret",
    });
    expect(evidence).toMatchObject({
      engineId: "engine-id",
      dockerVersion: "29.5.2",
      apiVersion: "1.54",
      minimumApiVersion: "1.40",
      portainerVersion: "2.45.2",
      architecture: "arm64",
      cpuCount: 2,
      unmanagedContainerCount: 1,
    });
    expect(urls).toContain(
      "https://portainer.example/api/endpoints/1/docker/info",
    );
    expect(JSON.stringify(evidence)).not.toContain("SENTINEL");
    expect(JSON.stringify(evidence)).not.toContain("api-secret");
  });
  it("rejects mismatched architecture evidence", async () => {
    const payloads = [
      {
        ID: "engine",
        OSType: "linux",
        Architecture: "x86_64",
        NCPU: 2,
        MemTotal: 4096,
      },
      {
        Version: "29",
        ApiVersion: "1.54",
        MinAPIVersion: "1.40",
        Arch: "arm64",
      },
      { ServerVersion: "2.45.2" },
      [],
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(payloads.shift()), { status: 200 }),
      ),
    );
    await expect(
      probePortainer({
        endpointUrl: "https://portainer.example",
        environmentId: "1",
        apiKey: "x",
      }),
    ).rejects.toThrow(/incomplete/);
  });
});
