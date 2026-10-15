-- Internal identity catalogue. No application schema-version publication here.
CREATE TABLE IF NOT EXISTS source_registry (
  object_key TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
  last_change_seq INTEGER NOT NULL CHECK(last_change_seq>0),
  event_revision TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS source_dependency_invalidations (
  owner_key TEXT PRIMARY KEY, changed_object_key TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq>0), reason TEXT NOT NULL
    CHECK(reason IN ('source_changed','source_deleted','policy_changed','project_status_changed'))
);
CREATE INDEX IF NOT EXISTS source_registry_changes_object ON agent_change_log(object_key,seq);

-- json_quote escapes arbitrary old log keys before splitting. Legacy keys and
-- configuration changes are ignored, never reinterpreted as source identities.
CREATE VIEW IF NOT EXISTS source_registry_log_objects AS
SELECT seq,object_key,scope_key,revision,operation,created_at,
       json_extract(parts,'$[0]') AS workspace_id
FROM (
  SELECT *, '['||replace(json_quote(object_key),'/', '","')||']' AS parts
  FROM agent_change_log
)
WHERE json_array_length(parts)=4
  AND json_extract(parts,'$[1]')=scope_key
  AND length(json_extract(parts,'$[0]')) BETWEEN 1 AND 128
  AND json_extract(parts,'$[0]') NOT GLOB '*[^A-Za-z0-9_-]*'
  AND (scope_key='workspace' OR (scope_key='project:'||CAST(CAST(substr(scope_key,9) AS INTEGER) AS TEXT)
       AND CAST(substr(scope_key,9) AS INTEGER)>0))
  AND json_extract(parts,'$[2]') IN ('project','record','todo','quick_note','file','transcript','session_message','session_summary')
  AND length(json_extract(parts,'$[3]')) BETWEEN 1 AND 128
  AND json_extract(parts,'$[3]') NOT GLOB '*[^A-Za-z0-9_-]*'
  AND (json_extract(parts,'$[2]') IN ('session_message','session_summary')
       OR (json_extract(parts,'$[3]')=CAST(CAST(json_extract(parts,'$[3]') AS INTEGER) AS TEXT)
           AND CAST(json_extract(parts,'$[3]') AS INTEGER)>0));

CREATE TRIGGER IF NOT EXISTS source_registry_outbox_insert AFTER INSERT ON agent_change_log
WHEN EXISTS(SELECT 1 FROM source_registry_log_objects WHERE seq=NEW.seq)
BEGIN
  INSERT INTO source_registry(object_key,scope_key,last_change_seq,event_revision,deleted_at)
  VALUES(NEW.object_key,NEW.scope_key,NEW.seq,NEW.revision,
         CASE WHEN NEW.revision='deleted' THEN NEW.created_at ELSE NULL END)
  ON CONFLICT(object_key) DO UPDATE SET scope_key=excluded.scope_key,
    last_change_seq=excluded.last_change_seq,event_revision=excluded.event_revision,
    deleted_at=excluded.deleted_at;

  UPDATE agent_jobs SET state='cancelled',error=NULL
  WHERE kind='extract' AND state IN ('queued','running')
    AND dedupe_key='source-index:'||NEW.object_key AND NEW.revision='deleted';

  -- Reuse the existing derived_from graph. Real knowledge modules register
  -- their dependencies here; this maintenance seam invents no knowledge rows.
  -- UNION terminates cycles. Evidence versions, excerpts and edges are retained.
  INSERT INTO source_dependency_invalidations(owner_key,changed_object_key,seq,reason)
  SELECT owner_key,NEW.object_key,NEW.seq,
    CASE WHEN NEW.revision='deleted' THEN 'source_deleted'
         WHEN NEW.operation='source.policy.update' THEN 'policy_changed'
         WHEN NEW.operation='project.archive' THEN 'project_status_changed'
         ELSE 'source_changed' END
  FROM (
    WITH RECURSIVE affected(owner_key) AS (
      SELECT e.source_object_key FROM content_reference_edges e
      WHERE e.relation='derived_from'
        AND (e.target_object_key=NEW.object_key
          OR (NEW.operation='project.archive' AND substr(e.target_object_key,1,
              length((SELECT workspace_id FROM source_registry_log_objects WHERE seq=NEW.seq)||'/'||NEW.scope_key||'/'))=
              (SELECT workspace_id FROM source_registry_log_objects WHERE seq=NEW.seq)||'/'||NEW.scope_key||'/'))
        AND substr(e.source_object_key,1,length((SELECT workspace_id FROM source_registry_log_objects WHERE seq=NEW.seq)||'/'))=
            (SELECT workspace_id FROM source_registry_log_objects WHERE seq=NEW.seq)||'/'
      UNION
      SELECT e.source_object_key FROM content_reference_edges e JOIN affected a ON e.target_object_key=a.owner_key
      WHERE e.relation='derived_from' AND substr(e.source_object_key,1,
          length((SELECT workspace_id FROM source_registry_log_objects WHERE seq=NEW.seq)||'/'))=
          (SELECT workspace_id FROM source_registry_log_objects WHERE seq=NEW.seq)||'/'
    ) SELECT owner_key FROM affected
  ) WHERE 1
  ON CONFLICT(owner_key) DO UPDATE SET changed_object_key=excluded.changed_object_key,
    seq=excluded.seq,reason=excluded.reason;
END;
