import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { inspectRetainedStudio } from "./studio-acceptance-status.mjs";

function fixture(
  t,
  {
    profile = "Running",
    engine = "engine-a",
    identity = "installation-a",
    http = 200,
    https = 200,
    catalog = 200,
  } = {},
) {
  const root = mkdtempSync(resolve(tmpdir(), "hitchlet-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "secrets"));
  writeFileSync(
    resolve(root, "state.json"),
    JSON.stringify({
      installation: { installationId: "installation-a" },
      connection: { evidence: { engineId: "engine-a" } },
    }),
  );
  for (const [name, value] of [
    ["ca.crt", "fixture-public-ca"],
    ["admin-token", "fixture-admin-not-a-credential"],
    ["tenant-token", "fixture-tenant-not-a-credential"],
  ])
    writeFileSync(resolve(root, "secrets", name), value);
  const calls = [],
    requests = [];
  const run = (bin, args) => {
    calls.push([bin, args]);
    if (bin === "colima")
      return profile === null
        ? ""
        : JSON.stringify({
            name: "hitchlet-studio-acceptance",
            status: profile,
          });
    assert.equal(bin, "docker");
    return engine;
  };
  const request = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/healthz")) {
      const status = url.startsWith("http:") ? http : https;
      return status === null
        ? null
        : { status, body: { status: "ok", recoveryState: "ready" } };
    }
    if (url.endsWith("/installation"))
      return { status: 200, body: { installationId: identity } };
    if (url.endsWith("/catalog"))
      return { status: catalog, body: { versions: [{ id: "version-a" }] } };
    throw new Error("Unexpected request");
  };
  return { root, run, request, calls, requests };
}
test("reuses a matching online installation with read-only current consumer references and no credentials in output", async (t) => {
  const f = fixture(t),
    r = await inspectRetainedStudio(f);
  assert.equal(r.status, "running");
  assert.equal(r.ready, true);
  assert.equal(r.consumer.catalog.versions[0].id, "version-a");
  assert.deepEqual(
    f.calls.map(([bin, args]) => [bin, args.slice(0, 3)]),
    [
      ["colima", ["list", "--json"]],
      ["docker", ["--context", "colima-hitchlet-studio-acceptance", "info"]],
    ],
  );
  assert.ok(f.requests.find((x) => x.url.endsWith("/installation")).options.ca);
  assert.equal(
    f.requests.find((x) => x.url.endsWith("/catalog")).options.token,
    "fixture-tenant-not-a-credential",
  );
  assert.ok(!JSON.stringify(r).includes("fixture-admin-not-a-credential"));
  assert.ok(!JSON.stringify(r).includes("fixture-tenant-not-a-credential"));
});
test("a stopped retained profile and two refused listeners are reported without start commands or credential requests", async (t) => {
  const f = fixture(t, { profile: "Stopped", http: null, https: null }),
    r = await inspectRetainedStudio(f);
  assert.equal(r.status, "stopped");
  assert.equal(r.ready, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.requests.length, 2);
});
test("a missing retained profile never becomes a replacement VM", async (t) => {
  const f = fixture(t, { profile: null });
  await assert.rejects(inspectRetainedStudio(f), /profile is missing/);
  assert.equal(f.requests.length, 0);
});
test("a changed Engine is rejected before any credentials are sent", async (t) => {
  const f = fixture(t, { engine: "different-engine" });
  await assert.rejects(inspectRetainedStudio(f), /Engine identity changed/);
  assert.equal(f.requests.length, 0);
});
test("a different installation is left untouched", async (t) => {
  const f = fixture(t, { identity: "different-installation" });
  await assert.rejects(
    inspectRetainedStudio(f),
    /identity could not be confirmed/,
  );
  assert.equal(f.requests.length, 3);
});
test("one active listener cannot trigger a second supervisor", async (t) => {
  const f = fixture(t, { https: null });
  await assert.rejects(inspectRetainedStudio(f), /do not start a duplicate/);
  assert.equal(f.requests.length, 2);
});
test("an unhealthy listener is not interpreted as an absent service", async (t) => {
  const f = fixture(t, { http: 503 });
  await assert.rejects(inspectRetainedStudio(f), /unhealthy/);
  assert.equal(f.requests.length, 2);
});
test("consumer authorization failure remains separate from a matching running installation", async (t) => {
  const f = fixture(t, { catalog: 403 }),
    r = await inspectRetainedStudio(f);
  assert.equal(r.status, "running");
  assert.equal(r.consumer.catalogStatus, 403);
  assert.equal(r.consumer.catalog, undefined);
});
test("TLS or timeout errors do not become an offline restart decision", async (t) => {
  const f = fixture(t);
  f.request = async () => {
    throw new Error("fixture TLS verification failed");
  };
  await assert.rejects(inspectRetainedStudio(f), /TLS verification/);
});

test("a Broken metadata label does not reject a matching live Engine and authenticated installation", async (t) => {
  const f = fixture(t, { profile: "Broken" });
  const r = await inspectRetainedStudio(f);
  assert.equal(r.status, "running");
  assert.equal(r.profileStatus, "Broken");
  assert.equal(r.ready, true);
});
