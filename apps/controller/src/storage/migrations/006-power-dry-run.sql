-- D22a reuses JSON management/config and Operations, without a parallel resource ledger.
-- Exact plug identity is installation-wide, including across concurrent administrative writes.
BEGIN IMMEDIATE;
CREATE UNIQUE INDEX machine_plug_binding_id ON machines(json_extract(management_json,'$.smartPlugBinding.id'))
  WHERE json_extract(management_json,'$.smartPlugBinding.id') IS NOT NULL;
CREATE UNIQUE INDEX machine_plug_device_id ON machines(json_extract(management_json,'$.smartPlugBinding.device.deviceId'))
  WHERE json_extract(management_json,'$.smartPlugBinding.device.deviceId') IS NOT NULL;
CREATE UNIQUE INDEX machine_plug_mac ON machines(lower(json_extract(management_json,'$.smartPlugBinding.device.macAddress')))
  WHERE json_extract(management_json,'$.smartPlugBinding.device.macAddress') IS NOT NULL;
-- Dry-run mutex is isolated from allocation workers. Future real power intents share this fence.
CREATE UNIQUE INDEX machine_active_power_intent ON operations(machine_id)
  WHERE machine_id IS NOT NULL AND kind LIKE 'power.%' AND state IN ('planned','running','unknown');
INSERT INTO schema_migrations(version,description,applied_at_ms) VALUES(6,'Isolated power previews and exclusive smart plug identity',unixepoch('now')*1000);
PRAGMA user_version=6;
COMMIT;
