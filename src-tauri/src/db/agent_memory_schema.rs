use super::Database;

pub(super) const AGENT_MEMORY_SCHEMA_VERSION: i64 = 37;

impl Database {
    pub(super) fn ensure_agent_memory_schema(&self) -> anyhow::Result<()> {
        if self.schema_version()? >= AGENT_MEMORY_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn.execute_batch("SAVEPOINT agent_memory_schema")?;
        let result = (|| -> anyhow::Result<()> {
            // SQLite cannot alter the existing kind CHECK. Rebuild only the current pointer;
            // immutable version rows, FTS and evidence remain untouched.
            self.conn.execute_batch("ALTER TABLE agent_knowledge_nodes RENAME TO agent_knowledge_nodes_old;
                CREATE TABLE agent_knowledge_nodes (
                    scope_key TEXT NOT NULL, node_id TEXT NOT NULL,
                    current_revision INTEGER NOT NULL CHECK(current_revision>0),
                    kind TEXT NOT NULL CHECK(kind IN ('topic','decision','source_summary','memory')),
                    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), updated_at TEXT NOT NULL,
                    PRIMARY KEY(scope_key,node_id));
                INSERT INTO agent_knowledge_nodes SELECT * FROM agent_knowledge_nodes_old;
                DROP TABLE agent_knowledge_nodes_old;
                CREATE INDEX IF NOT EXISTS agent_knowledge_active_kind ON agent_knowledge_nodes(scope_key,deleted,kind,node_id);
                CREATE TABLE agent_memory_policy (
                    scope_key TEXT NOT NULL,node_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision>0),
                    confirmation TEXT NOT NULL CHECK(confirmation IN ('inferred','user_confirmed')),
                    status TEXT NOT NULL CHECK(status IN ('enabled','disabled')),
                    protected_correction INTEGER NOT NULL CHECK(protected_correction IN (0,1)),
                    PRIMARY KEY(scope_key,node_id));
                CREATE TABLE agent_memory_suppressions (
                    scope_key TEXT NOT NULL,owner_node_id TEXT NOT NULL,
                    category TEXT NOT NULL,source_key TEXT NOT NULL,
                    PRIMARY KEY(scope_key,owner_node_id,category,source_key));
                CREATE INDEX agent_memory_suppression_lookup ON agent_memory_suppressions(scope_key,category,source_key);
                CREATE TABLE agent_memory_node_sources (
                    scope_key TEXT NOT NULL,node_id TEXT NOT NULL,category TEXT NOT NULL,source_key TEXT NOT NULL,
                    PRIMARY KEY(scope_key,node_id,category,source_key));
                CREATE INDEX agent_memory_node_source_lookup ON agent_memory_node_sources(scope_key,category,source_key);
                CREATE TABLE agent_memory_scope_epochs (
                    scope_key TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0));")?;
            self.set_schema_version(AGENT_MEMORY_SCHEMA_VERSION)?;
            self.conn.execute_batch("RELEASE agent_memory_schema")?;
            Ok(())
        })();
        if result.is_err() {
            self.conn
                .execute_batch("ROLLBACK TO agent_memory_schema; RELEASE agent_memory_schema")?;
        }
        result
    }
}

/// Test fixtures that claim a pre-37 user_version must also remove schema 37.
/// Keep legacy non-memory current pointers and immutable versions intact.
#[cfg(test)]
pub(crate) fn remove_agent_memory_schema_fixture(db: &Database) {
    db.conn.execute_batch("DROP TABLE IF EXISTS agent_memory_suppressions;
        DROP TABLE IF EXISTS agent_memory_node_sources;
        DROP TABLE IF EXISTS agent_memory_policy;
        DROP TABLE IF EXISTS agent_memory_scope_epochs;").unwrap();
    if db.table_exists("agent_knowledge_nodes").unwrap() {
        let memory_count:i64=db.conn.query_row("SELECT count(*) FROM agent_knowledge_nodes WHERE kind='memory'",[],|r|r.get(0)).unwrap();
        assert_eq!(memory_count,0,"pre-37 fixture cannot contain memory nodes");
        db.conn.execute_batch("DROP INDEX IF EXISTS agent_knowledge_active_kind;
            ALTER TABLE agent_knowledge_nodes RENAME TO agent_knowledge_nodes_post37;
            CREATE TABLE agent_knowledge_nodes (
                scope_key TEXT NOT NULL,node_id TEXT NOT NULL,
                current_revision INTEGER NOT NULL CHECK(current_revision>0),
                kind TEXT NOT NULL CHECK(kind IN ('topic','decision','source_summary')),
                deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),updated_at TEXT NOT NULL,
                PRIMARY KEY(scope_key,node_id));
            INSERT INTO agent_knowledge_nodes SELECT * FROM agent_knowledge_nodes_post37;
            DROP TABLE agent_knowledge_nodes_post37;
            CREATE INDEX agent_knowledge_active_kind ON agent_knowledge_nodes(scope_key,deleted,kind,node_id);").unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_schema_36_kind_check_without_losing_versions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("memory.sqlite");
        let db = Database::open(&path, root.path(), None).unwrap();
        db.conn.execute_batch("DROP TABLE agent_memory_suppressions;
            DROP TABLE agent_memory_node_sources;
            DROP TABLE agent_memory_policy;
            DROP TABLE agent_memory_scope_epochs;
            DROP INDEX agent_knowledge_active_kind;
            ALTER TABLE agent_knowledge_nodes RENAME TO agent_knowledge_nodes_new;
            CREATE TABLE agent_knowledge_nodes (
              scope_key TEXT NOT NULL,node_id TEXT NOT NULL,current_revision INTEGER NOT NULL CHECK(current_revision>0),
              kind TEXT NOT NULL CHECK(kind IN ('topic','decision','source_summary')),
              deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),updated_at TEXT NOT NULL,
              PRIMARY KEY(scope_key,node_id));
            INSERT INTO agent_knowledge_nodes SELECT * FROM agent_knowledge_nodes_new;
            DROP TABLE agent_knowledge_nodes_new;
            CREATE INDEX agent_knowledge_active_kind ON agent_knowledge_nodes(scope_key,deleted,kind,node_id);") .unwrap();
        db.conn.execute("INSERT INTO agent_knowledge_versions(scope_key,node_id,revision,overview_revision,snapshot_json,created_at) VALUES('workspace','old-node',1,1,'{}','now')",[]).unwrap();
        db.set_schema_version(36).unwrap();
        drop(db);
        let db = Database::open(&path, root.path(), None).unwrap();
        assert_eq!(db.schema_version().unwrap(), 37);
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT snapshot_json FROM agent_knowledge_versions WHERE node_id='old-node'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "{}"
        );
        db.conn.execute("INSERT INTO agent_knowledge_nodes(scope_key,node_id,current_revision,kind,deleted,updated_at) VALUES('workspace','memory-node',1,'memory',0,'now')",[]).unwrap();
        drop(db);
        let db = Database::open(&path, root.path(), None).unwrap();
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT kind FROM agent_knowledge_nodes WHERE node_id='memory-node'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "memory"
        );
    }
}
