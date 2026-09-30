CREATE TABLE IF NOT EXISTS agent_scope_settings (
  scope_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  goal_record_id INTEGER,
  pinned_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(pinned_refs_json) AND json_type(pinned_refs_json)='array' AND json_array_length(pinned_refs_json)<=5),
  summary_policy TEXT NOT NULL DEFAULT 'on_success' CHECK(summary_policy IN ('on_success','manual')),
  overview_interval_hours INTEGER NOT NULL DEFAULT 24 CHECK(overview_interval_hours IN (24,48)),
  overview_local_time TEXT NOT NULL DEFAULT '03:00', overview_timezone TEXT NOT NULL DEFAULT 'UTC',
  execution_mode TEXT NOT NULL DEFAULT 'collaborate' CHECK(execution_mode IN ('collaborate','review','read_only')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE IF NOT EXISTS agent_context_instructions (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, text TEXT NOT NULL CHECK(length(text)<=2000),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_instructions_scope ON agent_context_instructions(scope_key,updated_at);
CREATE TABLE IF NOT EXISTS agent_source_policies (
  object_key TEXT PRIMARY KEY, excluded INTEGER NOT NULL CHECK(excluded IN (0,1)), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('extract','overview','session_summary','maintenance')),
  scope_key TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3), not_before TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), error TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_queue ON agent_jobs(state,not_before,scope_key);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'), scope_key TEXT NOT NULL,
  title TEXT NOT NULL, runtime_id TEXT NOT NULL, profile_override_id INTEGER,
  state TEXT NOT NULL CHECK(state IN ('active','archived','read_only')),
  session_path TEXT NOT NULL CHECK(session_path = '.project-mind/agent/sessions/' || id || '/session.jsonl'),
  checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_scope ON agent_sessions(scope_key,updated_at DESC);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('preparing','running','cancelling','completed','failed','cancelled','interrupted')),
  context_manifest_json TEXT NOT NULL CHECK(json_valid(context_manifest_json)),
  grant_json TEXT NOT NULL CHECK(json_valid(grant_json)), started_at TEXT NOT NULL, finished_at TEXT,
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)), error_code TEXT,
  UNIQUE(session_id,client_request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_one_active_run ON agent_runs((1)) WHERE state IN ('preparing','running','cancelling');
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id,started_at);
CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL CHECK(seq>0),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)), created_at TEXT NOT NULL, PRIMARY KEY(run_id,seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_time ON agent_run_events(created_at);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE, runtime_entry_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')), content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  state TEXT NOT NULL CHECK(state IN ('partial','complete')), ordinal INTEGER NOT NULL CHECK(ordinal>=0), created_at TEXT NOT NULL,
  UNIQUE(session_id,runtime_entry_id), UNIQUE(session_id,ordinal)
);
CREATE TABLE IF NOT EXISTS agent_outputs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('record','file','todo')), intent TEXT NOT NULL CHECK(intent IN ('create','record_patch','file_update','todo_update')),
  target_ref_json TEXT CHECK(target_ref_json IS NULL OR json_valid(target_ref_json)), base_revision INTEGER, file_expected_hash TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
  state TEXT NOT NULL CHECK(state IN ('staged','committing','committed','failed')),
  object_ref_json TEXT CHECK(object_ref_json IS NULL OR json_valid(object_ref_json)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  UNIQUE(run_id,ordinal)
);
CREATE TABLE IF NOT EXISTS agent_operation_receipts (
  request_id TEXT NOT NULL, caller_id TEXT NOT NULL, payload_hash TEXT NOT NULL, operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('committing','committed','failed')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), error TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(request_id,caller_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_receipts_state ON agent_operation_receipts(state,created_at);
CREATE TABLE IF NOT EXISTS content_reference_edges (
  source_object_key TEXT NOT NULL, target_object_key TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('internal_reference','evidence','derived_from')),
  locator_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(locator_json)), target_revision TEXT,
  PRIMARY KEY(source_object_key,target_object_key,relation,locator_json)
);
CREATE INDEX IF NOT EXISTS idx_agent_edges_target ON content_reference_edges(target_object_key,relation);
CREATE TABLE IF NOT EXISTS agent_evidence (
  id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('message','output','overview')),
  owner_id TEXT NOT NULL, source_ref_json TEXT NOT NULL CHECK(json_valid(source_ref_json)), excerpt TEXT NOT NULL CHECK(length(excerpt)<=2000)
);
CREATE INDEX IF NOT EXISTS idx_agent_evidence_owner ON agent_evidence(owner_kind,owner_id);
CREATE TRIGGER IF NOT EXISTS agent_message_evidence_delete AFTER DELETE ON agent_messages BEGIN
  DELETE FROM agent_evidence WHERE owner_kind='message' AND owner_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS agent_change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, object_key TEXT NOT NULL, scope_key TEXT NOT NULL,
  operation TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_changes_scope ON agent_change_log(scope_key,seq);
CREATE INDEX IF NOT EXISTS idx_agent_changes_time ON agent_change_log(created_at);
CREATE TABLE IF NOT EXISTS agent_connection_grants (
  id TEXT PRIMARY KEY, client_label TEXT NOT NULL, scope_grant_json TEXT NOT NULL CHECK(json_valid(scope_grant_json)),
  operations_json TEXT NOT NULL CHECK(json_valid(operations_json)), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL, revoked_at TEXT
);
