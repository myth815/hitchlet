BEGIN EXCLUSIVE;
ALTER TABLE agents ADD COLUMN host_identity TEXT;
ALTER TABLE agents ADD COLUMN enrollment_hash TEXT;
ALTER TABLE agents ADD COLUMN enrollment_expires_at_ms INTEGER;
ALTER TABLE agents ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0);
ALTER TABLE agents ADD COLUMN enrollment_consumed INTEGER NOT NULL DEFAULT 0 CHECK(enrollment_consumed IN(0,1));
-- Historical boot identities are retained so an old start request cannot revive an earlier sender.
CREATE TABLE agent_boots (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  boot_id TEXT NOT NULL,
  session_epoch INTEGER NOT NULL CHECK(session_epoch > 0),
  controller_epoch INTEGER NOT NULL CHECK(controller_epoch > 0),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
  PRIMARY KEY(agent_id,boot_id), UNIQUE(agent_id,session_epoch)
) STRICT;
ALTER TABLE machine_snapshots ADD COLUMN heartbeat_json TEXT CHECK(heartbeat_json IS NULL OR json_valid(heartbeat_json));
ALTER TABLE machine_snapshots ADD COLUMN heartbeat_hash TEXT;
ALTER TABLE machine_snapshots ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0);
INSERT INTO schema_migrations(version,description,applied_at_ms)
VALUES(5,'Persist physical Host enrollment, fenced boots and authenticated observations',CAST(unixepoch('now') AS INTEGER)*1000);
COMMIT;
