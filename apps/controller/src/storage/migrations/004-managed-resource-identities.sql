BEGIN EXCLUSIVE;
PRAGMA defer_foreign_keys = ON;

-- Native Provider IDs remain in receipts and provider_id. Only the service entity key changes.
CREATE TEMP TABLE managed_resource_id_upgrade(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL UNIQUE);
INSERT INTO managed_resource_id_upgrade(old_id,new_id)
SELECT id,
 lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
 substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))
FROM managed_resources
WHERE NOT (
 length(id)=36 AND substr(id,9,1)='-' AND substr(id,14,1)='-' AND substr(id,19,1)='-' AND substr(id,24,1)='-'
 AND length(replace(id,'-',''))=32 AND replace(id,'-','') NOT GLOB '*[^0-9a-fA-F]*'
 AND substr(id,15,1) IN ('1','2','3','4','5','6','7','8') AND lower(substr(id,20,1)) IN ('8','9','a','b')
);
UPDATE managed_resources SET provider_id=id WHERE provider_id IS NULL;
-- Redirect all child links before replacing parent primary keys; commit validates the complete graph.
UPDATE managed_resources SET parent_resource_id=(SELECT new_id FROM managed_resource_id_upgrade WHERE old_id=parent_resource_id)
WHERE parent_resource_id IN (SELECT old_id FROM managed_resource_id_upgrade);
UPDATE managed_resources SET id=(SELECT new_id FROM managed_resource_id_upgrade WHERE old_id=id)
WHERE id IN (SELECT old_id FROM managed_resource_id_upgrade);
DROP TABLE managed_resource_id_upgrade;
INSERT INTO schema_migrations(version,description,applied_at_ms)
VALUES(4,'Separate managed resource entity UUIDs from native Provider identities',CAST(unixepoch('now') AS INTEGER)*1000);
COMMIT;
