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

-- Pending is independent of the compactable outbox. Its initial manifest is
-- necessarily incomplete until a real bounded inventory establishes completeness.
CREATE TABLE IF NOT EXISTS agent_overview_pending (
 scope_key TEXT NOT NULL, object_key TEXT NOT NULL, first_seq INTEGER NOT NULL CHECK(first_seq>0),
 last_seq INTEGER NOT NULL CHECK(last_seq>=first_seq), operation TEXT NOT NULL, latest_revision TEXT NOT NULL,
 deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), excluded INTEGER NOT NULL CHECK(excluded IN (0,1)),
 PRIMARY KEY(scope_key,object_key)
);
CREATE INDEX IF NOT EXISTS agent_overview_pending_target ON agent_overview_pending(scope_key,last_seq,object_key);
CREATE TABLE IF NOT EXISTS agent_overview_pending_state (
 scope_key TEXT PRIMARY KEY, needs_rebuild INTEGER NOT NULL DEFAULT 1 CHECK(needs_rebuild IN (0,1))
);
CREATE TABLE IF NOT EXISTS agent_overview_pending_bootstrap (id INTEGER PRIMARY KEY CHECK(id=1));

CREATE TRIGGER IF NOT EXISTS agent_overview_pending_outbox AFTER INSERT ON agent_change_log
WHEN NEW.scope_key LIKE 'project:%' AND EXISTS(SELECT 1 FROM source_registry_log_objects WHERE seq=NEW.seq)
BEGIN
 INSERT INTO agent_overview_pending_state(scope_key,needs_rebuild) VALUES(NEW.scope_key,1) ON CONFLICT(scope_key) DO NOTHING;
 INSERT INTO agent_overview_pending(scope_key,object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded)
 VALUES(NEW.scope_key,NEW.object_key,NEW.seq,NEW.seq,NEW.operation,NEW.revision,
   NEW.revision='deleted',EXISTS(SELECT 1 FROM source_access_policies WHERE object_key=NEW.object_key AND excluded=1))
 ON CONFLICT(scope_key,object_key) DO UPDATE SET last_seq=excluded.last_seq,operation=excluded.operation,
   latest_revision=excluded.latest_revision,
   deleted=CASE WHEN excluded.operation='source.policy.update' THEN agent_overview_pending.deleted ELSE excluded.deleted END,
   excluded=excluded.excluded;
END;

-- Run this seed once only: reopening/preparing must never resurrect acknowledged
-- keys. Registry tombstones survive prior log compaction; policy state is read
-- from its real table instead of inventing an event revision encoding.
INSERT INTO agent_overview_pending_state(scope_key,needs_rebuild)
 SELECT 'project:'||id,1 FROM projects WHERE NOT EXISTS(SELECT 1 FROM agent_overview_pending_bootstrap)
 ON CONFLICT(scope_key) DO NOTHING;
INSERT INTO agent_overview_pending(scope_key,object_key,first_seq,last_seq,operation,latest_revision,deleted,excluded)
 SELECT r.scope_key,r.object_key,r.last_change_seq,r.last_change_seq,
   CASE WHEN r.deleted_at IS NOT NULL THEN 'bootstrap.deleted' ELSE 'bootstrap.inventory_required' END,
   r.event_revision,r.deleted_at IS NOT NULL,
   EXISTS(SELECT 1 FROM source_access_policies p WHERE p.object_key=r.object_key AND p.excluded=1)
 FROM source_registry r
 WHERE r.scope_key LIKE 'project:%' AND NOT EXISTS(SELECT 1 FROM agent_overview_pending_bootstrap)
 ON CONFLICT(scope_key,object_key) DO NOTHING;
INSERT OR IGNORE INTO agent_overview_pending_bootstrap(id) VALUES(1);
