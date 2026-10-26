//! File withdrawal uses the shared object ledger and native File/Version data.
use super::Database;

pub(super) const FILE_OUTPUT_SCHEMA_VERSION: i64 = 32;

impl Database {
    pub(super) fn ensure_file_output_schema(&self) -> anyhow::Result<()> {
        self.compact_office_candidate_receipts()?;
        if self.schema_version()? >= FILE_OUTPUT_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn.execute_batch("SAVEPOINT file_output_schema")?;
        let result = (|| -> anyhow::Result<()> {
            self.conn.execute_batch(super::agent_file_undo::FILE_VISIBILITY_VIEW_SQL)?;
            self.set_schema_version(FILE_OUTPUT_SCHEMA_VERSION)?;
            self.conn.execute_batch("RELEASE file_output_schema")?;
            Ok(())
        })();
        if result.is_err() {
            self.conn.execute_batch("ROLLBACK TO file_output_schema; RELEASE file_output_schema")?;
        }
        result
    }
    fn compact_office_candidate_receipts(&self) -> anyhow::Result<()> {
        use rusqlite::OptionalExtension;
        const KEY: &str = "migration.office_candidate_receipts_v1";
        if self.conn.query_row("SELECT 1 FROM app_settings WHERE key=?1", [KEY], |_| Ok(())).optional()?.is_some() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE agent_operation_receipts SET result_json=json_remove(result_json,'$.model') WHERE operation='file.office.candidate' AND json_type(result_json,'$.model') IS NOT NULL", [])?;
        tx.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES (?1,'true',?2)", rusqlite::params![KEY,chrono::Utc::now().to_rfc3339()])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn office_candidate_upgrade_keeps_idempotency_and_stage_without_model_body() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.conn.execute("DELETE FROM app_settings WHERE key='migration.office_candidate_receipts_v1'", []).unwrap();
        db.conn.execute("INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,created_at) VALUES ('r','gui','original-hash','file.office.candidate','committed',?1,'fixture')",
            [r#"{"target":{"id":"1"},"expectedVersion":1,"expectedHash":"fixed","stagedContentId":"stage","model":{"sourceBase64":"large"}}"#]).unwrap();
        db.compact_office_candidate_receipts().unwrap();
        db.compact_office_candidate_receipts().unwrap();
        let (hash, body): (String,String) = db.conn.query_row("SELECT payload_hash,result_json FROM agent_operation_receipts WHERE request_id='r'", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(hash, "original-hash");
        assert_eq!(value["stagedContentId"], "stage");
        assert!(value.get("model").is_none());
    }

    #[test]
    fn file_output_migration_preserves_native_rows_and_reopens_once() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("test.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let project = db.project_create(crate::models::ProjectCreateInput {
            name: "Retained files".into(), summary: None, status: None,
        }).unwrap();
        let source = root.path().join("original.txt");
        std::fs::write(&source, "retained bytes").unwrap();
        let file = db.document_import(crate::models::DocumentImportInput {
            project_id: Some(project.id), source_path: source.to_string_lossy().into(),
            is_starred: false, tag_ids: None,
        }).unwrap();
        db.conn.execute_batch("DROP VIEW agent_visible_files; DROP TABLE agent_run_source_dependencies; DROP TABLE agent_run_provenance; DROP TABLE agent_session_scan_state; DROP INDEX agent_session_search_rows_session; DROP TRIGGER agent_session_search_row_delete; DROP TABLE agent_session_search_rows; DROP TABLE agent_session_search_fts;").unwrap();
        super::super::agent_memory_schema::remove_agent_memory_schema_fixture(&db);
        db.set_schema_version(31).unwrap();
        let before: i64 = db.conn.query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0)).unwrap();
        db.ensure_file_output_schema().unwrap();
        assert_eq!(db.schema_version().unwrap(), 32);
        assert_eq!(db.conn.query_row("SELECT COUNT(*) FROM agent_visible_files", [], |row| row.get::<_, i64>(0)).unwrap(), before);
        drop(db);
        let reopened = Database::open(&path, root.path(), None).unwrap();
        assert_eq!(reopened.schema_version().unwrap(), super::super::CURRENT_SCHEMA_VERSION);
        assert_eq!(reopened.conn.query_row("SELECT COUNT(*) FROM documents", [], |row| row.get::<_, i64>(0)).unwrap(), before);
        assert_eq!(std::fs::read(file.managed_path).unwrap(), b"retained bytes");
    }

    #[test]
    fn file_output_migration_failure_does_not_advance_version() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("test.sqlite"), root.path(), None).unwrap();
        db.set_schema_version(31).unwrap();
        // A conflicting object is an actual migration failure, not a reason to
        // silently claim the new version through CREATE IF NOT EXISTS.
        assert!(db.ensure_file_output_schema().is_err());
        assert_eq!(db.schema_version().unwrap(), 31);
        assert!(db.conn.is_autocommit());
        db.conn.execute_batch("DROP VIEW agent_visible_files").unwrap();
        db.ensure_file_output_schema().unwrap();
        assert_eq!(db.schema_version().unwrap(), 32);
    }
}
