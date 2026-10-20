-- Independent compute resource service: current SQLite schema, v1.3 + D05.
-- This file is a design artifact, not a deployed migration runner.
-- SQL syntax requires SQLite >= 3.37 (STRICT) with JSON functions enabled.
-- Production requires the fixed SQLite 3.51.3+ baseline; passing these schema
-- checks on an older SQLite does not qualify that build for deployment.
-- Run on a LOCAL filesystem, with one active controller process.
-- Connections must set foreign_keys/busy_timeout; those are per connection.
-- WAL sidecar files belong to the persistent data directory too.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  description TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE installations (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  installation_id TEXT NOT NULL UNIQUE,
  controller_epoch INTEGER NOT NULL DEFAULT 1 CHECK (controller_epoch > 0),
  current_network_deny_revision_id TEXT REFERENCES platform_network_deny_revisions(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('machine', 'scheduler', 'lifecycle', 'consumer')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

-- Also holds human/API principals for the admin GUI. Machine/runtime agents
-- authenticate separately; a generation number is never an authentication key.
CREATE TABLE consumers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human', 'service')),
  role TEXT NOT NULL DEFAULT 'consumer' CHECK (role IN ('viewer', 'consumer', 'operator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  policy_id TEXT REFERENCES policies(id) ON DELETE RESTRICT,
  -- ConsumerAuthorization / ConsumerQuota. Application validates their full
  -- shape; creation must provide explicit authorization and effective limits.
  authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
  quota_json TEXT NOT NULL CHECK (json_valid(quota_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE consumer_credentials (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  token_prefix TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  last_used_at_ms INTEGER
) STRICT;

-- Opaque browser cookie material is hashed before storage. id is a non-secret
-- session record ID, not the bearer token. Every authenticated request must
-- check expires_at_ms > now, revoked_at_ms IS NULL and Consumer status/role.
CREATE TABLE gui_sessions (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  source_credential_id TEXT REFERENCES consumer_credentials(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  csrf_token_hash TEXT NOT NULL CHECK (length(csrf_token_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  last_seen_at_ms INTEGER CHECK (last_seen_at_ms IS NULL OR last_seen_at_ms >= created_at_ms)
) STRICT;

-- A live tightening of this baseline is applied to all active environments.
-- The accepted contract keeps its original baseline for audit, while the
-- managed network_policy resource records the last verified applied revision.
CREATE TABLE platform_network_deny_revisions (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE CHECK (revision > 0),
  -- NetworkDenyRule[]: {cidr, protocol: any|tcp|udp, ports: any|number[]}.
  -- Port-scoped rules let NAS data ports coexist with denied NAS management.
  management_deny_rules_json TEXT NOT NULL CHECK (json_valid(management_deny_rules_json)),
  reason TEXT NOT NULL,
  created_by_consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE storage_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  current_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (current_revision_id, id)
    REFERENCES storage_profile_revisions(id, profile_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE storage_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES storage_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  -- Maps to StorageProfileRevision.protocol; object storage is a later adapter.
  kind TEXT NOT NULL CHECK (kind IN ('nfs', 'smb', 'local')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  -- A versioned secret reference, never a mutable "latest" alias or plaintext.
  secret_version_ref TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (profile_id, revision),
  UNIQUE (id, profile_id)
) STRICT;

CREATE TABLE network_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  current_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (current_revision_id, id)
    REFERENCES network_profile_revisions(id, profile_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE network_profile_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES network_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  -- Structured baseline denials + explicit grants, interpreted by RuntimeAgent.
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (profile_id, revision),
  UNIQUE (id, profile_id)
) STRICT;

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  owner_consumer_id TEXT REFERENCES consumers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

-- Publish freezes version metadata and artifact content in application code.
-- Deleting/retiring an alias never rewrites the version pinned by a Ticket.
CREATE TABLE image_versions (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'validating', 'published', 'deprecated', 'blocked')),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  entity_version INTEGER NOT NULL DEFAULT 1 CHECK (entity_version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  published_at_ms INTEGER,
  UNIQUE (image_id, version),
  UNIQUE (id, image_id)
) STRICT;

CREATE TABLE image_aliases (
  image_id TEXT NOT NULL REFERENCES images(id) ON DELETE RESTRICT,
  alias TEXT NOT NULL,
  image_version_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (image_id, alias),
  FOREIGN KEY (image_version_id, image_id)
    REFERENCES image_versions(id, image_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE image_artifacts (
  id TEXT PRIMARY KEY,
  image_version_id TEXT NOT NULL REFERENCES image_versions(id) ON DELETE RESTRICT,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('portainer', 'hyperv', 'tart')),
  environment_kind TEXT NOT NULL CHECK (environment_kind IN ('container', 'vm')),
  architecture TEXT NOT NULL CHECK (architecture IN ('amd64', 'arm64')),
  guest_os TEXT NOT NULL CHECK (guest_os IN ('linux', 'windows', 'macos')),
  variant TEXT NOT NULL DEFAULT 'default',
  artifact_ref TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) > 0),
  minimum_cpu_millis INTEGER NOT NULL CHECK (minimum_cpu_millis >= 0),
  minimum_memory_mib INTEGER NOT NULL CHECK (minimum_memory_mib >= 0),
  minimum_scratch_mib INTEGER NOT NULL CHECK (minimum_scratch_mib >= 0),
  requirements_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(requirements_json)),
  -- access_recipe_json.accessProtocols must match ImageArtifact.accessProtocols.
  access_recipe_json TEXT NOT NULL CHECK (json_valid(access_recipe_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (image_version_id, backend_kind, architecture, variant),
  CHECK ((backend_kind = 'portainer' AND environment_kind = 'container' AND guest_os = 'linux')
      OR (backend_kind = 'hyperv' AND environment_kind = 'vm' AND guest_os IN ('linux', 'windows'))
      OR (backend_kind = 'tart' AND environment_kind = 'vm' AND guest_os IN ('linux', 'macos') AND architecture = 'arm64'))
) STRICT;

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  site_id TEXT NOT NULL DEFAULT 'local',
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'cloud')),
  usage_mode TEXT NOT NULL CHECK (usage_mode IN ('shared', 'dedicated')),
  host_os TEXT NOT NULL CHECK (host_os IN ('windows', 'macos', 'linux')),
  architecture TEXT NOT NULL CHECK (architecture IN ('amd64', 'arm64')),
  admission TEXT NOT NULL DEFAULT 'disabled' CHECK (admission IN ('enabled', 'draining', 'disabled')),
  desired_power TEXT NOT NULL DEFAULT 'unchanged' CHECK (desired_power IN ('unchanged', 'on', 'off', 'sleeping')),
  observed_power TEXT NOT NULL DEFAULT 'unknown' CHECK (observed_power IN ('on', 'off', 'sleeping', 'unknown')),
  power_lifecycle TEXT NOT NULL DEFAULT 'unknown' CHECK (power_lifecycle IN
    ('idle', 'draining', 'shutdown_requested', 'off_expected', 'off_confirmed', 'waking', 'unknown')),
  power_cycle_id TEXT,
  power_transition_id TEXT,
  shutdown_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  accepted_shutdown_receipt_id TEXT REFERENCES agent_receipts(id) ON DELETE RESTRICT,
  out_of_band_evidence_id TEXT,
  shutdown_accepted_at_ms INTEGER,
  wake_not_before_ms INTEGER,
  wake_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (wake_attempt_count >= 0),
  power_transition_deadline_ms INTEGER,
  machine_epoch INTEGER NOT NULL DEFAULT 1 CHECK (machine_epoch > 0),
  policy_id TEXT REFERENCES policies(id) ON DELETE RESTRICT,
  labels_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(labels_json)),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  -- D21: management_json.humanUsePolicy is validated by the runtime schema.
  -- systemReserve includes humanReserved once and mirrors the physical root system_*.
  -- Policy writes and tenant/validation reservations fence the same complete Machine input
  -- inside BEGIN IMMEDIATE (including Host evidence, not only Machine.version).
  management_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(management_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  CHECK (power_lifecycle NOT IN ('shutdown_requested', 'off_expected', 'waking')
      OR (power_cycle_id IS NOT NULL AND power_transition_id IS NOT NULL
          AND power_transition_deadline_ms IS NOT NULL)),
  CHECK (power_lifecycle <> 'off_expected' OR (shutdown_accepted_at_ms IS NOT NULL AND wake_not_before_ms IS NOT NULL
      AND wake_not_before_ms >= shutdown_accepted_at_ms)),
  CHECK (power_lifecycle <> 'off_confirmed' OR observed_power = 'off')
) STRICT;

-- Runtime identity is independent of mutable addresses and Portainer IDs.
-- native_kind names the provider's identity scheme; native_id is authoritative
-- identity evidence (e.g. Docker Engine ID), not an endpoint URL or display name.
CREATE TABLE runtime_identities (
  id TEXT PRIMARY KEY,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('portainer', 'hyperv', 'tart')),
  native_kind TEXT NOT NULL CHECK (native_kind IN ('docker_engine', 'hyperv_host', 'tart_host')),
  native_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (backend_kind, native_kind, native_id),
  UNIQUE (id, backend_kind),
  CHECK ((backend_kind = 'portainer' AND native_kind = 'docker_engine')
      OR (backend_kind = 'hyperv' AND native_kind = 'hyperv_host')
      OR (backend_kind = 'tart' AND native_kind = 'tart_host'))
) STRICT;

CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('portainer', 'hyperv', 'tart')),
  runtime_identity_id TEXT NOT NULL,
  current_revision_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE (id, backend_kind),
  UNIQUE (id, runtime_identity_id),
  FOREIGN KEY (runtime_identity_id, backend_kind)
    REFERENCES runtime_identities(id, backend_kind) ON DELETE RESTRICT,
  FOREIGN KEY (current_revision_id, id)
    REFERENCES provider_connection_revisions(id, connection_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE provider_connection_revisions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  endpoint_ref TEXT NOT NULL,
  provider_endpoint_id TEXT NOT NULL,
  secret_version_ref TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  -- The same identity MUST be verified before making this revision current.
  verified_runtime_identity_id TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (connection_id, revision),
  UNIQUE (id, connection_id),
  UNIQUE (id, verified_runtime_identity_id),
  FOREIGN KEY (connection_id, verified_runtime_identity_id)
    REFERENCES provider_connections(id, runtime_identity_id) ON DELETE RESTRICT
) STRICT;

-- Circular references below are deliberate: a VM Allocation can own a child
-- CapacityPool/Node. SQLite permits declaring FKs before the referenced table.
-- Create Machine/root Pool/VM Node, then base Allocation, then child Pool/Node.
CREATE TABLE capacity_pools (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  parent_allocation_id TEXT,
  total_cpu_millis INTEGER NOT NULL CHECK (total_cpu_millis >= 0),
  total_memory_mib INTEGER NOT NULL CHECK (total_memory_mib >= 0),
  total_scratch_mib INTEGER NOT NULL CHECK (total_scratch_mib >= 0),
  system_cpu_millis INTEGER NOT NULL DEFAULT 0 CHECK (system_cpu_millis >= 0),
  system_memory_mib INTEGER NOT NULL DEFAULT 0 CHECK (system_memory_mib >= 0),
  system_scratch_mib INTEGER NOT NULL DEFAULT 0 CHECK (system_scratch_mib >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE (id, machine_id),
  UNIQUE (parent_allocation_id),
  FOREIGN KEY (parent_allocation_id, machine_id)
    REFERENCES allocations(id, machine_id) ON DELETE RESTRICT,
  CHECK (system_cpu_millis <= total_cpu_millis),
  CHECK (system_memory_mib <= total_memory_mib),
  CHECK (system_scratch_mib <= total_scratch_mib)
) STRICT;

CREATE UNIQUE INDEX capacity_pools_one_root_per_machine
  ON capacity_pools(machine_id) WHERE parent_allocation_id IS NULL;

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('portainer', 'hyperv', 'tart')),
  provider_connection_id TEXT NOT NULL,
  runtime_identity_id TEXT NOT NULL UNIQUE,
  pool_id TEXT NOT NULL,
  admission TEXT NOT NULL DEFAULT 'disabled' CHECK (admission IN ('enabled', 'draining', 'disabled')),
  observed_health TEXT NOT NULL DEFAULT 'unknown' CHECK (observed_health IN ('healthy', 'degraded', 'unknown', 'lost')),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  latest_observation_json TEXT CHECK (latest_observation_json IS NULL OR json_valid(latest_observation_json)),
  observed_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE (machine_id, name),
  UNIQUE (id, machine_id),
  UNIQUE (id, runtime_identity_id),
  FOREIGN KEY (pool_id, machine_id)
    REFERENCES capacity_pools(id, machine_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, backend_kind)
    REFERENCES provider_connections(id, backend_kind) ON DELETE RESTRICT,
  FOREIGN KEY (provider_connection_id, runtime_identity_id)
    REFERENCES provider_connections(id, runtime_identity_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  node_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('host', 'runtime')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  credential_hash TEXT NOT NULL,
  protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version > 0),
  current_boot_id TEXT,
  host_identity TEXT,
  enrollment_hash TEXT,
  enrollment_expires_at_ms INTEGER,
  session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0),
  enrollment_consumed INTEGER NOT NULL DEFAULT 0 CHECK(enrollment_consumed IN(0,1)),
  last_seen_at_ms INTEGER,
  accepted_controller_epoch INTEGER NOT NULL DEFAULT 0 CHECK (accepted_controller_epoch >= 0),
  UNIQUE (id, machine_id),
  FOREIGN KEY (node_id, machine_id) REFERENCES nodes(id, machine_id) ON DELETE RESTRICT,
  CHECK ((kind = 'host' AND node_id IS NULL) OR (kind = 'runtime' AND node_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX agents_one_host_per_machine ON agents(machine_id) WHERE kind = 'host';
CREATE UNIQUE INDEX agents_one_runtime_per_node ON agents(node_id) WHERE kind = 'runtime';

CREATE TABLE agent_boots (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  boot_id TEXT NOT NULL,
  session_epoch INTEGER NOT NULL CHECK(session_epoch > 0),
  controller_epoch INTEGER NOT NULL CHECK(controller_epoch > 0),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
  PRIMARY KEY(agent_id,boot_id), UNIQUE(agent_id,session_epoch)
) STRICT;

CREATE TABLE machine_snapshots (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  agent_boot_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  heartbeat_json TEXT CHECK(heartbeat_json IS NULL OR json_valid(heartbeat_json)),
  heartbeat_hash TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0),
  sessions_json TEXT NOT NULL CHECK (json_valid(sessions_json)),
  workloads_json TEXT NOT NULL CHECK (json_valid(workloads_json)),
  resources_json TEXT NOT NULL CHECK (json_valid(resources_json)),
  probe_status TEXT NOT NULL CHECK (probe_status IN ('complete', 'partial', 'failed')),
  FOREIGN KEY (agent_id, machine_id) REFERENCES agents(id, machine_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE image_validations (
  id TEXT PRIMARY KEY,
  image_artifact_id TEXT NOT NULL REFERENCES image_artifacts(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  requested_by_consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  accepted_contract_json TEXT NOT NULL CHECK (json_valid(accepted_contract_json)),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'releasing', 'succeeded', 'failed', 'cancelled')),
  test_outcome TEXT NOT NULL DEFAULT 'pending' CHECK (test_outcome IN ('pending', 'passed', 'failed')),
  cleanup_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_status IN ('pending', 'running', 'blocked', 'complete')),
  scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
  checks_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checks_json)),
  report_id TEXT,
  deadline_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  evidence_expires_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (id, image_artifact_id, node_id),
  CHECK (deadline_ms > created_at_ms),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled') AND cleanup_status = 'complete' AND finished_at_ms IS NOT NULL)
      OR (state NOT IN ('succeeded', 'failed', 'cancelled') AND finished_at_ms IS NULL)),
  CHECK (state <> 'succeeded' OR (test_outcome = 'passed' AND report_id IS NOT NULL)),
  CHECK (evidence_expires_at_ms IS NULL OR (finished_at_ms IS NOT NULL AND evidence_expires_at_ms > finished_at_ms))
) STRICT;

CREATE TABLE image_caches (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  image_artifact_id TEXT NOT NULL REFERENCES image_artifacts(id) ON DELETE RESTRICT,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('missing', 'pulling', 'ready', 'invalid', 'evicting', 'unknown')),
  local_ref TEXT,
  digest_verified_at_ms INTEGER,
  pinned_until_ms INTEGER,
  size_mib INTEGER CHECK (size_mib IS NULL OR size_mib >= 0),
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  PRIMARY KEY (node_id, image_artifact_id)
) STRICT;

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  image_version_id TEXT NOT NULL REFERENCES image_versions(id) ON DELETE RESTRICT,
  network_profile_revision_id TEXT NOT NULL REFERENCES network_profile_revisions(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL DEFAULT 'queued'
    CHECK (phase IN ('queued', 'reserved', 'provisioning', 'ready', 'releasing', 'released')),
  terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN (
    'consumer_release', 'consumer_cancel', 'queue_timeout', 'provision_timeout',
    'provision_failed', 'unclaimed_timeout', 'lease_expired', 'max_lifetime',
    'resource_lost', 'admin_revoke')),
  cleanup_status TEXT NOT NULL DEFAULT 'not_needed'
    CHECK (cleanup_status IN ('not_needed', 'pending', 'running', 'blocked', 'complete')),
  -- v1.2 contracts: normalized AcceptedAcquireRequest (resolved image/defaults
  -- and ResourceContract), not the public shorthand input. request_hash is the
  -- canonical original input hash used for idempotency before re-resolution.
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  accepted_contract_json TEXT NOT NULL CHECK (json_valid(accepted_contract_json)),
  requested_cpu_millis INTEGER NOT NULL CHECK (requested_cpu_millis > 0),
  requested_memory_mib INTEGER NOT NULL CHECK (requested_memory_mib > 0),
  requested_scratch_mib INTEGER NOT NULL CHECK (requested_scratch_mib >= 0),
  client_ref TEXT,
  scheduling_reason_json TEXT CHECK (scheduling_reason_json IS NULL OR json_valid(scheduling_reason_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  queue_deadline_ms INTEGER NOT NULL CHECK (queue_deadline_ms > created_at_ms),
  provision_deadline_ms INTEGER,
  ready_at_ms INTEGER,
  termination_requested_at_ms INTEGER,
  released_at_ms INTEGER,
  CHECK ((phase IN ('releasing', 'released') AND terminal_reason IS NOT NULL)
      OR (phase NOT IN ('releasing', 'released') AND terminal_reason IS NULL)),
  CHECK (phase <> 'released' OR cleanup_status IN ('not_needed', 'complete')),
  CHECK ((phase = 'released' AND released_at_ms IS NOT NULL)
      OR (phase <> 'released' AND released_at_ms IS NULL)),
  CHECK (phase <> 'ready' OR ready_at_ms IS NOT NULL)
) STRICT;

-- Accepted grants freeze a concrete immutable revision, not a mutable profile.
-- resolved_source_ref and secret_version_ref remain internal to provisioning.
CREATE TABLE ticket_storage_grants (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  storage_profile_revision_id TEXT NOT NULL REFERENCES storage_profile_revisions(id) ON DELETE RESTRICT,
  authorized_subpath TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read_only', 'read_write')),
  grant_revision INTEGER NOT NULL DEFAULT 1 CHECK (grant_revision = 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (ticket_id, mount_path)
) STRICT;

CREATE TABLE resolved_provision_contracts (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  selection_hash TEXT NOT NULL CHECK (length(selection_hash) = 64),
  resolved_at_ms INTEGER NOT NULL CHECK (resolved_at_ms >= 0),
  network_profile_revision_id TEXT NOT NULL REFERENCES network_profile_revisions(id) ON DELETE RESTRICT,
  platform_deny_revision_id TEXT NOT NULL REFERENCES platform_network_deny_revisions(id) ON DELETE RESTRICT,
  contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
  storage_bindings_json TEXT NOT NULL CHECK (json_valid(storage_bindings_json)),
  network_binding_json TEXT NOT NULL CHECK (json_valid(network_binding_json)),
  UNIQUE (id, node_id)
) STRICT;

-- v1: exactly one tenant environment at most for a Ticket, including history.
-- Do not delete old Allocation rows to bypass this invariant. Infrastructure
-- allocations have no Ticket and are reusable platform-owned base VMs.
CREATE TABLE allocations (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('tenant', 'infrastructure', 'validation')),
  ticket_id TEXT UNIQUE REFERENCES tickets(id) ON DELETE RESTRICT,
  image_validation_id TEXT UNIQUE REFERENCES image_validations(id) ON DELETE RESTRICT,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL,
  runtime_identity_id TEXT NOT NULL REFERENCES runtime_identities(id) ON DELETE RESTRICT,
  -- Reservation may wake an offline node before it can inspect source paths.
  -- Set exactly once after live verification, before the first tenant create.
  resolved_provision_contract_id TEXT REFERENCES resolved_provision_contracts(id) ON DELETE RESTRICT,
  image_artifact_id TEXT NOT NULL REFERENCES image_artifacts(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  -- New desired control intents increment this. Observations only increment
  -- entity version, and renewals additionally CAS leases.version.
  control_version INTEGER NOT NULL DEFAULT 1 CHECK (control_version > 0),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'stopped', 'absent')),
  observed_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (observed_state IN ('unknown', 'absent', 'creating', 'running', 'stopped', 'error')),
  cleanup_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_status IN ('pending', 'running', 'blocked', 'complete')),
  actual_resources_json TEXT CHECK (actual_resources_json IS NULL OR json_valid(actual_resources_json)),
  -- Infrastructure has no Ticket: its accepted resource contract is explicit.
  resource_contract_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(resource_contract_json)),
  manifest_id TEXT UNIQUE,
  manifest_revision INTEGER NOT NULL DEFAULT 0 CHECK (manifest_revision >= 0),
  manifest_complete INTEGER NOT NULL DEFAULT 0 CHECK (manifest_complete IN (0, 1)),
  ownership_json TEXT NOT NULL CHECK (json_valid(ownership_json)),
  access_secret_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  UNIQUE (id, machine_id),
  UNIQUE (id, node_id),
  UNIQUE (id, generation),
  UNIQUE (id, ticket_id),
  UNIQUE (id, runtime_identity_id),
  FOREIGN KEY (node_id, machine_id) REFERENCES nodes(id, machine_id) ON DELETE RESTRICT,
  FOREIGN KEY (node_id, runtime_identity_id) REFERENCES nodes(id, runtime_identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_provision_contract_id, node_id)
    REFERENCES resolved_provision_contracts(id, node_id) ON DELETE RESTRICT,
  FOREIGN KEY (image_validation_id, image_artifact_id, node_id)
    REFERENCES image_validations(id, image_artifact_id, node_id) ON DELETE RESTRICT,
  CHECK ((purpose = 'tenant' AND ticket_id IS NOT NULL AND image_validation_id IS NULL)
      OR (purpose = 'infrastructure' AND ticket_id IS NULL AND image_validation_id IS NULL)
      OR (purpose = 'validation' AND ticket_id IS NULL AND image_validation_id IS NOT NULL)),
  CHECK (manifest_complete = 0 OR manifest_id IS NOT NULL),
  CHECK (cleanup_status <> 'complete' OR (desired_state = 'absent' AND observed_state = 'absent'))
) STRICT;

-- reserved/committed/quarantined all consume capacity. Only released does not.
-- SQL does not enforce SUM(claims) <= pool capacity: reserve and release must
-- run in BEGIN IMMEDIATE with a re-read of all pools/quotas and version CAS.
-- Subpool claims must never be charged to the Machine root for a second time.
CREATE TABLE capacity_claims (
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL REFERENCES allocations(id) ON DELETE RESTRICT,
  pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE RESTRICT,
  component TEXT NOT NULL DEFAULT 'combined' CHECK (component IN ('combined', 'runtime', 'storage')),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'quarantined', 'released')),
  cpu_millis INTEGER NOT NULL CHECK (cpu_millis >= 0),
  memory_mib INTEGER NOT NULL CHECK (memory_mib >= 0),
  scratch_mib INTEGER NOT NULL CHECK (scratch_mib >= 0),
  release_evidence_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  released_at_ms INTEGER,
  CHECK (component <> 'runtime' OR scratch_mib = 0),
  CHECK (component <> 'storage' OR (cpu_millis = 0 AND memory_mib = 0)),
  CHECK ((state = 'released' AND released_at_ms IS NOT NULL)
      OR (state <> 'released' AND released_at_ms IS NULL))
) STRICT;

-- Tenant allocations use one combined Claim. Infrastructure base VMs use
-- runtime + storage Claims: stopping the VM releases only runtime; its disk
-- remains committed. Starting creates a new runtime Claim after rechecking
-- root capacity. Released Claims remain immutable historical evidence.
CREATE UNIQUE INDEX claims_one_live_component
  ON capacity_claims(allocation_id, pool_id, component) WHERE state <> 'released';

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE RESTRICT,
  allocation_id TEXT NOT NULL UNIQUE REFERENCES allocations(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoking', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
  starts_at_ms INTEGER,
  last_renewed_at_ms INTEGER,
  claim_by_ms INTEGER,
  claimed_at_ms INTEGER,
  expires_at_ms INTEGER,
  renew_until_ms INTEGER,
  revoked_at_ms INTEGER,
  FOREIGN KEY (allocation_id, generation) REFERENCES allocations(id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_id, ticket_id) REFERENCES allocations(id, ticket_id) ON DELETE RESTRICT,
  CHECK (state <> 'active' OR (claim_by_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND renew_until_ms IS NOT NULL)),
  CHECK (expires_at_ms IS NULL OR renew_until_ms IS NULL OR expires_at_ms <= renew_until_ms),
  CHECK ((state = 'revoked' AND revoked_at_ms IS NOT NULL)
      OR (state <> 'revoked' AND revoked_at_ms IS NULL))
) STRICT;

CREATE TABLE managed_resources (
  -- Hitchlet entity UUID; the backend's opaque identifier belongs in provider_id.
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL REFERENCES allocations(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  parent_resource_id TEXT REFERENCES managed_resources(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('container', 'vm', 'disk', 'volume', 'network', 'network_policy', 'secret', 'workspace', 'endpoint', 'other')),
  provider_id TEXT,
  ownership TEXT NOT NULL CHECK (ownership IN ('owned', 'reference')),
  ownership_json TEXT NOT NULL CHECK (json_valid(ownership_json)),
  cleanup_policy TEXT NOT NULL CHECK (cleanup_policy IN ('destroy', 'retain_until', 'keep')),
  retention_until_ms INTEGER,
  observed_state TEXT NOT NULL DEFAULT 'unknown' CHECK (observed_state IN ('planned', 'present', 'absent', 'unknown', 'error')),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  FOREIGN KEY (allocation_id, node_id) REFERENCES allocations(id, node_id) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_id, generation) REFERENCES allocations(id, generation) ON DELETE RESTRICT,
  CHECK (ownership <> 'reference' OR cleanup_policy = 'keep'),
  CHECK (cleanup_policy <> 'retain_until' OR retention_until_ms IS NOT NULL),
  CHECK (parent_resource_id IS NULL OR parent_resource_id <> id)
) STRICT;

CREATE UNIQUE INDEX managed_resources_provider_identity
  ON managed_resources(node_id, kind, provider_id)
  WHERE provider_id IS NOT NULL AND ownership = 'owned';

-- kind is validated against the application allowlist, never a shell snippet.
-- One target column is set. Allocation operations fence on generation;
-- Machine operations fence on machine_epoch; all fence on controller_epoch.
-- dedup_key includes the stable target/kind/step and control_version (or the
-- Machine power-plan epoch). Do not omit the control cycle for reusable base
-- VMs, and do not change the dedup key merely because the controller restarted.
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  installation_id TEXT REFERENCES installations(installation_id) ON DELETE RESTRICT,
  allocation_id TEXT REFERENCES allocations(id) ON DELETE RESTRICT,
  machine_id TEXT REFERENCES machines(id) ON DELETE RESTRICT,
  node_id TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  image_artifact_id TEXT REFERENCES image_artifacts(id) ON DELETE RESTRICT,
  runtime_identity_id TEXT REFERENCES runtime_identities(id) ON DELETE RESTRICT,
  connection_revision_id TEXT REFERENCES provider_connection_revisions(id) ON DELETE RESTRICT,
  generation INTEGER CHECK (generation IS NULL OR generation > 0),
  control_version INTEGER CHECK (control_version IS NULL OR control_version > 0),
  machine_epoch INTEGER CHECK (machine_epoch IS NULL OR machine_epoch > 0),
  controller_epoch INTEGER NOT NULL CHECK (controller_epoch > 0),
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  step_key TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'running', 'succeeded', 'failed', 'unknown', 'cancelled')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  owner_token TEXT,
  locked_until_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  next_check_at_ms INTEGER NOT NULL CHECK (next_check_at_ms >= 0),
  deadline_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (allocation_id, generation) REFERENCES allocations(id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_id, runtime_identity_id) REFERENCES allocations(id, runtime_identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (node_id, runtime_identity_id) REFERENCES nodes(id, runtime_identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_revision_id, runtime_identity_id)
    REFERENCES provider_connection_revisions(id, verified_runtime_identity_id) ON DELETE RESTRICT,
  CHECK ((connection_revision_id IS NULL AND runtime_identity_id IS NULL)
      OR (connection_revision_id IS NOT NULL AND runtime_identity_id IS NOT NULL)),
  CHECK ((installation_id IS NOT NULL) + (allocation_id IS NOT NULL)
       + (machine_id IS NOT NULL) + (node_id IS NOT NULL) = 1),
  CHECK (allocation_id IS NULL OR generation IS NOT NULL),
  CHECK (allocation_id IS NULL OR control_version IS NOT NULL),
  CHECK (machine_id IS NULL OR machine_epoch IS NOT NULL),
  CHECK ((owner_token IS NULL AND locked_until_ms IS NULL)
      OR (owner_token IS NOT NULL AND locked_until_ms IS NOT NULL))
) STRICT;

-- Installation-wide backup/pause operations have no Machine/Node/Allocation.
-- step_key includes the stable logical request/cycle ID, not a constant such
-- as "backup"; recovery reuses it while a later new request chooses a new one.
CREATE UNIQUE INDEX operations_installation_step
  ON operations(installation_id, kind, step_key) WHERE installation_id IS NOT NULL;

-- A pending proposal does not extend Lease.expires_at_ms. Final acknowledgement
-- rechecks Lease CAS, Ticket state and claim_by_ms in one short transaction.
CREATE TABLE lease_renewals (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  proposed_version INTEGER NOT NULL CHECK (proposed_version = expected_version + 1),
  proposed_expires_at_ms INTEGER NOT NULL CHECK (proposed_expires_at_ms > 0),
  is_initial_claim INTEGER NOT NULL CHECK (is_initial_claim IN (0, 1)),
  decision_deadline_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  confirmed_receipt_json TEXT CHECK (confirmed_receipt_json IS NULL OR json_valid(confirmed_receipt_json)),
  rejection_json TEXT CHECK (rejection_json IS NULL OR json_valid(rejection_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (decision_deadline_ms > created_at_ms),
  CHECK ((state = 'confirmed' AND confirmed_receipt_json IS NOT NULL)
      OR (state <> 'confirmed' AND confirmed_receipt_json IS NULL)),
  CHECK ((state IN ('pending', 'confirmed') AND rejection_json IS NULL)
      OR (state IN ('rejected', 'cancelled') AND rejection_json IS NOT NULL
          AND json_type(rejection_json, '$.code') IS 'text'
          AND length(json_extract(rejection_json, '$.code')) > 0))
) STRICT;

CREATE UNIQUE INDEX lease_renewals_one_pending ON lease_renewals(lease_id) WHERE state = 'pending';

-- Permanent revocation overlays immutable profile history. Admission, renew,
-- access and queued placement check this table; the Operation terminates all
-- affected live grants using the same controlled cleanup flow as admin revoke.
CREATE TABLE profile_grant_revocations (
  id TEXT PRIMARY KEY,
  storage_profile_revision_id TEXT UNIQUE REFERENCES storage_profile_revisions(id) ON DELETE RESTRICT,
  network_profile_revision_id TEXT UNIQUE REFERENCES network_profile_revisions(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  created_by_consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK ((storage_profile_revision_id IS NOT NULL) + (network_profile_revision_id IS NOT NULL) = 1)
) STRICT;

CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'maintenance', 'unmanaged_work', 'infrastructure', 'recovery')),
  reason TEXT NOT NULL,
  created_by_consumer_id TEXT REFERENCES consumers(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms > created_at_ms),
  released_at_ms INTEGER
) STRICT;

CREATE TABLE idempotency_keys (
  consumer_id TEXT NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  route_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  renewal_id TEXT REFERENCES lease_renewals(id) ON DELETE RESTRICT,
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  safe_response_json TEXT CHECK (safe_response_json IS NULL OR json_valid(safe_response_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  retain_until_ms INTEGER NOT NULL CHECK (retain_until_ms > created_at_ms),
  PRIMARY KEY (consumer_id, route_scope, idempotency_key)
) STRICT;

CREATE TABLE agent_commands (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  controller_epoch INTEGER NOT NULL CHECK (controller_epoch > 0),
  machine_epoch INTEGER NOT NULL CHECK (machine_epoch > 0),
  generation INTEGER CHECK (generation IS NULL OR generation > 0),
  control_version INTEGER CHECK (control_version IS NULL OR control_version > 0),
  lease_version INTEGER CHECK (lease_version IS NULL OR lease_version > 0),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'acknowledged', 'completed', 'expired', 'cancelled', 'unknown')),
  not_after_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (agent_id, sequence),
  UNIQUE (id, agent_id),
  CHECK (not_after_ms > created_at_ms)
) STRICT;

CREATE TABLE agent_receipts (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_boot_id TEXT NOT NULL,
  receipt_sequence INTEGER NOT NULL CHECK (receipt_sequence >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('accepted', 'running', 'succeeded', 'failed', 'rejected')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  control_version INTEGER CHECK (control_version IS NULL OR control_version > 0),
  lease_version INTEGER CHECK (lease_version IS NULL OR lease_version > 0),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  UNIQUE (command_id, receipt_sequence),
  FOREIGN KEY (command_id, agent_id) REFERENCES agent_commands(id, agent_id) ON DELETE RESTRICT
) STRICT;

-- AUTOINCREMENT preserves monotonic SSE cursors after retention deletion.
-- Payloads are redacted domain events, not secrets or raw provider output.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  event_type TEXT NOT NULL,
  consumer_id TEXT REFERENCES consumers(id) ON DELETE RESTRICT,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE TABLE audit_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('consumer', 'agent', 'controller')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  safe_details_json TEXT NOT NULL CHECK (json_valid(safe_details_json))
) STRICT;

CREATE INDEX credentials_by_consumer ON consumer_credentials(consumer_id);
CREATE INDEX gui_sessions_by_consumer ON gui_sessions(consumer_id, revoked_at_ms, expires_at_ms);
CREATE INDEX nodes_by_machine ON nodes(machine_id, admission);
CREATE INDEX nodes_by_pool ON nodes(pool_id);
CREATE INDEX validations_by_artifact ON image_validations(image_artifact_id, state, created_at_ms);
CREATE INDEX tickets_queue ON tickets(phase, queue_deadline_ms, created_at_ms);
CREATE INDEX tickets_by_consumer ON tickets(consumer_id, phase, created_at_ms);
CREATE INDEX allocations_by_node ON allocations(node_id, cleanup_status);
CREATE INDEX allocations_by_machine ON allocations(machine_id, cleanup_status);
CREATE INDEX claims_by_pool ON capacity_claims(pool_id, state);
CREATE INDEX leases_due ON leases(state, expires_at_ms);
CREATE INDEX leases_unclaimed ON leases(state, claim_by_ms) WHERE claimed_at_ms IS NULL;
CREATE INDEX resources_by_allocation ON managed_resources(allocation_id, observed_state);
CREATE INDEX operations_runnable ON operations(state, next_check_at_ms);
CREATE INDEX operations_by_allocation ON operations(allocation_id, state);
CREATE INDEX renewals_due ON lease_renewals(state, decision_deadline_ms);
CREATE INDEX holds_active ON holds(machine_id, released_at_ms, expires_at_ms);
CREATE INDEX commands_pending ON agent_commands(agent_id, state, sequence);
CREATE INDEX events_by_aggregate ON events(aggregate_type, aggregate_id, id);
CREATE INDEX events_by_consumer ON events(consumer_id, id);
CREATE INDEX audit_by_target ON audit_entries(target_type, target_id, id);

-- Revision rows are append-only. Updating a logical profile's current pointer
-- affects NEW requests only; existing grants/contracts retain their revision.
CREATE TRIGGER runtime_identity_no_update BEFORE UPDATE ON runtime_identities
BEGIN SELECT RAISE(ABORT, 'runtime identity is immutable'); END;
CREATE TRIGGER runtime_identity_no_delete BEFORE DELETE ON runtime_identities
BEGIN SELECT RAISE(ABORT, 'runtime identity is immutable'); END;
CREATE TRIGGER connection_identity_no_update BEFORE UPDATE OF runtime_identity_id, backend_kind ON provider_connections
WHEN NEW.runtime_identity_id IS NOT OLD.runtime_identity_id OR NEW.backend_kind IS NOT OLD.backend_kind
BEGIN SELECT RAISE(ABORT, 'connection runtime identity is immutable'); END;
CREATE TRIGGER connection_revision_no_update BEFORE UPDATE ON provider_connection_revisions
BEGIN SELECT RAISE(ABORT, 'connection revision is immutable'); END;
CREATE TRIGGER connection_revision_no_delete BEFORE DELETE ON provider_connection_revisions
BEGIN SELECT RAISE(ABORT, 'connection revision is immutable'); END;
CREATE TRIGGER node_runtime_no_update BEFORE UPDATE OF runtime_identity_id ON nodes
WHEN NEW.runtime_identity_id IS NOT OLD.runtime_identity_id
BEGIN SELECT RAISE(ABORT, 'node runtime identity is immutable'); END;
CREATE TRIGGER allocation_identity_no_update BEFORE UPDATE OF purpose, ticket_id, image_validation_id, node_id, machine_id,
  runtime_identity_id, image_artifact_id, generation ON allocations
WHEN NEW.purpose IS NOT OLD.purpose OR NEW.ticket_id IS NOT OLD.ticket_id
  OR NEW.image_validation_id IS NOT OLD.image_validation_id OR NEW.node_id IS NOT OLD.node_id
  OR NEW.machine_id IS NOT OLD.machine_id OR NEW.runtime_identity_id IS NOT OLD.runtime_identity_id
  OR NEW.image_artifact_id IS NOT OLD.image_artifact_id OR NEW.generation IS NOT OLD.generation
BEGIN SELECT RAISE(ABORT, 'allocation identity and accepted contract are immutable'); END;
CREATE TRIGGER allocation_contract_write_once BEFORE UPDATE OF resolved_provision_contract_id ON allocations
WHEN OLD.resolved_provision_contract_id IS NOT NULL
 AND NEW.resolved_provision_contract_id IS NOT OLD.resolved_provision_contract_id
BEGIN SELECT RAISE(ABORT, 'resolved provision binding is write-once'); END;
CREATE TRIGGER operation_connection_no_update BEFORE UPDATE OF runtime_identity_id, connection_revision_id ON operations
WHEN NEW.runtime_identity_id IS NOT OLD.runtime_identity_id OR NEW.connection_revision_id IS NOT OLD.connection_revision_id
BEGIN SELECT RAISE(ABORT, 'operation connection binding is immutable'); END;
CREATE TRIGGER storage_revision_no_update BEFORE UPDATE ON storage_profile_revisions
BEGIN SELECT RAISE(ABORT, 'storage revision is immutable'); END;
CREATE TRIGGER storage_revision_no_delete BEFORE DELETE ON storage_profile_revisions
BEGIN SELECT RAISE(ABORT, 'storage revision is immutable'); END;
CREATE TRIGGER network_revision_no_update BEFORE UPDATE ON network_profile_revisions
BEGIN SELECT RAISE(ABORT, 'network revision is immutable'); END;
CREATE TRIGGER network_revision_no_delete BEFORE DELETE ON network_profile_revisions
BEGIN SELECT RAISE(ABORT, 'network revision is immutable'); END;
CREATE TRIGGER platform_deny_revision_no_update BEFORE UPDATE ON platform_network_deny_revisions
BEGIN SELECT RAISE(ABORT, 'platform deny revision is immutable'); END;
CREATE TRIGGER platform_deny_revision_no_delete BEFORE DELETE ON platform_network_deny_revisions
BEGIN SELECT RAISE(ABORT, 'platform deny revision is immutable'); END;
CREATE TRIGGER provision_contract_no_update BEFORE UPDATE ON resolved_provision_contracts
BEGIN SELECT RAISE(ABORT, 'resolved provision contract is immutable'); END;
CREATE TRIGGER provision_contract_no_delete BEFORE DELETE ON resolved_provision_contracts
WHEN EXISTS (SELECT 1 FROM allocations WHERE resolved_provision_contract_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'referenced provision contract cannot be purged'); END;
CREATE TRIGGER storage_grant_no_update BEFORE UPDATE ON ticket_storage_grants
BEGIN SELECT RAISE(ABORT, 'accepted storage grant is immutable'); END;
CREATE TRIGGER storage_grant_no_delete BEFORE DELETE ON ticket_storage_grants
WHEN EXISTS (SELECT 1 FROM tickets WHERE id=OLD.ticket_id AND phase<>'released')
BEGIN SELECT RAISE(ABORT, 'active storage grant cannot be purged'); END;
CREATE TRIGGER profile_revocation_no_update BEFORE UPDATE ON profile_grant_revocations
BEGIN SELECT RAISE(ABORT, 'profile revocation is immutable'); END;
CREATE TRIGGER profile_revocation_no_delete BEFORE DELETE ON profile_grant_revocations
BEGIN SELECT RAISE(ABORT, 'profile revocation is immutable'); END;
CREATE TRIGGER ticket_network_no_update BEFORE UPDATE OF network_profile_revision_id ON tickets
WHEN NEW.network_profile_revision_id IS NOT OLD.network_profile_revision_id
BEGIN SELECT RAISE(ABORT, 'accepted network revision is immutable'); END;
CREATE TRIGGER ticket_contract_no_update BEFORE UPDATE OF accepted_contract_json ON tickets
WHEN NEW.accepted_contract_json IS NOT OLD.accepted_contract_json
BEGIN SELECT RAISE(ABORT, 'accepted provision selection is immutable'); END;
CREATE TRIGGER ticket_request_no_update BEFORE UPDATE OF consumer_id, image_version_id, request_json,
  request_hash, requested_cpu_millis, requested_memory_mib, requested_scratch_mib ON tickets
WHEN NEW.consumer_id IS NOT OLD.consumer_id OR NEW.image_version_id IS NOT OLD.image_version_id
  OR NEW.request_json IS NOT OLD.request_json OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.requested_cpu_millis IS NOT OLD.requested_cpu_millis
  OR NEW.requested_memory_mib IS NOT OLD.requested_memory_mib
  OR NEW.requested_scratch_mib IS NOT OLD.requested_scratch_mib
BEGIN SELECT RAISE(ABORT, 'accepted ticket request is immutable'); END;
CREATE TRIGGER validation_contract_no_update BEFORE UPDATE OF accepted_contract_json ON image_validations
WHEN NEW.accepted_contract_json IS NOT OLD.accepted_contract_json
BEGIN SELECT RAISE(ABORT, 'accepted validation selection is immutable'); END;
CREATE TRIGGER renewal_final_no_update BEFORE UPDATE ON lease_renewals
WHEN OLD.state IN ('confirmed', 'rejected', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'final renewal decision is immutable'); END;
CREATE TRIGGER machine_snapshot_requires_host_insert BEFORE INSERT ON machine_snapshots
WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.agent_id AND kind='host' AND machine_id=NEW.machine_id)
BEGIN SELECT RAISE(ABORT, 'physical snapshot requires host agent'); END;
CREATE TRIGGER machine_snapshot_requires_host_update BEFORE UPDATE OF agent_id, machine_id ON machine_snapshots
WHEN NOT EXISTS (SELECT 1 FROM agents WHERE id=NEW.agent_id AND kind='host' AND machine_id=NEW.machine_id)
BEGIN SELECT RAISE(ABORT, 'physical snapshot requires host agent'); END;
CREATE TRIGGER child_pool_requires_infrastructure_insert BEFORE INSERT ON capacity_pools
WHEN NEW.parent_allocation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM allocations a JOIN image_artifacts i ON i.id = a.image_artifact_id
  WHERE a.id = NEW.parent_allocation_id AND a.purpose = 'infrastructure' AND i.environment_kind = 'vm')
BEGIN SELECT RAISE(ABORT, 'child pool requires infrastructure VM'); END;
CREATE TRIGGER child_pool_requires_infrastructure_update BEFORE UPDATE OF parent_allocation_id ON capacity_pools
WHEN NEW.parent_allocation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM allocations a JOIN image_artifacts i ON i.id = a.image_artifact_id
  WHERE a.id = NEW.parent_allocation_id AND a.purpose = 'infrastructure' AND i.environment_kind = 'vm')
BEGIN SELECT RAISE(ABORT, 'child pool requires infrastructure VM'); END;

-- Keep this full snapshot aligned with runtime migration 003.
CREATE TRIGGER allocation_operation_intent_no_update BEFORE UPDATE OF intent_json ON operations
WHEN OLD.kind IN ('allocation.provision','allocation.cleanup') AND NEW.intent_json IS NOT OLD.intent_json
BEGIN SELECT RAISE(ABORT, 'allocation operation intent is immutable'); END;

CREATE TRIGGER validation_tested_evidence_no_update BEFORE UPDATE OF checks_json ON image_validations
WHEN json_type(OLD.checks_json,'$.testedEvidence') IS NOT NULL
 AND json_extract(NEW.checks_json,'$.testedEvidence') IS NOT json_extract(OLD.checks_json,'$.testedEvidence')
BEGIN SELECT RAISE(ABORT, 'tested validation evidence is immutable'); END;

CREATE TRIGGER validation_report_no_update BEFORE UPDATE ON image_validations
WHEN OLD.state IN ('succeeded','failed','cancelled') AND
 (NEW.state IS NOT OLD.state OR NEW.test_outcome IS NOT OLD.test_outcome
  OR NEW.cleanup_status IS NOT OLD.cleanup_status OR NEW.report_id IS NOT OLD.report_id
  OR NEW.evidence_expires_at_ms IS NOT OLD.evidence_expires_at_ms
  OR NEW.finished_at_ms IS NOT OLD.finished_at_ms OR NEW.checks_json IS NOT OLD.checks_json
  OR NEW.scope_json IS NOT OLD.scope_json)
BEGIN SELECT RAISE(ABORT, 'completed validation report is immutable'); END;

INSERT INTO schema_migrations(version, description, applied_at_ms)
VALUES (1, 'Independent resource service v1.3 starting schema', CAST(unixepoch('now') AS INTEGER) * 1000);
INSERT INTO schema_migrations(version, description, applied_at_ms)
VALUES (2, 'Bind browser sessions to issuing credentials', CAST(unixepoch('now') AS INTEGER) * 1000);
INSERT INTO schema_migrations(version, description, applied_at_ms)
VALUES (3, 'Protect tested image evidence and completed validation reports', CAST(unixepoch('now') AS INTEGER) * 1000);
INSERT INTO schema_migrations(version, description, applied_at_ms)
VALUES (4, 'Separate managed resource entity UUIDs from native Provider identities', CAST(unixepoch('now') AS INTEGER) * 1000);

COMMIT;

-- Required APPLICATION invariants (not established by successful DDL alone):
-- 1. Serial reservation rechecks pooled SUM(active claims), consumer quotas,
--    image/contract compatibility, admission, policy versions and observations.
--    Every Claim must refer to the pool of its Allocation's Node. Shared
--    resource references may repeat; owned provider identities may not.
-- 2. Root/child pools form an acyclic graph; a child pool is owned only by an
--    infrastructure VM. Its capacity cannot exceed the parent reservation.
--    A base VM cannot stop while its child nodes have claims/unknown resources.
-- 3. State transitions, terminal-reason immutability, readiness probes, lease
--    expiry/renewal CAS and generation/epoch fencing use domain services.
--    Allocation generation identifies an immutable allocation identity;
--    control_version fences desired intents; version tracks all entity writes;
--    Lease.version independently fences accepted renewals. They are not aliases.
--    Strict offline renewal proposals live in lease_renewals and the Operation
--    until the executing Agent acknowledges; never publish an unacknowledged
--    expiry. First proposal AND acknowledgement require now < claim_by_ms if
--    claimed_at_ms is NULL; sweeper latency does not extend the claim deadline.
-- 4. 'released' requires all owned resources absent, retained data expired,
--    access revoked, operations resolved and claims released. This cross-table
--    proof is checked within the same transaction that finishes the Ticket.
-- 5. External create/delete and DB commit are not one transaction. Persist
--    intent first; after uncertain outcomes inspect before any replay.
-- 6. Digest/schema checks, path allowlists, secret redaction and authorization
--    need runtime validation. json_valid() checks syntax, not JSON semantics.
-- 7. Updates use version CAS. Event insertion shares the domain transaction.
--    Published artifacts and completed audit/history rows are immutable via API.
-- 8. Human sessions, stale/partial probes and unresolved actions veto automatic
--    shutdown. An idle CPU or expired Lease does not prove physical release.
-- 9. Runtime identity mismatch is UNKNOWN, never resource ABSENT. Every remote
--    observation checks immutable identity before interpreting missing IDs.
--    Create/inspect/destroy operations bind a validated connection revision.
-- 10. Validation allocations reserve ordinary capacity but never get a Lease.
--     A validation run cannot succeed until its allocation/manifests/claims are
--     fully cleaned. CHECK(cleanup_status) alone is not that cross-table proof.
-- 11. Admin revoke atomically sets termination reason, advances control_version,
--     revokes the Lease, cancels pending renewals, and enqueues cleanup + audit.
-- 12. off_expected is controller-owned evidence of accepted normal shutdown,
--     not an observed power fact. WOL after its guard requires the same cycle,
--     no contradictory fresh observation and a validated wake capability.
--     Smart-plug fault recovery is a separate machine Operation. Its exact
--     binding, off readback, restore-not-before time and restore-on obligation
--     survive Ticket cancellation and controller restart. Normal idle shutdown
--     never upgrades to forced AC removal. Claims remain occupied until proof.
-- 13. RuntimeAgent installs/verifies network policy from frozen profile+platform
--     baseline before starting tenant code. Policy rules remain managed owned
--     resources until teardown; inability to verify is a fail-closed barrier.
--     New platform deny revisions are applied as a restrictive union to ALL
--     active policies; record the verified revision in managed_resources JSON.
--     Failure to verify stops/isolates the environment and retains its Claims.
