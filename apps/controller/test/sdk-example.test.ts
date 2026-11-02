import { it, expect } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { openStorage } from "../dist/storage/index.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { TicketService } from "../src/application/tickets.js";
import { OperationWorker } from "../src/application/operations.js";
import { LeaseService } from "../src/application/leases.js";
import { PersistentSimulator } from "../src/providers/simulator.js";

const runNode = promisify(execFile);

it("recovers public SDK CLI processes after accepted writes lose responses, without another Ticket or premature release", async () => {
  const root = await mkdtemp(join(tmpdir(), "hitchlet-sdk-example-"));
  const dataDir = join(root, "ledger");
  const simulatorDir = join(root, "simulator");
  const stateDir = join(root, "consumer-state");
  const script = resolve("../../packages/sdk/examples/resumable-tenant.mjs");
  let closeApp: (() => Promise<unknown>) | undefined;
  let closeDb: (() => Promise<unknown>) | undefined;
  let closeProxy: (() => Promise<unknown>) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let tickError: unknown;
  const evidence: Record<string, unknown> = {
    kind: "localhost Simulator only",
    startedAt: new Date().toISOString(),
  };
  try {
    const { stdout: seed } = await runNode(
      process.execPath,
      [resolve("dist/init-simulator.js")],
      { env: { ...process.env, DATA_DIR: dataDir } },
    );
    const field = (pattern: RegExp) => {
      const value = seed.match(pattern)?.[1];
      if (!value) throw new Error("Incomplete disposable Simulator seed");
      return value;
    };
    const token = field(/Bearer token \(shown once\): (\S+)/);
    const adminToken = field(
      /Initial admin bearer token \(shown once\): (\S+)/,
    );
    const versionId = field(/Image version: (\S+)/);
    const networkId = field(/Network profile: (\S+)/);
    const db = await openStorage(dataDir);
    closeDb = () => db.close();
    const installation = await db.get<{ installation_id: string }>(
      "SELECT installation_id FROM installations WHERE singleton=1",
    );
    const tickets = new TicketService({
      storage: db,
      installationId: installation!.installation_id,
    });
    const worker = new OperationWorker({
      storage: db,
      installationId: installation!.installation_id,
      execution: new PersistentSimulator(simulatorDir),
    });
    const leases = new LeaseService(db);
    let pauseRenewals = false;
    const tick = () => {
      if (running) return running;
      running = (async () => {
        await tickets.refreshSimulatorFixtureObservation();
        await worker.reconcileBeforeScheduling();
        if (!pauseRenewals) await leases.reconcilePending();
        if (await tickets.reserveNext()) await worker.reconcile();
      })().finally(() => {
        running = undefined;
      });
      return running;
    };
    const app = await buildApp(
      loadConfig({
        DATA_DIR: dataDir,
        SIMULATOR_DATA_DIR: simulatorDir,
        EXECUTION_MODE: "simulator",
        HOST: "127.0.0.1",
        COOKIE_SECURE: "false",
        LOG_LEVEL: "silent",
      }),
      { storage: db, recoveryState: () => "ready" },
    );
    closeApp = () => app.close();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const backend = app.server.address();
    if (!backend || typeof backend === "string")
      throw new Error("No loopback listener");
    await tick();
    timer = setInterval(() => {
      void tick().catch((error) => {
        tickError = error;
      });
    }, 100);

    let dropAcquire = false;
    let dropRenewalReads = false;
    let dropRelease = false;
    let syntheticHostKey = false;
    const hostKey = Buffer.from("synthetic-server-public-key-blob");
    const fingerprint = `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
    const syntheticPrivateKey = "SYNTHETIC_PRIVATE_KEY_MATERIAL_NOT_A_REAL_KEY";
    const posts: { path: string; key: string | undefined }[] = [];
    const proxy = createServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "POST")
        posts.push({
          path: url,
          key: req.headers["idempotency-key"] as string | undefined,
        });
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: backend.port,
          method: req.method,
          path: url,
          headers: req.headers,
        },
        (response) => {
          if (
            (dropAcquire && req.method === "POST" && url === "/v1/tickets") ||
            (dropRenewalReads &&
              req.method === "GET" &&
              url.includes("/renewals/")) ||
            (dropRelease && req.method === "POST" && url.endsWith("/release"))
          ) {
            // Consume the accepted response, then drop it. The real ledger keeps the effect.
            response.resume();
            response.on("end", () => res.destroy());
          } else if (
            syntheticHostKey &&
            req.method === "POST" &&
            url.endsWith("/access") &&
            response.statusCode === 200
          ) {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => {
              const grant = JSON.parse(body);
              grant.access.hostKeyFingerprint = fingerprint;
              grant.authentication = {
                kind: "ephemeral_private_key",
                privateKey: syntheticPrivateKey,
              };
              res.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
              });
              res.end(JSON.stringify(grant));
            });
          } else {
            res.writeHead(response.statusCode ?? 500, response.headers);
            response.pipe(res);
          }
        },
      );
      upstream.on("error", () => {
        res.destroy();
      });
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    closeProxy = () =>
      new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
        proxy.closeAllConnections();
      });
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("No loopback proxy");
    const origin = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      HITCHLET_ORIGIN: origin,
      HITCHLET_TOKEN: token,
      HITCHLET_DEMO_STATE_DIR: stateDir,
      HITCHLET_DEMO_MODE: "SIMULATOR_ONLY",
    };
    const output: string[] = [];
    const cli = async (
      args: string[],
      overrides: Record<string, string> = {},
    ) => {
      try {
        const result = await runNode(process.execPath, [script, ...args], {
          env: { ...env, ...overrides },
          timeout: 25000,
        });
        output.push(result.stdout, result.stderr);
        return { code: 0, ...result };
      } catch (error) {
        const result = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        output.push(result.stdout ?? "", result.stderr ?? "");
        return {
          code: result.code ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      }
    };
    const readState = async () =>
      JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
    const count = async (sql: string) =>
      Number((await db.get<{ n: bigint }>(sql))!.n);
    const catalog = await cli(["catalog"]);
    expect(catalog.code).toBe(0);
    const choices = JSON.parse(catalog.stdout);
    const nodeId = choices.nodes[0].id;
    expect(
      (
        await cli([
          "preview",
          "--version",
          versionId,
          "--node",
          nodeId,
          "--network",
          networkId,
        ])
      ).code,
    ).toBe(0);
    const original = await readState();

    dropAcquire = true;
    const lostAcquire = await cli(["acquire-or-resume"]);
    expect(lostAcquire.code).not.toBe(0);
    expect(lostAcquire.stderr).toContain("NETWORK_RESULT_UNKNOWN");
    const uncertain = await readState();
    expect(uncertain.ticketId).toBeNull();
    expect(uncertain.prepared.kind).toBe("acquire");
    expect(uncertain.prepared.idempotencyKey).toBe(
      original.acquireIdempotencyKey,
    );
    expect(await count("SELECT count(*) n FROM tickets")).toBe(1);
    const acquired = await db.get<{ id: string }>("SELECT id FROM tickets");
    const postCount = posts.length;
    const wrongIdentity = await cli(["resume"], { HITCHLET_TOKEN: adminToken });
    expect(wrongIdentity.code).not.toBe(0);
    expect(wrongIdentity.stderr).toContain("STATE_IDENTITY_MISMATCH");
    let wrongOriginRequests = 0;
    const wrongOrigin = createServer((_request, response) => {
      wrongOriginRequests++;
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) =>
      wrongOrigin.listen(0, "127.0.0.1", resolve),
    );
    try {
      const otherAddress = wrongOrigin.address();
      if (!otherAddress || typeof otherAddress === "string")
        throw new Error("No second loopback listener");
      const result = await cli(["resume"], {
        HITCHLET_ORIGIN: `http://127.0.0.1:${otherAddress.port}`,
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("STATE_IDENTITY_MISMATCH");
      expect(wrongOriginRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => wrongOrigin.close(() => resolve()));
    }
    expect(
      (
        await cli([
          "preview",
          "--version",
          versionId,
          "--node",
          nodeId,
          "--network",
          networkId,
        ])
      ).code,
    ).not.toBe(0);
    expect(posts.length).toBe(postCount);
    expect((await readState()).prepared).toEqual(uncertain.prepared);
    dropAcquire = false;
    expect((await cli(["resume"])).code).toBe(0);
    expect((await readState()).ticketId).toBe(acquired!.id);
    expect(
      new Set(posts.filter((p) => p.path === "/v1/tickets").map((p) => p.key)),
    ).toEqual(new Set([original.acquireIdempotencyKey]));
    expect((await cli(["wait-ready"])).code).toBe(0);
    expect((await cli(["claim"])).code).toBe(0);
    const claimed = await readState();
    expect(claimed.lastConfirmedLeaseExpiresAt).toBeTruthy();
    const handoff = await cli(["access-with-adapter"]);
    expect(handoff.code).toBe(0);
    expect(JSON.parse(handoff.stdout)).toMatchObject({
      networkConnection: false,
      hostKeyVerified: false,
    });

    // Synthetic host-key callback validation only; still no SSH socket or real server.
    const adapter = join(root, "synthetic-adapter.mjs");
    syntheticHostKey = true;
    await writeFile(
      adapter,
      `export default async ()=>{throw Error(process.env.HITCHLET_TOKEN);};`,
      { mode: 0o600 },
    );
    const adapterFailure = await cli(
      ["access-with-adapter", "--adapter", adapter],
      { HITCHLET_DEMO_MODE: "" },
    );
    expect(adapterFailure.code).not.toBe(0);
    expect(adapterFailure.stderr).toContain("REQUEST_FAILED");
    expect(adapterFailure.stderr).not.toContain(token);
    await writeFile(
      adapter,
      `export default async ({grant,verifyServerHostKey})=>{if(!grant.authentication)throw Error('no material');let denied=false;try{verifyServerHostKey(Buffer.from('wrong-key'))}catch{denied=true}if(!denied)throw Error('wrong key accepted');verifyServerHostKey(Buffer.from('synthetic-server-public-key-blob'));};`,
      { mode: 0o600 },
    );
    expect(
      (
        await cli(["access-with-adapter", "--adapter", adapter], {
          HITCHLET_DEMO_MODE: "",
        })
      ).code,
    ).toBe(0);
    // Compose the lifecycle CLI with the reference factory and a controlled
    // Client. This wrapper never constructs a socket or parses an actual key.
    const referenceUrl = pathToFileURL(
      resolve("../../packages/sdk/examples/ssh-access-adapter.mjs"),
    ).href;
    await writeFile(
      adapter,
      `
      import { EventEmitter } from 'node:events';
      import { createSshAdapter } from ${JSON.stringify(referenceUrl)};
      let owned;
      class Client extends EventEmitter {
        constructor(){super();owned=this;}
        connect(options){this.options=options;queueMicrotask(()=>{if(options.hostVerifier(Buffer.from('synthetic-server-public-key-blob')))this.emit('ready');else this.emit('error',Error('unverified'));});return this;}
        exec(_command,callback){const stream=new EventEmitter();stream.stderr=new EventEmitter();stream.destroy=()=>stream;callback(null,stream);queueMicrotask(()=>{stream.emit('data',Buffer.from('workspace\\n1000\\n1000\\nv24.22.2\\n'));stream.emit('close',0);});return this;}
        end(){this.emit('error',Error(this.options.privateKey));return this;}
        destroy(){this.destroyed=true;return this;}
      }
      export default async context=>{const probe=await createSshAdapter({Client})(context);if(probe.uid!==1000||!owned.destroyed)throw Error('adapter composition failed');};
    `,
      { mode: 0o600 },
    );
    expect(
      (
        await cli(["access-with-adapter", "--adapter", adapter], {
          HITCHLET_DEMO_MODE: "",
        })
      ).code,
    ).toBe(0);
    syntheticHostKey = false;

    pauseRenewals = true;
    await running;
    dropRenewalReads = true;
    const uncertainRenewal = await cli(["renew", "1200"]);
    expect(uncertainRenewal.code).not.toBe(0);
    expect(uncertainRenewal.stderr).toContain("NETWORK_RESULT_UNKNOWN");
    const pending = await readState();
    expect(pending.prepared.kind).toBe("renew");
    expect(pending.lastConfirmedLeaseExpiresAt).toBe(
      claimed.lastConfirmedLeaseExpiresAt,
    );
    const lease = await db.get<{ expires_at_ms: bigint }>(
      "SELECT expires_at_ms FROM leases WHERE ticket_id=?",
      [acquired!.id],
    );
    expect(Number(lease!.expires_at_ms)).toBe(
      Date.parse(claimed.lastConfirmedLeaseExpiresAt),
    );
    const proposals = await count("SELECT count(*) n FROM lease_renewals");
    dropRenewalReads = false;
    pauseRenewals = false;
    await tick();
    expect((await cli(["resume"])).code).toBe(0);
    const renewed = await readState();
    expect(Date.parse(renewed.lastConfirmedLeaseExpiresAt)).toBeGreaterThan(
      Date.parse(claimed.lastConfirmedLeaseExpiresAt),
    );
    expect(await count("SELECT count(*) n FROM lease_renewals")).toBe(
      proposals,
    );
    const unconfirmedOutput = await cli(["confirm-output-and-release"]);
    expect(unconfirmedOutput.code).not.toBe(0);
    expect(unconfirmedOutput.stderr).toContain("OUTPUT_CONFIRMATION_REQUIRED");
    expect(posts.filter((p) => p.path.endsWith("/release"))).toHaveLength(0);
    const savedOutput = join(root, "saved-output.txt");
    await writeFile(savedOutput, "hitchlet-sdk-example-output-v1\n", {
      mode: 0o600,
    });
    const outputHash = createHash("sha256")
      .update(await readFile(savedOutput))
      .digest("hex");
    dropRelease = true;
    expect(
      (await cli(["confirm-output-and-release", "--output-saved"])).code,
    ).not.toBe(0);
    expect((await readState()).prepared.kind).toBe("release");
    expect((await readState()).outputConfirmation.confirmed).toBe(true);
    dropRelease = false;
    const released = await cli(["resume"]);
    expect(released.code).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({
      phase: "released",
      cleanupConfirmed: true,
    });
    expect(await count("SELECT count(*) n FROM tickets")).toBe(1);
    expect(
      await count(
        "SELECT count(*) n FROM allocations WHERE desired_state!='absent' OR observed_state!='absent' OR cleanup_status!='complete'",
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) n FROM capacity_claims WHERE state!='released'",
      ),
    ).toBe(0);
    expect(
      (
        await readdir(join(simulatorDir, "resources"), { recursive: true })
      ).filter((x) => x.endsWith(".json") && !x.endsWith("revoked.json")),
    ).toHaveLength(0);
    expect(
      createHash("sha256")
        .update(await readFile(savedOutput))
        .digest("hex"),
    ).toBe(outputHash);
    const stateText = await readFile(join(stateDir, "state.json"), "utf8");
    for (const secret of [
      token,
      adminToken,
      "SIMULATOR_ONLY_NO_NETWORK_ENDPOINT",
      syntheticPrivateKey,
    ]) {
      expect(stateText).not.toContain(secret);
      expect(output.join("\n")).not.toContain(secret);
    }
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, "state.json"))).mode & 0o777).toBe(0o600);
    expect(tickError).toBeUndefined();
    Object.assign(evidence, {
      result: "passed",
      ticketCount: 1,
      sameTicketAfterProcessRestart: true,
      sameAcquireKey: true,
      identityAndFrozenRequestEnforced: true,
      pendingRenewalKeptConfirmedDeadline: true,
      renewalReusedOriginalProposal: true,
      missingOutputConfirmationPreventedRelease: true,
      releaseUnknownRecovered: true,
      syntheticKeyComparisonOnly: true,
      referenceAdapterComposedWithControlledClient: true,
      realSsh: false,
      rawAccessMaterialPersistedOrLogged: false,
      activeClaims: 0,
      simulatorObjects: 0,
      syntheticOutputSha256: outputHash,
    });
  } finally {
    if (timer) clearInterval(timer);
    await running;
    await closeProxy?.();
    await closeApp?.();
    await closeDb?.();
    await rm(root, { recursive: true, force: true });
    if (process.env.HITCHLET_EXAMPLE_EVIDENCE && evidence.result === "passed") {
      await writeFile(
        process.env.HITCHLET_EXAMPLE_EVIDENCE,
        JSON.stringify(
          {
            ...evidence,
            temporaryFixtureRemoved: true,
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    }
  }
}, 60000);
