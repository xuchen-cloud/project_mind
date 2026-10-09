use super::Database;

pub(super) const AGENT_RUN_PROVENANCE_SCHEMA_VERSION: i64 = 35;

impl Database {
    pub(super) fn ensure_agent_run_provenance_schema(&self) -> anyhow::Result<()> {
        if self.schema_version()? >= AGENT_RUN_PROVENANCE_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn
            .execute_batch("SAVEPOINT agent_run_provenance_schema")?;
        let result = (|| -> anyhow::Result<()> {
            self.conn
                .execute_batch(include_str!("agent_run_provenance.sql"))?;
            self.set_schema_version(AGENT_RUN_PROVENANCE_SCHEMA_VERSION)?;
            self.conn
                .execute_batch("RELEASE agent_run_provenance_schema")?;
            Ok(())
        })();
        if result.is_err() {
            self.conn.execute_batch(
                "ROLLBACK TO agent_run_provenance_schema; RELEASE agent_run_provenance_schema",
            )?;
        }
        result
    }
}
