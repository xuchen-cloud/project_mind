CREATE TABLE record_logical_identities (
 logical_id TEXT PRIMARY KEY CHECK(length(logical_id)=32 AND logical_id NOT GLOB '*[^0-9a-f]*'),
 current_key TEXT NOT NULL UNIQUE REFERENCES record_document_heads(record_key) ON UPDATE CASCADE ON DELETE CASCADE,
 scope_key TEXT NOT NULL,
 record_id INTEGER NOT NULL CHECK(record_id>0)
);
CREATE TABLE record_location_aliases (
 location_key TEXT PRIMARY KEY,
 reference_kind TEXT NOT NULL CHECK(reference_kind IN ('note','workspace_record')),
 record_id INTEGER NOT NULL CHECK(record_id>0),
 logical_id TEXT NOT NULL REFERENCES record_logical_identities(logical_id) ON DELETE CASCADE,
 UNIQUE(reference_kind,record_id)
);
CREATE TABLE record_version_owner_context (
 version_id TEXT PRIMARY KEY REFERENCES record_versions(id) ON DELETE CASCADE,
 original_record_key TEXT NOT NULL
);
INSERT INTO record_version_owner_context SELECT id,record_key FROM record_versions;
CREATE TRIGGER record_version_owner_context_insert AFTER INSERT ON record_versions BEGIN
 INSERT INTO record_version_owner_context VALUES(NEW.id,NEW.record_key);
END;
CREATE TABLE record_owner_move_assets (
 logical_id TEXT NOT NULL REFERENCES record_logical_identities(logical_id) ON DELETE CASCADE,
 asset_ref TEXT NOT NULL,
 origin_scope_key TEXT NOT NULL,
 PRIMARY KEY(logical_id,asset_ref)
);
CREATE TRIGGER record_owner_move_asset_project_delete BEFORE DELETE ON projects
WHEN EXISTS(SELECT 1 FROM record_owner_move_assets a JOIN record_logical_identities i USING(logical_id)
 WHERE a.origin_scope_key='project:'||OLD.id AND i.scope_key!=a.origin_scope_key)
BEGIN SELECT RAISE(ABORT,'Project resources are retained by a moved Record'); END;
CREATE TRIGGER record_owner_move_asset_project_root BEFORE UPDATE OF root_path ON projects
WHEN NEW.root_path!=OLD.root_path AND EXISTS(SELECT 1 FROM record_owner_move_assets a JOIN record_logical_identities i USING(logical_id)
 WHERE a.origin_scope_key='project:'||OLD.id AND i.scope_key!=a.origin_scope_key)
BEGIN SELECT RAISE(ABORT,'Project resources are retained by a moved Record'); END;
