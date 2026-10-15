-- One row per processed projection message, including messages with no searchable text.
-- The FTS table is entirely derived and can be rebuilt from verified projections.
CREATE TABLE IF NOT EXISTS agent_session_search_rows (
  message_id TEXT PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
  text_hash TEXT,
  text TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS agent_session_search_fts USING fts5(
  message_id UNINDEXED, text, tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS agent_session_search_row_delete AFTER DELETE ON agent_session_search_rows BEGIN
  DELETE FROM agent_session_search_fts WHERE message_id=OLD.message_id;
END;
