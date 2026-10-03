CREATE TABLE IF NOT EXISTS agent_overviews (
 scope_key TEXT PRIMARY KEY, current_revision INTEGER NOT NULL, as_of_seq INTEGER NOT NULL,
 policy_revision INTEGER NOT NULL, correction_revision INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_overview_versions (
 scope_key TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), target_seq INTEGER NOT NULL, policy_revision INTEGER NOT NULL, correction_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(scope_key,revision), UNIQUE(scope_key,target_seq,policy_revision,correction_revision)
);
CREATE TABLE IF NOT EXISTS agent_overview_dependencies (
 scope_key TEXT NOT NULL, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 source_object_key TEXT NOT NULL, source_revision TEXT NOT NULL, source_ref_json TEXT NOT NULL CHECK(json_valid(source_ref_json)),
 PRIMARY KEY(scope_key,item_id,ordinal)
);
CREATE INDEX IF NOT EXISTS agent_overview_dependencies_source ON agent_overview_dependencies(source_object_key);
CREATE TABLE IF NOT EXISTS agent_overview_correction_heads (scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_overview_corrections (
 scope_key TEXT NOT NULL, id TEXT NOT NULL, correction_json TEXT NOT NULL CHECK(json_valid(correction_json)),
 PRIMARY KEY(scope_key,id)
);
CREATE TABLE IF NOT EXISTS agent_overview_correction_versions (
 scope_key TEXT NOT NULL, revision INTEGER NOT NULL, id TEXT NOT NULL, correction_json TEXT NOT NULL CHECK(json_valid(correction_json)),
 PRIMARY KEY(scope_key,revision)
);
