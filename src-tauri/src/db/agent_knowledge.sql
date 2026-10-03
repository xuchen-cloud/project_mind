-- Node snapshots are authority; current and trigram rows are derived pointers/indexes.
CREATE TABLE IF NOT EXISTS agent_knowledge_nodes (
 scope_key TEXT NOT NULL, node_id TEXT NOT NULL, current_revision INTEGER NOT NULL CHECK(current_revision>0),
 kind TEXT NOT NULL CHECK(kind IN ('topic','decision','source_summary')), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
 updated_at TEXT NOT NULL, PRIMARY KEY(scope_key,node_id)
);
CREATE INDEX IF NOT EXISTS agent_knowledge_active_kind ON agent_knowledge_nodes(scope_key,deleted,kind,node_id);
CREATE TABLE IF NOT EXISTS agent_knowledge_versions (
 scope_key TEXT NOT NULL,node_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 overview_revision INTEGER NOT NULL CHECK(overview_revision>0),snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 created_at TEXT NOT NULL,PRIMARY KEY(scope_key,node_id,revision)
);
CREATE INDEX IF NOT EXISTS agent_knowledge_versions_overview ON agent_knowledge_versions(scope_key,overview_revision);
CREATE VIRTUAL TABLE IF NOT EXISTS agent_knowledge_fts USING fts5(
 scope_key UNINDEXED,node_id UNINDEXED,title,aliases,keywords,one_line,tokenize='trigram'
);
