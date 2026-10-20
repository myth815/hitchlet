-- The single maintenance row is admission/control state, not a second resource ledger.
BEGIN IMMEDIATE;
CREATE TABLE system_maintenance (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
 disk_state TEXT NOT NULL DEFAULT 'healthy' CHECK(disk_state IN('healthy','low','full','unknown')),
 disk_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(disk_json)),
 runtime_disks_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(runtime_disks_json)),
 transports_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(transports_json)),
 recovery_json TEXT CHECK(recovery_json IS NULL OR json_valid(recovery_json)),
 reason TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1,
 updated_at_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO system_maintenance(singleton) VALUES(1);
-- Database-side gates close the read/write race for all allocation purposes.
-- Termination, lease continuation, reconciliation and cleanup are deliberately ungated.
CREATE TRIGGER ticket_maintenance_gate BEFORE INSERT ON tickets
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE paused=1 OR disk_state<>'healthy' OR recovery_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'new admission is paused'); END;
CREATE TRIGGER allocation_maintenance_gate BEFORE INSERT ON allocations
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE paused=1 OR disk_state<>'healthy' OR recovery_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'new allocation is paused'); END;
CREATE TRIGGER allocation_runtime_disk_gate BEFORE INSERT ON allocations
WHEN EXISTS(SELECT 1 FROM nodes n WHERE n.id=NEW.node_id AND json_extract(n.config_json,'$.executionMode')='portainer')
AND NOT EXISTS(SELECT 1 FROM system_maintenance s,json_each(s.runtime_disks_json) d WHERE d.key=NEW.node_id AND json_extract(d.value,'$.state')='healthy' AND json_extract(d.value,'$.observedAtMs')<=NEW.created_at_ms AND json_extract(d.value,'$.observedAtMs')+30000>=NEW.created_at_ms AND json_extract(d.value,'$.availableMiB')-json_extract(d.value,'$.reserveMiB')>=json_extract(NEW.resource_contract_json,'$.request.scratchMiB'))
BEGIN SELECT RAISE(ABORT,'runtime storage capacity is unavailable'); END;
CREATE TRIGGER cache_maintenance_gate BEFORE INSERT ON operations
WHEN NEW.kind='image-cache.pull' AND EXISTS(SELECT 1 FROM system_maintenance WHERE paused=1 OR disk_state<>'healthy' OR recovery_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'new prewarm is paused'); END;
INSERT INTO schema_migrations(version,description,applied_at_ms) VALUES(7,'Operational admission and isolated recovery state',unixepoch('now')*1000);
COMMIT;
