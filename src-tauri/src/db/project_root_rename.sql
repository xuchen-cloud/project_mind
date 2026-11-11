-- Exact persisted Record references retain their source Project identity while
-- its physical root changes. Neither canonical payloads nor history hashes move.
CREATE TABLE IF NOT EXISTS record_root_asset_locations (
  record_key TEXT NOT NULL REFERENCES record_document_heads(record_key) ON UPDATE CASCADE ON DELETE CASCADE,
  asset_ref TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path_suffix TEXT NOT NULL,
  PRIMARY KEY(record_key,asset_ref)
);
