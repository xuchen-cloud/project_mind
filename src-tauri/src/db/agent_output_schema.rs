//! Add Record operation/undo context to the existing atomic receipt, never a
//! second ledger. Experimental historical receipts remain unavailable for undo.
use super::Database;
pub(super) const AGENT_OUTPUT_SCHEMA_VERSION: i64 = 30;

impl Database {
    pub(super) fn ensure_agent_output_schema(&self) -> anyhow::Result<()> {
        if self.schema_version()? >= AGENT_OUTPUT_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn.execute_batch("SAVEPOINT agent_output_schema")?;
        let result = (|| -> anyhow::Result<()> {
            for (name, definition) in [
                ("operation_id", "TEXT"), ("run_id", "TEXT"),
                ("target_ref_json", "TEXT CHECK(target_ref_json IS NULL OR json_valid(target_ref_json))"),
                ("before_revision", "INTEGER CHECK(before_revision IS NULL OR before_revision>0)"),
                ("after_revision", "INTEGER CHECK(after_revision IS NULL OR after_revision>0)"),
                ("before_snapshot_ref", "TEXT"), ("after_snapshot_ref", "TEXT"),
                ("output_context_json", "TEXT CHECK(output_context_json IS NULL OR json_valid(output_context_json))"),
                ("undo_state", "TEXT NOT NULL DEFAULT 'unavailable' CHECK(undo_state IN ('unavailable','available','undone'))"),
                ("undo_operation_id", "TEXT"),
            ] {
                if !self.has_column("agent_operation_receipts", name)? {
                    self.conn.execute_batch(&format!("ALTER TABLE agent_operation_receipts ADD COLUMN {name} {definition}"))?;
                }
            }
            self.conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_receipt_operation_id ON agent_operation_receipts(operation_id) WHERE operation_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_agent_receipts_run ON agent_operation_receipts(run_id,created_at,operation_id) WHERE run_id IS NOT NULL;")?;
            self.conn
                .execute_batch(super::agent_record_withdrawals::AGENT_RECORD_WITHDRAWALS_SQL)?;
            // No inferred snapshots or invented undo availability for old receipts.
            self.set_schema_version(AGENT_OUTPUT_SCHEMA_VERSION)?;
            self.conn.execute_batch("RELEASE agent_output_schema")?;
            Ok(())
        })();
        if result.is_err() {
            self.conn
                .execute_batch("ROLLBACK TO agent_output_schema; RELEASE agent_output_schema")?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    fn fixture() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("agent_schema.sql"))
            .unwrap();
        let db = Database {
            conn,
            workspace_root: Default::default(),
            secret_password: None,
            native_workspace_id: None,
        };
        db.set_schema_version(29).unwrap();
        db
    }
    #[test]
    fn agent_output_schema_preserves_old_receipts_without_claiming_undo() {
        let db = fixture();
        db.conn.execute("INSERT INTO agent_operation_receipts(request_id,caller_id,payload_hash,operation,state,result_json,created_at) VALUES ('old','gui','hash','record.patch','committed','{}','now')", []).unwrap();
        db.ensure_agent_output_schema().unwrap();
        let row: (String, Option<String>, String) = db
            .conn
            .query_row(
                "SELECT result_json,operation_id,undo_state FROM agent_operation_receipts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("{}".into(), None, "unavailable".into()));
        assert_eq!(db.schema_version().unwrap(), 30);
        db.ensure_agent_output_schema().unwrap();
    }
    #[test]
    fn agent_output_schema_rolls_back_columns_and_version_on_index_failure() {
        let db = fixture();
        db.conn
            .execute(
                "CREATE TABLE idx_agent_receipt_operation_id(incompatible TEXT)",
                [],
            )
            .unwrap();
        assert!(db.ensure_agent_output_schema().is_err());
        assert_eq!(db.schema_version().unwrap(), 29);
        assert!(!db.has_column("agent_operation_receipts", "run_id").unwrap());
        assert!(db.conn.is_autocommit());
    }
}
