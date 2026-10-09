use super::Database;

pub(super) const AGENT_SESSION_SEARCH_SCHEMA_VERSION: i64 = 34;

impl Database {
    pub(super) fn ensure_agent_session_search_schema(&self) -> anyhow::Result<()> {
        let old_version = self.schema_version()?;
        if old_version >= AGENT_SESSION_SEARCH_SCHEMA_VERSION {
            return Ok(());
        }
        self.conn
            .execute_batch("SAVEPOINT agent_session_search_schema")?;
        let result = (|| -> anyhow::Result<()> {
            // Keep the schema 33 step for older databases, then preserve its
            // current-branch text and metadata in the session-owned index.
            if old_version < 33 {
                self.conn
                    .execute_batch(include_str!("agent_session_search.sql"))?;
                self.set_schema_version(33)?;
            }
            self.conn
                .execute_batch(include_str!("agent_session_search_34.sql"))?;
            // SQLite length(TEXT) stops at NUL, while Pi offsets count Unicode
            // scalar values. Correct only migrated rows with embedded NULs.
            let nul_rows: Vec<(String, String)> = {
                let mut stmt = self.conn.prepare("SELECT message_id,text FROM agent_session_search_rows WHERE instr(text,char(0))>0")?;
                let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for (message_id, text) in nul_rows {
                self.conn.execute(
                    "UPDATE agent_session_search_rows SET total_chars=?2 WHERE message_id=?1",
                    rusqlite::params![message_id, text.chars().count() as i64],
                )?;
            }
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
