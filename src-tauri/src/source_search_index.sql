CREATE TABLE IF NOT EXISTS source_index_snapshots (
 id INTEGER PRIMARY KEY, object_key TEXT NOT NULL, workspace_id TEXT NOT NULL,
 scope_key TEXT NOT NULL, object_json TEXT NOT NULL, revision TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, updated_at TEXT NOT NULL,
 is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
 coverage_json TEXT NOT NULL DEFAULT '{"chars":0,"complete":false}' CHECK(json_valid(coverage_json)),
 UNIQUE(object_key,revision,version)
);
CREATE INDEX IF NOT EXISTS source_index_scope_current ON source_index_snapshots(workspace_id,scope_key,is_current);
CREATE TABLE IF NOT EXISTS source_index_chunks (
 id INTEGER PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES source_index_snapshots(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
 locator_json TEXT NOT NULL, block_id TEXT, UNIQUE(snapshot_id,ordinal)
);
CREATE TABLE IF NOT EXISTS source_access_policies(object_key TEXT PRIMARY KEY, excluded INTEGER NOT NULL CHECK(excluded IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0));
CREATE VIRTUAL TABLE IF NOT EXISTS source_index_fts USING fts5(title,text,content='source_index_chunks',content_rowid='id',tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS source_index_chunks_insert AFTER INSERT ON source_index_chunks BEGIN
 INSERT INTO source_index_fts(rowid,title,text) VALUES (NEW.id,NEW.title,NEW.text);
END;
CREATE TRIGGER IF NOT EXISTS source_index_chunks_delete AFTER DELETE ON source_index_chunks BEGIN
 INSERT INTO source_index_fts(source_index_fts,rowid,title,text) VALUES ('delete',OLD.id,OLD.title,OLD.text);
END;
CREATE TRIGGER IF NOT EXISTS source_index_snapshot_delete AFTER DELETE ON source_index_snapshots BEGIN
 DELETE FROM source_index_chunks WHERE snapshot_id=OLD.id;
END;
