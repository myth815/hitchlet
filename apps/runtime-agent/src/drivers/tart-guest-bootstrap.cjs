const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MARKER_NAME = "guest-bootstrap-prepared.json";
const SERVICE_PREFIX = "com.hitchlet.sshd.";
const ACCOUNT = "admin";

function runGuestBootstrap(input, overrides) {
  const deps = overrides || defaultDependencies();
  const request = validateRequest(input);
  const linux = deps.platform === "linux";
  if (!["darwin", "linux"].includes(deps.platform) || deps.arch !== "arm64")
    fail("guest_platform_unsupported");
  if (Number(String(deps.nodeVersion).replace(/^v/, "").split(".")[0]) !== 24)
    fail("guest_node24_required");
  if (deps.uid !== 0) fail("guest_root_required");

  const prepared = readJson(deps, path.join(deps.root, MARKER_NAME));
  if (
    !prepared ||
    prepared.version !== 1 ||
    prepared.guestOS !== (linux ? "linux" : "macos") ||
    prepared.guestArch !== "arm64" ||
    prepared.nodeMajor !== 24 ||
    prepared.defaultSshDisabled !== true ||
    prepared.sshPort !== 22
  )
    fail("guest_template_not_prepared");
  assertRootDirectory(deps, deps.root, "guest_root_directory_invalid");
  assertRootFile(deps, path.join(deps.root, MARKER_NAME), true);

  const clientBlob = decodePublicKey(request.clientPublicKey);
  if (
    fingerprint(clientBlob) !==
    request.clientPublicKeyFingerprint
      .replace(/^SHA256:/, "")
      .replace(/=+$/, "")
  )
    fail("client_key_fingerprint_mismatch");

  const allocationHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        request.identity.installationId,
        request.identity.runtimeIdentityId,
        request.identity.connectionRevisionId,
        request.identity.allocationId,
        request.identity.generation,
        request.identity.purpose,
      ]),
    )
    .digest("hex");
  const requestHash = crypto
    .createHash("sha256")
    .update(canonical(request))
    .digest("hex");
  const stateDirectory = path.join(deps.root, "allocations", allocationHash);
  const statePath = path.join(stateDirectory, "bootstrap.json");
  const expectedServiceLabel =
    (linux ? "hitchlet-sshd-" : SERVICE_PREFIX) + allocationHash.slice(0, 24);
  const expectedConfigPath = path.join(stateDirectory, "sshd_config");
  const publicKeysDirectory =
    deps.publicKeysRoot || "/var/db/hitchlet-ssh-authorized-keys";
  const publicAllocationDirectory = path.join(
    publicKeysDirectory,
    allocationHash,
  );
  const authorizedKeysPath = path.join(
    publicAllocationDirectory,
    "authorized_keys",
  );
  const expectedServicePath = linux
    ? path.join(
        deps.systemdDirectory || "/etc/systemd/system",
        expectedServiceLabel + ".service",
      )
    : path.join(
        deps.launchdDirectory || "/Library/LaunchDaemons",
        expectedServiceLabel + ".plist",
      );
  deps.mkdir(path.dirname(stateDirectory), 0o700);
  assertRootDirectory(
    deps,
    path.dirname(stateDirectory),
    "guest_state_directory_invalid",
  );
  deps.mkdir(stateDirectory, 0o700);
  assertRootDirectory(deps, stateDirectory, "guest_state_directory_invalid");
  const accountUid = deps.run("/usr/bin/id", ["-u", ACCOUNT]).stdout.trim();
  if (!/^\d+$/.test(accountUid) || accountUid === "0")
    fail("guest_account_unavailable");

  let state = readJson(deps, statePath);
  if (state) {
    if (
      state.version !== 1 ||
      canonical(state.identity) !== canonical(request.identity) ||
      state.nonce !== request.nonce ||
      state.requestHash !== requestHash ||
      !["preparing", "applied"].includes(state.state) ||
      state.serviceLabel !== expectedServiceLabel ||
      state.stateDirectory !== stateDirectory ||
      state.configPath !== expectedConfigPath ||
      state.authorizedKeysPath !== authorizedKeysPath ||
      (state.servicePath || state.plistPath) !== expectedServicePath
    )
      fail("guest_allocation_already_bootstrapped");
    if (
      state.state === "applied" &&
      !validStoredReceipt(state.receipt, request)
    )
      fail("guest_bootstrap_receipt_invalid");
  } else {
    state = {
      version: 1,
      identity: request.identity,
      nonce: request.nonce,
      requestHash: requestHash,
      state: "preparing",
      serviceLabel: expectedServiceLabel,
      stateDirectory: stateDirectory,
      configPath: expectedConfigPath,
      authorizedKeysPath: authorizedKeysPath,
      ...(linux
        ? { servicePath: expectedServicePath }
        : { plistPath: expectedServicePath }),
    };
    writeJsonAtomic(deps, statePath, state);
  }

  const hostKeyPath = path.join(stateDirectory, "ssh_host_ed25519_key");
  const hostPublicKeyPath = hostKeyPath + ".pub";
  const privateFacts = deps.lstat(hostKeyPath);
  const publicFacts = deps.lstat(hostPublicKeyPath);
  const hasPrivate = !!privateFacts;
  const hasPublic = !!publicFacts;
  if (hasPrivate !== hasPublic) fail("guest_host_key_state_incomplete");
  if (!hasPrivate) {
    ensurePortAvailable(deps, state.serviceLabel);
    deps.run("/usr/bin/ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "hitchlet:" + allocationHash,
      "-f",
      hostKeyPath,
    ]);
    deps.chmod(hostKeyPath, 0o600);
    deps.chmod(hostPublicKeyPath, 0o644);
  }
  assertRootFile(deps, hostKeyPath, true);
  assertRootFile(deps, hostPublicKeyPath, false);
  const hostPublicKey = deps
    .readText(hostPublicKeyPath)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
  const hostFingerprint = fingerprint(decodePublicKey(hostPublicKey));
  const authorizedKey =
    request.clientPublicKey.split(/\s+/).slice(0, 2).join(" ") + "\n";
  deps.mkdir(publicKeysDirectory, 0o755);
  assertPublicDirectory(deps, publicKeysDirectory);
  deps.mkdir(publicAllocationDirectory, 0o755);
  assertPublicDirectory(deps, publicAllocationDirectory);
  writeOwnedPublicKey(deps, authorizedKeysPath, authorizedKey);

  const sshdConfig = [
    "Port 22",
    "AddressFamily inet",
    "ListenAddress 0.0.0.0",
    "HostKey " + hostKeyPath,
    "PidFile " + path.join(stateDirectory, "sshd.pid"),
    "AuthorizedKeysFile " + authorizedKeysPath,
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "PubkeyAuthentication yes",
    "AuthenticationMethods publickey",
    "PermitRootLogin no",
    "AllowTcpForwarding no",
    "X11Forwarding no",
    "PermitTunnel no",
    "AllowUsers " + ACCOUNT,
    "Subsystem sftp internal-sftp",
    "UsePAM yes",
    "StrictModes yes",
    "",
  ].join("\n");
  writeOwnedText(deps, state.configPath, sshdConfig, 0o600);

  const service = linux
    ? systemdUnit(state.configPath)
    : launchdPlist(state.serviceLabel, state.configPath, stateDirectory);
  writeOwnedText(deps, expectedServicePath, service, 0o644);
  if (linux) {
    const runtimeDirectory = deps.sshRuntimeDirectory || "/run/sshd";
    deps.mkdir(runtimeDirectory, 0o755);
    assertPublicDirectory(deps, runtimeDirectory);
  }
  deps.run("/usr/sbin/sshd", ["-t", "-f", state.configPath]);
  ensureService(
    deps,
    state.serviceLabel,
    expectedServicePath,
    state.configPath,
  );

  if (state.state === "applied") {
    if (
      state.receipt.hostPublicKey !== hostPublicKey ||
      state.receipt.hostKeyFingerprint !== "SHA256:" + hostFingerprint
    )
      fail("guest_bootstrap_receipt_invalid");
    return state.receipt;
  }

  const receipt = {
    status: "applied",
    identity: request.identity,
    nonce: request.nonce,
    account: request.account,
    clientPublicKeyFingerprint: request.clientPublicKeyFingerprint,
    hostPublicKey: hostPublicKey,
    hostKeyFingerprint: "SHA256:" + hostFingerprint,
    networkEvidenceReference: request.networkEvidence.reference,
    networkEvidenceExpiresAt: request.networkEvidence.expiresAt,
    observedAt: deps.now().toISOString(),
  };
  writeJsonAtomic(
    deps,
    statePath,
    Object.assign({}, state, { state: "applied", receipt: receipt }),
  );
  return receipt;
}

function validStoredReceipt(receipt, request) {
  return (
    !!receipt &&
    receipt.status === "applied" &&
    canonical(receipt.identity) === canonical(request.identity) &&
    receipt.nonce === request.nonce &&
    receipt.account === ACCOUNT &&
    receipt.clientPublicKeyFingerprint === request.clientPublicKeyFingerprint &&
    receipt.networkEvidenceReference === request.networkEvidence.reference &&
    receipt.networkEvidenceExpiresAt === request.networkEvidence.expiresAt &&
    Number.isFinite(Date.parse(receipt.observedAt))
  );
}

function ensureService(deps, label, plistPath, configPath) {
  if (deps.platform === "linux") {
    const unit = label + ".service";
    if (
      deps.tryRun("/usr/bin/systemctl", ["is-active", "--quiet", unit])
        .status === 0
    )
      return;
    ensurePortAvailable(deps, label);
    deps.run("/usr/sbin/sshd", ["-t", "-f", configPath]);
    deps.run("/usr/bin/systemctl", ["daemon-reload"]);
    deps.run("/usr/bin/systemctl", ["enable", "--now", unit]);
    if (
      deps.tryRun("/usr/bin/systemctl", ["is-active", "--quiet", unit])
        .status !== 0
    )
      fail("guest_sshd_launch_unverified");
    return;
  }
  const loaded = deps.tryRun("/bin/launchctl", ["print", "system/" + label]);
  if (loaded.status === 0) return;
  ensurePortAvailable(deps, label);
  deps.run("/usr/sbin/sshd", ["-t", "-f", configPath]);
  deps.run("/bin/launchctl", ["bootstrap", "system", plistPath]);
  if (deps.tryRun("/bin/launchctl", ["print", "system/" + label]).status !== 0)
    fail("guest_sshd_launch_unverified");
}

function ensurePortAvailable(deps, label) {
  if (deps.platform === "linux") {
    if (
      deps.tryRun("/usr/bin/systemctl", [
        "is-active",
        "--quiet",
        label + ".service",
      ]).status === 0
    )
      return;
    const result = deps.tryRun("/usr/bin/ss", ["-H", "-ltn", "sport = :22"]);
    if (result.status !== 0) fail("guest_ssh_port_check_unknown");
    if (result.stdout.trim()) fail("guest_ssh_port_22_in_use");
    return;
  }
  if (deps.tryRun("/bin/launchctl", ["print", "system/" + label]).status === 0)
    return;
  const result = deps.tryRun("/usr/sbin/lsof", [
    "-nP",
    "-iTCP:22",
    "-sTCP:LISTEN",
  ]);
  if (result.status === 0) fail("guest_ssh_port_22_in_use");
  if (result.status !== 1) fail("guest_ssh_port_check_unknown");
}

function systemdUnit(configPath) {
  return [
    "[Unit]",
    "Description=Hitchlet allocation SSH",
    "After=network.target",
    "[Service]",
    "Type=simple",
    "ExecStart=/usr/sbin/sshd -D -e -f " + configPath,
    "RuntimeDirectory=sshd",
    "RuntimeDirectoryMode=0755",
    "Restart=on-failure",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function launchdPlist(label, configPath, stateDirectory) {
  const args = ["/usr/sbin/sshd", "-D", "-e", "-f", configPath];
  const list = args
    .map((value) => "<string>" + xml(value) + "</string>")
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict><key>Label</key><string>' +
    xml(label) +
    "</string><key>ProgramArguments</key><array>" +
    list +
    "</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>" +
    "<key>StandardOutPath</key><string>" +
    xml(path.join(stateDirectory, "sshd.log")) +
    "</string><key>StandardErrorPath</key><string>" +
    xml(path.join(stateDirectory, "sshd.log")) +
    "</string></dict></plist>\n"
  );
}

function writeOwnedText(deps, file, content, mode) {
  if (deps.lstat(file)) {
    assertRootFile(deps, file, mode === 0o600);
    if (deps.readText(file) !== content)
      fail("guest_bootstrap_owned_file_conflict");
    return;
  }
  deps.writeAtomic(file, content, mode);
}

function assertRootDirectory(deps, directory, code) {
  const facts = deps.lstat(directory);
  if (
    !facts ||
    !facts.isDirectory ||
    facts.isSymbolicLink ||
    facts.uid !== 0 ||
    (facts.mode & 0o077) !== 0
  )
    fail(code);
}

function assertPublicDirectory(deps, directory) {
  const facts = deps.lstat(directory);
  if (
    !facts ||
    !facts.isDirectory ||
    facts.isSymbolicLink ||
    facts.uid !== 0 ||
    (facts.mode & 0o777) !== 0o755
  )
    fail("guest_authorized_keys_directory_invalid");
}

function writeOwnedPublicKey(deps, file, content) {
  if (deps.lstat(file)) {
    const facts = deps.lstat(file);
    if (
      !facts ||
      !facts.isFile ||
      facts.isSymbolicLink ||
      facts.uid !== 0 ||
      (facts.mode & 0o777) !== 0o644
    )
      fail("guest_bootstrap_file_permissions_invalid");
    if (deps.readText(file) !== content)
      fail("guest_bootstrap_owned_file_conflict");
    return;
  }
  deps.writeAtomic(file, content, 0o644);
  const facts = deps.lstat(file);
  if (
    !facts ||
    !facts.isFile ||
    facts.isSymbolicLink ||
    facts.uid !== 0 ||
    (facts.mode & 0o777) !== 0o644
  )
    fail("guest_bootstrap_file_permissions_invalid");
}

function assertRootFile(deps, file, privateFile) {
  const facts = deps.lstat(file);
  if (
    !facts ||
    !facts.isFile ||
    facts.isSymbolicLink ||
    facts.uid !== 0 ||
    (facts.mode & (privateFile ? 0o077 : 0o022)) !== 0
  )
    fail("guest_bootstrap_file_permissions_invalid");
}

function validateRequest(request) {
  exactKeys(request, [
    "identity",
    "nonce",
    "account",
    "clientPublicKey",
    "clientPublicKeyFingerprint",
    "networkEvidence",
  ]);
  exactKeys(request.identity, [
    "installationId",
    "runtimeIdentityId",
    "connectionRevisionId",
    "allocationId",
    "generation",
    "operationId",
    "controlVersion",
    "purpose",
  ]);
  exactKeys(request.networkEvidence, ["reference", "revisionId", "expiresAt"]);
  const id = request.identity;
  if (
    typeof id.installationId !== "string" ||
    typeof id.runtimeIdentityId !== "string" ||
    typeof id.connectionRevisionId !== "string" ||
    typeof id.allocationId !== "string" ||
    !Number.isSafeInteger(id.generation) ||
    id.generation < 1 ||
    !Number.isSafeInteger(id.controlVersion) ||
    id.controlVersion < 1 ||
    typeof id.operationId !== "string" ||
    !["tenant", "validation"].includes(id.purpose) ||
    typeof request.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(request.nonce) ||
    request.account !== ACCOUNT ||
    typeof request.clientPublicKey !== "string" ||
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(
      request.clientPublicKey,
    ) ||
    typeof request.clientPublicKeyFingerprint !== "string" ||
    !/^SHA256:[A-Za-z0-9+/]{20,44}={0,2}$/.test(
      request.clientPublicKeyFingerprint,
    ) ||
    typeof request.networkEvidence.reference !== "string" ||
    typeof request.networkEvidence.revisionId !== "string" ||
    !Number.isFinite(Date.parse(request.networkEvidence.expiresAt))
  )
    fail("guest_bootstrap_request_invalid");
  return request;
}

function decodePublicKey(publicKey) {
  const fields = publicKey.split(/\s+/);
  const algorithm = fields[0],
    encoded = fields[1];
  if (
    !new Set(["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"]).has(
      algorithm,
    ) ||
    !encoded
  )
    fail("guest_public_key_invalid");
  const blob = Buffer.from(encoded, "base64");
  if (blob.length < 8) fail("guest_public_key_invalid");
  const algorithmLength = blob.readUInt32BE(0);
  if (
    algorithmLength > blob.length - 4 ||
    blob.subarray(4, 4 + algorithmLength).toString("ascii") !== algorithm
  )
    fail("guest_public_key_invalid");
  return blob;
}

function fingerprint(blob) {
  return crypto
    .createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/, "");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
      .join(",") +
    "}"
  );
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("guest_bootstrap_request_invalid");
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  )
    fail("guest_bootstrap_request_invalid");
}

function readJson(deps, file) {
  if (!deps.lstat(file)) return undefined;
  assertRootFile(deps, file, true);
  try {
    return JSON.parse(deps.readText(file));
  } catch {
    fail("guest_bootstrap_marker_invalid");
  }
}

function writeJsonAtomic(deps, file, value) {
  deps.writeAtomic(file, JSON.stringify(value) + "\n", 0o600);
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function defaultDependencies() {
  return {
    root:
      process.platform === "linux" ? "/var/lib/hitchlet" : "/var/db/hitchlet",
    publicKeysRoot:
      process.platform === "linux"
        ? "/var/lib/hitchlet-ssh-authorized-keys"
        : "/var/db/hitchlet-ssh-authorized-keys",
    systemdDirectory: "/etc/systemd/system",
    launchdDirectory: "/Library/LaunchDaemons",
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    now: () => new Date(),
    exists: (file) => fs.existsSync(file),
    lstat: (file) => {
      try {
        const value = fs.lstatSync(file);
        return {
          uid: value.uid,
          mode: value.mode,
          isDirectory: value.isDirectory(),
          isFile: value.isFile(),
          isSymbolicLink: value.isSymbolicLink(),
        };
      } catch {
        return undefined;
      }
    },
    readText: (file) => fs.readFileSync(file, "utf8"),
    mkdir: (directory, mode) =>
      fs.mkdirSync(directory, { recursive: true, mode: mode }),
    chmod: (file, mode) => fs.chmodSync(file, mode),
    writeAtomic: (file, content, mode) => {
      const temporary = file + "." + crypto.randomUUID() + ".tmp";
      const fd = fs.openSync(temporary, "wx", mode);
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      const dir = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    },
    tryRun: (command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return {
        status: result.error || result.status === null ? -1 : result.status,
        stdout: result.stdout || "",
      };
    },
    run: (command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.error || result.status !== 0)
        fail("guest_bootstrap_command_failed");
      return { status: 0, stdout: result.stdout || "" };
    },
  };
}

module.exports = { runGuestBootstrap };
