CREATE TABLE IF NOT EXISTS agent_overview_versions (
 scope_key TEXT NOT NULL, revision INTEGER NOT NULL,
 batch_id TEXT NOT NULL CHECK(length(batch_id) BETWEEN 1 AND 128),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), target_seq INTEGER NOT NULL,
 policy_revision INTEGER NOT NULL, correction_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(scope_key,revision), UNIQUE(scope_key,batch_id)
);
