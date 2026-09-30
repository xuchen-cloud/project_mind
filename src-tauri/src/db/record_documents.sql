CREATE TABLE IF NOT EXISTS record_document_heads (
  record_key TEXT PRIMARY KEY,
  project_note_id INTEGER UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  workspace_note_id INTEGER UNIQUE REFERENCES workspace_notes(id) ON DELETE CASCADE,
  head_revision INTEGER NOT NULL CHECK(head_revision > 0),
  document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  html TEXT NOT NULL, markdown TEXT NOT NULL, text TEXT NOT NULL,
  body_hash TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  code_language TEXT,
  edit_session_id TEXT, edit_started_at TEXT, checkpoint_due_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((project_note_id IS NULL) != (workspace_note_id IS NULL))
);
CREATE TABLE IF NOT EXISTS record_versions (
  id TEXT PRIMARY KEY CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'),
  record_key TEXT NOT NULL REFERENCES record_document_heads(record_key) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  head_revision INTEGER NOT NULL CHECK(head_revision > 0),
  document_snapshot TEXT NOT NULL CHECK(json_valid(document_snapshot)),
  html TEXT NOT NULL, markdown TEXT NOT NULL, text TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version > 0), code_language TEXT, title_snapshot TEXT,
  body_hash TEXT NOT NULL, origin TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)), operation_id TEXT NOT NULL,
  restored_from_version_id TEXT REFERENCES record_versions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(record_key,version_number)
);
CREATE INDEX IF NOT EXISTS idx_record_versions_key ON record_versions(record_key,version_number DESC);
CREATE INDEX IF NOT EXISTS idx_record_checkpoints_due ON record_document_heads(checkpoint_due_at);
CREATE TABLE IF NOT EXISTS record_version_assets (
  version_id TEXT NOT NULL REFERENCES record_versions(id) ON DELETE CASCADE,
  asset_ref TEXT NOT NULL,
  UNIQUE(version_id,asset_ref)
);
