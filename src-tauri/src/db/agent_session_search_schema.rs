use super::Database;

pub(super) const AGENT_SESSION_SEARCH_SCHEMA_VERSION: i64 = 33;

impl Database {
    pub(super) fn ensure_agent_session_search_schema(&self) -> anyhow::Result<()> {
        if self.schema_version()? >= AGENT_SESSION_SEARCH_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn
            .execute_batch("SAVEPOINT agent_session_search_schema")?;
        let result = (|| -> anyhow::Result<()> {
            // No message JSON is read during upgrade. Older projections are
            // indexed in bounded batches when the GUI requests search.
            self.conn
                .execute_batch(include_str!("agent_session_search.sql"))?;
            self.set_schema_version(AGENT_SESSION_SEARCH_SCHEMA_VERSION)?;
            self.conn
                .execute_batch("RELEASE agent_session_search_schema")?;
            Ok(())
        })();
        if result.is_err() {
            self.conn.execute_batch(
                "ROLLBACK TO agent_session_search_schema; RELEASE agent_session_search_schema",
            )?;
        }
        result
    }
}
