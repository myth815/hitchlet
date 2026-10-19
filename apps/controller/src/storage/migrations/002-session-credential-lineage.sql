BEGIN EXCLUSIVE;

ALTER TABLE gui_sessions
  ADD COLUMN source_credential_id TEXT REFERENCES consumer_credentials(id) ON DELETE RESTRICT;

INSERT INTO schema_migrations(version, description, applied_at_ms)
VALUES (2, 'Bind browser sessions to issuing credentials', CAST(unixepoch('now') AS INTEGER) * 1000);

COMMIT;
