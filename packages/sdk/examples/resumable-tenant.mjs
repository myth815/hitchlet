#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  rename,
  chmod,
  unlink,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HitchletClient, ComputeClientError } from "@hitchlet/sdk";

const help = `Usage: node resumable-tenant.mjs <command> [options]

Commands:
  catalog
  preview --version ID --network ID [--kind container|vm] [--guest-os linux|macos|windows] [--architecture arm64|amd64] [--node ID] [--storage ID --subpath PATH --mode RO|RW]
  acquire-or-resume
  status
  wait-ready
  claim
  access-with-adapter [--adapter /absolute/path/to/consumer-adapter.mjs]
  renew [seconds]
  resume
  confirm-output-and-release --output-saved

Required environment: HITCHLET_ORIGIN, HITCHLET_TOKEN, HITCHLET_DEMO_STATE_DIR.
Set HITCHLET_DEMO_MODE=SIMULATOR_ONLY only for the explicit no-network fixture.`;

const STATE_FILE = "state.json";
const LOCK_FILE = ".tenant-state.lock";
const safeOutput = (value) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
class ExampleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const errorCode = (error) =>
  error instanceof ComputeClientError || error instanceof ExampleError
    ? error.code
    : "REQUEST_FAILED";

function validateOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "HITCHLET_ORIGIN must be a valid API origin.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "HITCHLET_ORIGIN must use HTTPS, or HTTP on loopback.",
    );
  if (url.username || url.password)
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "HITCHLET_ORIGIN must not contain credentials.",
    );
  if (url.pathname !== "/" || url.search || url.hash)
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "HITCHLET_ORIGIN must not include a path, query, or fragment.",
    );
  return url.origin;
}

async function withStateLock(dir, fn) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(dir);
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o777) !== 0o700) {
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "HITCHLET_DEMO_STATE_DIR must be a dedicated, non-symlink directory with mode 0700.",
    );
  }
  const lockPath = path.join(dir, LOCK_FILE);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new ExampleError(
      "STATE_LOCKED",
      "State is locked by another process; verify it has exited before removing the lock.",
    );
  }
  try {
    return await fn(dir);
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

function emptyState() {
  return {
    schemaVersion: 1,
    identity: null,
    request: null,
    acquireIdempotencyKey: null,
    prepared: null,
    lastDecision: null,
    decisionHistory: [],
    ticketId: null,
    lastConfirmedLeaseExpiresAt: null,
    outputConfirmation: null,
  };
}

async function readState(dir) {
  try {
    const statePath = path.join(dir, STATE_FILE);
    const info = await lstat(statePath);
    if (!info.isFile()) throw new Error("Invalid state file.");
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw);
    if (state?.schemaVersion !== 1) throw new Error("Invalid state file.");
    await chmod(statePath, 0o600);
    return {
      schemaVersion: 1,
      identity: state.identity ?? null,
      request: state.request ?? null,
      acquireIdempotencyKey: state.acquireIdempotencyKey ?? null,
      prepared: state.prepared ?? null,
      lastDecision: state.lastDecision ?? null,
      decisionHistory: Array.isArray(state.decisionHistory)
        ? state.decisionHistory
        : [],
      ticketId: state.ticketId ?? null,
      lastConfirmedLeaseExpiresAt: state.lastConfirmedLeaseExpiresAt ?? null,
      outputConfirmation: state.outputConfirmation ?? null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new ExampleError(
      "INVALID_STATE",
      "Saved state is unreadable or invalid.",
    );
  }
}

async function writeState(dir, state) {
  const target = path.join(dir, STATE_FILE);
  const temporary = path.join(
    dir,
    `.tenant-state.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  const directory = await open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--"))
      throw new ExampleError(
        "INVALID_ARGUMENTS",
        "Arguments do not match the command usage.",
      );
    const key = token.slice(2);
    if (key === "output-saved") {
      result[key] = true;
      continue;
    }
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new ExampleError(
        "INVALID_ARGUMENTS",
        "Arguments do not match the command usage.",
      );
    result[key] = args[++i];
  }
  return result;
}

function acquireRequestFromCatalog(catalog, args) {
  const version = catalog.versions.find((item) => item.id === args.version);
  const node = args.node
    ? catalog.nodes.find((item) => item.id === args.node)
    : null;
  const network = catalog.networks.find((item) => item.id === args.network);
  if (!version || (args.node && !node) || !network)
    throw new ExampleError(
      "INVALID_ARGUMENTS",
      "Choose version and network IDs returned by catalog; --node is optional.",
    );
  const kind = args.kind ?? "container";
  const platforms = version.platforms.filter(
    (item) =>
      item.kind === kind &&
      (!args["guest-os"] || item.guestOs === args["guest-os"]) &&
      (!args.architecture || item.architecture === args.architecture) &&
      (!node || item.architecture === node.architecture),
  );
  const platform = platforms[0];
  if (!platform)
    throw new ExampleError(
      "INVALID_ARGUMENTS",
      "Selected version has no artifact for the requested kind, guest OS and architecture.",
    );
  const request = {
    image: { versionId: version.id },
    resources: {
      cpuMillis: Math.max(
        1,
        ...platforms.map((p) => p.minimumResources.cpuMillis),
      ),
      memoryMiB: Math.max(
        1,
        ...platforms.map((p) => p.minimumResources.memoryMiB),
      ),
      scratchMiB: Math.max(
        0,
        ...platforms.map((p) => p.minimumResources.scratchMiB),
      ),
    },
    networkProfileId: network.id,
    kind,
    ...(args["guest-os"] ? { guestOs: args["guest-os"] } : {}),
    ...(args.architecture ? { allowedArchitectures: [args.architecture] } : {}),
    ...(node ? { allowedNodeIds: [node.id] } : {}),
  };
  if (args.storage) {
    const storage = catalog.storage.find((item) => item.id === args.storage);
    const mode =
      args.mode === "RO"
        ? "read_only"
        : args.mode === "RW"
          ? "read_write"
          : null;
    if (!storage || !args.subpath || !mode)
      throw new ExampleError(
        "INVALID_ARGUMENTS",
        "Storage requires a catalog ID, --subpath and --mode RO|RW.",
      );
    if (
      !storage.allowedSubpaths.includes(args.subpath) ||
      !storage.allowedModes.includes(mode)
    ) {
      throw new ExampleError(
        "INVALID_ARGUMENTS",
        "Selected storage subpath or mode is not catalog-authorized.",
      );
    }
    request.storage = [
      {
        storageProfileId: storage.id,
        authorizedSubpath: args.subpath,
        mountPath: "/workspace/data",
        mode,
      },
    ];
  } else if (args.subpath || args.mode) {
    throw new ExampleError(
      "INVALID_ARGUMENTS",
      "Storage options require --storage.",
    );
  }
  return request;
}

function assertAccessDeadlines(state, grant) {
  const confirmed = Date.parse(state.lastConfirmedLeaseExpiresAt ?? "");
  const grantExpiry = Date.parse(grant?.access?.expiresAt ?? "");
  const now = Date.now();
  if (!Number.isFinite(confirmed) || confirmed <= now)
    throw new ExampleError(
      "LEASE_DEADLINE_EXPIRED_OR_UNKNOWN",
      "No unexpired confirmed lease deadline is available; renew and confirm before access.",
    );
  if (
    !Number.isFinite(grantExpiry) ||
    grantExpiry <= now ||
    grantExpiry > confirmed
  )
    throw new ExampleError(
      "ACCESS_DEADLINE_INVALID",
      "The access grant is expired or outlives the last confirmed lease deadline.",
    );
  return state.lastConfirmedLeaseExpiresAt;
}

async function simulatorAccessConsumer(grant) {
  const auth = grant?.authentication;
  if (
    grant?.access?.hostKeyFingerprint !== "SIMULATOR_ONLY" ||
    auth?.kind !== "ephemeral_password" ||
    auth?.password !== "SIMULATOR_ONLY_NO_NETWORK_ENDPOINT"
  ) {
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "Simulator access sentinel did not match; refusing to hand off access material.",
    );
  }
  // Deliberately no socket, SSH client, credential logging, or host-key verification claim.
  return {
    handoff: "in-memory callback completed",
    networkConnection: false,
    hostKeyVerified: false,
  };
}

function hostKeyVerifier(expectedFingerprint) {
  if (
    typeof expectedFingerprint !== "string" ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/.test(expectedFingerprint)
  ) {
    throw new ExampleError(
      "INVALID_ARGUMENTS",
      "The API did not provide a valid SHA256 host-key fingerprint.",
    );
  }
  let verified = false;
  const verifyServerHostKey = (rawHostKey) => {
    if (!(Buffer.isBuffer(rawHostKey) || rawHostKey instanceof Uint8Array))
      throw new ExampleError(
        "INVALID_ARGUMENTS",
        "Host-key verifier requires the raw SSH public-key blob.",
      );
    const actual = `SHA256:${createHash("sha256").update(rawHostKey).digest("base64").replace(/=+$/, "")}`;
    verified = actual === expectedFingerprint;
    if (!verified)
      throw new ExampleError(
        "INVALID_ARGUMENTS",
        "SSH server host-key fingerprint did not match the API response.",
      );
    return true;
  };
  return { verifyServerHostKey, wasVerified: () => verified };
}

async function consumerAccessAdapter(grant, modulePath, confirmedExpiresAt) {
  if (!modulePath || !path.isAbsolute(modulePath))
    throw new ExampleError(
      "INVALID_ARGUMENTS",
      "Consumer access requires --adapter with an absolute module path.",
    );
  const fingerprint = grant?.access?.hostKeyFingerprint;
  const verifier = hostKeyVerifier(fingerprint);
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.default !== "function")
    throw new ExampleError(
      "INVALID_ARGUMENTS",
      "Adapter module must default-export an async consumer callback.",
    );
  const result = await module.default({
    grant,
    verifyServerHostKey: verifier.verifyServerHostKey,
    confirmedExpiresAt,
  });
  if (!verifier.wasVerified())
    throw new ExampleError(
      "INVALID_ARGUMENTS",
      "Adapter returned without verifying the SSH server host key.",
    );
  void result;
  return { handoff: "consumer adapter completed", hostKeyVerified: true };
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(`${help}\n`);
    return;
  }
  const origin = validateOrigin(process.env.HITCHLET_ORIGIN || "");
  const token = process.env.HITCHLET_TOKEN;
  const dir = process.env.HITCHLET_DEMO_STATE_DIR;
  if (!token || !dir)
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "Set HITCHLET_TOKEN and HITCHLET_DEMO_STATE_DIR.",
    );
  if (
    process.env.HITCHLET_DEMO_MODE &&
    process.env.HITCHLET_DEMO_MODE !== "SIMULATOR_ONLY"
  )
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "HITCHLET_DEMO_MODE, when set, must be SIMULATOR_ONLY.",
    );
  if (
    process.env.HITCHLET_DEMO_MODE === "SIMULATOR_ONLY" &&
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(origin).hostname,
    )
  ) {
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "SIMULATOR_ONLY mode is restricted to a loopback origin.",
    );
  }
  if (!path.isAbsolute(dir))
    throw new ExampleError(
      "INVALID_CONFIGURATION",
      "HITCHLET_DEMO_STATE_DIR must be an absolute path.",
    );
  const client = new HitchletClient(origin, {
    auth: { kind: "bearer", token },
  });
  const positional =
    command === "renew" && rawArgs[0] && !rawArgs[0].startsWith("--")
      ? rawArgs.shift()
      : undefined;
  const args = options(rawArgs);

  await withStateLock(dir, async (stateDir) => {
    const state = await readState(stateDir);
    const persist = () => writeState(stateDir, state);
    if (state.identity && state.identity.origin !== origin) {
      throw new ExampleError(
        "STATE_IDENTITY_MISMATCH",
        "State belongs to a different API origin; refusing recovery before contacting the configured origin.",
      );
    }
    const principal = await client.session.me();
    const identity = { origin, consumerId: principal.consumerId };
    if (state.identity && state.identity.consumerId !== identity.consumerId)
      throw new ExampleError(
        "STATE_IDENTITY_MISMATCH",
        "State belongs to a different consumer; refusing recovery as another identity.",
      );
    if (!state.identity) {
      state.identity = identity;
      await persist();
    }
    const preparedOptions = (key) => ({
      idempotencyKey: key,
      onPrepared: async (prepared) => {
        state.prepared = prepared;
        await persist();
      },
    });
    const ticketIdRequired = () => {
      if (!state.ticketId)
        throw new ExampleError(
          "INVALID_ARGUMENTS",
          "No Ticket is recorded; preview and acquire first.",
        );
      return state.ticketId;
    };

    switch (command) {
      case "catalog":
        safeOutput(await client.catalog());
        return;
      case "preview": {
        if (state.prepared)
          throw new ExampleError(
            "PREPARED_COMMAND_UNRESOLVED",
            "Cannot replace state while a prepared command remains unresolved.",
          );
        if (state.ticketId) {
          const previous = await client.tickets.get(state.ticketId);
          if (previous.phase !== "released")
            throw new ExampleError(
              "PREPARED_COMMAND_UNRESOLVED",
              "Existing Ticket is not released; refusing to overwrite it.",
            );
        }
        const catalog = await client.catalog();
        const request = acquireRequestFromCatalog(catalog, args);
        const feasibility = await client.preview(request);
        if (feasibility.availability === "unsupported")
          throw new ExampleError(
            "ENVIRONMENT_UNSUPPORTED",
            "No registered environment matches the requested kind, guest OS, architecture and recipe.",
          );
        if (args.node && !feasibility.eligibleNodeIds.includes(args.node))
          throw new ExampleError(
            "INVALID_ARGUMENTS",
            "Preview did not include the selected node as eligible.",
          );
        Object.assign(state, emptyState(), {
          identity,
          request,
          acquireIdempotencyKey: randomUUID(),
        });
        await persist();
        safeOutput({
          request,
          acquireIdempotencyKey: state.acquireIdempotencyKey,
          feasibility,
        });
        return;
      }
      case "acquire-or-resume": {
        if (state.ticketId) {
          safeOutput({
            ticketId: state.ticketId,
            phase: (await client.tickets.get(state.ticketId)).phase,
            action: "existing-ticket",
          });
          return;
        }
        if (!state.request || !state.acquireIdempotencyKey)
          throw new ExampleError(
            "INVALID_ARGUMENTS",
            "Run preview before acquire-or-resume.",
          );
        const receipt = state.prepared
          ? await client.tickets.resume(state.prepared)
          : await client.tickets.acquire(
              state.request,
              preparedOptions(state.acquireIdempotencyKey),
            );
        state.ticketId = receipt.ticket.id;
        state.prepared = null;
        await persist();
        safeOutput({
          ticketId: state.ticketId,
          idempotencyKey: receipt.idempotencyKey,
          phase: receipt.ticket.phase,
        });
        return;
      }
      case "status": {
        const ticket = state.ticketId
          ? await client.tickets.get(state.ticketId)
          : null;
        safeOutput({
          ticketId: state.ticketId,
          phase: ticket?.phase ?? null,
          lastConfirmedLeaseExpiresAt: state.lastConfirmedLeaseExpiresAt,
          preparedKind: state.prepared?.kind ?? null,
          lastDecision: state.lastDecision,
          decisionHistory: state.decisionHistory,
          outputConfirmed: Boolean(state.outputConfirmation),
        });
        return;
      }
      case "wait-ready": {
        const ready = await client.tickets.waitUntilReady(ticketIdRequired(), {
          timeoutMilliseconds: 60_000,
        });
        safeOutput({
          ticketId: ready.id,
          phase: ready.phase,
          leaseExpiresAt: ready.lease?.expiresAt ?? null,
        });
        return;
      }
      case "claim": {
        if (state.prepared)
          throw new ExampleError(
            "PREPARED_COMMAND_UNRESOLVED",
            "A prepared command is unresolved; run resume explicitly first.",
          );
        const receipt = await client.tickets.claim(
          ticketIdRequired(),
          preparedOptions(randomUUID()),
        );
        state.prepared = null;
        state.lastConfirmedLeaseExpiresAt = receipt.expiresAt;
        await persist();
        safeOutput({
          ticketId: state.ticketId,
          lastConfirmedLeaseExpiresAt: receipt.expiresAt,
          confirmed: true,
        });
        return;
      }
      case "renew": {
        if (state.prepared)
          throw new ExampleError(
            "PREPARED_COMMAND_UNRESOLVED",
            "A prepared command is unresolved; run resume explicitly first.",
          );
        const seconds =
          positional === undefined ? undefined : Number(positional);
        if (
          seconds !== undefined &&
          (!Number.isSafeInteger(seconds) || seconds < 1)
        )
          throw new ExampleError(
            "INVALID_ARGUMENTS",
            "Renewal seconds must be a positive integer.",
          );
        const receipt = await client.tickets.renew(
          ticketIdRequired(),
          seconds === undefined ? {} : { requestedTtlSec: seconds },
          preparedOptions(randomUUID()),
        );
        state.prepared = null;
        state.lastConfirmedLeaseExpiresAt = receipt.expiresAt;
        await persist();
        safeOutput({
          ticketId: state.ticketId,
          lastConfirmedLeaseExpiresAt: receipt.expiresAt,
          confirmed: true,
        });
        return;
      }
      case "access-with-adapter": {
        if (state.prepared && state.prepared.kind !== "access")
          throw new ExampleError(
            "PREPARED_COMMAND_UNRESOLVED",
            "A different prepared command is unresolved; run resume explicitly first.",
          );
        const grant = state.prepared
          ? await client.tickets.resume(state.prepared)
          : await client.tickets.getAccess(
              ticketIdRequired(),
              preparedOptions(randomUUID()),
            );
        const confirmedExpiresAt = assertAccessDeadlines(state, grant);
        state.prepared = null;
        await persist();
        if (process.env.HITCHLET_DEMO_MODE === "SIMULATOR_ONLY") {
          const result = await simulatorAccessConsumer(grant);
          safeOutput({
            ticketId: state.ticketId,
            ...result,
            note: "SIMULATOR_ONLY demonstration; no network connection or host-key verification occurred.",
          });
        } else {
          const result = await consumerAccessAdapter(
            grant,
            args.adapter,
            confirmedExpiresAt,
          );
          safeOutput({ ticketId: state.ticketId, ...result });
        }
        return;
      }
      case "resume": {
        if (!state.prepared && state.lastDecision) {
          const ticket = await client.tickets.get(ticketIdRequired());
          safeOutput({
            ticketId: ticket.id,
            phase: ticket.phase,
            preparedCommandClosed: true,
            lastDecision: state.lastDecision,
            decisionHistory: state.decisionHistory,
          });
          return;
        }
        if (!state.prepared)
          throw new ExampleError(
            "INVALID_ARGUMENTS",
            "No prepared command is saved.",
          );
        const prepared = state.prepared;
        if (
          ["access", "renew", "release", "cancel"].includes(prepared.kind) &&
          prepared.ticketId
        ) {
          if (prepared.ticketId !== state.ticketId)
            throw new ExampleError(
              "PREPARED_TICKET_MISMATCH",
              "The prepared command targets a different Ticket than the saved consumer state.",
            );
          const ticket = await client.tickets.get(prepared.ticketId);
          if (
            ticket.id !== prepared.ticketId ||
            ticket.consumerId !== identity.consumerId
          )
            throw new ExampleError(
              "PREPARED_TICKET_MISMATCH",
              "The Ticket returned for the prepared command does not match this saved owner and Ticket ID.",
            );
          if (ticket.phase === "released") {
            if (state.lastDecision)
              state.decisionHistory = [state.lastDecision];
            state.lastDecision = {
              kind: "ticket-released",
              ticketId: ticket.id,
              ownerId: identity.consumerId,
              command: prepared,
              recordedAt: new Date().toISOString(),
            };
            state.prepared = null;
            await persist();
            safeOutput({
              ticketId: ticket.id,
              phase: ticket.phase,
              preparedCommandClosed: true,
              ...(prepared.kind === "release" || prepared.kind === "cancel"
                ? { cleanupConfirmed: true }
                : {}),
              lastDecision: state.lastDecision,
              decisionHistory: state.decisionHistory,
            });
            return;
          }
        }
        let result;
        try {
          result = await client.tickets.resume(prepared);
        } catch (error) {
          if (
            prepared.kind === "renew" &&
            error instanceof ComputeClientError &&
            error.recovery.ticketId === prepared.ticketId &&
            error.recovery.command?.kind === "renew" &&
            error.recovery.command.ticketId === prepared.ticketId &&
            error.recovery.command?.idempotencyKey ===
              prepared.idempotencyKey &&
            error.recovery.renewalId
          ) {
            const renewal = await client.tickets.getRenewal(
              prepared.ticketId,
              error.recovery.renewalId,
            );
            if (
              renewal.id === error.recovery.renewalId &&
              (renewal.state === "rejected" || renewal.state === "cancelled")
            ) {
              state.lastDecision = {
                kind: "renewal-rejected",
                state: renewal.state,
                renewalId: renewal.id,
                reasonCode: renewal.reasonCode,
                ticketId: prepared.ticketId,
                command: prepared,
                recordedAt: new Date().toISOString(),
              };
              state.prepared = null;
              await persist();
            }
          }
          throw error;
        }
        if (prepared.kind === "acquire") {
          state.ticketId = result.ticket.id;
        } else if (prepared.kind === "renew") {
          state.lastConfirmedLeaseExpiresAt = result.expiresAt;
        }
        if (prepared.kind === "release") {
          const released = await client.tickets.waitUntilReleased(
            ticketIdRequired(),
            { timeoutMilliseconds: 60_000 },
          );
          state.prepared = null;
          await persist();
          safeOutput({
            ticketId: state.ticketId,
            phase: released.phase,
            cleanupConfirmed: true,
          });
          return;
        }
        if (prepared.kind === "access") {
          const confirmedExpiresAt = assertAccessDeadlines(state, result);
          const handoff =
            process.env.HITCHLET_DEMO_MODE === "SIMULATOR_ONLY"
              ? {
                  ...(await simulatorAccessConsumer(result)),
                  note: "SIMULATOR_ONLY demonstration; no network connection or host-key verification occurred.",
                }
              : await consumerAccessAdapter(
                  result,
                  args.adapter,
                  confirmedExpiresAt,
                );
          state.prepared = null;
          await persist();
          safeOutput({ ticketId: state.ticketId, ...handoff });
          return;
        }
        state.prepared = null;
        await persist();
        safeOutput({
          ticketId: state.ticketId,
          kind: prepared.kind,
          confirmed: true,
          lastConfirmedLeaseExpiresAt: state.lastConfirmedLeaseExpiresAt,
        });
        return;
      }
      case "confirm-output-and-release": {
        if (args["output-saved"] !== true)
          throw new ExampleError(
            "OUTPUT_CONFIRMATION_REQUIRED",
            "Explicit --output-saved confirmation is required before release.",
          );
        if (!state.ticketId)
          throw new ExampleError("INVALID_ARGUMENTS", "No Ticket is recorded.");
        if (!state.outputConfirmation) {
          state.outputConfirmation = {
            confirmed: true,
            confirmedAt: new Date().toISOString(),
          };
          await persist();
        }
        if (state.prepared && state.prepared.kind !== "release")
          throw new ExampleError(
            "PREPARED_COMMAND_UNRESOLVED",
            "Resume the existing prepared command before release.",
          );
        if (!state.prepared)
          await client.tickets.release(
            state.ticketId,
            { reclaimable: true },
            preparedOptions(randomUUID()),
          );
        else await client.tickets.resume(state.prepared);
        await persist();
        const released = await client.tickets.waitUntilReleased(
          state.ticketId,
          { timeoutMilliseconds: 60_000 },
        );
        state.prepared = null;
        await persist();
        safeOutput({
          ticketId: state.ticketId,
          phase: released.phase,
          cleanupConfirmed: true,
          outputConfirmed: true,
        });
        return;
      }
      default:
        throw new ExampleError(
          "INVALID_ARGUMENTS",
          `Unknown command.\n${help}`,
        );
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    const safeError =
      error instanceof ExampleError
        ? { error: error.code, message: error.message }
        : { error: errorCode(error) };
    process.stderr.write(`${JSON.stringify(safeError)}\n`);
    process.exitCode = 1;
  });
}
