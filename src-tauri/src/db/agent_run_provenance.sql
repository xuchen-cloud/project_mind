CREATE TABLE agent_run_provenance (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE
);
CREATE TABLE agent_run_source_dependencies (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_json TEXT NOT NULL CHECK(json_valid(object_json) AND json_type(object_json)='object'),
  revision TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(run_id,object_key,revision)
);
