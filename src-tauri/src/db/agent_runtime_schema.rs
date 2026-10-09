//! Formal publication of previously staged source/knowledge runtime storage.
use super::{Database, AGENT_RUNTIME_SCHEMA_VERSION};

impl Database {
    pub(super) fn ensure_agent_runtime_schema(&self) -> anyhow::Result<()> {
        if self.schema_version()? >= AGENT_RUNTIME_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn.execute_batch("SAVEPOINT agent_runtime_schema")?;
        let result = (|| -> anyhow::Result<()> {
            // Reuse the existing upgrade, including its legacy column/policy
            // conversion; nested preparation savepoints join this atomic step.
            crate::source_search_index::SourceIndex::prepare(&self.conn)
                .map_err(|error| anyhow::anyhow!("{}", error.message))?;
            self.conn
                .execute_batch(include_str!("source_registry.sql"))?;
            self.source_registry_reconcile()?;
            self.source_queue_prepare()
                .map_err(|error| anyhow::anyhow!("{}", error.message))?;
            // The existing one-time bootstrap marker prevents acknowledged
            // pending keys from being resurrected during upgrade or reopen.
            self.agent_overviews_prepare()?;
            self.agent_knowledge_prepare()?;
            self.conn
                .execute_batch(super::agent_profiles::AGENT_PROFILE_VERIFICATIONS_SQL)?;
            self.set_schema_version(AGENT_RUNTIME_SCHEMA_VERSION)?;
            self.conn.execute_batch("RELEASE agent_runtime_schema")?;
            Ok(())
        })();
        if result.is_err() {
            self.conn
                .execute_batch("ROLLBACK TO agent_runtime_schema; RELEASE agent_runtime_schema")?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    // Remove schema31/30 additions before this fixture simulates an older file.
    const REMOVE_LATER_AGENT_SCHEMA: &str = r#"
DROP TABLE agent_run_source_dependencies; DROP TABLE agent_run_provenance; DROP TABLE agent_session_scan_state;
DROP INDEX agent_session_search_rows_session;
DROP TRIGGER agent_session_search_row_delete;
DROP TABLE agent_session_search_rows;
DROP TABLE agent_session_search_fts;
DROP VIEW agent_visible_files;
DROP VIEW agent_visible_todos;
DROP TABLE todo_revision_heads;
DROP TABLE todo_revision_snapshots;
DROP INDEX agent_todo_output_dedupe;
ALTER TABLE agent_outputs DROP COLUMN dedupe_key;
DROP VIEW agent_visible_notes;
DROP VIEW agent_visible_workspace_notes;
DROP TABLE agent_object_withdrawals;
DROP INDEX idx_agent_receipt_operation_id;
DROP INDEX idx_agent_receipts_run;
ALTER TABLE agent_operation_receipts DROP COLUMN operation_id;
ALTER TABLE agent_operation_receipts DROP COLUMN run_id;
ALTER TABLE agent_operation_receipts DROP COLUMN target_ref_json;
ALTER TABLE agent_operation_receipts DROP COLUMN before_revision;
ALTER TABLE agent_operation_receipts DROP COLUMN after_revision;
ALTER TABLE agent_operation_receipts DROP COLUMN before_snapshot_ref;
ALTER TABLE agent_operation_receipts DROP COLUMN after_snapshot_ref;
ALTER TABLE agent_operation_receipts DROP COLUMN output_context_json;
ALTER TABLE agent_operation_receipts DROP COLUMN undo_state;
ALTER TABLE agent_operation_receipts DROP COLUMN undo_operation_id;
"#;

    use super::*;
    use rusqlite::Connection;

    fn open(root: &std::path::Path) -> Database {
        Database::open(
            &root.join("workspace.sqlite"),
            root,
            Some("fixture-secret".into()),
        )
        .unwrap()
    }

    fn assert_runtime_schema(db: &Database, expected_version: i64) {
        for table in [
            "source_index_snapshots",
            "source_index_chunks",
            "source_access_policies",
            "source_registry",
            "source_dependency_invalidations",
            "source_index_queue_cursors",
            "source_index_backfill_cursors",
            "agent_overviews",
            "agent_overview_versions",
            "agent_overview_pending",
            "agent_overview_pending_bootstrap",
            "agent_overview_inventory_cursors",
            "agent_knowledge_nodes",
            "agent_knowledge_versions",
            "agent_knowledge_fts",
            "agent_profile_verifications",
            "agent_sessions",
            "agent_runs",
            "agent_messages",
        ] {
            assert!(
                db.table_exists(table).unwrap(),
                "Missing migrated table: {table}"
            );
        }
        assert_eq!(db.schema_version().unwrap(), expected_version);
    }

    #[test]
    fn agent_runtime_schema_fresh_open_has_required_tables_without_lazy_reads() {
        let root = tempfile::tempdir().unwrap();
        let db = open(root.path());
        assert_runtime_schema(&db, super::super::CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn agent_runtime_schema_unprepared_28_installs_and_reconciles_metadata_only() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE projects(id INTEGER PRIMARY KEY);
            INSERT INTO projects VALUES (1);",
            )
            .unwrap();
        connection
            .execute_batch(include_str!("agent_schema.sql"))
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at)
            VALUES ('ws/project:1/record/7','project:1','record.delete','deleted','created')",
                [],
            )
            .unwrap();
        let db = Database {
            conn: connection,
            workspace_root: std::path::PathBuf::new(),
            secret_password: None,
            native_workspace_id: None,
        };
        db.set_schema_version(28).unwrap();
        db.ensure_agent_runtime_schema().unwrap();
        assert_runtime_schema(&db, AGENT_RUNTIME_SCHEMA_VERSION);
        let pending: (String, i64) = db.conn.query_row(
            "SELECT operation,deleted FROM agent_overview_pending WHERE object_key='ws/project:1/record/7'",
            [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(pending, ("bootstrap.deleted".into(), 1));
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM source_index_snapshots", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn agent_runtime_schema_upgrade_backs_up_and_preserves_acknowledged_pending() {
        let root = tempfile::tempdir().unwrap();
        let db = open(root.path());
        // Emulate a pre-publication schema28 database with staged storage whose
        // bootstrap completed and whose pending key was already acknowledged.
        db.conn
            .execute(
                "INSERT INTO agent_change_log(object_key,scope_key,operation,revision,created_at)
            VALUES ('ws/project:1/record/7','project:1','record.update','r1','created')",
                [],
            )
            .unwrap();
        db.conn
            .execute("DELETE FROM agent_overview_pending", [])
            .unwrap();
        db.conn
            .execute(
                "INSERT OR REPLACE INTO agent_overview_pending_state VALUES ('project:1',0)",
                [],
            )
            .unwrap();
        db.conn.execute("INSERT INTO agent_knowledge_nodes VALUES ('project:1','kept',1,'topic',0,'created')", []).unwrap();
        db.conn
            .execute("DROP TABLE agent_profile_verifications", [])
            .unwrap();
        db.conn.execute_batch(REMOVE_LATER_AGENT_SCHEMA).unwrap();
        db.set_schema_version(28).unwrap();
        drop(db);
        let reopened = open(root.path());
        assert_runtime_schema(&reopened, super::super::CURRENT_SCHEMA_VERSION);
        assert_eq!(
            reopened
                .conn
                .query_row("SELECT COUNT(*) FROM agent_overview_pending", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(reopened.conn.query_row("SELECT needs_rebuild FROM agent_overview_pending_state WHERE scope_key='project:1'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(
            reopened
                .conn
                .query_row("SELECT node_id FROM agent_knowledge_nodes", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "kept"
        );
        let backup_dir = root.path().join(".project-mind/backups");
        let backups: Vec<_> = std::fs::read_dir(backup_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        let backup = Connection::open(&backups[0]).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            28
        );
        assert_eq!(
            backup
                .query_row("SELECT node_id FROM agent_knowledge_nodes", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "kept"
        );
        drop(reopened);
        let repeated = open(root.path());
        assert_runtime_schema(&repeated, super::super::CURRENT_SCHEMA_VERSION);
        assert_eq!(
            repeated
                .conn
                .query_row("SELECT COUNT(*) FROM agent_overview_pending", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn agent_runtime_schema_failed_upgrade_rolls_back_new_tables_and_version() {
        let root = tempfile::tempdir().unwrap();
        let db = open(root.path());
        db.conn.execute_batch(REMOVE_LATER_AGENT_SCHEMA).unwrap();
        db.set_schema_version(28).unwrap();
        db.conn
            .execute("DROP TABLE agent_profile_verifications", [])
            .unwrap();
        db.conn
            .execute("DROP TABLE agent_knowledge_nodes", [])
            .unwrap();
        // An incompatible existing table forces a real DDL/index failure after
        // source and Overview preparation but before version publication.
        db.conn
            .execute("CREATE TABLE agent_knowledge_nodes(incompatible TEXT)", [])
            .unwrap();
        db.conn
            .execute("DROP TABLE source_index_queue_cursors", [])
            .unwrap();
        assert!(db.ensure_agent_runtime_schema().is_err());
        assert_eq!(db.schema_version().unwrap(), 28);
        assert!(!db.table_exists("source_index_queue_cursors").unwrap());
        assert!(!db.table_exists("agent_profile_verifications").unwrap());
        assert!(db.conn.is_autocommit());
    }
}
