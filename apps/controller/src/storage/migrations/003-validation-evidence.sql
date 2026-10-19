BEGIN EXCLUSIVE;

-- Allocation execution always resumes its original plan and Runtime Agent target.
CREATE TRIGGER allocation_operation_intent_no_update BEFORE UPDATE OF intent_json ON operations
WHEN OLD.kind IN ('allocation.provision','allocation.cleanup') AND NEW.intent_json IS NOT OLD.intent_json
BEGIN SELECT RAISE(ABORT, 'allocation operation intent is immutable'); END;

-- A successful test is a historical fact even while cleanup is still blocked.
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

INSERT INTO schema_migrations(version,description,applied_at_ms)
VALUES (3,'Protect tested image evidence and completed validation reports',CAST(unixepoch('now') AS INTEGER)*1000);
COMMIT;
