CREATE TEMP TABLE agent_search_old_rows AS
SELECT i.message_id,m.session_id,m.runtime_entry_id,m.ordinal,m.role,m.created_at,m.run_id,i.text_hash,i.text
FROM agent_session_search_rows i JOIN agent_messages m ON m.id=i.message_id
WHERE m.role IN ('user','assistant') AND i.text IS NOT NULL AND i.text_hash IS NOT NULL;
DROP TRIGGER IF EXISTS agent_session_search_row_delete;
DROP TABLE IF EXISTS agent_session_search_rows;
DROP TABLE IF EXISTS agent_session_search_fts;
CREATE TABLE agent_session_search_rows (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  runtime_entry_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  created_at TEXT NOT NULL,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  text_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  total_chars INTEGER NOT NULL CHECK(total_chars>=0),
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  UNIQUE(session_id,runtime_entry_id)
);
CREATE INDEX agent_session_search_rows_session ON agent_session_search_rows(session_id);
CREATE VIRTUAL TABLE agent_session_search_fts USING fts5(
  message_id UNINDEXED, text, tokenize='trigram'
);
CREATE TRIGGER agent_session_search_row_delete AFTER DELETE ON agent_session_search_rows BEGIN
  DELETE FROM agent_session_search_fts WHERE message_id=OLD.message_id;
END;
CREATE TABLE agent_session_scan_state (
  session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,
  entry_count INTEGER NOT NULL CHECK(entry_count>=0),
  cursor_json TEXT CHECK(cursor_json IS NULL OR json_valid(cursor_json)),
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1))
);

INSERT INTO agent_session_search_rows(message_id,session_id,runtime_entry_id,ordinal,role,created_at,run_id,text_hash,text,total_chars,complete)
SELECT message_id,session_id,runtime_entry_id,ordinal,role,created_at,run_id,text_hash,text,length(text),1 FROM agent_search_old_rows;
INSERT INTO agent_session_search_fts(message_id,text) SELECT message_id,text FROM agent_search_old_rows;
DROP TABLE agent_search_old_rows;
