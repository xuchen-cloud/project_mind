-- Every retention policy must pass this storage boundary before removing bytes.
-- No automatic retention policy exists today. Whole File deletion removes the
-- parent first, so its existing explicit/recoverable cascade remains permitted.
CREATE TRIGGER IF NOT EXISTS important_version_retain
BEFORE DELETE ON document_versions
WHEN OLD.is_important=1 AND EXISTS(SELECT 1 FROM documents WHERE id=OLD.document_id)
BEGIN SELECT RAISE(ABORT,'important File Version must be retained'); END;

CREATE TRIGGER IF NOT EXISTS important_version_identity
BEFORE UPDATE OF id,document_id,version_number,created_at ON document_versions
WHEN OLD.is_important=1 AND (NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id
 OR NEW.version_number IS NOT OLD.version_number OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'important File Version identity is immutable'); END;

-- REPLACE can skip DELETE triggers when recursive_triggers is off (SQLite
-- default). Guard INSERT itself, including replacement via the version key.
CREATE TRIGGER IF NOT EXISTS important_version_replace
BEFORE INSERT ON document_versions
WHEN EXISTS(SELECT 1 FROM document_versions WHERE is_important=1
 AND (id=NEW.id OR (document_id=NEW.document_id AND version_number=NEW.version_number)))
BEGIN SELECT RAISE(ABORT,'important File Version cannot be replaced'); END;

CREATE TRIGGER IF NOT EXISTS important_version_hash_retain
BEFORE DELETE ON source_file_version_hashes
WHEN EXISTS(SELECT 1 FROM document_versions WHERE id=OLD.document_version_id AND is_important=1)
BEGIN SELECT RAISE(ABORT,'important File Version hash must be retained'); END;

CREATE TRIGGER IF NOT EXISTS important_version_hash_replace
BEFORE INSERT ON source_file_version_hashes
WHEN EXISTS(SELECT 1 FROM document_versions v JOIN source_file_version_hashes h ON h.document_version_id=v.id
 WHERE v.id=NEW.document_version_id AND v.is_important=1)
BEGIN SELECT RAISE(ABORT,'important File Version hash cannot be replaced'); END;

CREATE TRIGGER IF NOT EXISTS important_version_update_replace
BEFORE UPDATE OF id,document_id,version_number ON document_versions
WHEN EXISTS(SELECT 1 FROM document_versions WHERE is_important=1 AND id!=OLD.id
 AND (id=NEW.id OR (document_id=NEW.document_id AND version_number=NEW.version_number)))
BEGIN SELECT RAISE(ABORT,'important File Version cannot be replaced by an update'); END;
